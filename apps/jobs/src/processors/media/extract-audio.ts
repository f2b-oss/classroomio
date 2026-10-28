import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

import { UnrecoverableError } from 'bullmq';

import { getAssetById, getJobStep, updateMediaJob, upsertJobStep } from '@cio/db/queries';
import { ZExtractAudioPayload, type TExtractAudioPayload } from '@cio/jobs/payloads/media';

import {
  downloadObjectToTempFile,
  mediaBucket,
  ObjectTooLargeError,
  objectExists,
  safeUnlink,
  uploadFileToBucket,
  videosBucket
} from '../../utils/storage';
import { errorMessage, throwIfCancelRequested } from '../../utils/cancel';
import { durationScaledTimeoutMs, ffmpegRun } from '../../utils/ffmpeg';
import { log } from '../../utils/logger';

const STEP_KEY = 'extract-audio';
const DOMAIN = 'media';
/** Fixed part of the transcode budget; the rest scales with the asset's duration. */
const TRANSCODE_TIMEOUT_BASE_MS = 60_000;

interface ExtractAudioResult {
  bucket: string;
  key: string;
  fileSizeBytes: number;
}

function transcodeToMp3(inputPath: string, outputPath: string, timeoutMs: number): Promise<void> {
  return ffmpegRun(
    [
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-acodec',
      'libmp3lame',
      '-b:a',
      '32k',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'mp3',
      outputPath
    ],
    timeoutMs
  );
}

/**
 * Tags the media playlists we produce use (the browser encoder and the
 * server-side encoder both write MPEG-TS segments, so there is no init
 * segment). The playlist is written by whoever uploaded the video, so anything
 * else fails the job, in particular a tag carrying a `URI=` (`EXT-X-MAP`,
 * `EXT-X-KEY`, ...), which would have ffmpeg open a file the worker never
 * downloaded.
 */
const HLS_ALLOWED_TAGS = new Set([
  '#EXTM3U',
  '#EXT-X-VERSION',
  '#EXT-X-TARGETDURATION',
  '#EXT-X-MEDIA-SEQUENCE',
  '#EXT-X-PLAYLIST-TYPE',
  '#EXT-X-INDEPENDENT-SEGMENTS',
  '#EXTINF',
  '#EXT-X-ENDLIST'
]);

/**
 * Both encoders name segments `seg-NNNNN.ts` and write nothing but MPEG-TS, so
 * a segment line is a flat `.ts` file name. Anything else (another playlist,
 * an mp4, a path) is not something we wrote.
 */
const HLS_SEGMENT_NAME = /^[A-Za-z0-9._-]+\.ts$/;

/**
 * Most segments a playlist may list. Every segment is a sequential GET made
 * before ffmpeg starts, while the job holds a worker slot, so the count needs
 * a ceiling of its own. 20 000 six-second segments is over 33 hours of audio.
 */
export const HLS_MAX_SEGMENTS = 20_000;

/**
 * Largest playlist the worker will read. It is read into memory whole, so its
 * size needs a ceiling of its own. `HLS_MAX_SEGMENTS` entries at about 40 bytes
 * each is under 1 MiB.
 */
export const HLS_MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

/**
 * Largest single segment the worker will download. Our encoders write 4 s
 * segments; at the 1080p rung's 5 Mbps ceiling that is about 2.5 MB.
 */
export const HLS_MAX_SEGMENT_BYTES = 32 * 1024 * 1024;

/**
 * Most bytes of segments one playlist may make the worker write to local temp.
 * Nothing caps segment uploads by size, so without this a playlist of
 * `HLS_MAX_SEGMENTS` large objects could fill the disk. Well above a rendition
 * of the largest video we accept for upload.
 */
export const HLS_MAX_TOTAL_SEGMENT_BYTES = 2 * 1024 * 1024 * 1024;

/** Longest piece of playlist text quoted in an error message. */
const HLS_ERROR_QUOTE_CHARS = 120;

/**
 * Quote playlist text for an error message. The text is the uploader's, and the
 * message ends up in the logs and on the media job, so it is cut short and
 * JSON-escaped.
 */
function quote(text: string): string {
  return JSON.stringify(text.slice(0, HLS_ERROR_QUOTE_CHARS));
}

/**
 * The uploaded playlist is not one we can process. It is the same playlist on
 * every attempt, so this is unrecoverable: BullMQ fails the job without
 * further attempts. The name is BullMQ's, which it matches on.
 */
