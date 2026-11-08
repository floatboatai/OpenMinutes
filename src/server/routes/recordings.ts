// ABOUTME: 录音列表、详情、编辑与删除相关路由。

import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type { RecordingDetail, RecordingListResult, RevealResult } from '../../contracts/app';
import { asObject, BadInput, optBool, optInt, optString, optStringArray, pathParam } from '../../contracts/input';
import { api } from '../http';
import { listRecordings, readRecordingDetail } from '../repo';
import { pruneTags, readTags, row, run, str, syncTags } from '../sql';
import { libraryRoot, resolveAudioFile } from '../library';
import { linkCalendarRecording } from '../calendar';
import { revealRecording } from '../reveal';

export function registerRecordingRoutes(app: WorkbenchServer): void {
  app.route(
    'GET',
    '/api/recordings',
    api((context): RecordingListResult => {
      const params = context.url.searchParams;
      const categoryParam = params.get('categoryId');
      const limitParam = params.get('limit');
      const offsetParam = params.get('offset');
      return listRecordings(context.database, {
        q: params.get('q')?.trim() || undefined,
        stage: params.get('stage')?.trim() || undefined,
        categoryId: categoryParam && categoryParam !== 'all' ? Number(categoryParam) : undefined,
        tag: params.get('tag')?.trim() || undefined,
        favorite: params.get('favorite') === '1',
        archived: params.get('archived') === '1' ? true : undefined,
        sort: params.get('sort')?.trim() || 'newest',
        limit: limitParam ? Number(limitParam) : 60,
        offset: offsetParam ? Number(offsetParam) : 0,
      });
    }),
  );

  app.route(
    'GET',
    '/api/recordings/:id',
    api((context): RecordingDetail => {
      const detail = readRecordingDetail(context.database, pathParam(context.params, 'id'));
      if (!detail) throw Object.assign(new Error('录音不存在或已删除'), { code: 'NOT_FOUND' });
      return detail;
    }),
  );

  app.route(
    'GET',
    '/api/recordings/:id/tags',
    api((context) => readTags(context.database, pathParam(context.params, 'id'))),
  );

  app.route(
    'PATCH',
    '/api/recordings/:id',
    api((context): RecordingDetail => {
      const id = pathParam(context.params, 'id');
      const body = asObject(context.body);
      const existing = row(context.database, 'SELECT id FROM recordings WHERE id = ?', [id]);
      if (!existing) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });

      const title = optString(body, 'title', 120);
      const summary = optString(body, 'summary', 800);
      const categoryId = optInt(body, 'categoryId', 1, 999999);
      const importance = optInt(body, 'importance', 1, 5);
      const isFavorite = optBool(body, 'isFavorite');
      const isArchived = optBool(body, 'isArchived');
      const tags = optStringArray(body, 'tags', 24);
      const calendarEventId = body.calendarEventId;
      if (calendarEventId !== undefined && calendarEventId !== null
        && (typeof calendarEventId !== 'number' || !Number.isSafeInteger(calendarEventId) || calendarEventId <= 0)) {
        throw new BadInput('calendarEventId 必须是正整数或 null');
      }

      if (title !== undefined) run(context.database, 'UPDATE recordings SET title = ? WHERE id = ?', [title || null, id]);
      if (summary !== undefined) run(context.database, 'UPDATE recordings SET summary = ? WHERE id = ?', [summary || null, id]);
      if (importance !== undefined) run(context.database, 'UPDATE recordings SET importance = ? WHERE id = ?', [importance, id]);
      if (isFavorite !== undefined) run(context.database, 'UPDATE recordings SET is_favorite = ? WHERE id = ?', [isFavorite ? 1 : 0, id]);
      if (isArchived !== undefined) run(context.database, 'UPDATE recordings SET is_archived = ? WHERE id = ?', [isArchived ? 1 : 0, id]);
      if (categoryId !== undefined) {
        const category = row(context.database, 'SELECT id FROM categories WHERE id = ?', [categoryId]);
        if (!category) throw Object.assign(new Error('分类不存在'), { code: 'BAD_CATEGORY' });
        run(context.database, 'UPDATE recordings SET category_id = ? WHERE id = ?', [categoryId, id]);
      }
      // 录音与日程的唯一关联入口（日历页 EventLinker）。
      if (calendarEventId !== undefined) linkCalendarRecording(context.database, id, calendarEventId as number | null);
      if (tags !== undefined) {
        syncTags(context.database, id, tags, 'user', true);
        pruneTags(context.database);
      }
      run(context.database, 'UPDATE recordings SET updated_at = ? WHERE id = ?', [new Date().toISOString(), id]);

      const detail = readRecordingDetail(context.database, id);
      if (!detail) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });
      return detail;
    }),
  );

  // 打开录音所在文件夹的唯一入口（录音列表「位置」列）；只接受录音 id，路径由服务端解析。
  app.route(
    'POST',
    '/api/recordings/:id/reveal',
    api((context): Promise<RevealResult> => revealRecording(context.database, pathParam(context.params, 'id'), {
      host: app.host,
      resolve: (storagePath) => resolveAudioFile(app, storagePath),
      fakeLog: process.env.OPENMINUTES_FAKE_REVEAL || undefined,
    })),
  );

  app.route(
    'DELETE',
    '/api/recordings/:id',
    api(async (context) => {
      const id = pathParam(context.params, 'id');
      const found = row(context.database, 'SELECT id, storage_path FROM recordings WHERE id = ?', [id]);
      if (!found) throw Object.assign(new Error('录音不存在'), { code: 'NOT_FOUND' });

      const storagePath = str(found.storage_path);
      let movedTo: string | null = null;
      if (storagePath) {
        try {
          const source = await resolveAudioFile(app, storagePath);
          const trashDir = path.join(libraryRoot(context.database), '_trash');
          await mkdir(trashDir, { recursive: true });
          const target = path.join(trashDir, `${Date.now()}-${path.basename(storagePath)}`);
          await rename(source, target);
          movedTo = path.basename(target);
        } catch {
          // 音频已不在时仍然删除记录，避免库中出现永久无法处理的条目。
        }
      }

      run(context.database, 'DELETE FROM transcripts WHERE recording_id = ?', [id]);
      run(context.database, 'DELETE FROM analyses WHERE recording_id = ?', [id]);
      run(context.database, 'DELETE FROM recording_tags WHERE recording_id = ?', [id]);
      run(context.database, 'DELETE FROM job_runs WHERE recording_id = ?', [id]);
      run(context.database, 'DELETE FROM recordings WHERE id = ?', [id]);
      pruneTags(context.database);

      return { removed: true, id, audioMovedToTrash: movedTo };
    }),
  );
}
