import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getAssetById: vi.fn(),
  generateUploadPresignedUrl: vi.fn()
}));

vi.mock('@cio/db/queries/assets', () => ({
  getAssetById: mocks.getAssetById
}));

vi.mock('@cio/jobs', () => ({
  enqueueAssetStorageCleanup: vi.fn(),
  isRedisConfigured: () => false
}));

vi.mock('@cio/core/services/jobs/media-jobs', () => ({
  startMediaJob: vi.fn(),
  startTranscriptionOnlyMediaJob: vi.fn(),
  startYoutubeCaptionsJob: vi.fn()
}));

vi.mock('@cio/core/utils/s3', () => ({
  generateUploadPresignedUrl: mocks.generateUploadPresignedUrl
}));

vi.mock('@cio/core/config/storage', () => ({
  getS3Client: vi.fn(),
  getStorageConfig: () => ({ bucketVideos: 'videos' })
}));

import { batchPresignHls1080Service, batchPresignHlsService } from '@cio/core/services/assets/assets';
import { ZBatchPresignHls, type TBatchPresignHls } from '@cio/utils/validation/assets';

const ORG_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const ASSET_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

const signedTypes = () =>
  Object.fromEntries(mocks.generateUploadPresignedUrl.mock.calls.map(([key, , type]) => [key, type]));

describe('HLS batch presign content types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generateUploadPresignedUrl.mockResolvedValue('https://storage.example.com/signed');
  });

  describe.each([
    ['default', 'processing', (data: TBatchPresignHls) => batchPresignHlsService(ORG_ID, ASSET_ID, data)],
    ['1080p', 'active', (data: TBatchPresignHls) => batchPresignHls1080Service(ORG_ID, ASSET_ID, data)]
  ])('%s path', (_name, status, presign) => {
    beforeEach(() => {
      mocks.getAssetById.mockResolvedValue({
        id: ASSET_ID,
        status,
        kind: 'video',
        provider: 'upload',
        hlsManifestKey: `${ASSET_ID}/master.m3u8`,
        hls1080Status: 'none',
        metadata: { hlsRenditions: ['p720'], sourceWidth: 1920, sourceHeight: 1080 }
      });
    });

    it('signs the type for each extension from the server map', async () => {
      await presign({ paths: ['master.m3u8', 'p1080/playlist.m3u8', 'p1080/seg-00001.ts'] });

      expect(signedTypes()).toEqual({
        [`${ASSET_ID}/master.m3u8`]: 'application/vnd.apple.mpegurl',
        [`${ASSET_ID}/p1080/playlist.m3u8`]: 'application/vnd.apple.mpegurl',
        [`${ASSET_ID}/p1080/seg-00001.ts`]: 'video/mp2t'
      });
    });

    it('ignores a caller-supplied content type', async () => {
      const body = ZBatchPresignHls.parse({
        paths: ['master.m3u8'],
        contentTypeByExtension: { '.m3u8': 'text/html' }
      });
      await presign(body);

      expect(signedTypes()).toEqual({ [`${ASSET_ID}/master.m3u8`]: 'application/vnd.apple.mpegurl' });
    });

    it.each([['p1080/seg.html'], ['p1080/noext'], ['p1080.d/seg']])('refuses %s and signs nothing', async (bad) => {
      await expect(presign({ paths: ['master.m3u8', bad] })).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.generateUploadPresignedUrl).not.toHaveBeenCalled();
    });
  });
});
