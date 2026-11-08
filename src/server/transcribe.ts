// ABOUTME: 把本地音频文件转成文本：ffmpeg 解码 PCM16，按 5 分钟分块送 Host ASR，上游中途失败时从最后确认的句子续传；每块完成即落检查点，重试时跳过已完成块。

import type { HostClient } from '../../sdk/host.mjs';
import type { AsrStartInput } from '../../sdk/asr-contracts.mjs';
import type { TranscriptSegment } from '../contracts/app';
import { decodePcmFrames, PCM_BYTES_PER_SECOND } from './media';

export interface TranscribeProgress {
  audioSentSec: number;
  /** 从断点直接复用、没有再送识别的秒数。 */
  resumedSec: number;
  segments: number;
  sessions: number;
  reconnects: number;
}

/** 一块已识别完成的音频；时间戳已按整段偏移校正。 */
export interface ChunkCheckpoint {
  index: number;
  offsetMs: number;
  endMs: number;
  segments: TranscriptSegment[];
}

/** 断点存储：completed 为上次已完成的块；每识别完一块调用 save。 */
export interface CheckpointSink {
  completed: ReadonlyMap<number, ChunkCheckpoint>;
  save: (chunk: ChunkCheckpoint) => void;
}

export interface TranscribeOptions {
  filePath: string;
  ffmpegPath: string;
  diarization: boolean;
  hotwords: string[];
  language?: string;
  checkpoint?: CheckpointSink;
  /** 默认用 ffmpeg 解码；测试可换成假 PCM 源。 */
  decode?: typeof decodePcmFrames;
  onProgress?: (progress: TranscribeProgress) => void;
}

/** 单次转录的诊断轨迹：写入 job_runs.detail_json，失败时用于定位。 */
export interface TranscribeTrace {
  startedAt: number;
  events: Array<Record<string, unknown>>;
}

export interface TranscribeOutcome {
  text: string;
  segments: TranscriptSegment[];
  audioMs: number;
  engine: string;
  trace: TranscribeTrace;
}

export class TranscribeError extends Error {
  readonly code: string;
  readonly trace?: TranscribeTrace;
  constructor(code: string, message: string, trace?: TranscribeTrace) {
    super(message);
    this.name = 'TranscribeError';
    this.code = code;
    this.trace = trace;
  }
}

/** 单个识别会话承载的音频秒数；实测上游长会话会中途 ASR_UPSTREAM_FAILED，分块后失败只影响一块。 */
export const CHUNK_AUDIO_SEC = 300;
/** 单次转录送识别的耗时上限；从断点复用的块不计入。 */
const MAX_ASR_MS = 60 * 60 * 1000;
/** 每块最多尝试次数（首发 + 续传）。 */
const MAX_CHUNK_ATTEMPTS = 4;
/** 整次转录累计续传上限，超过视为上游不可用。 */
const MAX_TOTAL_RECONNECTS = 16;

function note(trace: TranscribeTrace, stage: string, fields: Record<string, unknown> = {}): void {
  const entry = { t: Date.now() - trace.startedAt, stage, ...fields };
  if (trace.events.length < 300) trace.events.push(entry);
  console.log(`[transcribe] ${JSON.stringify(entry)}`);
}

function errorDetail(error: unknown): Record<string, unknown> {
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    return { code: record.code, message: record.message, requestId: record.requestId, execution: record.execution };
  }
  return { message: String(error) };
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return '';
}

/**
 * Host 同时活动的识别会话已满（Host 以 429 拒绝，例如超过 8 个活动会话或会话历史过多）。
 * Host 客户端不保留 HTTP 状态，只能按错误码判断；这类错误应排队重试，而不是把录音标失败。
 */
export function isCapacityError(error: unknown): boolean {
  const code = errorCode(error);
  if (/AUDIO_STORAGE/i.test(code)) return false;
  return /SESSION_HISTORY_LIMIT|SESSIONS?_LIMIT|ACTIVE_[A-Z_]*LIMIT|LIMIT_EXCEEDED|CONCURREN|TOO_MANY|RATE_LIMIT|CAPACITY/i.test(code);
}

/** 会话已被上游终止，可以开新会话续传（而不是参数或权限类的硬错误）。 */
function isRecoverableSendError(error: unknown): boolean {
  return /ASR_SESSION_NOT_RUNNING|ASR_AUDIO_SEND_FAILED|ASR_UPSTREAM|SESSION_NOT_FOUND|HOST_TRANSPORT_FAILED/i.test(errorCode(error));
}

