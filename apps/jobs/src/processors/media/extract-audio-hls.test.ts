import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  playlist: '',
  downloads: [] as string[],
  ffmpegRun: vi.fn(),
  readFile: vi.fn()
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  mocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: mocks.readFile };
});

vi.mock('@cio/db/queries', () => ({
  getAssetById: vi.fn(async (id: string) => ({ id, hlsAudioKey: `${id}/audio/playlist.m3u8`, durationSeconds: 60 })),
  getJobStep: vi.fn(async () => null),
  updateMediaJob: vi.fn(async () => undefined),
  upsertJobStep: vi.fn(async () => undefined)
}));

vi.mock('@cio/jobs/payloads/media', () => ({
  ZExtractAudioPayload: { parse: (data: unknown) => data }
}));

vi.mock('../../utils/cancel', () => ({
  throwIfCancelRequested: vi.fn(async () => undefined),
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error))
}));

vi.mock('../../utils/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

vi.mock('../../utils/storage', () => ({
  ObjectTooLargeError: class ObjectTooLargeError extends Error {},
  videosBucket: () => 'videos',
  mediaBucket: () => 'media',
  objectExists: vi.fn(async () => true),
  safeUnlink: vi.fn(async () => undefined),
  uploadFileToBucket: vi.fn(async () => undefined),
  downloadObjectToTempFile: vi.fn(async (_bucket: string, key: string, name: string) => {
    mocks.downloads.push(key);
    const file = path.join(tmpdir(), `extract-audio-hls-test-${process.pid}-${mocks.downloads.length}-${name}`);
    await writeFile(file, key.endsWith('.m3u8') ? mocks.playlist : 'segment');
    return file;
  })
}));

vi.mock('../../utils/ffmpeg', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/ffmpeg')>()),
  ffmpegRun: mocks.ffmpegRun
}));

import { UnrecoverableError } from 'bullmq';

import { HLS_MAX_PLAYLIST_BYTES, HLS_MAX_SEGMENTS, processExtractAudio } from './extract-audio';

const ASSET_ID = '11111111-1111-4111-8111-111111111111';
const payload = {
  mediaJobId: '22222222-2222-4222-8222-222222222222',
  assetId: ASSET_ID,
  storageKey: `${ASSET_ID}/audio/playlist.m3u8`,
  actorContext: { organizationId: 'org' }
};

function playlist(...body: string[]): string {
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6', ...body, '#EXT-X-ENDLIST', ''].join('\n');
}

