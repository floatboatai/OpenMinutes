import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isBusyStatus } from '../src/contracts/recording-status.ts';
import { enqueue, queueSnapshot } from '../src/server/queue.ts';
import {
  INTERRUPTED_TASK_MESSAGE,
  recoverInterruptedTasks,
  row,
  rows,
} from '../src/server/sql.ts';

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

test('启动恢复会收尾残留任务，并让录音可以再次排队', async () => {
  const db = createDatabase();
  try {
    db.exec(`
      INSERT INTO recordings (id, filename, dedupe_key, storage_path, status, transcript_text) VALUES
        (1, 'transcribing.mp3', 'transcribing', 'transcribing.mp3', 'transcribing', ''),
        (2, 'analyzing.mp3', 'analyzing', 'analyzing.mp3', 'analyzing', '已有转录'),
        (3, 'ready.mp3', 'ready', 'ready.mp3', 'ready', ''),
        (4, 'failed.mp3', 'failed', 'failed.mp3', 'failed', '');
      INSERT INTO job_runs (id, kind, recording_id, status, message) VALUES
        (11, 'transcribe', 1, 'running', '处理中'),
        (12, 'organize', 2, 'running', '处理中'),
        (13, 'transcribe', 3, 'success', '完成');
    `);

    assert.deepEqual(recoverInterruptedTasks(db), { recordings: 2, jobs: 2 });

    assert.deepEqual(
      plainRows('SELECT id, status, last_error FROM recordings ORDER BY id', db),
      [
        { id: 1, status: 'failed', last_error: INTERRUPTED_TASK_MESSAGE },
        { id: 2, status: 'failed', last_error: INTERRUPTED_TASK_MESSAGE },
        { id: 3, status: 'ready', last_error: null },
        { id: 4, status: 'failed', last_error: null },
      ],
    );
    assert.deepEqual(
      plainRows('SELECT id, status, message, finished_at IS NOT NULL AS finished FROM job_runs ORDER BY id', db),
      [
        { id: 11, status: 'failure', message: INTERRUPTED_TASK_MESSAGE, finished: 1 },
        { id: 12, status: 'failure', message: INTERRUPTED_TASK_MESSAGE, finished: 1 },
        { id: 13, status: 'success', message: '完成', finished: 0 },
      ],
    );
    assert.equal(isBusyStatus(String(row(db, 'SELECT status FROM recordings WHERE id = 1')?.status)), false);
    assert.equal(isBusyStatus(String(row(db, 'SELECT status FROM recordings WHERE id = 2')?.status)), false);

    const blocker = Promise.withResolvers<void>();
    const drained = Promise.withResolvers<void>();
    enqueue('test:startup-recovery-blocker', () => blocker.promise);
    enqueue('transcribe:1', async () => undefined);
    enqueue('organize:2', async () => undefined);
    enqueue('test:startup-recovery-drain', async () => drained.resolve());
    assert.deepEqual(queueSnapshot().slice(-3), ['transcribe:1', 'organize:2', 'test:startup-recovery-drain']);
    blocker.resolve();
    await drained.promise;
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

    assert.deepEqual(recoverInterruptedTasks(db), { recordings: 0, jobs: 0 });
    assert.deepEqual(recoverInterruptedTasks(db), { recordings: 0, jobs: 0 });
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
