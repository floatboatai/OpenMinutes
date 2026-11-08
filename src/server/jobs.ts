// ABOUTME: 转录/归类任务的统一入口：排队意图落库、识别繁忙时退回排队、启动时恢复排队，以及导入后的自动转录策略。

import type { DatabaseSync } from 'node:sqlite';
import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import { resolveAudioFile } from './library';
import { runOrganization, runTranscription, type PipelineDeps } from './pipeline';
import { DEFAULT_ASR_CONCURRENCY, MAX_ASR_CONCURRENCY, TRANSCRIBE_LANE, enqueue, queueSnapshot, setLaneLimit } from './queue';
import { readSetting, type RecoveryResult } from './sql';
import { clearQueuedTask, recordQueuedTask } from './transcribe-checkpoints';

/** 启动恢复的任务稍等再开始，给 Host 连接与页面首屏留出时间。 */
const RESUME_DELAY_MS = 2_000;

interface QueueOptions {
  delayMs?: number;
  attempt?: number;
}

export function pipelineDeps(app: WorkbenchServer): PipelineDeps {
  return {
    db: app.database,
    host: app.host,
    resolveAudio: (storagePath: string) => resolveAudioFile(app, storagePath),
    queueOrganization: (recordingId: number) => queueOrganization(app, recordingId),
  };
}

export function queueWork(app: WorkbenchServer, label: string, task: () => Promise<unknown>, options: { delayMs?: number } = {}): void {
  enqueue(label, () => app.trackTask(task, label).catch(() => undefined), options);
}

export function asrConcurrency(db: DatabaseSync): number {
  const value = Number(readSetting(db, 'asr_concurrency', String(DEFAULT_ASR_CONCURRENCY)));
  return Number.isInteger(value) && value >= 1 && value <= MAX_ASR_CONCURRENCY ? value : DEFAULT_ASR_CONCURRENCY;
}

/** 按设置更新转录车道的并行上限；启动时和设置保存后调用。 */
export function applyAsrConcurrency(db: DatabaseSync): void {
  setLaneLimit(TRANSCRIBE_LANE, asrConcurrency(db));
}

export function queueTranscription(app: WorkbenchServer, recordingId: number, options: QueueOptions = {}): void {
  const db = app.database;
  const attempt = options.attempt ?? 1;
  recordQueuedTask(db, recordingId, 'transcribe');
  queueWork(app, `transcribe:${recordingId}`, async () => {
    let requeued = false;
    try {
      const result = await runTranscription(pipelineDeps(app), recordingId, { attempt });
      if (result.retryAfterMs !== undefined) {
        requeued = true;
        queueTranscription(app, recordingId, { delayMs: result.retryAfterMs, attempt: attempt + 1 });
      }
      return result;
    } finally {
      if (!requeued) clearQueuedTask(db, recordingId, 'transcribe');
    }
  }, options);
}

export function queueOrganization(app: WorkbenchServer, recordingId: number, options: QueueOptions = {}): void {
  const db = app.database;
  recordQueuedTask(db, recordingId, 'organize');
  queueWork(app, `organize:${recordingId}`, async () => {
    try {
      return await runOrganization(pipelineDeps(app), recordingId);
    } finally {
      clearQueuedTask(db, recordingId, 'organize');
    }
  }, options);
}

/** 启动时把被打断的和原本排队的录音重新入队；已在内存队列里的跳过，重复调用不会重复排。 */
export function resumeQueuedTasks(app: WorkbenchServer, requeue: RecoveryResult['requeue']): number {
  let resumed = 0;
  for (const item of requeue) {
    if (item.recordingId <= 0 || queueSnapshot().includes(`${item.kind}:${item.recordingId}`)) continue;
    if (item.kind === 'transcribe') queueTranscription(app, item.recordingId, { delayMs: RESUME_DELAY_MS });
    else queueOrganization(app, item.recordingId, { delayMs: RESUME_DELAY_MS });
    resumed += 1;
  }
  return resumed;
}

/** 导入/拉取完成后，按设置决定是否自动排队转录。 */
export function autoTranscribeIfEnabled(app: WorkbenchServer, ids: number[]): number {
  if (ids.length === 0) return 0;
  if (readSetting(app.database, 'auto_transcribe', '1') !== '1') return 0;
  for (const id of ids) queueTranscription(app, id);
  return ids.length;
}
