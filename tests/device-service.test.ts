import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../src/contracts/errors.ts';
import { autoConnectTick } from '../src/server/device/auto-connect.ts';
import { DeviceService } from '../src/server/device/service.ts';
import { NetworkGate } from '../src/server/network-gate.ts';
import { readSetting, row, writeSetting } from '../src/server/sql.ts';
import { createTestApp, FakeDevice, MiB, SERIAL, waitFor, type FakeDeviceOptions, type TestApp } from './support/device-fixture.ts';

const FILES = [
  { name: 'REC20261102_090000.mp3', sizeBytes: 2 * MiB },
  { name: 'REC20261102_100000.mp3', sizeBytes: Math.round(1.5 * MiB) },
  { name: 'REC20261102_110000.mp3', sizeBytes: 200 * 1024 },
];

interface Harness {
  t: TestApp;
  device: FakeDevice;
  service: DeviceService;
}

async function harness(options: FakeDeviceOptions = {}, settings: Record<string, string> = {}, idleDisconnectMs?: number): Promise<Harness> {
  const t = await createTestApp('device-service');
  writeSetting(t.app.database, 'auto_pull', '0');
  for (const [key, value] of Object.entries(settings)) writeSetting(t.app.database, key, value);
  const device = new FakeDevice({ files: FILES, ...options });
  const gate = new NetworkGate();
  device.isOffline = () => gate.isOffline();
  const service = new DeviceService(t.app, {
    resolvePython: async () => 'python',
    spawnWorker: device.spawn,
    platform: 'win32',
    env: { OPENMINUTES_FAKE_DEVICE: 'wifi' },
    gate,
    idleDisconnectMs,
  });
  return { t, device, service };
}

async function finish(h: Harness): Promise<void> {
  if (h.service.view().connection.state !== 'live') await h.service.disconnect({ reason: 'user' }).catch(() => undefined);
  await h.t.close();
}

const isCode = (code: string) => (error: unknown) => error instanceof AppError && error.code === code;

test('connect is idempotent, remembers the device and logs a closed hotspot residue', async () => {
  const h = await harness({ hotspotWasOn: true });
  try {
    const [first, second] = await Promise.all([h.service.connect({ origin: 'user' }), h.service.connect({ origin: 'user' })]);
    assert.equal(h.device.spawns.length, 1);
    assert.equal(first.connection.state, 'connected');
    assert.equal(second.connection.state, 'connected');
    assert.equal((await h.service.connect({ origin: 'user' })).connection.state, 'connected');
    assert.equal(h.device.spawns.length, 1);
    assert.deepEqual(h.device.commands(), ['connect', 'status']);

    const view = h.service.view();
    assert.equal(view.connection.origin, 'user');
    assert.equal(view.device?.serial, SERIAL);
    assert.equal(view.device?.batteryPct, 80);
    assert.ok(view.connection.idleDisconnectAt);
    const stored = row(h.t.app.database, 'SELECT ble_address FROM devices WHERE serial = ?', [SERIAL]);
    assert.equal(stored?.ble_address, 'AA:BB:CC:DD:EE:FF');
    assert.equal(readSetting(h.t.app.database, 'device_serial'), SERIAL);
    assert.ok(h.service.logSnapshot().some((record) => record.code === 'HOTSPOT_RESIDUE_CLOSED'));

    // The remembered address is preferred on the next connection.
    await h.service.disconnect({ reason: 'user' });
    await h.service.connect({ origin: 'user' });
    assert.equal(h.device.spawns[1].prefer, 'AA:BB:CC:DD:EE:FF');
  } finally {
    await finish(h);
  }
});

test('a failed connection maps to a Chinese error and keeps the SDK text in detail', async () => {
  const h = await harness({ connectError: { kind: 'DeviceNotFound', message: 'no MemoTalk S1 advertising nearby' } });
  try {
    await assert.rejects(h.service.connect({ origin: 'user' }), isCode('DEVICE_NOT_FOUND'));
    const view = h.service.view();
    assert.equal(view.connection.state, 'disconnected');
    assert.equal(view.lastError?.code, 'DEVICE_NOT_FOUND');
    assert.match(view.lastError?.message ?? '', /没有找到录音笔/);
    assert.doesNotMatch(view.lastError?.message ?? '', /DeviceNotFound/);
    assert.match(view.lastError?.detail ?? '', /DeviceNotFound: no MemoTalk S1/);
    assert.ok(h.device.workers[0].exited, 'the worker is shut down after a failed connect');
  } finally {
    await finish(h);
  }
});

