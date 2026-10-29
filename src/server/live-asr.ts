// ABOUTME: 实时字幕的识别推流层——按需开会话、断线自动重建。

import type { WorkbenchServer } from '../../sdk/runtime.mjs';

/** 推流所需的最小状态，由 live.ts 的会话对象满足。 */
export interface AsrBridgeState {
  app: { host: { asr: Pick<WorkbenchServer['host']['asr'], 'start' | 'sendFrame' | 'events' | 'stop'> } };
  streamId: string | null;
  seq: number;
  queue: Array<Buffer<ArrayBufferLike>>;
  pumping: Promise<void> | null;
  eventsDone: Promise<void> | null;
  restarts: number;
  pcmBytes: number;
  message: string | null;
  partial: string;
  finals: string[];
}

function isSessionGone(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  return /ASR_SESSION_NOT_RUNNING|ASR_EVENT_CURSOR_EXPIRED|SESSION_NOT_FOUND/i.test(`${code} ${message}`);
}

function consumeEvents(rt: AsrBridgeState, streamId: string): Promise<void> {
  const firstFinal = rt.finals.length;
  return (async () => {
    try {
      for await (const event of rt.app.host.asr.events({ streamId, afterSequence: 0 })) {
        if (rt.streamId !== streamId) break;
        if (event.type === 'done') break;
        if (event.type === 'result') {
          const status = event.session.status;
          if (event.session.errorCode) rt.message = event.session.errorCode;
          if (status === 'cancelled' || status === 'failed' || status === 'completed') {
            const text = event.session.text.trim();
            if (text && rt.finals.length === firstFinal) rt.finals.push(text);
            rt.streamId = null;
            rt.seq = 0;
          }
          continue;
        }
        const progress = event.event;
        if (progress.type === 'error') {
          rt.message = progress.errorCode
            ? `识别服务异常（${progress.errorCode}），正在重连…`
            : '识别服务异常，正在重连…';
          rt.streamId = null;
          rt.seq = 0;
          continue;
        }
        if (progress.type === 'partial' && progress.text) rt.partial = progress.text;
        if (progress.type === 'final') {
          const text = (progress.utterances ?? [])
            .map((utterance) => utterance.text)
            .join('')
            .trim() || (progress.text ?? '').trim();
          if (text) rt.finals.push(text);
          rt.partial = '';
        }
      }
    } catch {
      /* 事件流中断不影响收尾 */
    }
  })();
}

/**
 * 识别会话按需开启：只有真正收到音频时才建立，
 * 避免连接/等待阶段会话空转到 60 秒被服务端回收（ASR_SESSION_NOT_RUNNING）。
 */
async function ensureStream(rt: AsrBridgeState): Promise<boolean> {
  if (rt.streamId) return true;
  try {
    const started = await rt.app.host.asr.start({ sampleRate: 16000, format: 'pcm' });
    rt.streamId = started.streamId;
    rt.seq = 0;
    if (rt.message && /识别会话|ASR_SESSION/.test(rt.message)) rt.message = null;
    rt.eventsDone = consumeEvents(rt, started.streamId);
    return true;
  } catch (error) {
    rt.message = `识别服务启动失败：${error instanceof Error ? error.message : '未知错误'}`;
    return false;
  }
}

export function pumpFrames(rt: AsrBridgeState): Promise<void> {
  if (rt.pumping) return rt.pumping;
  rt.pumping = drainFrames(rt).finally(() => {
    rt.pumping = null;
  });
  return rt.pumping;
}

async function drainFrames(rt: AsrBridgeState): Promise<void> {
  while (rt.queue.length > 0) {
    if (!(await ensureStream(rt))) break;
    const streamId = rt.streamId;
    const chunk = rt.queue[0];
    if (!streamId || !chunk) break;
    try {
      const sent = await rt.app.host.asr.sendFrame({
        streamId,
        sequence: rt.seq,
        pcmBase64: chunk.toString('base64'),
      });
      rt.seq = sent.nextSequence;
      rt.pcmBytes += chunk.length;
      rt.queue.shift();
      rt.restarts = 0;
      if (rt.message && rt.message.includes('识别')) rt.message = null;
    } catch (error) {
      rt.queue.shift();
      if (!isSessionGone(error)) {
        rt.message = error instanceof Error ? error.message : '识别推流中断';
        continue;
      }
      // 会话被回收/上游异常：丢掉旧 streamId，下一帧自动重建。
      rt.streamId = null;
      rt.seq = 0;
      rt.restarts += 1;
      if (rt.restarts > 4) {
        rt.message = '识别服务连续失败，请点「停止并归档」后重新开始';
        break;
      }
      rt.message = '识别会话已重置，正在自动重连…';
    }
  }
}

/** 等待最后一帧和收尾事件，再读取最终字幕。 */
export async function finishLiveAsr(rt: AsrBridgeState): Promise<string> {
  await pumpFrames(rt);
  let fallback = '';
  if (rt.streamId) {
    try {
      const final = await rt.app.host.asr.stop({ streamId: rt.streamId });
      fallback = final.text.trim();
      if (final.errorCode) rt.message = final.errorCode;
    } catch (error) {
      rt.message = `识别收尾失败：${error instanceof Error ? error.message : '未知错误'}`;
    }
  }
  if (rt.eventsDone) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        rt.eventsDone,
        new Promise<void>(resolve => {
          timer = setTimeout(resolve, 20000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return rt.finals.join('\n').trim() || fallback || rt.partial.trim();
}
