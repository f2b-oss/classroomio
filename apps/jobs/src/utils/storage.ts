import { GetObjectCommand, HeadObjectCommand, NotFound, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable, Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

import { getS3Client, getStorageConfig } from '../config/storage';

/**
 * Streams an S3 object to a temp file on disk and returns the absolute path.
 * Workers prefer disk over buffers so ffmpeg can seek without holding the
 * whole video in RAM.
 */
export async function objectExists(bucket: string, key: string): Promise<boolean> {
  try {
    await getS3Client().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (error) {
    if (error instanceof NotFound || (error as { name?: string }).name === 'NotFound') {
      return false;
    }

    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) {
      return false;
    }

    throw error;
  }
}

/** The object is larger than the caller allows. Raised before or while downloading it. */
export class ObjectTooLargeError extends Error {
  constructor(
    readonly bucket: string,
    readonly key: string,
    readonly maxBytes: number
  ) {
    super(`S3 object ${bucket}/${key} is larger than ${maxBytes} bytes`);
    this.name = 'ObjectTooLargeError';
  }
}

/** Passes chunks through until more than `maxBytes` have gone by, then fails the stream. */
function byteLimit(maxBytes: number, onExceeded: () => Error): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      callback(seen > maxBytes ? onExceeded() : null, chunk);
    }
  });
}

/**
 * With `maxBytes`, an object larger than that fails with `ObjectTooLargeError`:
 * up front when S3 reports its length, otherwise as soon as the stream passes
 * the limit. The partial file is removed.
 */
export async function downloadObjectToTempFile(
  bucket: string,
  key: string,
  fileNameHint?: string,
  options: { maxBytes?: number } = {}
): Promise<string> {
  const dir = path.join(tmpdir(), 'cio-jobs');
  await mkdir(dir, { recursive: true });

  const safeName = fileNameHint?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? 'media';
  const localPath = path.join(dir, `${Date.now()}_${process.pid}_${safeName}`);

  const { maxBytes } = options;
  const response = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (maxBytes !== undefined && (response.ContentLength ?? 0) > maxBytes) {
    (response.Body as Readable | undefined)?.destroy();
    throw new ObjectTooLargeError(bucket, key, maxBytes);
  }
  if (!response.Body) {
    throw new Error(`S3 object ${bucket}/${key} returned no body`);
  }

  const body = response.Body as Readable;
  try {
    if (maxBytes === undefined) {
      await pipeline(body, createWriteStream(localPath));
    } else {
      const limit = byteLimit(maxBytes, () => new ObjectTooLargeError(bucket, key, maxBytes));
      await pipeline(body, limit, createWriteStream(localPath));
    }
  } catch (error) {
    await safeUnlink(localPath);
    throw error;
  }

  return localPath;
}

export async function uploadFileToBucket(
  bucket: string,
  key: string,
  localPath: string,
  contentType: string,
  cacheControl?: string
): Promise<void> {
  const buffer = await readFile(localPath);
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: cacheControl
    })
  );
}

export async function uploadBufferToBucket(
  bucket: string,
  key: string,
  buffer: Buffer,
  contentType: string,
  cacheControl?: string
): Promise<void> {
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: cacheControl
    })
  );
}

export async function safeUnlink(filePath: string | undefined | null): Promise<void> {
  if (!filePath) return;

  try {
    await unlink(filePath);
  } catch {
    // best-effort cleanup
  }
}

export function videosBucket(): string {
  return getStorageConfig().bucketVideos;
}

export function mediaBucket(): string {
  return getStorageConfig().bucketMedia;
}
