// ABOUTME: 录音、分类与总览的读取查询，SQL 集中在本模块便于校验。

import type { DatabaseSync } from 'node:sqlite';
import type {
  AnalysisRecord,
  Category,
  Overview,
  RecordingDetail,
  RecordingSource,
  RecordingStatus,
  RecordingSummary,
  TranscriptRecord,
  TranscriptSegment,
} from '../contracts/app';
import { bool, jsonArray, num, numOr, row, rows, str, strOr } from './sql';
import { likePattern } from '../contracts/input';

const RECORDING_SELECT = `
  SELECT r.id, r.filename, r.title, r.source, r.status, r.category_id,
         r.duration_sec, r.size_bytes, r.recorded_at, r.created_at, r.importance,
         r.summary, r.is_favorite, r.is_archived, r.device_serial, r.storage_path,
         r.last_error,
         LENGTH(COALESCE(r.transcript_text, '')) AS transcript_chars,
         c.name AS category_name, c.color AS category_color
    FROM recordings r
    LEFT JOIN categories c ON c.id = r.category_id`;

const STAGE_FILTERS: Record<string, string> = {
  'need-transcribe': "r.status IN ('pending', 'ready')",
  'need-organize': "r.status = 'transcribed'",
  busy: "r.status IN ('transcribing', 'analyzing')",
  done: "r.status = 'organized'",
  failed: "r.status = 'failed'",
  summarized: "r.status IN ('organized', 'analyzing')",
};

const SORT_ORDERS: Record<string, string> = {
  newest: 'r.created_at DESC, r.id DESC',
  recorded: 'COALESCE(r.recorded_at, r.created_at) DESC, r.id DESC',
  duration: 'COALESCE(r.duration_sec, 0) DESC, r.id DESC',
  importance: 'COALESCE(r.importance, 0) DESC, r.id DESC',
  shortest: 'COALESCE(r.duration_sec, 999999) ASC, r.id DESC',
};

export interface ListFilters {
  q?: string;
  stage?: string;
  categoryId?: number;
  tag?: string;
  favorite?: boolean;
  archived?: boolean;
  sort?: string;
  limit?: number;
  offset?: number;
}

function toSummary(source: Record<string, unknown>, tagMap: Map<number, Array<{ id: number; name: string }>>): RecordingSummary {
  const id = numOr(source.id, 0);
  return {
    id,
    filename: strOr(source.filename, ''),
    title: str(source.title),
    source: strOr(source.source, 'folder_import') as RecordingSource,
    status: strOr(source.status, 'pending') as RecordingStatus,
    categoryId: num(source.category_id),
    categoryName: str(source.category_name),
    categoryColor: str(source.category_color),
    durationSec: num(source.duration_sec),
    sizeBytes: num(source.size_bytes),
    recordedAt: str(source.recorded_at),
    createdAt: strOr(source.created_at, ''),
    importance: num(source.importance),
    summary: str(source.summary),
    isFavorite: bool(source.is_favorite),
    isArchived: bool(source.is_archived),
    transcriptChars: numOr(source.transcript_chars, 0),
    hasAudioFile: typeof source.storage_path === 'string' && source.storage_path.length > 0,
    deviceSerial: str(source.device_serial),
    tags: tagMap.get(id) ?? [],
  };
}

export function loadTagMap(db: DatabaseSync, ids: number[]): Map<number, Array<{ id: number; name: string }>> {
  const map = new Map<number, Array<{ id: number; name: string }>>();
  if (ids.length === 0) return map;
  const placeholders = ids.map(() => '?').join(', ');
  for (const item of rows(
    db,
    `SELECT rt.recording_id AS rid, t.id AS id, t.name AS name
       FROM recording_tags rt JOIN tags t ON t.id = rt.tag_id
      WHERE rt.recording_id IN (${placeholders})
      ORDER BY t.name COLLATE NOCASE`,
    ids,
  )) {
    const rid = numOr(item.rid, 0);
    const list = map.get(rid) ?? [];
    list.push({ id: numOr(item.id, 0), name: strOr(item.name, '') });
    map.set(rid, list);
  }
  return map;
}