test('missing Python fails fast with RUNTIME_MISSING and never spawns a worker', async () => {
  const t = await createTestApp('device-service');
  const device = new FakeDevice({ files: FILES });
  const service = new DeviceService(t.app, { resolvePython: async () => null, spawnWorker: device.spawn, env: { OPENMINUTES_FAKE_DEVICE: 'wifi' } });
  try {
    await assert.rejects(service.connect({ origin: 'user' }), isCode('RUNTIME_MISSING'));
    assert.equal(device.spawns.length, 0);
    assert.equal(service.view().lastError?.action?.href, '#/settings/diagnostics');
  } finally {
    await t.close();
  }
});

test('one click: a user connect with auto_pull=1 syncs everything right away', async () => {
  const h = await harness({}, { auto_pull: '1' });
  try {
    await h.service.connect({ origin: 'user' });
    await waitFor(() => h.service.view().lastResult !== null, 15_000);
    const view = h.service.view();
    assert.equal(view.lastResult?.kind, 'sync');
    assert.equal(view.lastResult?.origin, 'user');
    assert.equal(view.lastResult?.done, 3);
    assert.equal(view.lastResult?.transport, 'wifi');
    assert.equal(view.connection.state, 'connected');
    assert.deepEqual(h.device.commands().filter((cmd) => cmd === 'pull'), ['pull']);
  } finally {
    await finish(h);
  }
});

test('a user disconnect pauses auto-connect until the user connects again', async () => {
  const h = await harness({}, { auto_connect: '1' });
  try {
    await h.service.connect({ origin: 'user' });
    const view = await h.service.disconnect({ reason: 'user' });
    assert.equal(view.connection.state, 'disconnected');
    assert.equal(view.connection.disconnectReason, 'user');
    assert.equal(view.connection.userDisconnected, true);
    assert.equal(readSetting(h.t.app.database, 'device_user_disconnected'), '1');
    assert.ok(h.device.workers[0].exited);
    assert.ok(h.device.commands().includes('disconnect'));

    const state = { nextAttemptAt: 0, running: false };
    assert.equal(await autoConnectTick({ db: h.t.app.database, service: h.service }, state), false);
    assert.equal(h.device.spawns.length, 1, 'no automatic reconnect after a manual disconnect');

    await h.service.connect({ origin: 'user' });
    assert.equal(h.service.view().connection.userDisconnected, false);
    await h.service.disconnect({ reason: 'idle' });
    assert.equal(readSetting(h.t.app.database, 'device_user_disconnected'), '0', 'only a user disconnect pauses auto-connect');
    assert.equal(await autoConnectTick({ db: h.t.app.database, service: h.service }, state), true);
  } finally {
    await finish(h);
  }
});

test('a user session disconnects itself after the idle window, without an error', async () => {
  const h = await harness({}, {}, 60);
  try {
    await h.service.connect({ origin: 'user' });
    await waitFor(() => h.service.view().connection.state === 'disconnected');
    const view = h.service.view();
    assert.equal(view.connection.disconnectReason, 'idle');
    assert.equal(view.connection.userDisconnected, false);
    assert.equal(view.lastError, null);
  } finally {
    await finish(h);
  }
});

