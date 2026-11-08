// ABOUTME: 测试用假 Host ASR 与假 PCM 源：每个识别会话返回一句覆盖整段的结果，可按会话序号注入失败。

import type { HostClient } from '../../sdk/host.mjs';
import { PCM_FRAME_BYTES } from '../../src/server/media.ts';

export interface FakeAsr {
  host: HostClient;
  /** 每个会话收到的帧数，按会话开启顺序。 */
  framesPerSession: number[];
  /** host.asr.start 被调用的次数（含失败）。 */
  starts: number;
}

export interface FakeAsrOptions {
  /** 第 n 个会话（从 1 开始）发送音频时抛不可续传的错误。 */
  failSession?: number;
  /** 前 n 次 start 以会话已满拒绝。 */
  busyStarts?: number;
}

export function fakeAsr(options: FakeAsrOptions = {}): FakeAsr {
  const streams = new Map<string, { index: number; frames: number; stopped: PromiseWithResolvers<void> }>();
  const state: FakeAsr = { host: undefined as unknown as HostClient, framesPerSession: [], starts: 0 };
  const stream = (streamId: string) => {
    const found = streams.get(streamId);
    if (!found) throw Object.assign(new Error('no stream'), { code: 'SESSION_NOT_FOUND' });
    return found;
  };
  const asr = {
    start: async () => {
      state.starts += 1;
      if (state.starts <= (options.busyStarts ?? 0)) {
        throw Object.assign(new Error('too many active sessions'), { code: 'ASR_SESSION_HISTORY_LIMIT', execution: 'not-executed' });
      }
      const index = state.framesPerSession.length;
      state.framesPerSession.push(0);
      const streamId = `s${index + 1}`;
      streams.set(streamId, { index, frames: 0, stopped: Promise.withResolvers<void>() });
      return { streamId };
    },
    sendFrame: async ({ streamId, sequence }: { streamId: string; sequence: number }) => {
      const current = stream(streamId);
      if (options.failSession === current.index + 1) {
        throw Object.assign(new Error('route invalid'), { code: 'ASR_ROUTE_INVALID', execution: 'executed' });
      }
      current.frames += 1;
      state.framesPerSession[current.index] = current.frames;
      return { nextSequence: sequence + 1 };
    },
    async *events({ streamId }: { streamId: string }) {
      const current = stream(streamId);
      await current.stopped.promise;
      if (current.frames > 0) {
        yield {
          type: 'event' as const,
          cursor: 1,
          event: { type: 'final' as const, utterances: [{ text: `[${streamId}]`, startTimeMs: 0, endTimeMs: current.frames * 2000 }] },
        };
      }
      yield { type: 'done' as const, requestId: 'fake' };
    },
    stop: async ({ streamId }: { streamId: string }) => {
      stream(streamId).stopped.resolve();
      return { streamId, status: 'completed', text: '', errorCode: null, nextSequence: 0 };
    },
    cancel: async ({ streamId }: { streamId: string }) => {
      streams.get(streamId)?.stopped.resolve();
      return { streamId, status: 'cancelled', text: '', errorCode: null, nextSequence: 0 };
    },
  };
  state.host = { asr } as unknown as HostClient;
  return state;
}

/** 生成 frames 帧（每帧 2 秒）静音 PCM 的假解码器，签名与 decodePcmFrames 一致。 */
export function fakePcm(frames: number) {
  return async function* decode(): AsyncGenerator<Buffer, null, void> {
    const frame = Buffer.alloc(PCM_FRAME_BYTES);
    for (let index = 0; index < frames; index += 1) yield frame;
    return null;
  };
}
