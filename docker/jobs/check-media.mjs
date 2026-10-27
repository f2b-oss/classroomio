// Runs the media worker's ffmpeg steps against the fixtures, through the
// worker's own wrappers, with the binaries installed in the image.
//
//   node check-media.mjs <path to dist/utils/ffmpeg.js> <fixtures dir>
//
// The thumbnail and extract-audio argv are copied from
// apps/jobs/src/processors/media/{generate-thumbnail,extract-audio}.ts.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, fixtures] = process.argv.slice(2);
const { ffmpegProbeLuma, ffmpegRun, ffprobeJson } = await import(pathToFileURL(path.resolve(modulePath)).href);

const cases = [
  { file: 'h264-aac.mp4', video: 'h264', audio: 'aac' },
  { file: 'vp9-opus.webm', video: 'vp9', audio: 'opus' }
];

const work = await mkdtemp(path.join(tmpdir(), 'check-media-'));
let failures = 0;

async function step(name, fn) {
  try {
    const detail = await fn();
    console.log(`ok   ${name}${detail ? ` (${detail})` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function nonEmpty(file) {
  const { size } = await stat(file);
  if (size === 0) throw new Error(`${file} is empty`);
  return size;
}

for (const { file, video, audio } of cases) {
  const input = path.join(fixtures, file);

  await step(`probe ${file}`, async () => {
    const probe = await ffprobeJson(input);
    const codecs = probe.streams.map((s) => s.codec_name);
    if (!codecs.includes(video) || !codecs.includes(audio)) throw new Error(`streams were ${codecs.join(',')}`);
    if (!(Number(probe.format.duration) > 0)) throw new Error(`duration was ${probe.format.duration}`);
    return `${codecs.join('+')}, ${Number(probe.format.duration).toFixed(1)}s`;
  });

  await step(`thumbnail ${file}`, async () => {
    const jpg = path.join(work, `${file}.jpg`);
    await ffmpegRun([
      '-y',
      '-i',
      input,
      '-ss',
      '1.5',
      '-vframes',
      '1',
      '-vf',
      "scale='min(1280,iw)':-2",
      '-q:v',
      '2',
      jpg
    ]);
    const size = await nonEmpty(jpg);
    const luma = await ffmpegProbeLuma(jpg);
    if (!(luma > 8)) throw new Error(`mean luma ${luma} reads as a black frame`);
    return `${size} bytes, luma ${luma.toFixed(1)}`;
  });

  await step(`extract-audio ${file}`, async () => {
    const mp3 = path.join(work, `${file}.mp3`);
    await ffmpegRun([
      '-y',
      '-i',
      input,
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
      mp3
    ]);
    return `${await nonEmpty(mp3)} bytes`;
  });
}

await step('extract-audio hls/playlist.m3u8', async () => {
  const mp3 = path.join(work, 'hls.mp3');
  const playlist = path.join(fixtures, 'hls', 'playlist.m3u8');
  await ffmpegRun([
    '-y',
    '-i',
    playlist,
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
    mp3
  ]);
  return `${await nonEmpty(mp3)} bytes`;
});

await step('does not fetch a remote segment named by a playlist', async () => {
  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const playlist = path.join(work, 'remote.m3u8');
  await writeFile(
    playlist,
    `#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nhttp://127.0.0.1:${port}/seg-00001.ts\n#EXT-X-ENDLIST\n`
  );
  await ffmpegRun(['-y', '-i', playlist, '-vn', '-f', 'mp3', path.join(work, 'remote.mp3')]).catch(() => undefined);
  server.close();

  if (connections > 0) throw new Error(`ffmpeg opened ${connections} connection(s) to the segment URL`);
  return 'no connection made';
});

await rm(work, { recursive: true, force: true });

if (failures > 0) {
  console.log(`${failures} media check(s) failed`);
  process.exit(1);
}