export function listRecordings(db: DatabaseSync, filters: ListFilters): { items: RecordingSummary[]; total: number } {
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filters.archived === true) where.push('r.is_archived = 1');
  else if (filters.archived !== undefined) where.push('r.is_archived = 0');

  if (filters.stage && STAGE_FILTERS[filters.stage]) where.push(STAGE_FILTERS[filters.stage]);
  if (filters.categoryId !== undefined) {
    where.push('r.category_id = ?');
    params.push(filters.categoryId);
  }
  if (filters.favorite) where.push('r.is_favorite = 1');
  if (filters.tag) {
    where.push('r.id IN (SELECT rt.recording_id FROM recording_tags rt JOIN tags t ON t.id = rt.tag_id WHERE t.name = ?)');
    params.push(filters.tag);
  }
  if (filters.q) {
    const pattern = likePattern(filters.q);
    where.push(
      `(r.filename LIKE ? ESCAPE '\\' OR COALESCE(r.title, '') LIKE ? ESCAPE '\\'
        OR COALESCE(r.summary, '') LIKE ? ESCAPE '\\' OR COALESCE(r.transcript_text, '') LIKE ? ESCAPE '\\')`,
    );
    params.push(pattern, pattern, pattern, pattern);
  }

  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = numOr(row(db, `SELECT COUNT(*) AS n FROM recordings r ${clause}`, params)?.n, 0);
  const order = SORT_ORDERS[filters.sort ?? 'newest'] ?? SORT_ORDERS.newest;
  const limit = Math.min(Math.max(filters.limit ?? 60, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const records = rows(db, `${RECORDING_SELECT} ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, [
    ...params,
    limit,
    offset,
  ]);
  const tagMap = loadTagMap(
    db,
    records.map((item) => numOr(item.id, 0)),
  );
  return { items: records.map((item) => toSummary(item, tagMap)), total };
}

export function readRecordingSummary(db: DatabaseSync, id: number): RecordingSummary | null {
  const found = row(db, `${RECORDING_SELECT} WHERE r.id = ?`, [id]);
  if (!found) return null;
  return toSummary(found, loadTagMap(db, [id]));
}

function parseSegments(raw: unknown): TranscriptSegment[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): TranscriptSegment[] => {
      if (item === null || typeof item !== 'object') return [];
      const record = item as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text : '';
      if (!text) return [];
      return [
        {
          startMs: numOr(record.startMs, 0),
          endMs: numOr(record.endMs, 0),
          text,
          speaker: str(record.speaker),
        },
      ];
    });
  } catch {
    return [];
  }
}

function toAnalysis(source: Record<string, unknown> | undefined): AnalysisRecord | null {
  if (!source) return null;
  return {
    id: numOr(source.id, 0),
    model: str(source.model),
    title: str(source.title),
    summary: str(source.summary),
    categorySlug: str(source.category_slug),
    keyPoints: jsonArray(source.key_points_json),
    actionItems: jsonArray(source.action_items_json),
    tags: jsonArray(source.tags_json),
    importance: num(source.importance),
    sentiment: str(source.sentiment),
    createdAt: strOr(source.created_at, ''),
  };
}

export function readRecordingDetail(db: DatabaseSync, id: number): RecordingDetail | null {
  const detail = row(db, 'SELECT id, storage_path, last_error FROM recordings WHERE id = ?', [id]);
  if (!detail) return null;
  const summary = readRecordingSummary(db, id);
  if (!summary) return null;

  const transcriptRow = row(
    db,
    'SELECT id, engine, language, text, segments_json, char_count, audio_ms, created_at FROM transcripts WHERE recording_id = ? ORDER BY id DESC LIMIT 1',
    [id],
  );
  const transcript: TranscriptRecord | null = transcriptRow
    ? {
        id: numOr(transcriptRow.id, 0),
        engine: strOr(transcriptRow.engine, 'host-asr'),
        language: str(transcriptRow.language),
        text: strOr(transcriptRow.text, ''),
        charCount: numOr(transcriptRow.char_count, 0),
        audioMs: num(transcriptRow.audio_ms),
        createdAt: strOr(transcriptRow.created_at, ''),
      }
    : null;

  const analysis = toAnalysis(
    row(db, 'SELECT * FROM analyses WHERE recording_id = ? ORDER BY id DESC LIMIT 1', [id]),
  );

  const jobs = rows(
    db,
    'SELECT id, kind, status, message, started_at, finished_at FROM job_runs WHERE recording_id = ? ORDER BY id DESC LIMIT 8',
    [id],
  ).map((item) => ({
    id: numOr(item.id, 0),
    kind: strOr(item.kind, ''),
    status: strOr(item.status, ''),
    message: str(item.message),
    startedAt: strOr(item.started_at, ''),
    finishedAt: str(item.finished_at),
  }));

  return {
    recording: summary,
    transcript,
    segments: parseSegments(transcriptRow?.segments_json),
    analysis,
    jobs,
    lastError: str(detail.last_error),
    storagePath: str(detail.storage_path),
  };
}

export function listCategories(db: DatabaseSync): Category[] {
  return rows(
    db,
    `SELECT c.id, c.slug, c.name, c.color, c.icon, c.description, c.sort_order, c.is_system,
            (SELECT COUNT(*) FROM recordings r WHERE r.category_id = c.id AND r.is_archived = 0) AS recording_count
       FROM categories c
      ORDER BY c.sort_order, c.name`,
  ).map((item) => ({
    id: numOr(item.id, 0),
    slug: strOr(item.slug, ''),
    name: strOr(item.name, ''),
    color: strOr(item.color, '#237a63'),
    icon: strOr(item.icon, 'folder'),
    description: str(item.description),
    sortOrder: numOr(item.sort_order, 100),
    isSystem: bool(item.is_system),
    recordingCount: numOr(item.recording_count, 0),
  }));
}

export function listTagNames(db: DatabaseSync): Array<{ name: string; count: number }> {
  return rows(
    db,
    `SELECT t.name AS name, COUNT(*) AS n
       FROM recording_tags rt JOIN tags t ON t.id = rt.tag_id
       JOIN recordings r ON r.id = rt.recording_id AND r.is_archived = 0
      GROUP BY t.name ORDER BY n DESC, t.name COLLATE NOCASE LIMIT 80`,
  ).map((item) => ({ name: strOr(item.name, ''), count: numOr(item.n, 0) }));
}

export function buildOverview(db: DatabaseSync): Overview {
  const totals = row(
    db,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(duration_sec), 0) AS duration,
            SUM(CASE WHEN status IN ('transcribed','organized') THEN 1 ELSE 0 END) AS transcribed,
            SUM(CASE WHEN status = 'organized' THEN 1 ELSE 0 END) AS organized,
            SUM(CASE WHEN status IN ('pending','ready') THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN is_favorite = 1 THEN 1 ELSE 0 END) AS favorite
       FROM recordings WHERE is_archived = 0`,
  );
  const today = new Date().toISOString().slice(0, 10);
  const unreviewed = numOr(
    row(
      db,
      `SELECT COUNT(*) AS n FROM recordings
        WHERE is_archived = 0 AND status IN ('pending','ready','transcribed')
          AND substr(COALESCE(recorded_at, created_at), 1, 10) = ?`,
      [today],
    )?.n,
    0,
  );

  const byCategory = rows(
    db,
    `SELECT c.id, c.name, c.color, COUNT(r.id) AS n, COALESCE(SUM(r.duration_sec), 0) AS duration
       FROM categories c
       LEFT JOIN recordings r ON r.category_id = c.id AND r.is_archived = 0
      GROUP BY c.id ORDER BY n DESC, c.sort_order`,
  ).map((item) => ({
    id: numOr(item.id, 0),
    name: strOr(item.name, ''),
    color: strOr(item.color, '#237a63'),
    count: numOr(item.n, 0),
    durationSec: numOr(item.duration, 0),
  }));

  const byStatus = rows(
    db,
    'SELECT status, COUNT(*) AS n FROM recordings WHERE is_archived = 0 GROUP BY status',
  ).map((item) => ({ status: strOr(item.status, 'pending') as RecordingStatus, count: numOr(item.n, 0) }));

  const deviceRow = row(
    db,
    `SELECT serial, model, firmware, battery_pct, free_space_pct, last_seen_at
       FROM devices ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1`,
  );
  const lastSeenAt = deviceRow ? str(deviceRow.last_seen_at) : null;
  const seenRecently = lastSeenAt ? Date.now() - new Date(lastSeenAt).getTime() < 6 * 60 * 1000 : false;
  const pendingPulls = numOr(
    row(db, "SELECT COUNT(*) AS n FROM recordings WHERE is_archived = 0 AND status = 'pending'")?.n,
    0,
  );
  const readyToTranscribe = numOr(
    row(db, "SELECT COUNT(*) AS n FROM recordings WHERE is_archived = 0 AND status = 'ready'")?.n,
    0,
  );
  const device = deviceRow
    ? {
        serial: strOr(deviceRow.serial, ''),
        model: strOr(deviceRow.model, 'MemoTalk S1'),
        firmware: str(deviceRow.firmware),
        batteryPct: num(deviceRow.battery_pct),
        freeSpacePct: num(deviceRow.free_space_pct),
        lastSeenAt,
        connected: seenRecently,
        pendingPulls,
        readyToTranscribe,
      }
    : null;

  return {
    totalRecordings: numOr(totals?.total, 0),
    totalDurationSec: numOr(totals?.duration, 0),
    transcribedCount: numOr(totals?.transcribed, 0),
    organizedCount: numOr(totals?.organized, 0),
    pendingCount: numOr(totals?.pending, 0),
    failedCount: numOr(totals?.failed, 0),
    favoriteCount: numOr(totals?.favorite, 0),
    unreviewedToday: unreviewed,
    byCategory,
    byStatus,
    recent: listRecordings(db, { limit: 5, sort: 'recorded' }).items,
    device,
  };
}
