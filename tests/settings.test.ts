import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, cp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createWorkbenchServer } from '../sdk/runtime.mjs';
import { registerSettingRoutes } from '../src/server/routes/settings.ts';
import { readSetting, readSettings, writeSetting } from '../src/server/sql.ts';

test('upgrade removes only sdk_dir; settings API tolerates stale clients', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-settings-'));
  let close: (() => Promise<void>) | undefined;
  try {
    const data = path.join(root, 'data');
    await mkdir(data);
    const old = new DatabaseSync(path.join(data, 'data.sqlite'));
    old.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
    writeSetting(old, 'sdk_dir', 'C:/old-source/scripts');
    writeSetting(old, 'python_path', 'C:/venv/python.exe');
    writeSetting(old, 'ffmpeg_path', 'C:/tools/ffmpeg.exe');
    writeSetting(old, 'service_url', 'https://example.invalid');
    writeSetting(old, 'api_key', 'test-only-secret');
    old.close();
    await cp(new URL('../migrations/', import.meta.url), path.join(root, 'migrations'), { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      appId: 'settings-test', name: 'test', version: '1',
      server: fileURLToPath(import.meta.url), ui: '.', migrations: 'migrations', resources: [],
    }));
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({
      appId: 'settings-test', generation: '1', nonce: 'test', sourceDirectory: root, dataDirectory: data,
    }));
    const app = await createWorkbenchServer(import.meta.url, { configPath });
    close = () => app.close();
    registerSettingRoutes(app);
    assert.equal(readSetting(app.database, 'sdk_dir'), '');
    assert.equal(readSetting(app.database, 'python_path'), 'C:/venv/python.exe');
    assert.equal(readSetting(app.database, 'api_key'), 'test-only-secret');
    assert.equal(readSetting(app.database, 'service_url'), 'https://example.invalid');
    const { url } = await app.listen();
    const patch = async (values: unknown) => (await fetch(`${url}/api/settings`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ values }),
    })).json();
    const saved = await patch({ sdk_dir: 'x'.repeat(1000), import_dir: ' C:/recordings ' });
    assert.equal(saved.ok, true);
    assert.equal(readSetting(app.database, 'import_dir'), 'C:/recordings');
    assert.equal(readSetting(app.database, 'sdk_dir'), '');
    assert.equal((await patch({ sdk_dir: null })).ok, true);
    assert.equal((await patch({})).code, 'EMPTY');
    assert.equal((await patch({ other_path: 'x' })).code, 'UNKNOWN_SETTING');
    assert.equal((await patch({ python_path: 'x'.repeat(501) })).code, 'INVALID_INPUT');
    assert.equal(readSetting(app.database, 'ffmpeg_path'), 'C:/tools/ffmpeg.exe');
    // Even a stale value reintroduced outside the API must not leak into UI drafts.
    writeSetting(app.database, 'sdk_dir', 'stale');
    assert.equal(readSettings(app.database).has('sdk_dir'), false);
    const response = await (await fetch(`${url}/api/settings`)).json();
    assert.equal(response.data.some((entry: { key: string }) => entry.key === 'sdk_dir'), false);
  } finally {
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});