describe('extract-audio HLS playlist handling', () => {
  beforeEach(() => {
    mocks.downloads.length = 0;
    mocks.ffmpegRun.mockReset();
    mocks.readFile.mockClear();
    mocks.ffmpegRun.mockImplementation(async (args: string[]) => {
      await writeFile(args.at(-1) as string, 'mp3');
    });
  });

  it('accepts the playlists our encoders write', async () => {
    mocks.playlist = playlist(
      '#EXT-X-INDEPENDENT-SEGMENTS',
      '#EXTINF:6.0,',
      'seg-00001.ts',
      '#EXTINF:2.5,',
      'seg-00002.ts'
    );

    await processExtractAudio(payload);

    expect(mocks.downloads.slice(1)).toEqual([`${ASSET_ID}/audio/seg-00001.ts`, `${ASSET_ID}/audio/seg-00002.ts`]);
    expect(mocks.ffmpegRun).toHaveBeenCalledTimes(1);
  });

  it('rejects an EXT-X-MAP that points at a local file', async () => {
    mocks.playlist = playlist('#EXT-X-MAP:URI="/etc/hostname"', '#EXTINF:6.0,', 'seg-00001.ts');

    await expect(processExtractAudio(payload)).rejects.toThrow(/EXT-X-MAP/);
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();
  });

  it.each([
    '../other-asset/x.ts',
    `../../${'33333333-3333-4333-8333-333333333333'}/audio/seg-00001.ts`,
    'sub/x.ts',
    '/etc/hostname',
    'file:///etc/hostname'
  ])('rejects a segment outside the playlist directory (%s)', async (segment) => {
    mocks.playlist = playlist('#EXTINF:6.0,', segment);

    await expect(processExtractAudio(payload)).rejects.toThrow(/HLS segment/);
    expect(mocks.downloads).toHaveLength(1);
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();
  });

  it('rejects any other tag that carries a URI', async () => {
    mocks.playlist = playlist('#EXT-X-KEY:METHOD=AES-128,URI="/etc/hostname"', '#EXTINF:6.0,', 'seg-00001.ts');

    await expect(processExtractAudio(payload)).rejects.toThrow(/EXT-X-KEY/);
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();
  });

  it.each(['playlist.m3u8', 'x.mp4', 'seg-00001.ts.m3u8', 'seg-00001'])(
    'rejects a segment that is not an MPEG-TS file name (%s)',
    async (segment) => {
      mocks.playlist = playlist('#EXTINF:6.0,', segment);

      await expect(processExtractAudio(payload)).rejects.toThrow(/HLS segment must be an MPEG-TS file name/);
      expect(mocks.downloads).toHaveLength(1);
      expect(mocks.ffmpegRun).not.toHaveBeenCalled();
    }
  );

  it('rejects a playlist that lists a segment twice', async () => {
    mocks.playlist = playlist(...Array.from({ length: 3 }, () => ['#EXTINF:6.0,', 'seg-00001.ts']).flat());

    await expect(processExtractAudio(payload)).rejects.toThrow(/listed more than once/);
    expect(mocks.downloads).toHaveLength(1);
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();
  });

  it('rejects the same segment spelled two ways', async () => {
    mocks.playlist = playlist('#EXTINF:6.0,', 'seg-00001.ts', '#EXTINF:6.0,', './seg-00001.ts');

    await expect(processExtractAudio(payload)).rejects.toThrow(/listed more than once/);
    expect(mocks.downloads).toHaveLength(1);
  });

  it('accepts a playlist at the segment cap and rejects one segment over it', async () => {
    const segmentLines = (count: number) =>
      Array.from({ length: count }, (_, i) => ['#EXTINF:6.0,', `seg-${String(i + 1).padStart(5, '0')}.ts`]).flat();

    mocks.playlist = playlist(...segmentLines(HLS_MAX_SEGMENTS + 1));
    await expect(processExtractAudio(payload)).rejects.toThrow(`more than ${HLS_MAX_SEGMENTS} segments`);
    expect(mocks.downloads).toHaveLength(1);
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();

    mocks.downloads.length = 0;
    mocks.playlist = playlist(...segmentLines(HLS_MAX_SEGMENTS));
    await processExtractAudio(payload);
    expect(mocks.downloads).toHaveLength(HLS_MAX_SEGMENTS + 1);
  }, 60_000);

  it('fails a rejected playlist without retries', async () => {
    mocks.playlist = playlist('#EXTINF:6.0,', 'playlist.m3u8');

    const error = await processExtractAudio(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).name).toBe('UnrecoverableError');
  });

  it('gives the transcode a budget scaled to the asset duration', async () => {
    mocks.playlist = playlist('#EXTINF:6.0,', 'seg-00001.ts');

    await processExtractAudio(payload);

    expect(mocks.ffmpegRun.mock.calls[0]?.[1]).toBe(90_000);
  });

  it('rejects a playlist over the size cap without reading it', async () => {
    // Valid apart from its size: padded with comments, which the rewrite drops.
    const padding = `# ${'x'.repeat(1022)}`;
    mocks.playlist = playlist(
      '#EXTINF:6.0,',
      'seg-00001.ts',
      ...Array.from({ length: HLS_MAX_PLAYLIST_BYTES / 1024 + 1 }, () => padding)
    );

    await expect(processExtractAudio(payload)).rejects.toThrow(
      `HLS playlist is larger than ${HLS_MAX_PLAYLIST_BYTES} bytes`
    );
    expect(mocks.downloads).toEqual([payload.storageKey]);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();
  });

  it('turns an over-cap download into a rejected playlist', async () => {
    const storage = await import('../../utils/storage');
    vi.mocked(storage.downloadObjectToTempFile).mockRejectedValueOnce(new storage.ObjectTooLargeError('too large'));

    const error = await processExtractAudio(payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toBe(`HLS playlist is larger than ${HLS_MAX_PLAYLIST_BYTES} bytes`);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.ffmpegRun).not.toHaveBeenCalled();
  });

  it.each([
    ['segment', (long: string) => `${long}.mp4`],
    ['tag', (long: string) => `#EXT-X-${long}`]
  ])('bounds and escapes the rejected %s it quotes', async (_kind, line) => {
    const long = `"\u001b[31m${'a'.repeat(10_000)}`;
    mocks.playlist = playlist('#EXTINF:6.0,', line(long));

    const error = (await processExtractAudio(payload).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(error.message.length).toBeLessThan(200);
    expect(error.message).not.toMatch(/[\u0000-\u001f]/);
    expect(error.message).toContain('\\"');
  });
});
