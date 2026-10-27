import { existsSync } from 'node:fs';
import { readdir, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  response: {} as { ContentLength?: number; Body?: Readable }
}));

vi.mock('../config/storage', () => ({
  getS3Client: () => ({ send: async () => mocks.response }),
  getStorageConfig: () => ({ bucketVideos: 'videos', bucketMedia: 'media' })
}));

import { ObjectTooLargeError, downloadObjectToTempFile } from './storage';

const NAME = `storage-test-${process.pid}.bin`;

async function leftovers(): Promise<string[]> {
  const dir = path.join(tmpdir(), 'cio-jobs');
  return existsSync(dir) ? (await readdir(dir)).filter((file) => file.endsWith(NAME)) : [];
}

function body(bytes: number): Readable {
  return Readable.from(Array.from({ length: Math.ceil(bytes / 1024) }, () => Buffer.alloc(1024)));
}

describe('downloadObjectToTempFile maxBytes', () => {
  beforeEach(() => {
    mocks.response = {};
  });

  it('downloads an object within the limit', async () => {
    mocks.response = { ContentLength: 4096, Body: body(4096) };

    const file = await downloadObjectToTempFile('videos', 'k', NAME, { maxBytes: 4096 });
    expect(existsSync(file)).toBe(true);
    await unlink(file);
  });

  it('refuses an object whose reported length is over the limit without reading it', async () => {
    const stream = body(8192);
    mocks.response = { ContentLength: 8192, Body: stream };

    await expect(downloadObjectToTempFile('videos', 'k', NAME, { maxBytes: 4096 })).rejects.toBeInstanceOf(
      ObjectTooLargeError
    );
    expect(stream.destroyed).toBe(true);
    expect(await leftovers()).toHaveLength(0);
  });

  it('stops a stream that passes the limit and removes the partial file', async () => {
    mocks.response = { Body: body(64 * 1024) };

    await expect(downloadObjectToTempFile('videos', 'k', NAME, { maxBytes: 4096 })).rejects.toBeInstanceOf(
      ObjectTooLargeError
    );
    expect(await leftovers()).toHaveLength(0);
  });
});