test('the background session syncs small files over BLE, defers large ones and disconnects when done', async () => {
  const h = await harness({}, { auto_connect: '1', auto_pull: '1', auto_pull_wifi: '0' });
  try {
    const state = { nextAttemptAt: 0, running: false };
    let now = 1_000_000;
    const deps = { db: h.t.app.database, service: h.service, now: () => now };
    assert.equal(await autoConnectTick(deps, state), true);
    // 断开过程中不能出现「已休眠」之类的中间原因。
    const reasons = new Set<string | null>();
    await waitFor(() => {
      const current = h.service.view().connection;
      if (current.state === 'disconnected') reasons.add(current.disconnectReason);
      return current.state === 'disconnected' && current.disconnectReason === 'auto-done';
    });
    assert.deepEqual([...reasons], ['auto-done']);
    const view = h.service.view();
    assert.equal(view.connection.disconnectReason, 'auto-done');
    assert.equal(view.lastResult?.origin, 'auto');
    assert.equal(view.lastResult?.done, 1);
    assert.equal(view.lastResult?.deferred, 2);
    assert.equal(view.lastResult?.transport, 'ble');
    assert.equal(h.device.last('pull')?.args.transport, 'ble');
    assert.equal(h.device.last('pull')?.offline, false);
    assert.ok(!h.service.logSnapshot().some((record) => record.transport === 'wifi'), 'no Wi-Fi in the background');
    assert.ok(readSetting(h.t.app.database, 'last_auto_connect_at'));
    assert.ok(view.autoConnect.nextAttemptAt);

    // Too early for the next round.
    assert.equal(await autoConnectTick(deps, state), false);
    now += 3 * 60_000;
    // With background Wi-Fi allowed, the deferred large files go over the hotspot.
    writeSetting(h.t.app.database, 'auto_pull_wifi', '1');
    assert.equal(await autoConnectTick(deps, state), true);
    await waitFor(() => h.service.view().connection.state === 'disconnected');
    assert.equal(h.service.view().lastResult?.transport, 'wifi');
    assert.equal(h.service.view().lastResult?.done, 2);
  } finally {
    await finish(h);
  }
});

test('auto-connect stays quiet when the pen is asleep and when the feature is off', async () => {
  const h = await harness({ connectError: { kind: 'DeviceNotFound', message: 'asleep' } }, { auto_connect: '1' });
  try {
    const state = { nextAttemptAt: 0, running: false };
    assert.equal(await autoConnectTick({ db: h.t.app.database, service: h.service }, state), true);
    const view = h.service.view();
    assert.equal(view.connection.state, 'disconnected');
    // 后台连不上是常态：只进诊断日志，页面上不出现红色错误，也不改断开原因。
    assert.equal(view.lastError, null);
    assert.equal(view.connection.disconnectReason, null);
    assert.ok(h.service.logSnapshot().some((record) => record.origin === 'auto' && record.code === 'DEVICE_NOT_FOUND'));
    writeSetting(h.t.app.database, 'auto_connect', '0');
    state.nextAttemptAt = 0;
    assert.equal(await autoConnectTick({ db: h.t.app.database, service: h.service }, state), false);
  } finally {
    await finish(h);
  }
});

test('the idle timer never fires during a transfer and counts down to a fixed deadline', async () => {
  const hold = Promise.withResolvers<void>();
  const h = await harness({ holdPull: hold.promise }, {}, 80);
  try {
    await h.service.connect({ origin: 'user' });
    const first = h.service.view().connection.idleDisconnectAt;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.service.view().connection.idleDisconnectAt, first, 'the deadline does not move on every poll');

    const running = h.service.sync({ origin: 'user' });
    await waitFor(() => h.service.view().activity?.phase === 'transferring');
    // 远超空闲窗口的长传输：既不能被空闲断开，也不能取消进行中的同步。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(h.service.view().connection.state, 'busy');
    assert.equal(h.service.view().activity?.cancelling, false);
    assert.equal(h.device.workers[0].exited, false);
    hold.resolve();
    assert.equal((await running).done, 3);
    // 活动结束后重新开始计时，随后照常空闲断开。
    assert.equal(h.service.view().connection.state, 'connected');
    assert.ok(h.service.view().connection.idleDisconnectAt);
    await waitFor(() => h.service.view().connection.state === 'disconnected');
    assert.equal(h.service.view().connection.disconnectReason, 'idle');
  } finally {
    hold.resolve();
    await finish(h);
  }
});

