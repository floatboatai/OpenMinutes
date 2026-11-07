import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeviceService } from '../src/server/device/service.ts';
import { NetworkGate } from '../src/server/network-gate.ts';
import type { appPreflight } from '../src/server/preflight.ts';
import { registerDeviceRoutes } from '../src/server/routes/device.ts';
import { registerDiagnosticsRoutes } from '../src/server/routes/diagnostics.ts';
import { registerIngestRoutes } from '../src/server/routes/ingest.ts';
import { registerRecordingRoutes } from '../src/server/routes/recordings.ts';
import { registerSettingRoutes } from '../src/server/routes/settings.ts';
import { readSetting, writeSetting } from '../src/server/sql.ts';
import { createTestApp, FakeDevice, MiB, waitFor } from './support/device-fixture.ts';

// 诊断路由会探测无线网卡；假设备模式下直接返回 true，不派生 netsh/nmcli。
process.env.OPENMINUTES_FAKE_DEVICE = 'wifi';

type Preflight = ReturnType<typeof appPreflight>;

function stubPreflight(failCount: number): Preflight {
  const report = {
    checkedAt: new Date().toISOString(),
    items: Array.from({ length: failCount }, (_, index) => ({
      id: `fail-${index}`, label: '录音笔组件', group: 'device', status: 'fail', reason: '未安装', detail: 'uv pip install memotalk-sdk', autoRepair: false, action: '',
    })),
  };
  return { get: async () => ({ report }), peek: () => ({ report }) } as unknown as Preflight;
}