export class HlsPlaylistRejectedError extends UnrecoverableError {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

export interface HlsSegment {
  /** Bucket key of the segment object. */
  key: string;
  /** File name the rewritten playlist refers to. */
  localName: string;
}

/**
 * Validate an HLS media playlist and rewrite it to refer to local segment
 * files. Every segment must be a `.ts` object directly under `playlistPrefix`,
 * so the playlist cannot choose what else the worker reads, and may appear only
 * once, up to `HLS_MAX_SEGMENTS`, so it cannot choose how much the worker reads.
 * Throws `HlsPlaylistRejectedError`.
 */
export function rewriteHlsPlaylist(
  rawPlaylist: string,
  playlistPrefix: string
): { playlist: string; segments: HlsSegment[] } {
  const lines: string[] = [];
  const segments: HlsSegment[] = [];
  const seenKeys = new Set<string>();
  const prefix = path.posix.normalize(playlistPrefix);

  for (const line of rawPlaylist.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      lines.push(line);
      continue;
    }

    if (trimmed.startsWith('#')) {
      if (!trimmed.startsWith('#EXT')) {
        // A plain comment; ffmpeg ignores it, but there is no reason to pass it on.
        continue;
      }
      const tag = trimmed.split(':', 1)[0];
      if (!HLS_ALLOWED_TAGS.has(tag) || /URI\s*=/i.test(trimmed)) {
        throw new HlsPlaylistRejectedError(`Unsupported HLS playlist tag: ${quote(tag)}`);
      }
      lines.push(trimmed);
      continue;
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.includes('\\')) {
      throw new HlsPlaylistRejectedError(`HLS segment must be a relative path: ${quote(trimmed)}`);
    }
    const key = path.posix.normalize(`${prefix}/${trimmed}`);
    if (path.posix.dirname(key) !== prefix) {
      throw new HlsPlaylistRejectedError(`HLS segment resolves outside the playlist directory: ${quote(trimmed)}`);
    }
    const localName = path.posix.basename(key);
    if (!HLS_SEGMENT_NAME.test(localName)) {
      throw new HlsPlaylistRejectedError(`HLS segment must be an MPEG-TS file name: ${quote(trimmed)}`);
    }
    if (seenKeys.has(key)) {
      throw new HlsPlaylistRejectedError(`HLS segment listed more than once: ${quote(trimmed)}`);
    }
    if (segments.length >= HLS_MAX_SEGMENTS) {
      throw new HlsPlaylistRejectedError(`HLS playlist lists more than ${HLS_MAX_SEGMENTS} segments`);
    }
    seenKeys.add(key);
    segments.push({ key, localName });
    lines.push(localName);
  }

  return { playlist: lines.join('\n'), segments };
}

/**
 * Download an HLS media playlist and its segment objects from the videos
 * bucket into a temp directory so ffmpeg can demux the audio track.
 */
async function downloadHlsPlaylistToTempFile(
  bucket: string,
  playlistKey: string
): Promise<{ inputPath: string; tempDir: string }> {
  const tooLarge = () => new HlsPlaylistRejectedError(`HLS playlist is larger than ${HLS_MAX_PLAYLIST_BYTES} bytes`);
  const downloadedPlaylist = await downloadObjectToTempFile(bucket, playlistKey, 'playlist.m3u8', {
    maxBytes: HLS_MAX_PLAYLIST_BYTES
  }).catch((error: unknown) => {
    throw error instanceof ObjectTooLargeError ? tooLarge() : error;
  });

  let rawPlaylist: string;
  try {
    // The download is already bounded; check the file itself before reading it into memory.
    if ((await stat(downloadedPlaylist)).size > HLS_MAX_PLAYLIST_BYTES) {
      throw tooLarge();
    }
    rawPlaylist = await readFile(downloadedPlaylist, 'utf-8');
  } finally {
    await safeUnlink(downloadedPlaylist);
  }

  // Validate before creating anything, so a rejected playlist leaves nothing behind.
  const { playlist, segments } = rewriteHlsPlaylist(rawPlaylist, path.posix.dirname(playlistKey));

  const tempDir = path.join(tmpdir(), 'cio-jobs', 'hls-audio', `${Date.now()}_${process.pid}`);
  await mkdir(tempDir, { recursive: true });

  try {
    let totalBytes = 0;
    for (const segment of segments) {
      const remaining = HLS_MAX_TOTAL_SEGMENT_BYTES - totalBytes;
      if (remaining <= 0) {
        throw new HlsPlaylistRejectedError(`HLS segments total more than ${HLS_MAX_TOTAL_SEGMENT_BYTES} bytes`);
      }
      // Each download stops at the smaller of the per-segment cap and what is left of the budget.
      const maxBytes = Math.min(HLS_MAX_SEGMENT_BYTES, remaining);
      const segmentTooLarge = () =>
        new HlsPlaylistRejectedError(`HLS segment ${quote(segment.localName)} is larger than ${maxBytes} bytes`);
      const downloadedSegment = await downloadObjectToTempFile(bucket, segment.key, segment.localName, {
        maxBytes
      }).catch((error: unknown) => {
        throw error instanceof ObjectTooLargeError ? segmentTooLarge() : error;
      });
      const localPath = path.join(tempDir, segment.localName);
      await rename(downloadedSegment, localPath);
      const { size } = await stat(localPath);
      if (size > maxBytes) {
        throw segmentTooLarge();
      }
      totalBytes += size;
    }
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const inputPath = path.join(tempDir, 'playlist.m3u8');
  await writeFile(inputPath, playlist);

  return { inputPath, tempDir };
}

type HlsAssetMetadata = {
  hlsRenditions?: string[];
};

function readHlsRenditions(metadata: unknown): string[] {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
    return [];
  }

  return (metadata as HlsAssetMetadata).hlsRenditions ?? [];
}

