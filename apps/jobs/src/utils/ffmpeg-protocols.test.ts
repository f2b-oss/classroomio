import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFile = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({ execFile }));

import { ffmpegProbeLuma, ffmpegRun, ffprobeJson } from './ffmpeg';

type Callback = (error: Error | null, result: { stdout: string; stderr: string }) => void;

function lastArgv(): string[] {
  return execFile.mock.calls.at(-1)?.[1] as string[];
}

function expectFileOnly(argv: string[]) {
  expect(argv.slice(0, 2)).toEqual(['-protocol_whitelist', 'file']);
}

describe('ffmpeg argv', () => {
  beforeEach(() => {
    execFile.mockReset();
    execFile.mockImplementation((_bin: string, _args: string[], _opts: unknown, callback: Callback) => {
      callback(null, { stdout: '{"streams":[],"format":{}}', stderr: 'lavfi.signalstats.YAVG=10' });
    });
  });

  it('limits ffprobe to local files', async () => {
    await ffprobeJson('/tmp/upload.bin');

    expectFileOnly(lastArgv());
    expect(lastArgv().at(-1)).toBe('/tmp/upload.bin');
  });

  it('limits every ffmpeg run to local files', async () => {
    await ffmpegRun(['-y', '-i', '/tmp/upload.bin', '-vn', '/tmp/out.mp3']);

    expectFileOnly(lastArgv());
    expect(lastArgv().slice(2)).toEqual(['-y', '-i', '/tmp/upload.bin', '-vn', '/tmp/out.mp3']);
  });

  it('limits the luma probe to local files', async () => {
    await ffmpegProbeLuma('/tmp/frame.jpg');

    expectFileOnly(lastArgv());
  });
});