test('sync and cleanup are refused while a connection is in progress, so only one worker ever exists', async () => {
  const hold = Promise.withResolvers<void>();
  const h = await harness({ holdConnect: hold.promise });
  try {
    const connecting = h.service.connect({ origin: 'auto' });
    await waitFor(() => h.service.view().connection.state === 'connecting');
    assert.throws(() => h.service.sync({ origin: 'user', ids: [1] }), isCode('DEVICE_BUSY'));
    assert.throws(() => h.service.sync({ origin: 'user' }), isCode('DEVICE_BUSY'));
    assert.throws(() => h.service.cleanup({ origin: 'user' }), isCode('DEVICE_BUSY'));
    hold.resolve();
    await connecting;
    assert.equal(h.device.spawns.length, 1);
  } finally {
    hold.resolve();
    await finish(h);
  }
});

test('when the worker goes away, per-recording sync rows disappear with it', async () => {
  // 一条大小不一致的录音留在「还在录音笔里」，另外两条可清理。
  const h = await harness({ wrongSize: ['REC20261102_110000.mp3'] });
  try {
    await h.service.connect({ origin: 'user' });
    await h.service.sync({ origin: 'user' });
    assert.equal(h.service.view().onDevice.length, 1);
    assert.equal(h.service.view().cleanable?.count, 2);
    h.device.workers[0].exit(0);
    const view = h.service.view();
    assert.deepEqual(view.onDevice, []);
    assert.equal(view.cleanable, null);
  } finally {
    await finish(h);
  }
});

test('stop during the network wait returns at once, reopens the gate and leaves the worker alone', async () => {
  const t = await createTestApp('device-service');
  writeSetting(t.app.database, 'auto_pull', '0');
  const device = new FakeDevice({ files: FILES });
  const gate = new NetworkGate();
  device.isOffline = () => gate.isOffline();
  const service = new DeviceService(t.app, {
    resolvePython: async () => 'python', spawnWorker: device.spawn, platform: 'win32', env: { OPENMINUTES_FAKE_DEVICE: 'wifi' }, gate,
  });
  const asr = Promise.withResolvers<void>();
  const inFlight = gate.runNetworkTask(() => asr.promise);
  try {
    await service.connect({ origin: 'user' });
    const running = service.sync({ origin: 'user' });
    await waitFor(() => service.view().activity?.phase === 'waiting-network');
    assert.equal(gate.isOffline(), true);
    const started = Date.now();
    await service.disconnect({ reason: 'user' });
    assert.ok(Date.now() - started < 2000, 'disconnect does not wait out the 180 s network window');
    assert.equal(gate.isOffline(), false, 'the network was never cut, so the gate reopens');
    assert.equal((await running).cancelled, true);
    assert.equal(device.workers[0].killed, false);
    assert.ok(!device.commands().includes('pull'));
    assert.equal(service.view().connection.disconnectReason, 'user');
  } finally {
    asr.resolve();
    await inFlight;
    await t.close();
  }
});

test('a stalled pull is cancelled cooperatively; the gate stays closed until the worker has restored the network', async () => {
  const t = await createTestApp('device-service');
  writeSetting(t.app.database, 'auto_pull', '0');
  const hold = Promise.withResolvers<void>();
  const device = new FakeDevice({ files: FILES, holdPull: hold.promise, ignoreCancel: true });
  const gate = new NetworkGate();
  device.isOffline = () => gate.isOffline();
  const service = new DeviceService(t.app, {
    resolvePython: async () => 'python', spawnWorker: device.spawn, platform: 'win32', env: { OPENMINUTES_FAKE_DEVICE: 'wifi' }, gate,
    pullStallMs: 60,
  });
  try {
    await service.connect({ origin: 'user' });
    const running = service.sync({ origin: 'user' });
    await waitFor(() => device.commands().includes('cancel'));
    // 卡住后先协作取消：worker 仍在热点上，闸门不能提前打开，也不能马上强杀。
    assert.equal(gate.isOffline(), true);
    assert.equal(device.workers[0].killed, false);
    assert.equal(service.view().connection.state, 'busy');
    hold.resolve();
    // worker 自己收尾返回：落盘的文件照常挂接，闸门此时才打开，worker 也没被强杀。
    const outcome = await running;
    assert.equal(outcome.done, 3);
    assert.equal(outcome.cancelled, false);
    assert.equal(gate.isOffline(), false);
    assert.equal(device.workers[0].killed, false);
    assert.equal(service.view().connection.state, 'connected');
    assert.ok(service.logSnapshot().some((record) => record.code === 'DEVICE_TIMEOUT'));
  } finally {
    hold.resolve();
    await service.disconnect({ reason: 'user' }).catch(() => undefined);
    await t.close();
  }

  // worker 响应取消、什么都没传完：结果是超时失败，而不是「已停止」。
  const k = await createTestApp('device-service');
  writeSetting(k.app.database, 'auto_pull', '0');
  const stuck = Promise.withResolvers<void>();
  const pen = new FakeDevice({ files: FILES, holdPull: stuck.promise });
  const quiet = new DeviceService(k.app, {
    resolvePython: async () => 'python', spawnWorker: pen.spawn, platform: 'win32', env: { OPENMINUTES_FAKE_DEVICE: 'wifi' },
    gate: new NetworkGate(), pullStallMs: 60,
  });
  try {
    await quiet.connect({ origin: 'user' });
    const outcome = await quiet.sync({ origin: 'user' });
    assert.equal(outcome.done, 0);
    assert.equal(outcome.failed, 3);
    assert.equal(outcome.cancelled, false);
    assert.equal(outcome.error?.code, 'DEVICE_TIMEOUT');
    assert.equal(quiet.view().lastResult?.error?.code, 'DEVICE_TIMEOUT');
    assert.equal(pen.workers[0].killed, false);
  } finally {
    stuck.resolve();
    await quiet.disconnect({ reason: 'user' }).catch(() => undefined);
    await k.close();
  }
});

