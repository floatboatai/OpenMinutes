// ABOUTME: 转录与归类的后台流水线：维护状态机、任务记录与失败可重试信息。

import { stat } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { HostClient } from '../../sdk/host.mjs';
import { finishJob, num, nowIso, pruneTags, readSetting, row, run, startJob, str, strOr, touchRecording } from './sql';
import { CHUNK_AUDIO_SEC, TranscribeError, transcribeAudioFile } from './transcribe';
import { clearCheckpoints, openCheckpoints } from './transcribe-checkpoints';
import { OrganizeError, organizeRecording } from './organize';
import { resolveFfmpeg } from './runtime-probe';
import { AppError, ERROR_COPY } from '../contracts/errors';
import { toFailure } from './http';
import { isBusyStatus } from '../contracts/recording-status';
import { scheduleScenesForRecording } from './scenes/day';

export { isBusyStatus } from '../contracts/recording-status';

export interface PipelineDeps {
  db: DatabaseSync;
  host: HostClient;
  resolveAudio: (storagePath: string) => Promise<string>;
  /** 自动归类时把归类排进归类车道，释放转录名额；未提供时在转录任务内直接归类。 */
  queueOrganization?: (recordingId: number) => void;
  /** 测试替换 ffmpeg 定位与音频解码。 */
  resolveFfmpeg?: typeof resolveFfmpeg;
  decode?: Parameters<typeof transcribeAudioFile>[1]['decode'];
}

export interface PipelineResult {
  ok: boolean;
  message: string;
  /** 识别服务繁忙：录音保持排队状态，调用方应在这么久之后重新排队。 */
  retryAfterMs?: number;
}

/** 识别服务会话已满时最多自动重排的次数（间隔 5 秒递增到 1 分钟，约 25 分钟）。 */
export const MAX_BUSY_ATTEMPTS = 30;

export function busyRetryDelayMs(attempt: number): number {
  return Math.min(60_000, 5_000 * Math.max(1, attempt));
}

export interface DescribedError {
  code: string;
  message: string;
  detail: string | null;
}

/** 引擎/宿主错误码 → 面向用户的统一 code；原文全部进 detail。 */
const STAGE_CODES: Record<string, string> = {
  ASR_START_FAILED: 'ASR_START_FAILED',
  ASR_UNSTABLE: 'ASR_UNSTABLE',
  ASR_TIMEOUT: 'ASR_UNSTABLE',
  ASR_EMPTY: 'ASR_EMPTY',
  DECODE_FAILED: 'DECODE_FAILED',
  AUDIO_EMPTY: 'DECODE_FAILED',
  LLM_OBJECT_INVALID: 'LLM_INCOMPLETE',
  BAD_MODEL_OUTPUT: 'LLM_INCOMPLETE',
};

const HOST_CODE = /HOST|CAPABILITY|ACCOUNT|PERMISSION|AUTH|QUOTA|MODEL/;

export function describeError(error: unknown, stage: 'transcribe' | 'organize' = 'transcribe'): DescribedError {
  if (error instanceof AppError) return { code: error.code, message: error.message, detail: error.detail ?? null };
  const record = (error !== null && typeof error === 'object' ? error : {}) as Record<string, unknown>;
  const rawCode = typeof record.code === 'string' ? record.code : null;
  const rawMessage = typeof record.message === 'string' ? record.message : error instanceof Error ? error.message : String(error);
  const requestId = typeof record.requestId === 'string' ? `\nrequestId=${record.requestId}` : '';
  const detail = `${rawCode ? `${rawCode}: ` : ''}${rawMessage}${requestId}`.slice(0, 4000);
  if (typeof record.errno === 'number' || typeof record.syscall === 'string') {
    const failure = toFailure(error);
    return { code: failure.code, message: failure.error, detail: failure.detail ?? detail };
  }
  let code = rawCode ? STAGE_CODES[rawCode] : undefined;
  if (!code && rawCode && HOST_CODE.test(rawCode)) code = stage === 'transcribe' ? 'ASR_START_FAILED' : 'LLM_UNAVAILABLE';
  if (code) return { code, message: ERROR_COPY[code]?.message ?? rawMessage, detail };
  if (rawCode && ERROR_COPY[rawCode]) return { code: rawCode, message: ERROR_COPY[rawCode].message, detail };
  // 只有本应用自己抛出的业务错误自带中文提示，可以直接展示；
  // Host 或引擎的其它原始 code 一律收敛为通用文案，原文只进 detail。
  if (rawCode && (error instanceof TranscribeError || error instanceof OrganizeError)) {
    return { code: rawCode, message: rawMessage, detail };
  }
  const fallback = rawCode && stage === 'transcribe' ? 'ASR_START_FAILED' : 'INTERNAL_ERROR';
  return { code: fallback, message: ERROR_COPY[fallback].message, detail };
}

