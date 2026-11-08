import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { WorkbenchServer } from '../sdk/runtime.mjs';
import { isBusyStatus } from '../src/contracts/recording-status.ts';
import { resumeQueuedTasks } from '../src/server/jobs.ts';
import { queueSnapshot, whenIdle } from '../src/server/queue.ts';
import {
  INTERRUPTED_TASK_MESSAGE,
  recoverInterruptedTasks,
  row,
  rows,
} from '../src/server/sql.ts';
import { countCheckpoints } from '../src/server/transcribe-checkpoints.ts';
import { fakeAsr } from './support/fake-asr.ts';

function plainRows(sql: string, db: DatabaseSync): Array<Record<string, unknown>> {
  return rows(db, sql).map((item) => Object.fromEntries(Object.entries(item)));
}

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  return db;
}

test('启动恢复把被打断与原排队的录音重新入队，检查点保留，重复启动不重复排队', async () => {
  const db = createDatabase();
  try {
    // 没有音频路径，重新入队后会以 NO_AUDIO_FILE 快速结束，不需要 ffmpeg。
    db.exec(`
      INSERT INTO recordings (id, filename, dedupe_key, storage_path, status, transcript_text) VALUES
        (1, 'transcribing.mp3', 'transcribing', NULL, 'transcribing', ''),
        (2, 'analyzing.mp3', 'analyzing', 'analyzing.mp3', 'analyzing', '已有转录'),
        (3, 'queued.mp3', 'queued', NULL, 'ready', ''),
        (4, 'failed.mp3', 'failed', 'failed.mp3', 'failed', ''),
        (5, 'queued-organize.mp3', 'queued-organize', 'queued-organize.mp3', 'transcribed', '已有转录');
      INSERT INTO queued_tasks (recording_id, kind, queued_at) VALUES
        (1, 'transcribe', '2026-11-08T00:00:01Z'),
        (3, 'transcribe', '2026-11-08T00:00:02Z'),
        (5, 'organize', '2026-11-08T00:00:03Z');
      INSERT INTO transcribe_checkpoints (recording_id, chunk_index, offset_ms, end_ms, segments_json, source_size, source_mtime_ms, params_fingerprint)
        VALUES (1, 0, 0, 300000, '[]', 10, 1, 'p');
      INSERT INTO job_runs (id, kind, recording_id, status, message) VALUES
        (11, 'transcribe', 1, 'running', '处理中'),
        (12, 'organize', 2, 'running', '处理中'),
        (13, 'transcribe', 3, 'success', '完成');
    `);

    const first = recoverInterruptedTasks(db);
    assert.equal(first.recordings, 2);
    assert.equal(first.jobs, 2);
    const expected = [
      { recordingId: 1, kind: 'transcribe' },
      { recordingId: 3, kind: 'transcribe' },
      { recordingId: 5, kind: 'organize' },
      { recordingId: 2, kind: 'organize' },
    ];
    assert.deepEqual(first.requeue, expected);
    assert.deepEqual(
      plainRows('SELECT id, status, last_error FROM recordings ORDER BY id', db),
      [
        { id: 1, status: 'ready', last_error: null },
        { id: 2, status: 'transcribed', last_error: null },
        { id: 3, status: 'ready', last_error: null },
        { id: 4, status: 'failed', last_error: null },
        { id: 5, status: 'transcribed', last_error: null },
      ],
    );
    assert.deepEqual(
      plainRows('SELECT id, status, message, finished_at IS NOT NULL AS finished FROM job_runs ORDER BY id', db),
      [
        { id: 11, status: 'interrupted', message: INTERRUPTED_TASK_MESSAGE, finished: 1 },
        { id: 12, status: 'interrupted', message: INTERRUPTED_TASK_MESSAGE, finished: 1 },
        { id: 13, status: 'success', message: '完成', finished: 0 },
      ],
    );
    assert.equal(countCheckpoints(db, 1), 1);
    assert.equal(isBusyStatus(String(row(db, 'SELECT status FROM recordings WHERE id = 1')?.status)), false);

    // 第二次启动（例如恢复中途又崩溃）：状态与意图不变，不产生重复意图。
    const second = recoverInterruptedTasks(db);
    assert.deepEqual(second, { recordings: 0, jobs: 0, requeue: expected });
    assert.equal(row(db, 'SELECT COUNT(*) AS n FROM queued_tasks')?.n, 4);

    const app = { database: db, host: fakeAsr().host, trackTask: (operation: () => Promise<unknown>) => operation() } as unknown as WorkbenchServer;
    assert.equal(resumeQueuedTasks(app, second.requeue), 4);
    assert.equal(resumeQueuedTasks(app, second.requeue), 0);
    assert.deepEqual(queueSnapshot().sort(), ['organize:2', 'organize:5', 'transcribe:1', 'transcribe:3']);

    await whenIdle();
    // 每条都真正执行过一次，结束后意图清空。
    assert.equal(row(db, "SELECT COUNT(*) AS n FROM job_runs WHERE kind = 'organize' AND id > 13")?.n, 2);
    assert.match(String(row(db, 'SELECT last_error FROM recordings WHERE id = 1')?.last_error), /音频文件/);
    assert.equal(row(db, 'SELECT COUNT(*) AS n FROM queued_tasks')?.n, 0);
    // 转录失败时检查点保留，下次可继续。
    assert.equal(countCheckpoints(db, 1), 1);
  } finally {
    db.close();
  }
});

test('启动恢复幂等，正常 ready/failed 记录不受影响', () => {
  const db = createDatabase();
  try {
    db.exec(`
      INSERT INTO recordings (id, filename, dedupe_key, status, last_error) VALUES
        (1, 'ready.mp3', 'ready', 'ready', NULL),
        (2, 'failed.mp3', 'failed', 'failed', '原有失败原因');
      INSERT INTO job_runs (id, kind, recording_id, status, message) VALUES
        (1, 'transcribe', 1, 'success', '已完成');
    `);

    assert.deepEqual(recoverInterruptedTasks(db), { recordings: 0, jobs: 0, requeue: [] });
    assert.deepEqual(recoverInterruptedTasks(db), { recordings: 0, jobs: 0, requeue: [] });
    assert.deepEqual(
      plainRows('SELECT id, status, last_error FROM recordings ORDER BY id', db),
      [
        { id: 1, status: 'ready', last_error: null },
        { id: 2, status: 'failed', last_error: '原有失败原因' },
      ],
    );
    assert.deepEqual(Object.fromEntries(Object.entries(row(db, 'SELECT status, message FROM job_runs WHERE id = 1') ?? {})), {
      status: 'success',
      message: '已完成',
    });
  } finally {
    db.close();
  }
});