test('while busy, sync/pull/cleanup/live are refused but connect just returns the state', async () => {
  const hold = Promise.withResolvers<void>();
  const h = await harness({ holdPull: hold.promise });
  try {
    await h.service.connect({ origin: 'user' });
    const running = h.service.sync({ origin: 'user' });
    await waitFor(() => h.service.view().activity?.phase === 'transferring');
    const view = h.service.view();
    assert.equal(view.connection.state, 'busy');
    assert.equal(view.activity?.transport, 'wifi');
    assert.equal(view.activity?.offline, true);
    assert.equal(view.activity?.count, 3);
    assert.equal(view.syncPlan, null);
    assert.throws(() => h.service.sync({ origin: 'user' }), isCode('DEVICE_BUSY'));
    assert.throws(() => h.service.sync({ origin: 'user', ids: [1] }), isCode('DEVICE_BUSY'));
    assert.throws(() => h.service.cleanup({ origin: 'user' }), isCode('DEVICE_BUSY'));
    await assert.rejects(h.service.claimForLive({ scriptPath: 'x', pythonCommand: 'python', env: {}, scanTimeoutSec: 1 }), isCode('DEVICE_BUSY'));
    assert.equal((await h.service.connect({ origin: 'user' })).connection.state, 'busy');
    hold.resolve();
    assert.equal((await running).done, 3);
    assert.equal(h.service.view().connection.state, 'connected');
  } finally {
    hold.resolve();
    await finish(h);
  }
});

test('cancel is cooperative: the worker stops on its own and stays alive', async () => {
  const hold = Promise.withResolvers<void>();
  const h = await harness({ holdPull: hold.promise });
  try {
    await h.service.connect({ origin: 'user' });
    const running = h.service.sync({ origin: 'user' });
    await waitFor(() => h.service.view().activity?.phase === 'transferring');
    const view = await h.service.cancel();
    assert.equal(view.activity, null);
    const outcome = await running;
    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.done, 0);
    assert.ok(h.device.commands().includes('cancel'));
    assert.equal(h.device.workers[0].killed, false);
    assert.equal(h.service.view().lastResult?.cancelled, true);
    assert.equal(h.service.view().connection.state, 'connected');
  } finally {
    hold.resolve();
    await finish(h);
  }
});

