// ABOUTME: 转录与归类的后台流水线：维护状态机、任务记录与失败可重试信息。

import type { DatabaseSync } from 'node:sqlite';
import type { HostClient } from '../../sdk/host.mjs';
import { finishJob, num, nowIso, pruneTags, readSetting, row, run, startJob, str, strOr, touchRecording } from './sql';
import { transcribeAudioFile } from './transcribe';
import { organizeRecording } from './organize';
import { resolveFfmpeg } from './bridge';
import { isBusyStatus } from '../contracts/recording-status';

export { isBusyStatus } from '../contracts/recording-status';

export interface PipelineDeps {
  db: DatabaseSync;
  host: HostClient;
  resolveAudio: (storagePath: string) => Promise<string>;
}

export interface PipelineResult {
  ok: boolean;
  message: string;
}

export function describeError(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : null;
    const message = typeof record.message === 'string' ? record.message : null;
    if (message) return code ? `${message}（${code}）` : message;
  }
  return error instanceof Error ? error.message : '未知错误';
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

/** 转录一条录音；失败时保留可重试状态与原因，不吞掉错误。 */
export async function runTranscription(deps: PipelineDeps, recordingId: number): Promise<PipelineResult> {
  const { db } = deps;
  const recording = row(db, 'SELECT id, filename, storage_path, status, duration_sec FROM recordings WHERE id = ?', [recordingId]);
  if (!recording) return { ok: false, message: '录音不存在' };
  if (isBusyStatus(strOr(recording.status, ''))) return { ok: false, message: '该录音已有任务在执行' };

  const storagePath = str(recording.storage_path);
  if (!storagePath) {
    const message = '这条录音还没有音频文件，请先完成设备拉取或目录导入。';
    touchRecording(db, recordingId, { status: 'failed', last_error: message });
    return { ok: false, message };
  }

  const ffmpegPath = await resolveFfmpeg(db);
  if (!ffmpegPath) {
    const message = '未找到 ffmpeg，无法解码音频。请在设置中填写 ffmpeg 的绝对路径。';
    touchRecording(db, recordingId, { status: 'failed', last_error: message });
    return { ok: false, message };
  }
  const jobId = startJob(db, 'transcribe', recordingId);
  touchRecording(db, recordingId, { status: 'transcribing', last_error: null });

  try {
    const absolute = await deps.resolveAudio(storagePath);
    const outcome = await transcribeAudioFile(deps.host, {
      filePath: absolute,
      ffmpegPath,
      diarization: settingOn(db, 'speaker_diarization'),
      hotwords: hotwords(db),
      onProgress: (progress) => {
        const total = num(recording.duration_sec);
        const sent = Math.round(progress.audioSentSec / 60);
        const head = total ? `已送识别 ${sent}/${Math.max(1, Math.round(total / 60))} 分钟` : `已送识别 ${sent} 分钟`;
        const tail = progress.reconnects > 0 ? ` · 上游断线 ${progress.reconnects} 次已自动续传` : '';
        run(db, 'UPDATE job_runs SET message = ? WHERE id = ?', [`${head} · 已识别 ${progress.segments} 句${tail}`, jobId]);
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

    const speakers = new Set(outcome.segments.map((segment) => segment.speaker).filter(Boolean)).size;
    const durationSec = num(recording.duration_sec) ?? Math.max(1, Math.round(outcome.audioMs / 1000));
    touchRecording(db, recordingId, {
      transcript_text: outcome.text,
      language: readSetting(db, 'asr_language') || null,
      speaker_count: speakers,
      duration_sec: durationSec,
      status: 'transcribed',
      last_error: null,
    });
    finishJob(db, jobId, 'success', `识别 ${outcome.text.length} 字`, {
      chars: outcome.text.length,
      segments: outcome.segments.length,
      audioMs: outcome.audioMs,
      trace: outcome.trace.events,
    });

    if (settingOn(db, 'auto_analyze')) {
      await runOrganization(deps, recordingId);
    }
    return { ok: true, message: '转录完成' };
  } catch (error) {
    const message = describeError(error);
    touchRecording(db, recordingId, { status: 'failed', last_error: message });
    const trace = (error as { trace?: { events: unknown[] } } | null)?.trace?.events;
    console.error(`[transcribe] recording ${recordingId} failed: ${message}`);
    finishJob(db, jobId, 'failure', message, trace ? { trace } : undefined);
    return { ok: false, message };
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
  touchRecording(db, recordingId, { status: 'analyzing', last_error: null });
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
    const message = describeError(error);
    touchRecording(db, recordingId, { status: 'transcribed', last_error: message });
    finishJob(db, jobId, 'failure', message);
    return { ok: false, message };
  }
}
