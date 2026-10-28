import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile }));

import { FfmpegTimeoutError, durationScaledTimeoutMs, ffmpegProbeLuma, ffmpegRun, ffprobeJson } from './ffmpeg';

type Callback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;

interface ExecOptions {
  timeout?: number;
  killSignal?: string;
}

function lastOptions(): ExecOptions {
  return execFile.mock.calls.at(-1)?.[2] as ExecOptions;
}

function expectBounded(options: ExecOptions) {
  expect(options.timeout).toBeGreaterThan(0);
  expect(Number.isFinite(options.timeout)).toBe(true);
  expect(options.killSignal).toBe('SIGKILL');
}

/** What `execFile` reports when it killed the child because `timeout` elapsed. */
function timeoutKill(): Error {
  return Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGKILL', code: null, stderr: '' });
}

const wrappers: Array<[string, () => Promise<unknown>]> = [
  ['ffprobeJson', () => ffprobeJson('/tmp/upload.bin')],
  ['ffmpegRun', () => ffmpegRun(['-y', '-i', '/tmp/upload.bin', '/tmp/out.mp3'])],
  ['ffmpegProbeLuma', () => ffmpegProbeLuma('/tmp/frame.jpg')]
];

describe('ffmpeg time budgets', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, callback: Callback) => {
      callback(null, { stdout: '{"streams":[],"format":{}}', stderr: 'lavfi.signalstats.YAVG=10' });
    });
  });

  it.each(wrappers)('%s passes a finite timeout and SIGKILL', async (_name, call) => {
    await call();

    expectBounded(lastOptions());
  });

  it('lets the caller set the ffmpegRun budget', async () => {
    await ffmpegRun(['-i', '/tmp/upload.bin', '/tmp/out.mp3'], 1234);

    expect(lastOptions().timeout).toBe(1234);
  });

  it.each(wrappers)('%s turns a timeout kill into an unrecoverable error', async (_name, call) => {
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, callback: Callback) => {
      callback(timeoutKill());
    });

    const error = await call().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    // BullMQ skips retries for errors with this name.
    expect((error as Error).name).toBe('UnrecoverableError');
  });

  it('does not treat a maxBuffer overflow as a timeout', async () => {
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, callback: Callback) => {
      callback(Object.assign(timeoutKill(), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }));
    });

    const error = await ffmpegRun(['-i', '/tmp/upload.bin', '/tmp/out.mp3']).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(FfmpegTimeoutError);
  });
});

describe('durationScaledTimeoutMs', () => {
  it('adds half a second per second of media to the base', () => {
    expect(durationScaledTimeoutMs(600, 60_000)).toBe(360_000);
  });

  it('never exceeds the cap', () => {
    expect(durationScaledTimeoutMs(10 * 3600, 60_000, 900_000)).toBe(900_000);
  });

  it.each([null, undefined, 0, -5, Number.NaN])('uses the cap for an unknown duration (%s)', (duration) => {
    expect(durationScaledTimeoutMs(duration, 60_000, 900_000)).toBe(900_000);
  });
});