test('during the hotspot phase cancel waits instead of killing; only an explicit deadline kills', async () => {
  const hold = Promise.withResolvers<void>();
  const h = await harness({ holdPull: hold.promise, ignoreCancel: true });
  try {
    await h.service.connect({ origin: 'user' });
    const running = h.service.sync({ origin: 'user' });
    await waitFor(() => h.service.view().activity?.phase === 'transferring');
    const cancelling = h.service.cancel();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(h.device.workers[0].killed, false, 'a worker restoring the network must not be killed early');
    assert.equal(h.service.view().activity?.cancelling, true);
    hold.resolve();
    await cancelling;
    assert.equal((await running).done, 3);
  } finally {
    hold.resolve();
    await finish(h);
  }

  const stuck = Promise.withResolvers<void>();
  const k = await harness({ holdPull: stuck.promise, ignoreCancel: true });
  try {
    await k.service.connect({ origin: 'user' });
    const running = k.service.sync({ origin: 'user' }).catch((error: unknown) => error);
    await waitFor(() => k.service.view().activity?.phase === 'transferring');
    await k.service.cancel({ timeoutMs: 30 });
    assert.equal(k.device.workers[0].killed, true);
    assert.ok(await running instanceof AppError);
    assert.equal(k.service.view().connection.state, 'disconnected');
    assert.equal(k.service.view().activity, null);
  } finally {
    stuck.resolve();
    await finish(k);
  }
});

test('a worker that exits on its own leaves the service disconnected with a reason', async () => {
  const h = await harness();
  try {
    await h.service.connect({ origin: 'user' });
    h.device.workers[0].exit(0);
    const view = h.service.view();
    assert.equal(view.connection.state, 'disconnected');
    assert.equal(view.connection.disconnectReason, 'device_sleep');
    assert.equal(view.connection.userDisconnected, false);
  } finally {
    await finish(h);
  }
});

test('live captions claim the pen exclusively and restore a user connection afterwards', async () => {
  const h = await harness();
  try {
    await h.service.connect({ origin: 'user' });
    const script = path.join(h.t.root, 'capture.js');
    await writeFile(script, 'process.exit(0)\n');
    // Node rejects the -X flag and exits immediately; only the hand-over matters here.
    const child = await h.service.claimForLive({ scriptPath: script, pythonCommand: process.execPath, env: process.env, scanTimeoutSec: 1 });
    await new Promise((resolve) => child.once('close', resolve));
    assert.ok(h.device.workers[0].exited, 'the worker exits before live capture starts');
    assert.equal(h.service.view().connection.state, 'live');
    await assert.rejects(h.service.connect({ origin: 'user' }), isCode('DEVICE_BUSY'));
    assert.throws(() => h.service.sync({ origin: 'user' }), isCode('DEVICE_BUSY'));
    await assert.rejects(h.service.claimForLive({ scriptPath: script, pythonCommand: process.execPath, env: process.env, scanTimeoutSec: 1 }), isCode('DEVICE_BUSY'));
    await h.service.releaseFromLive();
    await waitFor(() => h.service.view().connection.state === 'connected');
    assert.equal(h.device.spawns.length, 2);
    assert.equal(h.service.view().connection.origin, 'user');
  } finally {
    await finish(h);
  }
});

test('live captions do not reconnect when nobody was connected before', async () => {
  const h = await harness();
  try {
    const script = path.join(h.t.root, 'capture.js');
    await writeFile(script, 'process.exit(0)\n');
    const child = await h.service.claimForLive({ scriptPath: script, pythonCommand: process.execPath, env: process.env, scanTimeoutSec: 1 });
    await new Promise((resolve) => child.once('close', resolve));
    await h.service.releaseFromLive();
    assert.equal(h.service.view().connection.state, 'disconnected');
    assert.equal(h.device.spawns.length, 0);
  } finally {
    await finish(h);
  }
});

test('the device log is a bounded ring buffer', async () => {
  const t = await createTestApp('device-service');
  const service = new DeviceService(t.app, { resolvePython: async () => 'python', spawnWorker: new FakeDevice().spawn, logLimit: 5 });
  try {
    for (let index = 0; index < 8; index += 1) {
      service.log({ op: 'status', origin: 'user', ok: true, code: null, transport: null, bytes: null, durationMs: index, detail: String(index) });
    }
    assert.deepEqual(service.logSnapshot().map((record) => record.detail), ['3', '4', '5', '6', '7']);
  } finally {
    await t.close();
  }
});