function failRecording(db: DatabaseSync, recordingId: number, status: string, failure: DescribedError): void {
  touchRecording(db, recordingId, {
    status,
    last_error: failure.message,
    last_error_code: failure.code,
    last_error_detail: failure.detail,
  });
}

function settingOn(db: DatabaseSync, key: string): boolean {
  return readSetting(db, key, '0') === '1';
}

function hotwords(db: DatabaseSync): string[] {
  return readSetting(db, 'asr_hotwords')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= 20)
    .slice(0, 50);
}

/**
 * 转录一条录音；失败时保留可重试状态与原因，不吞掉错误。
 * 每块识别完成即落检查点，再次转录时跳过已完成的块；识别服务会话已满时退回排队（retryAfterMs）。
 */
export async function runTranscription(deps: PipelineDeps, recordingId: number, options: { attempt?: number } = {}): Promise<PipelineResult> {
  const { db } = deps;
  const attempt = options.attempt ?? 1;
  const recording = row(db, 'SELECT id, filename, storage_path, status, duration_sec FROM recordings WHERE id = ?', [recordingId]);
  if (!recording) return { ok: false, message: '录音不存在' };
  if (isBusyStatus(strOr(recording.status, ''))) return { ok: false, message: '该录音已有任务在执行' };

  const storagePath = str(recording.storage_path);
  if (!storagePath) {
    const message = '这条录音还没有音频文件，请先在「录音笔」页同步或导入。';
    failRecording(db, recordingId, 'failed', { code: 'NO_AUDIO_FILE', message, detail: null });
    return { ok: false, message };
  }

  const ffmpegPath = await (deps.resolveFfmpeg ?? resolveFfmpeg)(db);
  if (!ffmpegPath) {
    const failure = { code: 'RUNTIME_MISSING', message: '还没有找到音频处理工具，无法读取音频。', detail: 'ffmpeg not found; set ffmpeg_path in 设置 › 诊断与高级' };
    failRecording(db, recordingId, 'failed', failure);
    return { ok: false, message: failure.message };
  }
  const jobId = startJob(db, 'transcribe', recordingId);
  touchRecording(db, recordingId, { status: 'transcribing', last_error: null, last_error_code: null, last_error_detail: null });

  try {
    const absolute = await deps.resolveAudio(storagePath);
    const diarization = settingOn(db, 'speaker_diarization');
    const words = hotwords(db);
    const source = await stat(absolute);
    const checkpoint = openCheckpoints(db, recordingId, {
      size: source.size,
      mtimeMs: Math.floor(source.mtimeMs),
      params: JSON.stringify({ chunkSec: CHUNK_AUDIO_SEC, diarization, hotwords: words }),
    });
    const outcome = await transcribeAudioFile(deps.host, {
      filePath: absolute,
      ffmpegPath,
      diarization,
      hotwords: words,
      checkpoint,
      decode: deps.decode,
      onProgress: (progress) => {
        const total = num(recording.duration_sec);
        const sent = Math.round(progress.audioSentSec / 60);
        const head = total ? `已送识别 ${sent}/${Math.max(1, Math.round(total / 60))} 分钟` : `已送识别 ${sent} 分钟`;
        const resumed = progress.resumedSec > 0 ? ` · 从上次进度继续（${Math.round(progress.resumedSec / 60)} 分钟已完成）` : '';
        const tail = progress.reconnects > 0 ? ` · 上游断线 ${progress.reconnects} 次已自动续传` : '';
        run(db, 'UPDATE job_runs SET message = ? WHERE id = ?', [`${head} · 已识别 ${progress.segments} 句${resumed}${tail}`, jobId]);
      },
    });

    run(
      db,
      `INSERT INTO transcripts (recording_id, engine, language, text, segments_json, char_count, audio_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        recordingId,
        outcome.engine,
        readSetting(db, 'asr_language') || null,
        outcome.text,
        JSON.stringify(outcome.segments).slice(0, 400000),
        outcome.text.length,
        outcome.audioMs,
        nowIso(),
      ],
    );
    clearCheckpoints(db, recordingId);

    const speakers = new Set(outcome.segments.map((segment) => segment.speaker).filter(Boolean)).size;
    const durationSec = num(recording.duration_sec) ?? Math.max(1, Math.round(outcome.audioMs / 1000));
    touchRecording(db, recordingId, {
      transcript_text: outcome.text,
      language: readSetting(db, 'asr_language') || null,
      speaker_count: speakers,
      duration_sec: durationSec,
      status: 'transcribed',
      last_error: null,
      last_error_code: null,
      last_error_detail: null,
    });
    finishJob(db, jobId, 'success', `识别 ${outcome.text.length} 字`, {
      chars: outcome.text.length,
      segments: outcome.segments.length,
      audioMs: outcome.audioMs,
      trace: outcome.trace.events,
    });

    if (settingOn(db, 'auto_analyze')) {
      if (deps.queueOrganization) deps.queueOrganization(recordingId);
      else await runOrganization(deps, recordingId);
    }
    scheduleScenesForRecording(db, deps.host, recordingId);
    return { ok: true, message: '转录完成' };
  } catch (error) {
    const failure = describeError(error, 'transcribe');
    if (failure.code === 'ASR_BUSY' && attempt < MAX_BUSY_ATTEMPTS) {
      // 已完成的块都在检查点里；退回执行前的状态，由调用方稍后重新排队。
      touchRecording(db, recordingId, { status: strOr(recording.status, 'ready'), last_error: null, last_error_code: null, last_error_detail: null });
      finishJob(db, jobId, 'interrupted', '识别服务繁忙，稍后自动继续', { code: failure.code, detail: failure.detail, attempt });
      return { ok: false, message: '识别服务繁忙，已重新排队', retryAfterMs: busyRetryDelayMs(attempt) };
    }
    failRecording(db, recordingId, 'failed', failure);
    const trace = (error as { trace?: { events: unknown[] } } | null)?.trace?.events;
    console.error(`[transcribe] recording ${recordingId} failed: ${failure.code} ${failure.detail ?? failure.message}`);
    finishJob(db, jobId, 'failure', failure.message, { code: failure.code, detail: failure.detail, ...(trace ? { trace } : {}) });
    return { ok: false, message: failure.message };
  }
}

/** 结构化归类；已有转录结果才能执行。 */
export async function runOrganization(deps: PipelineDeps, recordingId: number): Promise<PipelineResult> {
  const { db } = deps;
  const recording = row(db, 'SELECT id, status, transcript_text FROM recordings WHERE id = ?', [recordingId]);
  if (!recording) return { ok: false, message: '录音不存在' };
  const transcript = str(recording.transcript_text) ?? '';
  if (!transcript.trim()) return { ok: false, message: '还没有转录文本，无法归类' };
  if (strOr(recording.status, '') === 'analyzing') return { ok: false, message: '该录音正在归类中' };

  const jobId = startJob(db, 'organize', recordingId);
  touchRecording(db, recordingId, { status: 'analyzing', last_error: null, last_error_code: null, last_error_detail: null });
  try {
    const result = await organizeRecording(db, deps.host, recordingId);
    finishJob(db, jobId, 'success', `已归入「${result.categorySlug}」`, {
      importance: result.importance,
      tags: result.tags,
      keyPoints: result.keyPoints.length,
      actionItems: result.actionItems.length,
    });
    pruneTags(db);
    return { ok: true, message: '归类完成' };
  } catch (error) {
    const failure = describeError(error, 'organize');
    failRecording(db, recordingId, 'transcribed', failure);
    finishJob(db, jobId, 'failure', failure.message, { code: failure.code, detail: failure.detail });
    return { ok: false, message: failure.message };
  }
}
