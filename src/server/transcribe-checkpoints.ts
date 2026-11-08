// ABOUTME: 断点续转的检查点存储与转录/归类排队意图：都在 SQLite 里，重启后仍可继续。

import type { DatabaseSync } from 'node:sqlite';
import type { TranscriptSegment } from '../contracts/app';
import type { CheckpointSink, ChunkCheckpoint } from './transcribe';
import { num, nowIso, rows, run, strOr } from './sql';

/** 源文件指纹（大小 + 修改时间）与识别参数指纹；任何一项变化，旧检查点都作废。 */
export interface CheckpointFingerprint {
  size: number;
  mtimeMs: number;
  params: string;
}

function parseSegments(raw: unknown): TranscriptSegment[] {
  try {
    const parsed: unknown = JSON.parse(strOr(raw, '[]'));
    return Array.isArray(parsed) ? (parsed as TranscriptSegment[]) : [];
  } catch {
    return [];
  }
}

export function clearCheckpoints(db: DatabaseSync, recordingId: number): void {
  run(db, 'DELETE FROM transcribe_checkpoints WHERE recording_id = ?', [recordingId]);
}

export function countCheckpoints(db: DatabaseSync, recordingId: number): number {
  return rows(db, 'SELECT chunk_index FROM transcribe_checkpoints WHERE recording_id = ?', [recordingId]).length;
}

/** 读出与指纹一致的检查点；不一致时清空，从头转录。 */
export function openCheckpoints(db: DatabaseSync, recordingId: number, fingerprint: CheckpointFingerprint): CheckpointSink {
  const stored = rows(
    db,
    `SELECT chunk_index, offset_ms, end_ms, segments_json, source_size, source_mtime_ms, params_fingerprint
       FROM transcribe_checkpoints WHERE recording_id = ? ORDER BY chunk_index`,
    [recordingId],
  );
  const stale = stored.some((item) =>
    num(item.source_size) !== fingerprint.size
    || num(item.source_mtime_ms) !== fingerprint.mtimeMs
    || strOr(item.params_fingerprint, '') !== fingerprint.params);
  const completed = new Map<number, ChunkCheckpoint>();
  if (stale) {
    clearCheckpoints(db, recordingId);
  } else {
    for (const item of stored) {
      const index = num(item.chunk_index) ?? -1;
      completed.set(index, {
        index,
        offsetMs: num(item.offset_ms) ?? 0,
        endMs: num(item.end_ms) ?? 0,
        segments: parseSegments(item.segments_json),
      });
    }
  }
  return {
    completed,
    save: (chunk) => {
      run(
        db,
        `INSERT OR REPLACE INTO transcribe_checkpoints
           (recording_id, chunk_index, offset_ms, end_ms, segments_json, source_size, source_mtime_ms, params_fingerprint, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          recordingId,
          chunk.index,
          chunk.offsetMs,
          chunk.endMs,
          JSON.stringify(chunk.segments),
          fingerprint.size,
          fingerprint.mtimeMs,
          fingerprint.params,
          nowIso(),
        ],
      );
    },
  };
}

// -------------------------------------------------------------- 排队意图

export type QueuedKind = 'transcribe' | 'organize';

export function recordQueuedTask(db: DatabaseSync, recordingId: number, kind: QueuedKind): void {
  run(db, 'INSERT OR IGNORE INTO queued_tasks (recording_id, kind, queued_at) VALUES (?, ?, ?)', [recordingId, kind, nowIso()]);
}

export function clearQueuedTask(db: DatabaseSync, recordingId: number, kind: QueuedKind): void {
  run(db, 'DELETE FROM queued_tasks WHERE recording_id = ? AND kind = ?', [recordingId, kind]);
}
