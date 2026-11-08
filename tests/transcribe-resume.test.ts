import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MAX_BUSY_ATTEMPTS, runTranscription, type PipelineDeps } from '../src/server/pipeline.ts';
import { countCheckpoints, openCheckpoints } from '../src/server/transcribe-checkpoints.ts';
import { readSetting, row, rows, writeSetting } from '../src/server/sql.ts';
import { fakeAsr, fakePcm } from './support/fake-asr.ts';

/** 150 + 150 + 50 帧（每帧 2 秒）：两个整块 + 一个 100 秒的尾块。 */
const FRAMES = 350;

function createDatabase(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  db.exec("INSERT INTO recordings (id, filename, dedupe_key, storage_path, status) VALUES (1, 'a.wav', 'a', 'a.wav', 'ready')");
  writeSetting(db, 'auto_analyze', '0');
  return db;
}

async function withAudio<T>(body: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openminutes-resume-'));
  const file = path.join(dir, 'a.wav');
  await writeFile(file, 'original audio');
  try {
    return await body(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function deps(db: DatabaseSync, file: string, host: PipelineDeps['host'], extra: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    db,
    host,
    resolveAudio: async () => file,
    resolveFfmpeg: async () => 'ffmpeg',
    decode: fakePcm(FRAMES),
    ...extra,
  };
}

function segments(db: DatabaseSync): Array<{ startMs: number; endMs: number; text: string }> {
  const stored = row(db, 'SELECT segments_json FROM transcripts WHERE recording_id = 1 ORDER BY id DESC LIMIT 1');
  return (JSON.parse(String(stored?.segments_json)) as Array<{ startMs: number; endMs: number; text: string }>)
    .map(({ startMs, endMs, text }) => ({ startMs, endMs, text }));
}

test('失败保留已完成块；重试只把剩余块送识别，偏移正确拼接，成功后删除检查点', async () => {
  const db = createDatabase();
  try {
    await withAudio(async (file) => {
      const broken = fakeAsr({ failSession: 2 });
      const first = await runTranscription(deps(db, file, broken.host), 1);
      assert.equal(first.ok, false);
      assert.equal(row(db, 'SELECT status FROM recordings WHERE id = 1')?.status, 'failed');
      assert.deepEqual(
        rows(db, 'SELECT chunk_index, offset_ms, end_ms FROM transcribe_checkpoints WHERE recording_id = 1').map((item) => ({ ...item })),
        [{ chunk_index: 0, offset_ms: 0, end_ms: 300000 }],
      );

      const healthy = fakeAsr();
      const second = await runTranscription(deps(db, file, healthy.host), 1);
      assert.equal(second.ok, true, second.message);
      // 第一块来自检查点，没有再送识别。
      assert.deepEqual(healthy.framesPerSession, [150, 50]);
      assert.deepEqual(segments(db), [
        { startMs: 0, endMs: 300000, text: '[s1]' },
        { startMs: 300000, endMs: 600000, text: '[s1]' },
        { startMs: 600000, endMs: 700000, text: '[s2]' },
      ]);
      assert.equal(row(db, 'SELECT audio_ms FROM transcripts WHERE recording_id = 1')?.audio_ms, 700000);
      assert.equal(row(db, 'SELECT status FROM recordings WHERE id = 1')?.status, 'transcribed');
      assert.equal(countCheckpoints(db, 1), 0);
    });
  } finally {
    db.close();
  }
});

test('源文件或识别参数变化时清空检查点，从头转录', async () => {
  const db = createDatabase();
  try {
    await withAudio(async (file) => {
      await runTranscription(deps(db, file, fakeAsr({ failSession: 3 }).host), 1);
      assert.equal(countCheckpoints(db, 1), 2);

      // 参数指纹不一致：直接打开即清空。
      const fingerprint = { size: 14, mtimeMs: 1, params: 'old' };
      const sink = openCheckpoints(db, 1, fingerprint);
      assert.equal(sink.completed.size, 0);
      assert.equal(countCheckpoints(db, 1), 0);
      sink.save({ index: 0, offsetMs: 0, endMs: 300000, segments: [] });
      assert.equal(openCheckpoints(db, 1, fingerprint).completed.size, 1);
      assert.equal(openCheckpoints(db, 1, { ...fingerprint, mtimeMs: 2 }).completed.size, 0);

      await runTranscription(deps(db, file, fakeAsr({ failSession: 3 }).host), 1);
      assert.equal(countCheckpoints(db, 1), 2);
      // 换了录音文件内容（大小变化）：全部重新识别。
      await writeFile(file, 'replaced audio with another size');
      const healthy = fakeAsr();
      assert.equal((await runTranscription(deps(db, file, healthy.host), 1)).ok, true);
      assert.deepEqual(healthy.framesPerSession, [150, 150, 50]);
      assert.equal(countCheckpoints(db, 1), 0);

      // 切换「区分说话人」同样作废检查点。
      await runTranscription(deps(db, file, fakeAsr({ failSession: 2 }).host), 1);
      assert.equal(countCheckpoints(db, 1), 1);
      writeSetting(db, 'speaker_diarization', readSetting(db, 'speaker_diarization', '1') === '1' ? '0' : '1');
      const again = fakeAsr();
      assert.equal((await runTranscription(deps(db, file, again.host), 1)).ok, true);
      assert.deepEqual(again.framesPerSession, [150, 150, 50]);
    });
  } finally {
    db.close();
  }
});

test('识别服务会话已满时退回排队而不标失败；超过重试次数才失败', async () => {
  const db = createDatabase();
  try {
    await withAudio(async (file) => {
      const busy = await runTranscription(deps(db, file, fakeAsr({ busyStarts: 1 }).host), 1);
      assert.equal(busy.ok, false);
      assert.equal(busy.retryAfterMs, 5000);
      assert.deepEqual({ ...row(db, 'SELECT status, last_error FROM recordings WHERE id = 1') }, { status: 'ready', last_error: null });
      assert.equal(row(db, "SELECT status FROM job_runs WHERE kind = 'transcribe' ORDER BY id DESC")?.status, 'interrupted');

      const exhausted = await runTranscription(deps(db, file, fakeAsr({ busyStarts: 1 }).host), 1, { attempt: MAX_BUSY_ATTEMPTS });
      assert.equal(exhausted.retryAfterMs, undefined);
      assert.deepEqual(
        { ...row(db, 'SELECT status, last_error_code FROM recordings WHERE id = 1') },
        { status: 'failed', last_error_code: 'ASR_BUSY' },
      );
    });
  } finally {
    db.close();
  }
});

test('自动归类改为转录成功后排进归类车道，不在转录任务里执行', async () => {
  const db = createDatabase();
  try {
    writeSetting(db, 'auto_analyze', '1');
    await withAudio(async (file) => {
      const queued: number[] = [];
      const result = await runTranscription(deps(db, file, fakeAsr().host, { queueOrganization: (id) => queued.push(id) }), 1);
      assert.equal(result.ok, true, result.message);
      assert.deepEqual(queued, [1]);
      assert.equal(row(db, "SELECT COUNT(*) AS n FROM job_runs WHERE kind = 'organize'")?.n, 0);
    });
  } finally {
    db.close();
  }
});
