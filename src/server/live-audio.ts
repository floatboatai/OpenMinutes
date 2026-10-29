// ABOUTME: 实时 MP3 解码参数与按秒分帧的 PCM 流。

import { Transform } from 'node:stream';

export const LIVE_DECODER_ARGS = [
  '-v', 'error', '-probesize', '32', '-analyzeduration', '0',
  '-f', 'mp3', '-i', 'pipe:0',
  '-f', 's16le', '-ac', '1', '-ar', '16000', '-flush_packets', '1', 'pipe:1',
];

export function createPcmFramer(): Transform {
  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= 32000) {
        this.push(pending.subarray(0, 32000));
        pending = pending.subarray(32000);
      }
      callback();
    },
    flush(callback) {
      if (pending.length > 0) this.push(pending);
      pending = Buffer.alloc(0);
      callback();
    },
  });
}