test('a user connect during a background connect takes over: it syncs everything and stays connected', async () => {
  let releaseConnect!: () => void;
  const holdConnect = new Promise<void>((resolve) => { releaseConnect = resolve; });
  const h = await harness({ holdConnect }, { auto_connect: '1', auto_pull: '1', auto_pull_wifi: '0' });
  try {
    const state = { nextAttemptAt: 0, running: false };
    const tick = autoConnectTick({ db: h.t.app.database, service: h.service }, state);
    await waitFor(() => h.service.view().connection.state === 'connecting');
    const userConnect = h.service.connect({ origin: 'user' });
    releaseConnect();
    await userConnect;
    assert.equal(await tick, true);
    await waitFor(() => h.service.view().lastResult !== null, 15_000);
    const view = h.service.view();
    assert.equal(h.device.spawns.length, 1, 'both callers share one connection');
    assert.equal(view.connection.origin, 'user');
    assert.equal(view.connection.state, 'connected');
    assert.equal(view.lastResult?.origin, 'user');
    assert.equal(view.lastResult?.done, 3);
    assert.equal(view.lastResult?.deferred, 0);
    assert.equal(view.lastResult?.transport, 'wifi');
    assert.deepEqual(h.device.commands().filter((cmd) => cmd === 'pull'), ['pull'], 'the background tick does not sync a second time');
    assert.notEqual(view.connection.disconnectReason, 'auto-done');
  } finally {
    await finish(h);
  }
});

test('a user connect during a background sync keeps the session and syncs the deferred large files', async () => {
  let releasePull!: () => void;
  const holdPull = new Promise<void>((resolve) => { releasePull = resolve; });
  const h = await harness({ holdPull }, { auto_connect: '1', auto_pull: '1', auto_pull_wifi: '0' });
  try {
    const state = { nextAttemptAt: 0, running: false };
    const tick = autoConnectTick({ db: h.t.app.database, service: h.service }, state);
    await waitFor(() => h.service.view().activity?.phase === 'transferring' || h.device.commands().includes('pull'), 15_000);
    assert.equal(h.service.view().connection.origin, 'auto');
    await h.service.connect({ origin: 'user' });
    assert.equal(h.service.view().connection.origin, 'user');
    releasePull();
    assert.equal(await tick, true);
    await waitFor(() => h.service.view().lastResult?.origin === 'user' && !h.service.view().activity, 15_000);
    const view = h.service.view();
    assert.equal(view.connection.state, 'connected');
    assert.equal(view.lastResult?.transport, 'wifi');
    assert.equal(view.lastResult?.done, 2, 'the follow-up sync fetches what the background sync deferred');
    assert.equal(readSetting(h.t.app.database, 'device_user_disconnected'), '0');
  } finally {
    await finish(h);
  }
});

test('a user sync inside a background session keeps the connection afterwards', async () => {
  const h = await harness({}, { auto_pull: '0' });
  try {
    await h.service.connect({ origin: 'auto' });
    assert.equal(h.service.view().connection.origin, 'auto');
    await h.service.sync({ origin: 'user' });
    const view = h.service.view();
    assert.equal(view.connection.origin, 'user');
    assert.equal(view.connection.state, 'connected');
    assert.equal(view.lastResult?.done, 3);
  } finally {
    await finish(h);
  }
});

test('ending live captions restores the user connection without starting a sync', async () => {
  const h = await harness({}, { auto_pull: '1' });
  try {
    writeSetting(h.t.app.database, 'auto_pull', '0');
    await h.service.connect({ origin: 'user' });
    writeSetting(h.t.app.database, 'auto_pull', '1');
    const script = path.join(h.t.root, 'capture.js');
    await writeFile(script, 'process.exit(0)\n');
    const child = await h.service.claimForLive({ scriptPath: script, pythonCommand: process.execPath, env: process.env, scanTimeoutSec: 1 });
    await new Promise((resolve) => child.once('close', resolve));
    await h.service.releaseFromLive();
    await waitFor(() => h.service.view().connection.state === 'connected');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(h.service.view().activity, null);
    assert.equal(h.service.view().lastResult, null);
    assert.ok(!h.device.commands().includes('pull'), 'no sync, so no silent switch to the hotspot');
  } finally {
    await finish(h);
  }
});