/**
 * Pick the first videos-bucket object that actually exists. HLS assets may
 * store a dedicated audio playlist, a legacy audio.m4a, or only muxed audio
 * inside a video rendition playlist.
 */
async function resolveTranscriptionSource(
  assetId: string,
  payloadStorageKey: string
): Promise<{ key: string; durationSeconds: number | null }> {
  const asset = await getAssetById(assetId);
  if (!asset) {
    throw new Error(`Asset ${assetId} not found`);
  }

  const candidates: string[] = [];
  const push = (key: string | null | undefined) => {
    if (key && !candidates.includes(key)) {
      candidates.push(key);
    }
  };

  push(asset.hlsAudioKey);
  push(payloadStorageKey);
  push(asset.storageKey);

  if (asset.hlsManifestKey) {
    const prefix = `${assetId}/`;
    push(`${prefix}audio/playlist.m3u8`);
    push(`${prefix}audio.m4a`);
    for (const rung of [...readHlsRenditions(asset.metadata)].reverse()) {
      push(`${prefix}${rung}/playlist.m3u8`);
    }
  }

  const bucket = videosBucket();
  for (const key of candidates) {
    if (await objectExists(bucket, key)) {
      log.info('extract-audio-source-resolved', { assetId, key });
      return { key, durationSeconds: asset.durationSeconds ?? null };
    }
  }

  throw new Error(`No transcription source object found for asset ${assetId} (tried ${candidates.join(', ')})`);
}

async function resolveAudioSourcePath(
  bucket: string,
  storageKey: string
): Promise<{ inputPath: string; tempDir?: string }> {
  if (storageKey.endsWith('.m3u8')) {
    return downloadHlsPlaylistToTempFile(bucket, storageKey);
  }

  return {
    inputPath: await downloadObjectToTempFile(bucket, storageKey, 'audio-source.bin')
  };
}

/**
 * Extract a 16 kHz mono MP3 (32 kbps) from the source video for Whisper (25 MB
 * API limit). The transcribe step reads the object from the media bucket.
 */
export async function processExtractAudio(rawData: unknown): Promise<ExtractAudioResult> {
  const payload: TExtractAudioPayload = ZExtractAudioPayload.parse(rawData);
  const { mediaJobId, assetId, storageKey } = payload;

  const existing = await getJobStep(DOMAIN, mediaJobId, STEP_KEY);
  if (existing?.status === 'completed' && existing.result) {
    log.info('extract-audio-skip', { mediaJobId, reason: 'ledger-completed' });
    return existing.result as unknown as ExtractAudioResult;
  }

  await throwIfCancelRequested(mediaJobId);
  await updateMediaJob(mediaJobId, { stage: 'extracting-audio', progressPercent: 70 });
  await upsertJobStep({
    domain: DOMAIN,
    runId: mediaJobId,
    stepKey: STEP_KEY,
    status: 'running',
    startedAt: new Date().toISOString(),
    attempt: (existing?.attempt ?? 0) + 1
  });

  let inputPath: string | undefined;
  let inputTempDir: string | undefined;
  let outputPath: string | undefined;
  try {
    const resolved = await resolveTranscriptionSource(assetId, storageKey);
    const source = await resolveAudioSourcePath(videosBucket(), resolved.key);
    inputPath = source.inputPath;
    inputTempDir = source.tempDir;

    const dir = path.join(tmpdir(), 'cio-jobs', 'audio');
    await mkdir(dir, { recursive: true });
    outputPath = path.join(dir, `${mediaJobId}.mp3`);

    await throwIfCancelRequested(mediaJobId);
    await transcodeToMp3(
      inputPath,
      outputPath,
      durationScaledTimeoutMs(resolved.durationSeconds, TRANSCODE_TIMEOUT_BASE_MS)
    );

    const audioKey = `audio/${assetId}/${mediaJobId}.mp3`;
    await uploadFileToBucket(mediaBucket(), audioKey, outputPath, 'audio/mpeg', 'private, max-age=0');

    const fileStat = await stat(outputPath);
    const result: ExtractAudioResult = { bucket: mediaBucket(), key: audioKey, fileSizeBytes: fileStat.size };

    await upsertJobStep({
      domain: DOMAIN,
      runId: mediaJobId,
      stepKey: STEP_KEY,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      result: result as unknown as Record<string, unknown>
    });

    await updateMediaJob(mediaJobId, { stage: 'audio-ready', progressPercent: 80 });
    log.info('extract-audio-done', { mediaJobId, audioKey });
    return result;
  } catch (error) {
    log.error('extract-audio-failed', { mediaJobId, error: errorMessage(error) });
    await upsertJobStep({
      domain: DOMAIN,
      runId: mediaJobId,
      stepKey: STEP_KEY,
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: { code: 'EXTRACT_AUDIO_FAILED', message: errorMessage(error) }
    });
    throw error;
  } finally {
    if (inputTempDir) {
      await rm(inputTempDir, { recursive: true, force: true }).catch(() => undefined);
    } else {
      await safeUnlink(inputPath);
    }
    await safeUnlink(outputPath);
  }
}
