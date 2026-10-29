import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { createPcmFramer, LIVE_DECODER_ARGS } from '../src/server/live-audio.ts';

test('PCM framing preserves the final subsecond audio', async () => {
  const framer = createPcmFramer();
  const frames: Buffer[] = [];
  framer.on('data', (frame: Buffer) => frames.push(frame));
  const ended = once(framer, 'end');
  const audio = Buffer.alloc(35000, 7);
  framer.write(audio.subarray(0, 500));
  framer.write(audio.subarray(500, 33000));
  framer.end(audio.subarray(33000));
  await ended;
  assert.deepEqual(frames.map(frame => frame.length), [32000, 3000]);
  assert.deepEqual(Buffer.concat(frames), audio);
});

const ffmpeg = process.env.FFMPEG_TEST_COMMAND ?? 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0;

test('live decoder emits PCM before the MP3 input closes', { skip: !available && 'ffmpeg is not available' }, async () => {
  const generated = spawnSync(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000:duration=3',
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '32k',
    '-write_xing', '0', '-id3v2_version', '0', '-f', 'mp3', 'pipe:1',
  ], { windowsHide: true });
  assert.equal(generated.status, 0, generated.stderr.toString());
  const child = spawn(ffmpeg, LIVE_DECODER_ARGS, { windowsHide: true });
  const output: Buffer[] = [];
  let errors = '';
  child.stdout.on('data', (chunk: Buffer) => { output.push(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
  const closed = once(child, 'close');
  const firstOutput = once(child.stdout, 'data');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child.stdin.write(generated.stdout.subarray(0, 8000));
    await Promise.race([
      firstOutput,
      new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); }),
    ]);
    assert.ok(output.length > 0, 'the decoder buffered two seconds of audio without emitting PCM');
  } finally {
    clearTimeout(timer);
    child.stdin.end(generated.stdout.subarray(8000));
    await closed;
  }
  assert.equal(child.exitCode, 0, errors);
  const reference = spawnSync(ffmpeg, [
    '-v', 'error', '-f', 'mp3', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1',
  ], { input: generated.stdout, windowsHide: true });
  assert.equal(reference.status, 0, reference.stderr.toString());
  assert.deepEqual(Buffer.concat(output), reference.stdout, 'low latency must not discard or change audio');
});
