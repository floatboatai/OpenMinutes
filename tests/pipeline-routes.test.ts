import assert from 'node:assert/strict';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createWorkbenchServer } from '../sdk/runtime.mjs';
import { enqueue } from '../src/server/queue.ts';
import { registerPipelineRoutes } from '../src/server/routes/pipeline.ts';
import { registerRecordingRoutes } from '../src/server/routes/recordings.ts';

test('HTTP enqueue exposes waiting tasks, rejects duplicates, and publishes terminal errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-queue-'));
  const blocker = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  let close: (() => Promise<void>) | undefined;
  let drainQueued = false;
  try {
    await cp(new URL('../migrations/', import.meta.url), path.join(root, 'migrations'), { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      appId: 'queue-test', name: 'test', version: '1',
      server: fileURLToPath(import.meta.url), ui: '.', migrations: 'migrations', resources: [],
    }));
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({
      appId: 'queue-test', generation: '1', nonce: 'test', sourceDirectory: root,
      dataDirectory: path.join(root, 'data'),
    }));
    const app = await createWorkbenchServer(import.meta.url, { configPath });
    close = () => app.close();
    registerPipelineRoutes(app);
    registerRecordingRoutes(app);
    app.database.exec(`
      INSERT INTO recordings (id, filename, dedupe_key, storage_path, status, transcript_text) VALUES
        (1, 'one.mp3', 'one', 'one.mp3', 'ready', 'text'),
        (2, 'two.mp3', 'two', 'two.mp3', 'transcribed', 'text'),
        (3, 'three.mp3', 'three', 'three.mp3', 'ready', 'text'),
        (4, 'four.mp3', 'four', 'four.mp3', 'transcribed', 'text');
    `);
    const { url } = await app.listen();
    const get = async (route: string) => (await fetch(`${url}${route}`)).json();
    const post = async (route: string, body = {}) => (await fetch(`${url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    enqueue('test:blocker', () => blocker.promise);
    assert.equal((await post('/api/recordings/1/transcribe')).data.queued, true);
    assert.equal((await post('/api/recordings/2/organize')).data.queued, true);
    assert.equal((await get('/api/recordings/1')).data.recording.status, 'queued_transcribe');
    assert.equal((await get('/api/recordings/2')).data.recording.status, 'queued_organize');
    for (const id of [1, 2]) {
      for (const kind of ['transcribe', 'organize']) {
        assert.equal((await post(`/api/recordings/${id}/${kind}`)).code, 'BUSY');
      }
    }
    assert.deepEqual((await post('/api/recordings/batch/transcribe', { ids: [1, 2, 3] })).data,
      { accepted: 1, skipped: 2, ids: [3] });
    assert.deepEqual((await post('/api/recordings/batch/organize', { ids: [1, 2, 4] })).data,
      { accepted: 1, skipped: 2, ids: [4] });
    const list = (await get('/api/recordings?stage=failed&limit=1')).data;
    assert.equal(list.items.length, 0);
    assert.equal(list.hasActiveTasks, true);

    // Exercise the real pipeline's preflight failure without requiring ffmpeg or audio.
    app.database.exec('UPDATE recordings SET storage_path = NULL WHERE id IN (1, 3)');
    enqueue('test:drain', async () => drained.resolve());
    drainQueued = true;
    blocker.resolve();
    await drained.promise;
    for (const id of [1, 3]) {
      const detail = (await get(`/api/recordings/${id}`)).data;
      assert.equal(detail.recording.status, 'failed');
      assert.match(detail.lastError, /音频文件/);
    }
    for (const id of [2, 4]) {
      const detail = (await get(`/api/recordings/${id}`)).data;
      assert.equal(detail.recording.status, 'transcribed');
      assert.match(detail.lastError, /HOST_NOT_CONNECTED/);
      assert.equal(detail.jobs[0].status, 'failure');
    }
    assert.equal((await get('/api/recordings')).data.hasActiveTasks, false);
  } finally {
    if (!drainQueued) enqueue('test:drain', async () => drained.resolve());
    blocker.resolve();
    await drained.promise;
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});
