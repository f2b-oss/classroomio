import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { UnrecoverableError } from 'bullmq';

import { log } from './logger';

const execFileAsync = promisify(execFile);

/**
 * Resolved at module load. Set `FFMPEG_PATH` / `FFPROBE_PATH` to point at
 * non-default binary locations (e.g. when ffmpeg lives outside PATH for the
 * worker process). When unset we fall through to `ffmpeg` / `ffprobe` on
 * PATH, which is what most installs provide.
 */
export const FFMPEG_BIN = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE_BIN = process.env.FFPROBE_PATH ?? 'ffprobe';

/** Cap subprocess stdout/stderr so a runaway log can't blow up the worker. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Inputs are user uploads, and container formats such as HLS, DASH and concat
 * can name further URLs that ffmpeg would otherwise open. Restricting every
 * invocation to local files stops an upload from making the worker fetch or
 * read anything it was not handed.
 */
const PROTOCOL_ALLOWLIST = ['-protocol_whitelist', 'file'];

/**
 * Wall-clock budgets for each kind of invocation. A valid but pathological
 * upload (a huge frame size, a long high-bitrate stream) can otherwise keep a
 * subprocess and a worker slot busy indefinitely. When a budget runs out the
 * child is SIGKILLed: ffmpeg traps SIGTERM to finish writing its output, which
 * is the opposite of what is wanted here.
 */
export const FFMPEG_TIMEOUTS_MS = {
  /** `ffprobe` of a whole upload; reads headers, not frames. */
  probe: 30_000,
  /** Luma of a single already-extracted JPEG. */
  luma: 30_000,
  /** Default for `ffmpegRun` when the caller passes no budget. */
  run: 60_000
} as const;

/** Upper bound for any duration-scaled budget, however long the source claims to be. */
export const FFMPEG_MAX_TIMEOUT_MS = 30 * 60_000;

/**
 * Budget for work that has to decode the source up to some point: `baseMs`
 * plus half a second per second of media, capped at `capMs`. Unknown or
 * invalid durations get the cap.
 */
export function durationScaledTimeoutMs(
  durationSeconds: number | null | undefined,
  baseMs: number,
  capMs: number = FFMPEG_MAX_TIMEOUT_MS
): number {
  if (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return capMs;
  }
  return Math.min(capMs, Math.ceil(baseMs + durationSeconds * 500));
}

/**
 * The subprocess ran out of its budget. Retrying would spend the same budget
 * on the same input, so this is unrecoverable: BullMQ fails the job without
 * further attempts. The name is BullMQ's, which it matches on.
 */
export class FfmpegTimeoutError extends UnrecoverableError {
  constructor(
    public readonly bin: string,
    public readonly timeoutMs: number
  ) {
    super(`${bin} killed after exceeding its ${timeoutMs} ms time budget`);
    this.name = 'UnrecoverableError';
  }
}

function execOptions(timeoutMs: number) {
  return { maxBuffer: MAX_OUTPUT_BYTES, timeout: timeoutMs, killSignal: 'SIGKILL' as const };
}

