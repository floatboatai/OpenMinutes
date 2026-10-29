import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { isBusyStatus } from '../src/contracts/recording-status.ts';
import { enqueue } from '../src/server/queue.ts';
import { listRecordings, readRecordingDetail } from '../src/server/repo.ts';

test('queued recordings remain observable until the serial queue settles', async () => {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  db.exec(`
    INSERT INTO recordings (id, filename, dedupe_key, status) VALUES
      (1, 'first.mp3', 'first', 'ready'),
      (2, 'second.mp3', 'second', 'transcribed');
  `);
  const blocker = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  enqueue('test:blocker', () => blocker.promise);
  enqueue('transcribe:1', async () => {
    db.exec("UPDATE recordings SET status = 'failed', last_error = 'HOST_NOT_CONNECTED' WHERE id = 1");
  });
  enqueue('organize:2', async () => {
    db.exec("UPDATE recordings SET status = 'organized' WHERE id = 2");
  });
  enqueue('test:drain', async () => drained.resolve());
  try {
    assert.equal(readRecordingDetail(db, 1)?.recording.status, 'queued_transcribe');
    assert.equal(readRecordingDetail(db, 2)?.recording.status, 'queued_organize');
    assert.equal(listRecordings(db, {}).hasActiveTasks, true);
    assert.equal(listRecordings(db, { q: 'no-match', limit: 1 }).hasActiveTasks, true);
    assert.equal(listRecordings(db, { offset: 2 }).hasActiveTasks, true);
    db.exec("UPDATE recordings SET status = 'transcribing' WHERE id = 1");
    db.exec("UPDATE recordings SET status = 'analyzing' WHERE id = 2");
    assert.equal(readRecordingDetail(db, 1)?.recording.status, 'transcribing');
    assert.equal(readRecordingDetail(db, 2)?.recording.status, 'analyzing');

    blocker.resolve();
    await drained.promise;
    assert.equal(readRecordingDetail(db, 1)?.recording.status, 'failed');
    assert.equal(readRecordingDetail(db, 1)?.lastError, 'HOST_NOT_CONNECTED');
    assert.equal(readRecordingDetail(db, 2)?.recording.status, 'organized');
    assert.equal(listRecordings(db, {}).hasActiveTasks, false);
    db.exec("UPDATE recordings SET status = 'analyzing' WHERE id = 2");
    assert.equal(listRecordings(db, { q: 'no-match' }).hasActiveTasks, true);
    db.exec("UPDATE recordings SET status = 'transcribed', last_error = 'HOST_NOT_CONNECTED' WHERE id = 2");
    assert.equal(listRecordings(db, {}).hasActiveTasks, false);
  } finally {
    blocker.resolve();
    await drained.promise;
    db.close();
  }
});

test('polling includes both queued kinds and stops for every terminal status', () => {
  for (const status of ['queued_transcribe', 'queued_organize', 'transcribing', 'analyzing']) {
    assert.equal(isBusyStatus(status), true, status);
  }
  for (const status of ['pending', 'ready', 'transcribed', 'organized', 'failed']) {
    assert.equal(isBusyStatus(status), false, status);
  }
});

test('rejected tasks are removed and do not leave polling enabled', async () => {
  const drained = Promise.withResolvers<void>();
  enqueue('transcribe:99', async () => { throw new Error('test failure'); });
  enqueue('test:drain', async () => drained.resolve());
  await drained.promise;
  const { hasRecordingTasks, queuedRecordingStatus } = await import('../src/server/queue.ts');
  assert.equal(queuedRecordingStatus(99), null);
  assert.equal(hasRecordingTasks(), false);
});
