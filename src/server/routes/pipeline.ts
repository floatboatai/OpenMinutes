// ABOUTME: 转录与归类触发路由；长任务进后台队列，页面轮询详情获取进度。

import type { DatabaseSync } from 'node:sqlite';
import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { BatchResult } from '../../contracts/app';
import { asObject, BadInput, optIntArray, optString, pathParam } from '../../contracts/input';
import { api } from '../http';
import { isBusyStatus } from '../pipeline';
import { queueOrganization, queueTranscription } from '../jobs';
import { num, row, rows, strOr } from '../sql';
import { queuedRecordingStatus } from '../queue';

/** 批量接口除 {ids} 外支持 {stage}：由服务端选出该阶段的全部录音（上限 400）。 */
function batchIds(context: { database: DatabaseSync; body: unknown }, stage: 'ready' | 'transcribed'): number[] {
  const body = asObject(context.body);
  const requested = optString(body, 'stage', 20);
  if (requested === undefined) return optIntArray(body, 'ids', 400) ?? [];
  if (requested !== stage) throw new BadInput(`stage 只能是 ${stage}`);
  return rows(context.database,
    'SELECT id FROM recordings WHERE status = ? AND is_archived = 0 ORDER BY COALESCE(recorded_at, created_at) DESC LIMIT 400', [stage])
    .map((item) => num(item.id) ?? 0).filter((id) => id > 0);
}

export function registerPipelineRoutes(app: WorkbenchServer): void {
  // 路由按注册顺序匹配，batch 必须先于 :id。
  app.route(
    'POST',
    '/api/recordings/batch/transcribe',
    api((context): BatchResult => {
      const ids = batchIds(context, 'ready');
      const eligible: number[] = [];
      for (const id of ids) {
        const found = row(context.database, 'SELECT id, status, storage_path FROM recordings WHERE id = ?', [id]);
        if (!found) continue;
        if (!strOr(found.storage_path, '')) continue;
        if (queuedRecordingStatus(id) || isBusyStatus(strOr(found.status, ''))) continue;
        eligible.push(id);
      }
      for (const id of eligible) {
        queueTranscription(app, id);
      }
      return { accepted: eligible.length, skipped: ids.length - eligible.length, ids: eligible };
    }),
  );

  app.route(
    'POST',
    '/api/recordings/batch/organize',
    api((context): BatchResult => {
      const ids = batchIds(context, 'transcribed');
      const eligible: number[] = [];
      for (const id of ids) {
        const found = row(context.database, 'SELECT id, status, transcript_text FROM recordings WHERE id = ?', [id]);
        if (!found) continue;
        if (!strOr(found.transcript_text, '').trim()) continue;
        if (queuedRecordingStatus(id) || isBusyStatus(strOr(found.status, ''))) continue;
        eligible.push(id);
      }
      for (const id of eligible) {
        queueOrganization(app, id);
      }
      return { accepted: eligible.length, skipped: ids.length - eligible.length, ids: eligible };
    }),
  );

  app.route(
    'POST',
    '/api/recordings/:id/transcribe',
    api((context) => {
      const id = pathParam(context.params, 'id');
      const found = row(context.database, 'SELECT id, status, storage_path FROM recordings WHERE id = ?', [id]);
      if (!found) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });
      if (!strOr(found.storage_path, '')) {
        throw Object.assign(new Error('这条录音还没有音频文件，请先在「录音笔」页同步或导入'), { code: 'NO_AUDIO_FILE' });
      }
      if (queuedRecordingStatus(id) || isBusyStatus(strOr(found.status, ''))) {
        throw Object.assign(new Error('该录音已有任务在执行'), { code: 'BUSY' });
      }
      queueTranscription(app, id);
      return { queued: true, id };
    }),
  );

  app.route(
    'POST',
    '/api/recordings/:id/organize',
    api((context) => {
      const id = pathParam(context.params, 'id');
      const found = row(context.database, 'SELECT id, status, transcript_text FROM recordings WHERE id = ?', [id]);
      if (!found) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });
      if (!strOr(found.transcript_text, '').trim()) {
        throw Object.assign(new Error('还没有转录文本，请先完成转录'), { code: 'NO_TRANSCRIPT' });
      }
      if (queuedRecordingStatus(id) || isBusyStatus(strOr(found.status, ''))) {
        throw Object.assign(new Error('该录音已有任务在执行'), { code: 'BUSY' });
      }
      queueOrganization(app, id);
      return { queued: true, id };
    }),
  );
}