/** True when `execFile` killed the child because `timeout` elapsed. */
function isTimeoutKill(error: unknown): boolean {
  const err = error as { killed?: boolean; signal?: string | null; code?: unknown };
  return err?.killed === true && err.signal === 'SIGKILL' && err.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/** Full argv for an ffmpeg run: the protocol allowlist, then `args`. */
export function ffmpegArgs(args: string[]): string[] {
  return [...PROTOCOL_ALLOWLIST, ...args];
}

/** Full argv for the JSON probe of `localPath`. */
export function ffprobeArgs(localPath: string): string[] {
  return [...PROTOCOL_ALLOWLIST, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', localPath];
}

export interface FfprobeStream {
  codec_type?: 'video' | 'audio' | 'subtitle' | 'data';
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

export interface FfprobeFormat {
  duration?: string;
  size?: string;
  bit_rate?: string;
}

export interface FfprobeData {
  streams: FfprobeStream[];
  format: FfprobeFormat;
}

/**
 * Run `ffprobe -print_format json -show_format -show_streams <file>` and
 * return the parsed JSON. Mirrors the shape we used to get from
 * `fluent-ffmpeg.ffprobe()` but without the deprecated wrapper.
 */
export async function ffprobeJson(localPath: string): Promise<FfprobeData> {
  try {
    const { stdout } = await execFileAsync(FFPROBE_BIN, ffprobeArgs(localPath), execOptions(FFMPEG_TIMEOUTS_MS.probe));
    return JSON.parse(stdout) as FfprobeData;
  } catch (error) {
    if (isTimeoutKill(error)) {
      throw new FfmpegTimeoutError(FFPROBE_BIN, FFMPEG_TIMEOUTS_MS.probe);
    }
    const err = error as Error & { code?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        `ffprobe binary not found at "${FFPROBE_BIN}". Ensure ffprobe is installed and available on PATH or set FFPROBE_PATH.`,
        { cause: err }
      );
    }
    throw error;
  }
}

/**
 * Spawn ffmpeg with the supplied argv. Captures stderr and surfaces a useful
 * tail in the error message when ffmpeg exits non-zero, since ffmpeg writes
 * progress and diagnostics to stderr by default. The child is killed after
 * `timeoutMs` and the call throws `FfmpegTimeoutError`.
 */
export async function ffmpegRun(args: string[], timeoutMs: number = FFMPEG_TIMEOUTS_MS.run): Promise<void> {
  try {
    await execFileAsync(FFMPEG_BIN, ffmpegArgs(args), execOptions(timeoutMs));
  } catch (error) {
    if (isTimeoutKill(error)) {
      throw new FfmpegTimeoutError(FFMPEG_BIN, timeoutMs);
    }
    const err = error as Error & { stderr?: string | Buffer; code?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        `ffmpeg binary not found at "${FFMPEG_BIN}". Ensure ffmpeg is installed and available on PATH or set FFMPEG_PATH.`,
        { cause: err }
      );
    }

    const stderr = typeof err.stderr === 'string' ? err.stderr : (err.stderr?.toString('utf8') ?? '');
    const tail = stderr.split('\n').filter(Boolean).slice(-5).join(' | ');
    const detail = tail || err.message || String(error);
    throw new Error(`ffmpeg exited with error: ${detail}`, { cause: err });
  }
}

/**
 * Mean luminance of a frame, 0 (black) to 255 (white).
 *
 * `signalstats` alone no longer prints its stats to stderr on newer ffmpeg, so
 * the value is requested as frame metadata. Both shapes are accepted because
 * older builds still log the stderr form.
 */
export function parseMeanLuma(ffmpegOutput: string): number | null {
  const metadata = ffmpegOutput.match(/lavfi\.signalstats\.YAVG=([0-9]+(?:\.[0-9]+)?)/);
  const logged = ffmpegOutput.match(/YAVG:([0-9]+(?:\.[0-9]+)?)/);
  const value = metadata?.[1] ?? logged?.[1];

  return value === undefined ? null : Number.parseFloat(value);
}

/** Last few lines of ffmpeg output, for an error a caller can act on. */
function stderrTail(stderr: string, lines = 4): string {
  return stderr.trimEnd().split('\n').slice(-lines).join(' | ');
}

/**
 * Compute the mean luminance (`YAVG`) of an image or single video frame using
 * ffmpeg's `signalstats` filter. Returned on the original 0-255 scale; a fully
 * black frame is ~0, fully white ~255. Throws if ffmpeg fails or the value is
 * not present in its output.
 */
export async function ffmpegProbeLuma(filePath: string): Promise<number> {
  const args = ffmpegArgs([
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-vf',
    'signalstats,metadata=print:key=lavfi.signalstats.YAVG',
    '-f',
    'null',
    '-'
  ]);
  let stderr = '';
  try {
    const result = await execFileAsync(FFMPEG_BIN, args, execOptions(FFMPEG_TIMEOUTS_MS.luma));
    const raw = result.stderr as string | Buffer | undefined;
    stderr = typeof raw === 'string' ? raw : (raw?.toString('utf8') ?? '');
  } catch (error) {
    if (isTimeoutKill(error)) {
      throw new FfmpegTimeoutError(FFMPEG_BIN, FFMPEG_TIMEOUTS_MS.luma);
    }
    const err = error as Error & { stderr?: string | Buffer; code?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        `ffmpeg binary not found at "${FFMPEG_BIN}". Ensure ffmpeg is installed and available on PATH or set FFMPEG_PATH.`,
        { cause: err }
      );
    }

    const raw = err.stderr;
    stderr = typeof raw === 'string' ? raw : (raw?.toString('utf8') ?? '');
    if (!stderr) {
      throw error as Error;
    }
  }

  const luma = parseMeanLuma(stderr);
  if (luma === null) {
    throw new Error(`ffmpegProbeLuma: no YAVG in ffmpeg output — ${stderrTail(stderr)}`);
  }

  return luma;
}

/**
 * Probe for the binaries at worker startup. Logs a warning when missing so
 * media jobs surface a clearer failure than a raw ENOENT from the first
 * spawn. Non-media workers (emails, maintenance) keep booting either way.
 */
export async function warnIfFfmpegMissing(): Promise<void> {
  const checks = await Promise.all([isExecutable(FFMPEG_BIN), isExecutable(FFPROBE_BIN)]);

  const missing: string[] = [];
  if (!checks[0]) missing.push(FFMPEG_BIN);
  if (!checks[1]) missing.push(FFPROBE_BIN);

  if (missing.length === 0) {
    log.info('ffmpeg-binaries-resolved', { ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN });
    return;
  }

  log.warn('ffmpeg-binaries-missing', {
    missing,
    hint: 'Install ffmpeg (macOS: brew install ffmpeg, Debian/Ubuntu: apt install ffmpeg) or set FFMPEG_PATH / FFPROBE_PATH. Media jobs will fail until this is resolved; other workers are unaffected.'
  });
}

async function isExecutable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['-version'], execOptions(FFMPEG_TIMEOUTS_MS.probe));
    return true;
  } catch {
    return false;
  }
}