test('device HTTP API: one route per task, Chinese failures with detail, removed routes are gone', async () => {
  const t = await createTestApp('device-routes');
  const device = new FakeDevice({ files: [{ name: 'REC20261103_090000.mp3', sizeBytes: 2 * MiB }, { name: 'REC20261103_100000.mp3', sizeBytes: 64 * 1024 }] });
  const service = new DeviceService(t.app, {
    resolvePython: async () => 'python',
    spawnWorker: device.spawn,
    platform: 'win32',
    env: { OPENMINUTES_FAKE_DEVICE: 'wifi' },
    gate: new NetworkGate(),
  });
  const preflight = stubPreflight(1);
  registerDeviceRoutes(t.app, service, preflight);
  registerDiagnosticsRoutes(t.app, service, preflight);
  registerIngestRoutes(t.app);
  registerRecordingRoutes(t.app);
  registerSettingRoutes(t.app);
  writeSetting(t.app.database, 'auto_pull', '1');
  try {
    const { url } = await t.app.listen();
    const request = async (route: string, method = 'GET', body?: unknown) => {
      const response = await fetch(`${url}${route}`, {
        method, headers: { 'content-type': 'application/json', connection: 'close' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: response.status === 404 ? null : await response.json() };
    };
    const get = async (route: string) => (await request(route)).json;
    const post = async (route: string, body: unknown = {}) => (await request(route, 'POST', body)).json;

    const idle = await get('/api/device');
    assert.equal(idle.ok, true);
    assert.equal(idle.data.connection.state, 'disconnected');
    assert.deepEqual(idle.data.environment, { failCount: 1 });
    assert.equal(device.spawns.length, 0, 'polling never spawns a worker');

    // One click: connecting also syncs because auto_pull is on.
    const connected = await post('/api/device/connect');
    assert.equal(connected.ok, true);
    assert.ok(['connected', 'busy'].includes(connected.data.connection.state));
    await waitFor(() => service.view().lastResult !== null, 15_000);
    const synced = (await get('/api/device')).data;
    assert.equal(synced.lastResult.done, 2);
    assert.equal(synced.lastResult.transport, 'wifi');
    assert.equal(synced.cleanable.count, 2);

    const pullBad = await post('/api/device/pull', { ids: [] });
    assert.equal(pullBad.ok, false);
    assert.equal(pullBad.code, 'INVALID_INPUT');
    assert.equal((await post('/api/device/pull', { ids: ['x'] })).code, 'INVALID_INPUT');

    const cleanup = await post('/api/device/cleanup');
    assert.equal(cleanup.ok, true);
    assert.equal(typeof cleanup.data.jobId, 'string');
    await waitFor(() => service.view().lastResult?.kind === 'cleanup');
    assert.equal((await get('/api/device')).data.cleanable.count, 0);

    const sync = await post('/api/device/sync');
    assert.equal(typeof sync.data.jobId, 'string');
    await waitFor(() => service.view().activity === null);
    assert.equal((await post('/api/device/cancel')).data.activity, null);

    const diagnostics = (await get('/api/diagnostics')).data;
    assert.ok(diagnostics.deviceLog.some((record: { op: string; transport: string }) => record.op === 'pull' && record.transport === 'wifi'));
    assert.equal(diagnostics.transport.setting, 'auto');
    assert.equal(diagnostics.transport.thresholdBytes, MiB);
    assert.equal(diagnostics.transport.wifiCapable, true);
    assert.ok(diagnostics.transport.measured.wifiBps > 0);
    assert.ok(Array.isArray(diagnostics.commands));
    // Newest entries first.
    assert.ok(diagnostics.deviceLog[0].at >= diagnostics.deviceLog.at(-1).at);

    const disconnected = await post('/api/device/disconnect');
    assert.equal(disconnected.data.connection.state, 'disconnected');
    assert.equal(disconnected.data.connection.userDisconnected, true);

    // Transport override and background Wi-Fi are validated settings; the pause flag is not writable.
    const settings = await request('/api/settings', 'PATCH', { values: { device_transport: 'ble', auto_pull_wifi: '1' } });
    assert.equal(settings.json.ok, true);
    assert.equal(readSetting(t.app.database, 'device_transport'), 'ble');
    assert.equal((await request('/api/settings', 'PATCH', { values: { device_transport: 'ftp' } })).json.code, 'INVALID_INPUT');
    assert.equal((await request('/api/settings', 'PATCH', { values: { device_user_disconnected: '0' } })).json.code, 'UNKNOWN_SETTING');
    assert.equal(readSetting(t.app.database, 'device_user_disconnected'), '1');

    for (const [method, route] of [
      ['POST', '/api/device/status'], ['POST', '/api/device/list'], ['POST', '/api/device/download'], ['POST', '/api/device/check'],
      ['GET', '/api/device/capabilities'], ['GET', '/api/device/summary'], ['DELETE', '/api/device/1'],
      ['POST', '/api/ingest/directory/ensure'], ['PUT', '/api/recordings/1'],
    ] as const) {
      assert.equal((await request(route, method, method === 'GET' || method === 'DELETE' ? undefined : {})).status, 404, `${method} ${route}`);
    }
  } finally {
    await service.disconnect({ reason: 'user' }).catch(() => undefined);
    await t.close();
  }
});

test('a missing pen yields a Chinese headline; the SDK exception is only in detail', async () => {
  const t = await createTestApp('device-routes');
  const device = new FakeDevice({ connectError: { kind: 'DeviceNotFound', message: 'no MemoTalk S1 advertising nearby' } });
  const service = new DeviceService(t.app, { resolvePython: async () => 'python', spawnWorker: device.spawn, env: { OPENMINUTES_FAKE_DEVICE: 'absent' } });
  registerDeviceRoutes(t.app, service, stubPreflight(0));
  try {
    const { url } = await t.app.listen();
    const response = await fetch(`${url}/api/device/connect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'DEVICE_NOT_FOUND');
    assert.match(body.error, /没有找到录音笔/);
    assert.doesNotMatch(body.error, /DeviceNotFound/);
    assert.match(body.detail, /DeviceNotFound: no MemoTalk S1/);
    // The same error stays on the view for the page to show after polling.
    const view = await (await fetch(`${url}/api/device`)).json();
    assert.equal(view.data.lastError.code, 'DEVICE_NOT_FOUND');
    assert.equal(view.data.connection.state, 'disconnected');
  } finally {
    await t.close();
  }
});
