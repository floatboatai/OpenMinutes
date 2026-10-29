// ABOUTME: node:sqlite 的薄封装与通用行读取工具，避免各处重复断言列类型。

import type { DatabaseSync } from 'node:sqlite';

export type SqlParam = string | number | null;
export type Row = Record<string, unknown>;

export function rows(db: DatabaseSync, sql: string, params: SqlParam[] = []): Row[] {
  const statement = db.prepare(sql);
  return statement.all(...(params as never[])) as unknown as Row[];
}

export function row(db: DatabaseSync, sql: string, params: SqlParam[] = []): Row | undefined {
  const statement = db.prepare(sql);
  return statement.get(...(params as never[])) as unknown as Row | undefined;
}

export function run(db: DatabaseSync, sql: string, params: SqlParam[] = []): { changes: number; lastId: number } {
  const statement = db.prepare(sql);
  const result = statement.run(...(params as never[]));
  return { changes: Number(result.changes), lastId: Number(result.lastInsertRowid) };
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function numOr(value: unknown, fallback: number): number {
  return num(value) ?? fallback;
}

export function str(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

export function strOr(value: unknown, fallback: string): string {
  return str(value) ?? fallback;
}

export function bool(value: unknown): boolean {
  return num(value) === 1;
}

export function jsonArray(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// -------------------------------------------------------------- 设置

export function readSettings(db: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of rows(db, 'SELECT key, value FROM settings ORDER BY key')) {
    if (item.key === 'sdk_dir') continue;
    map.set(strOr(item.key, ''), strOr(item.value, ''));
  }
  return map;
}

export function readSetting(db: DatabaseSync, key: string, fallback = ''): string {
  const found = row(db, 'SELECT value FROM settings WHERE key = ?', [key]);
  return found ? strOr(found.value, fallback) : fallback;
}

export function writeSetting(db: DatabaseSync, key: string, value: string): void {
  run(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

// -------------------------------------------------------------- 任务记录

export function startJob(db: DatabaseSync, kind: string, recordingId: number | null): number {
  return run(db, 'INSERT INTO job_runs (kind, recording_id, status, started_at) VALUES (?, ?, ?, ?)', [
    kind,
    recordingId,
    'running',
    nowIso(),
  ]).lastId;
}

export function finishJob(
  db: DatabaseSync,
  jobId: number,
  status: 'success' | 'failure' | 'interrupted',
  message: string | null,
  detail?: unknown,
): void {
  run(db, 'UPDATE job_runs SET status = ?, message = ?, detail_json = ?, finished_at = ? WHERE id = ?', [
    status,
    message,
    detail === undefined ? null : JSON.stringify(detail).slice(0, 20000),
    nowIso(),
    jobId,
  ]);
}

export const INTERRUPTED_TASK_MESSAGE = '上次处理因服务重启中断，可重新开始';

export interface RecoveryResult {
  recordings: number;
  jobs: number;
}

/** 将进程退出时遗留的持久化任务恢复为可重试状态。 */
export function recoverInterruptedTasks(db: DatabaseSync): RecoveryResult {
  const timestamp = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    const recordings = run(
      db,
      `UPDATE recordings
          SET status = 'failed', last_error = ?, updated_at = ?
        WHERE status IN ('transcribing', 'analyzing')`,
      [INTERRUPTED_TASK_MESSAGE, timestamp],
    ).changes;
    const jobs = run(
      db,
      `UPDATE job_runs
          SET status = 'failure', message = ?, finished_at = ?
        WHERE status = 'running'`,
      [INTERRUPTED_TASK_MESSAGE, timestamp],
    ).changes;
    db.exec('COMMIT');
    return { recordings, jobs };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function touchRecording(db: DatabaseSync, id: number, patch: Record<string, SqlParam>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const assignments = keys.map((key) => `${key} = ?`).join(', ');
  const values = keys.map((key) => patch[key]);
  run(db, `UPDATE recordings SET ${assignments}, updated_at = ? WHERE id = ?`, [...values, nowIso(), id]);
}

// -------------------------------------------------------------- 标签

export function syncTags(
  db: DatabaseSync,
  recordingId: number,
  names: string[],
  source: 'ai' | 'user',
  replaceAll = false,
): void {
  const cleaned = [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 24);
  if (replaceAll) run(db, 'DELETE FROM recording_tags WHERE recording_id = ?', [recordingId]);
  else run(db, 'DELETE FROM recording_tags WHERE recording_id = ? AND source = ?', [recordingId, source]);
  for (const name of cleaned) {
    const existing = row(db, 'SELECT id FROM tags WHERE name = ?', [name]);
    const tagId = existing ? numOr(existing.id, 0) : run(db, 'INSERT INTO tags (name, created_at) VALUES (?, ?)', [name, nowIso()]).lastId;
    if (tagId > 0) {
      run(db, 'INSERT OR IGNORE INTO recording_tags (recording_id, tag_id, source) VALUES (?, ?, ?)', [
        recordingId,
        tagId,
        source,
      ]);
    }
  }
}

export function readTags(db: DatabaseSync, recordingId: number): Array<{ id: number; name: string }> {
  return rows(
    db,
    `SELECT t.id AS id, t.name AS name
       FROM recording_tags rt JOIN tags t ON t.id = rt.tag_id
      WHERE rt.recording_id = ?
      ORDER BY t.name COLLATE NOCASE`,
    [recordingId],
  ).map((item) => ({ id: numOr(item.id, 0), name: strOr(item.name, '') }));
}

/** 清理没有任何录音引用的标签，避免筛选器堆积僵尸项。 */
export function pruneTags(db: DatabaseSync): void {
  run(db, 'DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM recording_tags)');
}