function speakerLabel(speakerId: string | number | undefined): string | null {
  if (speakerId === undefined || speakerId === null || speakerId === '') return null;
  const raw = String(speakerId);
  return raw.startsWith('说话人') || raw.startsWith('Speaker') ? raw : `说话人 ${raw}`;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TranscribeError('ASR_TIMEOUT', `${label} 超过 ${Math.round(ms / 1000)} 秒未结束`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 把 Host 错误压成可读文本，保留请求 ID 便于排查。 */
function describeStartError(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : null;
    const message = typeof record.message === 'string' ? record.message : null;
    const requestId = typeof record.requestId === 'string' ? record.requestId : null;
    const parts = [message && message !== code ? message : code ?? '未知错误'];
    if (code && message !== code) parts.push(code);
    if (requestId) parts.push(`请求 ${requestId}`);
    return parts.filter(Boolean).join(' · ');
  }
  return error instanceof Error ? error.message : String(error);
}

/** 依次尝试更保守的启动参数：识别服务可能不接受可选开关。 */
function startCandidates(options: TranscribeOptions): Array<{ label: string; input: AsrStartInput }> {
  const full: AsrStartInput = {
    sampleRate: 16000,
    format: 'pcm',
    semanticPunctuationEnabled: true,
    ...(options.diarization ? { speakerDiarizationEnabled: true } : {}),
    ...(options.hotwords.length > 0 ? { hotwords: options.hotwords } : {}),
  };
  const candidates: Array<{ label: string; input: AsrStartInput }> = [
    { label: '完整参数', input: full },
    { label: '基础参数', input: { sampleRate: 16000, format: 'pcm' } },
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate.input);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 一次会话的产出：逐句结果（已按整段偏移校正）+ 是否被上游中途终止。 */
interface SessionResult {
  segments: TranscriptSegment[];
  fallbackText: string;
  failed: boolean;
}

/** 打开 ASR 会话 → 分块推流（失败续传）→ 收尾，返回可直接落库的文本与分段。 */
export async function transcribeAudioFile(host: HostClient, options: TranscribeOptions): Promise<TranscribeOutcome> {
  const trace: TranscribeTrace = { startedAt: Date.now(), events: [] };
  let startInput: AsrStartInput | null = null;
  const done: TranscriptSegment[] = [];
  let sessions = 0;
  let reconnects = 0;
  let decodedBytes = 0;
  let resumedMs = 0;
  let lastAsrError: string | null = null;
  let activeStream: string | null = null;

  const report = (live = 0) =>
    options.onProgress?.({
      audioSentSec: Math.round(decodedBytes / PCM_BYTES_PER_SECOND),
      resumedSec: Math.round(resumedMs / 1000),
      segments: done.length + live,
      sessions,
      reconnects,
    });

  const busy = (error: unknown) => {
    note(trace, 'asr_busy', errorDetail(error));
    return new TranscribeError('ASR_BUSY', `识别服务同时处理的会话已满：${describeStartError(error)}`, trace);
  };

  const startStream = async (): Promise<string> => {
    if (startInput) {
      try {
        return (await host.asr.start(startInput)).streamId;
      } catch (error) {
        throw isCapacityError(error) ? busy(error) : error;
      }
    }
    const failures: string[] = [];
    for (const candidate of startCandidates(options)) {
      try {
        const streamId = (await host.asr.start(candidate.input)).streamId;
        startInput = candidate.input;
        note(trace, 'start', { variant: candidate.label });
        return streamId;
      } catch (error) {
        if (isCapacityError(error)) throw busy(error);
        failures.push(`${candidate.label}：${describeStartError(error)}`);
        note(trace, 'start_failed', { variant: candidate.label, ...errorDetail(error) });
        if ((error as { execution?: string } | null)?.execution === 'executed') break;
      }
    }
    throw new TranscribeError('ASR_START_FAILED', `语音识别无法启动。${failures.join(' / ')}`, trace);
  };

  /** 用一个新会话识别 frames，时间戳以 offsetMs 为起点。 */
  const runSession = async (frames: Buffer[], offsetMs: number): Promise<SessionResult> => {
    const streamId = await startStream();
    activeStream = streamId;
    sessions += 1;
    const result: SessionResult = { segments: [], fallbackText: '', failed: false };
    let partial = '';
    let sessionText = '';
    note(trace, 'session_open', { session: sessions, offsetSec: Math.round(offsetMs / 1000), frames: frames.length });

    const pump = (async () => {
      try {
        for await (const event of host.asr.events({ streamId, afterSequence: 0 })) {
          if (event.type === 'done') break;
          if (event.type === 'result') {
            sessionText = event.session.text ?? '';
            if (event.session.status === 'failed') result.failed = true;
            if (event.session.errorCode) lastAsrError = event.session.errorCode;
            continue;
          }
          const progress = event.event;
          if (progress.type === 'error') {
            result.failed = true;
            lastAsrError = progress.errorCode ?? 'ASR_ERROR';
            note(trace, 'asr_error_event', { session: sessions, errorCode: progress.errorCode, recoverable: progress.recoverable });
            continue;
          }
          if (progress.type === 'final') {
            const utterances = progress.utterances ?? [];
            if (utterances.length > 0) {
              for (const utterance of utterances) {
                const text = (utterance.text ?? '').trim();
                if (!text) continue;
                result.segments.push({
                  startMs: offsetMs + (utterance.startTimeMs ?? 0),
                  endMs: offsetMs + (utterance.endTimeMs ?? 0),
                  text,
                  speaker: speakerLabel(utterance.speakerId),
                });
              }
            } else {
              const text = (progress.text ?? '').trim();
              if (text) result.segments.push({ startMs: offsetMs, endMs: offsetMs, text, speaker: null });
            }
            partial = '';
            continue;
          }
          if (progress.type === 'partial' && progress.text) partial = progress.text;
        }
      } catch (error) {
        note(trace, 'asr_events_broken', { session: sessions, ...errorDetail(error) });
      }
    })();

    let sequence = 0;
    for (const frame of frames) {
      if (result.failed) break;
      try {
        const sent = await host.asr.sendFrame({ streamId, sequence, pcmBase64: frame.toString('base64') });
        sequence = sent.nextSequence;
      } catch (error) {
        note(trace, 'send_failed', { session: sessions, sequence, asrError: lastAsrError, ...errorDetail(error) });
        if (!isRecoverableSendError(error)) throw Object.assign(error as object, { trace });
        result.failed = true;
        break;
      }
      if (sequence % 15 === 0) report(result.segments.length);
    }

    if (result.failed) {
      await host.asr.cancel({ streamId }).catch(() => undefined);
    } else {
      try {
        const stopped = await host.asr.stop({ streamId });
        if (stopped.text) sessionText = stopped.text;
        if (stopped.status === 'failed') result.failed = true;
      } catch (error) {
        note(trace, 'stop_failed', { session: sessions, ...errorDetail(error) });
        result.failed = true;
      }
    }
    await withTimeout(pump, 20000, 'ASR 收尾').catch(() => undefined);
    activeStream = null;
    // 会话文本只保证最近内容，仅在没有逐句结果时兜底。
    result.fallbackText = (sessionText || partial).trim();
    return result;
  };

  /** 识别一块音频；上游中途失败时，从最后一句确认的结束位置开新会话续传。 */
  const runChunk = async (frames: Buffer[], chunkOffsetMs: number): Promise<void> => {
    const frameMs = frames.length > 0 ? Math.round((frames[0].length / PCM_BYTES_PER_SECOND) * 1000) : 2000;
    let start = 0;
    for (let attempt = 1; attempt <= MAX_CHUNK_ATTEMPTS && start < frames.length; attempt += 1) {
      const offsetMs = chunkOffsetMs + start * frameMs;
      const result = await runSession(frames.slice(start), offsetMs);
      if (result.segments.length > 0) {
        done.push(...result.segments);
      } else if (result.fallbackText && !result.failed) {
        const endMs = chunkOffsetMs + frames.length * frameMs;
        done.push({ startMs: offsetMs, endMs, text: result.fallbackText, speaker: null });
      }
      if (!result.failed) return;

      reconnects += 1;
      if (reconnects > MAX_TOTAL_RECONNECTS) {
        throw new TranscribeError('ASR_UNSTABLE', `识别服务连续中断 ${reconnects} 次，已停止。最后错误：${lastAsrError ?? '未知'}`, trace);
      }
      // 从最后确认句子的结束点续传；没有新句子时至少前进一帧，避免在同一处死循环。
      const lastEnd = result.segments.length > 0 ? result.segments[result.segments.length - 1].endMs : offsetMs;
      const resumeFrame = Math.floor((lastEnd - chunkOffsetMs) / frameMs);
      start = Math.max(start + (result.segments.length > 0 ? 0 : 1), resumeFrame);
      note(trace, 'resume', { attempt, resumeSec: Math.round((chunkOffsetMs + start * frameMs) / 1000), asrError: lastAsrError });
      report();
      await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
    }
    if (start < frames.length) {
      note(trace, 'chunk_gave_up', { fromSec: Math.round((chunkOffsetMs + start * frameMs) / 1000) });
      throw new TranscribeError('ASR_UNSTABLE', `识别服务在 ${Math.round((chunkOffsetMs + start * frameMs) / 60000)} 分钟处反复中断。最后错误：${lastAsrError ?? '未知'}`, trace);
    }
  };

  let chunkIndex = 0;
  let asrMs = 0;
  /** 断点里有同一位置的完成块就直接复用，否则送识别并落一个检查点。 */
  const processChunk = async (frames: Buffer[], offsetMs: number): Promise<void> => {
    const index = chunkIndex;
    chunkIndex += 1;
    const endMs = Math.round((decodedBytes / PCM_BYTES_PER_SECOND) * 1000);
    const saved = options.checkpoint?.completed.get(index);
    if (saved && saved.offsetMs === offsetMs && saved.endMs === endMs) {
      done.push(...saved.segments);
      resumedMs += endMs - offsetMs;
      note(trace, 'chunk_resumed', { index, offsetSec: Math.round(offsetMs / 1000), segments: saved.segments.length });
      report();
      return;
    }
    if (asrMs > MAX_ASR_MS) throw new TranscribeError('TRANSCRIBE_TIMEOUT', '单次转录超过 60 分钟，已中止', trace);
    const before = done.length;
    const startedAt = Date.now();
    await runChunk(frames, offsetMs);
    asrMs += Date.now() - startedAt;
    options.checkpoint?.save({ index, offsetMs, endMs, segments: done.slice(before) });
  };

  const iterator = (options.decode ?? decodePcmFrames)(options.ffmpegPath, options.filePath);
  const framesPerChunk = Math.max(1, Math.round(CHUNK_AUDIO_SEC / 2));
  let chunk: Buffer[] = [];
  let chunkOffsetMs = 0;

  try {
    let step = await iterator.next();
    while (!step.done) {
      chunk.push(step.value);
      decodedBytes += step.value.length;
      if (chunk.length >= framesPerChunk) {
        await processChunk(chunk, chunkOffsetMs);
        chunkOffsetMs = Math.round((decodedBytes / PCM_BYTES_PER_SECOND) * 1000);
        chunk = [];
      }
      step = await iterator.next();
    }
    const decodeFailure = step.value;
    if (decodeFailure) throw new TranscribeError('DECODE_FAILED', `音频解码失败：${decodeFailure.message}`, trace);
    if (decodedBytes === 0) throw new TranscribeError('AUDIO_EMPTY', '解码后没有音频数据，请确认文件未损坏', trace);
    if (chunk.length > 0) await processChunk(chunk, chunkOffsetMs);
  } catch (error) {
    await iterator.return(null).catch(() => undefined);
    if (activeStream) await host.asr.cancel({ streamId: activeStream }).catch(() => undefined);
    if (error instanceof TranscribeError) throw error;
    throw Object.assign(error as object, { trace });
  }

  report();
  note(trace, 'finished', {
    audioSec: Math.round(decodedBytes / PCM_BYTES_PER_SECOND),
    resumedSec: Math.round(resumedMs / 1000),
    segments: done.length,
    sessions,
    reconnects,
  });

  const text = done
    .map((segment) => segment.text)
    .join('')
    .trim();
  if (!text) {
    // 识别接口报过错：原文只进详情，主文案由 describeError 按 ASR_UNSTABLE 给出。
    if (lastAsrError) throw new TranscribeError('ASR_UNSTABLE', `识别接口返回错误：${lastAsrError}`, trace);
    throw new TranscribeError('ASR_EMPTY', '没有识别到可用的语音内容', trace);
  }

  const audioMs = Math.round((decodedBytes / PCM_BYTES_PER_SECOND) * 1000);
  return { text, segments: done, audioMs, engine: 'host-asr', trace };
}
