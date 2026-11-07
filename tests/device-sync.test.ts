import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { AppError } from '../src/contracts/errors.ts';
import { DeviceService } from '../src/server/device/service.ts';
import { cleanupCandidates, pendingRecords, pullTimeoutMs } from '../src/server/device/sync.ts';
import { NetworkGate } from '../src/server/network-gate.ts';
import { rows, writeSetting } from '../src/server/sql.ts';
import { createTestApp, FakeDevice, MiB, SERIAL, type FakeDeviceOptions, type TestApp } from './support/device-fixture.ts';

const FILES = [
  { name: 'REC20261101_090000.mp3', sizeBytes: 2 * MiB },
  { name: 'REC20261101_100000.mp3', sizeBytes: Math.round(1.5 * MiB) },
  { name: 'REC20261101_110000.mp3', sizeBytes: 200 * 1024 },
];

interface Harness {
  t: TestApp;
  device: FakeDevice;
  gate: NetworkGate;
  service: DeviceService;
}

async function harness(options: FakeDeviceOptions = {}, gate = new NetworkGate(), platform = 'win32'): Promise<Harness> {
  const t = await createTestApp('device-sync');
  // 连接本身不触发自动同步，由测试显式调用 sync。
  writeSetting(t.app.database, 'auto_pull', '0');
  const device = new FakeDevice({ files: FILES, ...options });
  device.isOffline = () => gate.isOffline();
  const service = new DeviceService(t.app, {
    resolvePython: async () => 'python',
    spawnWorker: device.spawn,
    platform,
    env: { OPENMINUTES_FAKE_DEVICE: 'wifi' },
    gate,
  });
  return { t, device, gate, service };
}

function recordings(h: Harness) {
  return rows(h.t.app.database, 'SELECT id, filename, status, storage_path, device_serial FROM recordings ORDER BY id');
}

function incomingEntries(h: Harness): string[] {
  const dir = path.join(h.t.root, 'data', 'audio', '_incoming');
  return existsSync(dir) ? readdirSync(dir) : [];
}

