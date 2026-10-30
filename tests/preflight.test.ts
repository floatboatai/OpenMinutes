import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { DeviceEnv } from '../src/contracts/app.ts';
import { bluetoothPermission, capabilityCheck, createPreflight, dependencyChecks, hostChecks, systemCheck, writableDirectory } from '../src/server/preflight.ts';

const ready = { ok: true, detail: 'ready', resolvedPath: '/python' };
const env: DeviceEnv = { python: ready, bleak: ready, sdk: ready, ffmpeg: ready, checkedAt: '' };

test('dependency failures expose actions but healthy dependencies do not offer repairs', () => {
  assert.ok(dependencyChecks(env).every((item) => item.status === 'ok' && !item.autoRepair));
  const result = dependencyChecks({ ...env, sdk: { ok: false, detail: 'import failed', resolvedPath: null } });
  assert.equal(result.find((item) => item.id === 'sdk')?.status, 'fail');
  assert.match(result.find((item) => item.id === 'sdk')?.action ?? '', /uv run/);
});

for (const platform of ['win32', 'darwin', 'linux'] as const) {
  test(`${platform}: cache and concurrent refresh run only one inspection`, async () => {
    let calls = 0;
    const preflight = createPreflight(platform, 'arm64', {
      environment: async () => { calls++; return env; },
      directories: async () => [],
      host: async () => [capabilityCheck('agent', [])],
      bluetooth: async () => ({ id: 'bluetooth', label: 'BLE', status: 'warn', reason: 'not scanned', autoRepair: false, action: '' }),
      decode: async () => ({ id: 'decode', label: 'decode', status: 'ok', reason: 'decoded', autoRepair: false, action: '' }),
    });
    const [a, b] = await Promise.all([preflight.get(), preflight.get(true)]);
    assert.equal(a, b);
    assert.equal(calls, 1);
    assert.equal(a.report.platform, platform);
    assert.equal(a.report.items[0].status, 'ok');
    await preflight.get();
    assert.equal(calls, 1);
    await preflight.get(true);
    assert.equal(calls, 2);
  });
}

test('unsupported OS/architecture and macOS authorization states are never reported as ready', () => {
  assert.equal(systemCheck('aix', 'x64').status, 'fail');
  assert.equal(systemCheck('darwin', 'ia32').status, 'fail');
  assert.equal(bluetoothPermission('0').status, 'warn');
  assert.equal(bluetoothPermission('1').status, 'fail');
  assert.equal(bluetoothPermission('2').status, 'fail');
  assert.equal(bluetoothPermission('3').status, 'ok');
  assert.equal(bluetoothPermission('unknown').status, 'warn');
});

test('Host checks require actual operations and declaration; unavailable Host is explicit', async () => {
  assert.equal(capabilityCheck('agent', [{ operation: 'list', status: 'available', declared: true }]).status, 'warn');
  assert.equal(capabilityCheck('agent', ['start', 'get'].map((operation) => ({ operation, declared: true, status: 'available' }))).status, 'ok');
  assert.equal(capabilityCheck('agent', ['agent.start', 'agent.get'].map((operation) => ({ operation, declared: false, status: 'available' }))).status, 'warn');
  const calls: string[] = [];
  const result = await hostChecks({ capabilities: { list: async (input) => {
    calls.push(input?.domain ?? '');
    throw new Error('HOST_NOT_CONNECTED');
  } } });
  assert.deepEqual(calls.sort(), ['agent', 'asr', 'llm']);
  assert.ok(result.every((item) => item.status === 'warn' && /HOST_NOT_CONNECTED/.test(item.reason)));
});

test('directory probe creates only its marker and removes it; blocked paths fail', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-writable-'));
  try {
    const directory = path.join(root, 'inbox');
    assert.equal((await writableDirectory('dir', 'dir', directory)).status, 'ok');
    assert.deepEqual(await readdir(directory), []);
    const blocker = path.join(root, 'file');
    await writeFile(blocker, 'user data');
    assert.equal((await writableDirectory('dir', 'dir', blocker)).status, 'fail');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
