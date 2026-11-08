import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createWorkbenchServer } from '../sdk/runtime.mjs';
import { registerRecordingRoutes } from '../src/server/routes/recordings.ts';
import { registerSettingRoutes } from '../src/server/routes/settings.ts';
import { explorerCommand, pickWorkspaceId, revealRecording } from '../src/server/reveal.ts';

test('explorer command selects the file with argument arrays per platform', () => {
  assert.deepEqual(explorerCommand('C:\\a b\\2026-10\\x.mp3', 'win32'), { command: 'explorer.exe', args: ['/select,', 'C:\\a b\\2026-10\\x.mp3'] });
  assert.deepEqual(explorerCommand('/u/raw/x.mp3', 'darwin'), { command: 'open', args: ['-R', '/u/raw/x.mp3'] });
  assert.deepEqual(explorerCommand('/u/raw/x.mp3', 'linux'), { command: 'xdg-open', args: ['/u/raw'] });
});

test('workspace choice prefers the active workspace and fails when none exist', async () => {
  const host = (workspaces: Array<{ id: string; name: string | null; status: string }>) => ({
    workspaces: { list: async () => ({ workspaces, nextCursor: null }) },
  }) as never;
  assert.equal(await pickWorkspaceId(host([{ id: 'a', name: null, status: 'idle' }, { id: 'b', name: null, status: 'active' }])), 'b');
  assert.equal(await pickWorkspaceId(host([{ id: 'a', name: null, status: 'idle' }])), 'a');
  await assert.rejects(pickWorkspaceId(host([])), /no workspace/);
});

test('location column fields and the reveal route', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-reveal-'));
  let close: (() => Promise<void>) | undefined;
  const previousFake = process.env.OPENMINUTES_FAKE_REVEAL;
  delete process.env.OPENMINUTES_FAKE_REVEAL;
  try {
    await cp(new URL('../migrations/', import.meta.url), path.join(root, 'migrations'), { recursive: true });
    await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
      appId: 'reveal-test', name: 'test', version: '1',
      server: fileURLToPath(import.meta.url), ui: '.', migrations: 'migrations', resources: [],
    }));
    const configPath = path.join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ appId: 'reveal-test', generation: '1', nonce: 'test', sourceDirectory: root, dataDirectory: path.join(root, 'data') }));
    const app = await createWorkbenchServer(import.meta.url, { configPath });
    close = () => app.close();
    registerRecordingRoutes(app);
    registerSettingRoutes(app);
    const { url } = await app.listen();
    const request = async (route: string, method = 'GET', body?: unknown) => (await fetch(`${url}${route}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    })).json();

    const month = path.join(root, 'library', '2026-10');
    await mkdir(month, { recursive: true });
    const file = path.join(month, 'REC1.mp3');
    await writeFile(file, 'audio');
    const insert = app.database.prepare('INSERT INTO recordings(id, filename, dedupe_key, status, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(1, 'REC1.mp3', 'k1', 'ready', file, '2026-10-01T00:00:00Z');
    insert.run(2, 'REC2.mp3', 'k2', 'pending', null, '2026-10-02T00:00:00Z');
    insert.run(3, 'REC3.mp3', 'k3', 'ready', path.join(month, 'gone.mp3'), '2026-10-03T00:00:00Z');
    insert.run(4, 'REC4.mp3', 'k4', 'failed', null, '2026-10-04T00:00:00Z');

    const list = await request('/api/recordings');
    const byId = new Map(list.data.items.map((item: { id: number }) => [item.id, item]));
    assert.deepEqual(
      (({ location, folderPath }) => ({ location, folderPath }))(byId.get(1) as { location: string; folderPath: string }),
      { location: 'local', folderPath: month },
    );
    assert.equal((byId.get(1) as { folderLabel: string }).folderLabel.endsWith('2026-10'), true);
    assert.deepEqual((({ location, folderPath, folderLabel }) => ({ location, folderPath, folderLabel }))(byId.get(2) as never), { location: 'device', folderPath: null, folderLabel: null });
    assert.equal((byId.get(4) as { location: string }).location, 'none');

    assert.equal((await request('/api/recordings/99/reveal', 'POST')).code, 'NOT_FOUND');
    const onDevice = await request('/api/recordings/2/reveal', 'POST');
    assert.equal(onDevice.code, 'ON_DEVICE');
    assert.match(onDevice.error, /还在录音笔中/);
    const missing = await request('/api/recordings/3/reveal', 'POST');
    assert.equal(missing.code, 'FILE_MOVED');
    assert.match(missing.detail, /gone\.mp3/);
    // Extra body fields are ignored: the route never opens a caller-supplied path.
    const calls: unknown[] = [];
    app.host.workspaces.list = async () => ({ workspaces: [{ id: 'w-other', name: null, status: 'idle' }, { id: 'w-home', name: null, status: 'active' }], nextCursor: null });
    app.host.workspaces.openUrl = async (input) => {
      calls.push(input);
      return { workspaceId: input.workspaceId, tabId: 't1', displayed: true };
    };
    const opened = await request('/api/recordings/1/reveal', 'POST', { path: 'C:\\Windows' });
    assert.equal(opened.ok, true);
    assert.equal(opened.data.mode, 'floatboat');
    assert.equal(calls.length, 1);
    const call = calls[0] as { workspaceId: string; url: string; idempotencyKey: string };
    assert.equal(call.workspaceId, 'w-home');
    assert.equal(call.url, pathToFileURL(month).href);
    assert.match(call.idempotencyKey, /^reveal-1-/);

    app.host.workspaces.openUrl = async () => { throw Object.assign(new Error('HOST_UNAVAILABLE socket closed'), { code: 'HOST_UNAVAILABLE' }); };
    const failed = await request('/api/recordings/1/reveal', 'POST');
    assert.equal(failed.code, 'REVEAL_FAILED');
    assert.match(failed.error, /没能在 Floatboat 中打开文件夹。可以在设置中改为用 Windows 资源管理器打开/);
    assert.doesNotMatch(failed.error, /Host/);
    assert.match(failed.detail, /HOST_UNAVAILABLE socket closed/);
    assert.deepEqual(failed.action, { label: '去设置', href: '#/settings' });

    assert.equal((await request('/api/settings', 'PATCH', { values: { open_folder_with: 'finder' } })).code, 'INVALID_INPUT');
    assert.equal((await request('/api/settings', 'PATCH', { values: { open_folder_with: 'explorer' } })).ok, true);
    const launched: Array<[string, string[]]> = [];
    const viaExplorer = await revealRecording(app.database, 1, {
      host: app.host,
      resolve: async (stored) => stored,
      launch: (command, args) => launched.push([command, args]),
    });
    assert.equal(viaExplorer.mode, 'explorer');
    assert.deepEqual(launched, [[explorerCommand(file).command, explorerCommand(file).args]]);

    // Test switch: record the call instead of opening a window.
    const log = path.join(root, 'reveal.log');
    process.env.OPENMINUTES_FAKE_REVEAL = log;
    const faked = await request('/api/recordings/1/reveal', 'POST');
    assert.equal(faked.data.mode, 'explorer');
    assert.deepEqual(JSON.parse((await readFile(log, 'utf8')).trim()), { mode: 'explorer', ...explorerCommand(file) });
  } finally {
    if (previousFake === undefined) delete process.env.OPENMINUTES_FAKE_REVEAL;
    else process.env.OPENMINUTES_FAKE_REVEAL = previousFake;
    await close?.();
    await rm(root, { recursive: true, force: true });
  }
});