test('a user sync pulls every pending file over Wi-Fi while the network gate is held', async () => {
  const h = await harness();
  try {
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user' });
    assert.equal(outcome.done, 3);
    assert.equal(outcome.failed, 0);
    assert.equal(outcome.transport, 'wifi');
    assert.equal(outcome.fallback, null);
    const pull = h.device.last('pull');
    assert.equal(pull?.args.transport, 'wifi');
    assert.equal(pull?.offline, true, 'the gate is offline while the hotspot is used');
    assert.equal(h.gate.isOffline(), false, 'the gate reopens after the pull');
    for (const item of recordings(h)) {
      assert.equal(item.status, 'ready');
      assert.equal(item.device_serial, SERIAL);
      assert.ok(String(item.storage_path).startsWith(h.t.libraryDir));
    }
    assert.deepEqual(incomingEntries(h), [], 'the per-job incoming directory is removed');
    const view = h.service.view();
    assert.equal(view.connection.state, 'connected');
    assert.equal(view.activity, null);
    assert.deepEqual(view.onDevice, []);
    assert.equal(view.lastResult?.transport, 'wifi');
    assert.deepEqual(view.cleanable, { count: 3, bytes: FILES.reduce((sum, file) => sum + file.sizeBytes, 0) });
    const log = h.service.logSnapshot().filter((record) => record.op === 'pull');
    assert.equal(log.at(-1)?.transport, 'wifi');
    assert.match(log.at(-1)?.detail ?? '', /无线快传/);
    assert.ok(h.service.measuredSpeeds().wifiBps);
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('a small batch goes over BLE and never takes the network offline', async () => {
  const h = await harness({ files: [FILES[2]] });
  try {
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user' });
    assert.equal(outcome.transport, 'ble');
    assert.equal(h.device.last('pull')?.offline, false);
    assert.ok(h.service.measuredSpeeds().bleBps);
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('a Wi-Fi join failure falls back to BLE, reopens the gate and keeps the reason in detail', async () => {
  const h = await harness({ wifiFails: true });
  try {
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user' });
    assert.equal(outcome.done, 3);
    assert.equal(outcome.transport, 'ble');
    assert.equal(outcome.fallback?.code, 'WIFI_FALLBACK');
    assert.equal(outcome.fallback?.message, '无线快传不可用，已改用蓝牙（较慢）。');
    assert.match(outcome.fallback?.detail ?? '', /WIFI_JOIN_FAILED/);
    assert.doesNotMatch(outcome.fallback?.message ?? '', /WIFI_JOIN_FAILED|netsh/);
    assert.equal(h.gate.isOffline(), false);
    assert.equal(h.service.view().lastResult?.fallback?.code, 'WIFI_FALLBACK');
    assert.ok(h.service.logSnapshot().some((record) => record.code === 'WIFI_JOIN_FAILED'));
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

class BusyGate extends NetworkGate {
  override async acquireOffline(): Promise<(() => void) | null> {
    return null;
  }
}

test('when transcriptions do not finish in time, the batch switches to BLE with NETWORK_IN_USE', async () => {
  const h = await harness({}, new BusyGate());
  try {
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user' });
    assert.equal(h.device.last('pull')?.args.transport, 'ble');
    assert.equal(outcome.transport, 'ble');
    assert.equal(outcome.fallback?.code, 'WIFI_FALLBACK');
    assert.match(outcome.fallback?.detail ?? '', /NETWORK_IN_USE/);
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('only pending records of the connected serial are pulled', async () => {
  const h = await harness();
  try {
    h.t.app.database.exec(`INSERT INTO recordings (filename, dedupe_key, device_serial, source, status)
      VALUES ('OTHER_DEVICE.mp3', 'other', 'MT-OTHER', 'device_manifest', 'pending')`);
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user' });
    assert.equal(outcome.failed, 0);
    const requested = (h.device.last('pull')?.args.files as Array<{ name: string }>).map((file) => file.name);
    assert.deepEqual([...requested].sort(), FILES.map((file) => file.name).sort());
    assert.equal(recordings(h).find((item) => item.filename === 'OTHER_DEVICE.mp3')?.status, 'pending');
    assert.deepEqual(pendingRecords(h.t.app.database, 'MT-OTHER').map((item) => item.filename), ['OTHER_DEVICE.mp3']);
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('size mismatches and paths outside the job directory are never attached', async () => {
  const h = await harness({ wrongSize: [FILES[0].name], outsidePath: [FILES[1].name] });
  try {
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user' });
    assert.equal(outcome.done, 1);
    assert.equal(outcome.failed, 2);
    assert.equal(outcome.error?.code, 'TRANSFER_FAILED');
    const byName = new Map(recordings(h).map((item) => [item.filename, item]));
    assert.equal(byName.get(FILES[0].name)?.status, 'pending');
    assert.equal(byName.get(FILES[1].name)?.status, 'pending');
    assert.equal(byName.get(FILES[2].name)?.status, 'ready');
    const failures = h.service.logSnapshot().filter((record) => record.code === 'TRANSFER_FAILED');
    assert.ok(failures.some((record) => /device reported/.test(record.detail)));
    assert.ok(failures.some((record) => /unexpected path/.test(record.detail)));
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('a recording in progress blocks the sync before any transfer', async () => {
  const h = await harness({ status: { recordingState: 'RECORDING' } });
  try {
    await h.service.connect({ origin: 'user' });
    await assert.rejects(h.service.sync({ origin: 'user' }), (error: unknown) => error instanceof AppError && error.code === 'DEVICE_RECORDING');
    assert.equal(h.device.last('pull'), undefined);
    assert.equal(h.service.view().lastError?.code, 'DEVICE_RECORDING');
    assert.equal(h.service.view().connection.state, 'connected');
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('single-file sync only pulls the requested ids', async () => {
  const h = await harness();
  try {
    const insert = h.t.app.database.prepare(`INSERT INTO recordings (filename, dedupe_key, device_serial, source, size_bytes, status)
      VALUES (?, ?, ?, 'device_manifest', ?, 'pending')`);
    for (const file of FILES) insert.run(file.name, `device::${SERIAL}::${file.name}::${file.sizeBytes}`, SERIAL, file.sizeBytes);
    const ids = recordings(h).map((item) => Number(item.id));
    await h.service.connect({ origin: 'user' });
    const outcome = await h.service.sync({ origin: 'user', ids: [ids[2]] });
    assert.equal(outcome.done, 1);
    assert.deepEqual((h.device.last('pull')?.args.files as Array<{ name: string }>).map((file) => file.name), [FILES[2].name]);
    assert.deepEqual(recordings(h).map((item) => item.status), ['pending', 'pending', 'ready']);
    assert.equal(h.service.view().lastResult?.kind, 'pull');
    // 两条仍在录音笔中，列表给出它们，按钮提示会走无线快传（合计 ≥ 1 MiB）。
    assert.deepEqual(h.service.view().onDevice.map((item) => item.id).sort(), [ids[0], ids[1]].sort());
    assert.deepEqual(h.service.view().syncPlan, { transport: 'wifi', willGoOffline: true });
    // 不存在的 id 什么也不拉。
    const pulls = h.device.calls.filter((call) => call.cmd === 'pull').length;
    await h.service.sync({ origin: 'user', ids: [99_999] });
    assert.equal(h.device.calls.filter((call) => call.cmd === 'pull').length, pulls);
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('cleanup deletes only files that are in the library with a matching local size', async () => {
  const h = await harness();
  try {
    await h.service.connect({ origin: 'user' });
    await h.service.sync({ origin: 'user' });
    // 一条本地文件被删掉，一条本地文件大小不一致：都不能删设备上的副本。
    const stored = new Map(recordings(h).map((item) => [String(item.filename), String(item.storage_path)]));
    const { rm } = await import('node:fs/promises');
    await rm(stored.get(FILES[0].name)!);
    await writeFile(stored.get(FILES[1].name)!, Buffer.alloc(10));
    // 设备上另有一条库里没有的录音。
    h.device.files.push({ name: 'UNKNOWN.mp3', sizeBytes: 4096 });
    assert.deepEqual(cleanupCandidates(h.t.app.database, SERIAL, h.device.files.map((file) => ({
      name: file.name, format: 'MP3', sizeBytes: file.sizeBytes, durationSec: null, timestamp: null,
    })), h.t.libraryDir).map((file) => file.name), [FILES[2].name]);

    const outcome = await h.service.cleanup({ origin: 'user' });
    assert.equal(outcome.done, 1);
    assert.equal(outcome.bytes, FILES[2].sizeBytes);
    assert.deepEqual(h.device.last('delete')?.args.names, [FILES[2].name]);
    assert.deepEqual(h.device.files.map((file) => file.name).sort(), [FILES[0].name, FILES[1].name, 'UNKNOWN.mp3'].sort());
    assert.deepEqual(h.service.view().cleanable, { count: 0, bytes: 0 });
    assert.ok(h.service.logSnapshot().some((record) => record.op === 'delete' && record.ok));
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('a failed delete is reported as DELETE_FAILED', async () => {
  const h = await harness({ files: [FILES[2]], deleteFails: [FILES[2].name] });
  try {
    await h.service.connect({ origin: 'user' });
    await h.service.sync({ origin: 'user' });
    const outcome = await h.service.cleanup({ origin: 'user' });
    assert.equal(outcome.failed, 1);
    assert.equal(outcome.error?.code, 'DELETE_FAILED');
    assert.equal(h.device.files.length, 1);
  } finally {
    await h.service.disconnect({ reason: 'user' });
    await h.t.close();
  }
});

test('cleanupCandidates skips entries without a size and pull timeouts scale with size', async () => {
  const t = await createTestApp('device-cleanup');
  try {
    const local = path.join(t.libraryDir, 'a.mp3');
    await mkdir(t.libraryDir, { recursive: true });
    await writeFile(local, Buffer.alloc(5));
    t.app.database.prepare(`INSERT INTO recordings (filename, dedupe_key, device_serial, source, status, storage_path)
      VALUES ('a.mp3', 'a', ?, 'device_manifest', 'ready', ?)`).run(SERIAL, local);
    const entry = { name: 'a.mp3', format: 'MP3', durationSec: null, timestamp: null };
    assert.equal(cleanupCandidates(t.app.database, SERIAL, [{ ...entry, sizeBytes: 5 }], t.libraryDir).length, 1);
    assert.equal(cleanupCandidates(t.app.database, SERIAL, [{ ...entry, sizeBytes: null }], t.libraryDir).length, 0);
    assert.equal(cleanupCandidates(t.app.database, 'MT-OTHER', [{ ...entry, sizeBytes: 5 }], t.libraryDir).length, 0);
  } finally {
    await t.close();
  }
  assert.equal(pullTimeoutMs(0), 120_000);
  assert.ok(pullTimeoutMs(10 * MiB) > pullTimeoutMs(MiB));
  assert.equal(pullTimeoutMs(1e12), 2 * 3600_000);
});
