// ABOUTME: 转录/归类任务的统一入口，含导入后的自动转录策略。

import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import { resolveAudioFile } from './library';
import { runOrganization, runTranscription, type PipelineDeps } from './pipeline';
import { enqueue } from './queue';
import { readSetting } from './sql';

export function pipelineDeps(app: WorkbenchServer): PipelineDeps {
  return {
    db: app.database,
    host: app.host,
    resolveAudio: (storagePath: string) => resolveAudioFile(app, storagePath),
  };
}

export function queueWork(app: WorkbenchServer, label: string, task: () => Promise<unknown>): void {
  enqueue(label, () => app.trackTask(task, label).catch(() => undefined));
}

export function queueTranscription(app: WorkbenchServer, recordingId: number): void {
  queueWork(app, `transcribe:${recordingId}`, () => runTranscription(pipelineDeps(app), recordingId));
}

export function queueOrganization(app: WorkbenchServer, recordingId: number): void {
  queueWork(app, `organize:${recordingId}`, () => runOrganization(pipelineDeps(app), recordingId));
}

/** 导入/拉取完成后，按设置决定是否自动排队转录。 */
export function autoTranscribeIfEnabled(app: WorkbenchServer, ids: number[]): number {
  if (ids.length === 0) return 0;
  if (readSetting(app.database, 'auto_transcribe', '1') !== '1') return 0;
  for (const id of ids) queueTranscription(app, id);
  return ids.length;
}
