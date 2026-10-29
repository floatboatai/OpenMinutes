// ABOUTME: 转录与归类触发路由；长任务进后台队列，页面轮询详情获取进度。

import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { BatchResult } from '../../contracts/app';
import { asObject, optIntArray, pathParam } from '../../contracts/input';
import { api } from '../http';
import { isBusyStatus } from '../pipeline';
import { queueOrganization, queueTranscription } from '../jobs';
import { row, strOr } from '../sql';
import { queuedRecordingStatus } from '../queue';

export function registerPipelineRoutes(app: WorkbenchServer): void {
  app.route(
    'POST',
    '/api/recordings/:id/transcribe',
    api((context) => {
      const id = pathParam(context.params, 'id');
      const found = row(context.database, 'SELECT id, status, storage_path FROM recordings WHERE id = ?', [id]);
      if (!found) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });
      if (!strOr(found.storage_path, '')) {
        throw Object.assign(new Error('这条录音还没有音频文件，请先导入或拉取'), { code: 'NO_AUDIO_FILE' });
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

  app.route(
    'POST',
    '/api/recordings/batch/transcribe',
    api((context): BatchResult => {
      const body = asObject(context.body);
      const ids = optIntArray(body, 'ids', 400) ?? [];
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
      const body = asObject(context.body);
      const ids = optIntArray(body, 'ids', 400) ?? [];
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
}
