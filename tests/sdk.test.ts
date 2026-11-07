import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { probeSdk, pythonRuntimeEnv } from '../src/server/runtime-probe.ts';
import { attachWorker, writeWorkerFiles, type WorkerEvent, type WorkerHandle } from '../src/server/device/worker.ts';
import { LIVE_CAPTION_SCRIPT } from '../src/server/live-script.ts';

const python = process.env.MEMOTALK_TEST_PYTHON;
const simulated = { skip: !python && 'Set MEMOTALK_TEST_PYTHON to a Python with memotalk-sdk installed' };
const SECRETS = ['TESTwifi', 'ESqn3Dvc'];
const setup = `
import memotalk
from memotalk.fake import FakeMemoTalk, FakeTransport
from memotalk.models import AudioFileEntry
real_client = memotalk.MemoTalkClient
device = FakeMemoTalk(files=[AudioFileEntry("REC20261020_103000.mp3", 0, 1792492200, 960, 3)])
transport = FakeTransport(device)
memotalk.MemoTalkClient = lambda **kwargs: real_client(transport=transport)
`;

function execute(script: string, args: string[] = [], prefix = setup) {
  assert.ok(python);
  return spawnSync(python, ['-X', 'utf8', '-c', `${prefix}\nexec(${JSON.stringify(script)})`, ...args], {
    encoding: 'utf8', timeout: 15000,
  });
}

/**
 * Test prelude: SDK simulator + recorded subprocess calls. Network commands never run; their
 * argv lands in calls.json so each platform's join/restore sequence can be asserted anywhere.
 */
function testPrelude(options: { files?: Array<[string, number]>; wifiOn?: boolean; ignoreClose?: number; joinFails?: boolean; locationDenied?: boolean; slowFtp?: boolean; probes?: boolean[]; restoreWait?: number } = {}) {
  const files = options.files ?? [['REC20261020_103000.mp3', 40_000], ['REC20261020_143000.mp3', 30_000]];
  return `
import json, subprocess, sys, time
from pathlib import Path
import memotalk
from memotalk.client import NetworkSession
from memotalk.fake import FakeMemoTalk, FakeTransport, make_file_entry
worker = sys.modules["__main__"]
device = FakeMemoTalk(files=[make_file_entry(n, size=s) for n, s in ${JSON.stringify(files)}])
device.wifi_on = ${options.wifiOn ? 'True' : 'False'}
device.wifi_ignore_close = ${options.ignoreClose ?? 0}
transport = FakeTransport(device)
real_client = memotalk.MemoTalkClient
memotalk.MemoTalkClient = lambda **kwargs: real_client(transport=transport)
calls_path = worker.STATE_DIR / "calls.json"

class Done:
    def __init__(self, code=0, out=b"", err=b""):
        self.returncode, self.stdout, self.stderr = code, out, err

def fake_run(args, *rest, **kwargs):
    args = [str(a) for a in args]
    record = {"argv": args}
    for a in args:
        if a.startswith("filename="):
            xml = Path(a.split("=", 1)[1]).read_text(encoding="utf-8")
            record["xmlHasHex"] = "<hex>" in xml and "manual" in xml
    if args[:2] == ["nmcli", "--wait"]:
        record["passwdFile"] = Path(args[-1]).exists()
    calls = json.loads(calls_path.read_text()) if calls_path.exists() else []
    calls.append(record)
    calls_path.write_text(json.dumps(calls))
    if args[:4] == ["netsh", "wlan", "show", "interfaces"]:
        if ${options.locationDenied ? 'True' : 'False'}:
            return Done(1, b"Network shell commands need location permission to access WLAN information.")
        return Done(0, "    Name                   : Wi-Fi\\n    Profile                : HomeNet\\n".encode())
    if args[:2] == ["networksetup", "-listallhardwareports"]:
        return Done(0, b"Hardware Port: Wi-Fi\\nDevice: en1\\n")
    if ${options.joinFails ? 'True' : 'False'} and ("connect" in args or "up" in args):
        return Done(1, b"", b"join refused")
    return Done(0)

subprocess.run = fake_run
NetworkSession.join_hotspot = lambda self, iface="en0", wait=15.0: "192.168.4.2"
worker.wait_reachable = lambda host, port, timeout, cancelled: True
probe_results = ${JSON.stringify((options.probes ?? [true]).map((value) => (value ? 1 : 0)))}
probe_path = worker.STATE_DIR / "probes.json"

def fake_usable():
    probes = json.loads(probe_path.read_text()) if probe_path.exists() else []
    result = bool(probe_results[min(len(probes), len(probe_results) - 1)])
    probes.append(result)
    probe_path.write_text(json.dumps(probes))
    return result

worker.network_usable = fake_usable
worker.NETWORK_RESTORE_WAIT = ${options.restoreWait ?? 10}

class FakeFtp:
    def _entry(self, name):
        return next((f for f in device.files if f.name == name), None)
    def retrlines(self, cmd, cb):
        for f in device.files:
            cb("-rw-r--r-- 1 ftp ftp %d Oct 20 10:30 %s" % (f.size, f.name.lower()))
    def voidcmd(self, cmd):
        return "200"
    def size(self, name):
        return self._entry(name.upper().replace(".MP3", ".mp3")).size
    def retrbinary(self, cmd, cb, blocksize=8192):
        entry = self._entry(cmd.split(" ", 1)[1].upper().replace(".MP3", ".mp3"))
        data = device._file_bytes(entry)
        for i in range(0, len(data), 4096):
            if ${options.slowFtp ? 'True' : 'False'}:
                time.sleep(0.05)
            cb(data[i:i + 4096])
    def close(self):
        pass

NetworkSession.open_ftp = lambda self, timeout=10.0: FakeFtp()
`;
}

interface Harness {
  worker: WorkerHandle;
  root: string;
  stateDir: string;
  events: WorkerEvent[];
  output: () => string;
  calls: () => Promise<Array<{ argv: string[]; xmlHasHex?: boolean; passwdFile?: boolean }>>;
  close: () => Promise<void>;
}

async function harness(prelude: string, netPlatform?: string, preexisting?: (stateDir: string) => Promise<void>): Promise<Harness> {
  assert.ok(python);
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-worker-'));
  const stateDir = path.join(root, 'state');
  const { script } = await writeWorkerFiles(stateDir, {});
  await preexisting?.(stateDir);
  const preludePath = path.join(stateDir, 'test_prelude.py');
  await writeFile(preludePath, prelude, 'utf8');
  const args = ['-X', 'utf8', '-u', script, '--state-dir', stateDir, '--fake-prelude', preludePath];
  if (netPlatform) args.push('--net-platform', netPlatform);
  const child = spawn(python, args, { windowsHide: true, env: await pythonRuntimeEnv(python) });
  let raw = '';
  child.stdout.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
  const worker = attachWorker(child);
  const events: WorkerEvent[] = [];
  worker.onEvent((event) => events.push(event));
  return {
    worker, root, stateDir, events,
    output: () => raw,
    calls: async () => {
      const file = path.join(stateDir, 'calls.json');
      return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : [];
    },
    close: async () => {
      await worker.close(5000);
      await rm(root, { recursive: true, force: true });
    },
  };
}

type PullResult = { files: Array<{ name: string; ok: boolean; path?: string; sizeBytes?: number; transport?: string; error?: { kind: string } }>; cancelled: boolean };

async function connectAndList(h: Harness) {
  await h.worker.request('connect', {}, { timeoutMs: 20000 });
  return h.worker.request<{ files: Array<{ name: string; sizeBytes: number }> }>('list', {}, { timeoutMs: 20000 });
}

function pullArgs(h: Harness, files: Array<{ name: string; sizeBytes: number }>, transport: 'wifi' | 'ble') {
  return { files: files.map((file) => ({ name: file.name, size: file.sizeBytes })), outDir: path.join(h.root, 'out'), transport };
}

function assertNoSecrets(h: Harness) {
  for (const secret of SECRETS) assert.ok(!h.output().includes(secret), `worker output leaked ${secret}`);
}

test('missing Python reports SDK unavailable', async () => {
  assert.equal((await probeSdk(null)).ok, false);
});

test('Windows BLE backend imports in the application Python environment', {
  skip: !python || process.platform !== 'win32',
}, async () => {
  assert.ok(python);
  const env = await pythonRuntimeEnv(python);
  const result = spawnSync(python, ['-c',
    'from bleak.backends.winrt.client import BleakClientWinRT; from bleak.backends.winrt.scanner import BleakScannerWinRT; print("OK")',
  ], { encoding: 'utf8', timeout: 15000, ...(env ? { env } : {}) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'OK');
});

test('installed package is probed using the selected interpreter', simulated, async () => {
  assert.ok(python);
  const probe = await probeSdk(python);
  assert.equal(probe.ok, true, probe.detail);
  assert.match(probe.detail, /memotalk-sdk/);
});

test('worker connect syncs time, closes a leftover hotspot, and reports status and listing as JSON', simulated, async () => {
  const h = await harness(testPrelude({ wifiOn: true }));
  try {
    const connected = await h.worker.request<{ hotspotWasOn: boolean; timeSynced: boolean }>('connect', {}, { timeoutMs: 20000 });
    assert.equal(connected.hotspotWasOn, true);
    assert.equal(connected.timeSynced, true);
    const status = await h.worker.request<{ serial: string; batteryPct: number; freeSpacePct: number; recordingState: string }>('status', {}, { timeoutMs: 20000 });
    assert.equal(status.serial, 'L0m0J06000074305');
    assert.equal(status.freeSpacePct, 99);
    assert.equal(status.recordingState, 'STOPPED');
    const listed = await h.worker.request<{ files: Array<{ name: string; sizeBytes: number; format: string }> }>('list', {}, { timeoutMs: 20000 });
    assert.deepEqual(listed.files.map((file) => [file.name, file.sizeBytes, file.format]),
      [['REC20261020_103000.mp3', 40000, 'MP3'], ['REC20261020_143000.mp3', 30000, 'MP3']]);
  } finally {
    await h.close();
  }
});

test('BLE pull writes files and reports their path and size; delete removes them from the device', simulated, async () => {
  const h = await harness(testPrelude());
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'ble'), { timeoutMs: 60000 });
    for (const file of pulled.files) {
      assert.equal(file.ok, true);
      assert.equal(file.transport, 'ble');
      assert.equal((await stat(file.path!)).size, file.sizeBytes);
    }
    const deleted = await h.worker.request<{ files: Array<{ ok: boolean }> }>('delete', { names: [listed.files[0].name, 'missing.mp3'] }, { timeoutMs: 20000 });
    assert.deepEqual(deleted.files.map((file) => file.ok), [true, false]);
    const after = await h.worker.request<{ files: unknown[] }>('list', {}, { timeoutMs: 20000 });
    assert.equal(after.files.length, 1);
  } finally {
    await h.close();
  }
});

test('Windows Wi-Fi pull joins with a temporary manual profile, restores the original network, and never leaks secrets', simulated, async () => {
  const h = await harness(testPrelude(), 'win32');
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    assert.deepEqual(pulled.files.map((file) => [file.ok, file.transport]), [[true, 'wifi'], [true, 'wifi']]);
    for (const file of pulled.files) assert.equal((await stat(file.path!)).size, file.sizeBytes);
    const calls = await h.calls();
    const verbs = calls.map((call) => call.argv.slice(0, 3).join(' '));
    assert.deepEqual(verbs, ['netsh wlan show', 'netsh wlan add', 'netsh wlan connect', 'netsh wlan disconnect', 'netsh wlan delete', 'netsh wlan connect']);
    assert.equal(calls[1].xmlHasHex, true);
    assert.ok(calls[2].argv.includes('interface=Wi-Fi'));
    assert.ok(calls[5].argv.includes('name=HomeNet'));
    const leftovers = await readdir(h.stateDir);
    assert.ok(!leftovers.some((name) => name.endsWith('.xml')), leftovers.join(','));
    assert.ok(!leftovers.includes('wifi-restore.json'));
    assert.ok(!h.events.some((event) => event.event === 'fallback'));
    assertNoSecrets(h);
  } finally {
    await h.close();
  }
});

test('Windows without location permission connects without interface and relies on auto-reconnect', simulated, async () => {
  const h = await harness(testPrelude({ locationDenied: true }), 'win32');
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    assert.ok(pulled.files.every((file) => file.ok && file.transport === 'wifi'));
    const calls = await h.calls();
    const connects = calls.filter((call) => call.argv[2] === 'connect');
    assert.equal(connects.length, 1, 'no explicit reconnect when the original profile is unknown');
    assert.ok(!connects[0].argv.some((arg) => arg.startsWith('interface=')));
  } finally {
    await h.close();
  }
});

async function probes(h: Harness): Promise<boolean[]> {
  const file = path.join(h.stateDir, 'probes.json');
  return existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : [];
}

test('after leaving the hotspot the pull only returns once the original network carries traffic again', simulated, async () => {
  const h = await harness(testPrelude({ probes: [true, false, false, true] }), 'win32');
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    assert.ok(pulled.files.every((file) => file.ok && file.transport === 'wifi'));
    assert.deepEqual(await probes(h), [true, false, false, true], 'probed before joining, then polled until usable');
    assert.ok(!h.events.some((event) => event.event === 'warning'));
  } finally {
    await h.close();
  }
});

test('a network that does not come back in time is reported, with one extra reconnect on Windows', simulated, async () => {
  const h = await harness(testPrelude({ probes: [true, false], restoreWait: 1.5 }), 'win32');
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    assert.ok(pulled.files.every((file) => file.ok));
    const warning = h.events.find((event) => event.event === 'warning');
    assert.equal(warning?.data.code, 'NETWORK_RESTORE_TIMEOUT');
    const reconnects = (await h.calls()).filter((call) => call.argv[2] === 'connect' && call.argv.includes('name=HomeNet'));
    assert.equal(reconnects.length, 2);
  } finally {
    await h.close();
  }
});

test('a computer that was offline before the sync does not wait for the network afterwards', simulated, async () => {
  const h = await harness(testPrelude({ probes: [false] }), 'win32');
  try {
    const listed = await connectAndList(h);
    await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    assert.deepEqual(await probes(h), [false]);
    assert.ok(!h.events.some((event) => event.event === 'warning'));
  } finally {
    await h.close();
  }
});

test('macOS and Linux join sequences use the platform tools and clean up', simulated, async () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const h = await harness(testPrelude(), platform);
    try {
      const listed = await connectAndList(h);
      const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
      assert.ok(pulled.files.every((file) => file.ok && file.transport === 'wifi'), platform);
      const calls = await h.calls();
      if (platform === 'darwin') {
        assert.deepEqual(calls.map((call) => call.argv[0] + ' ' + call.argv[1]),
          ['networksetup -listallhardwareports', 'networksetup -removepreferredwirelessnetwork']);
        assert.equal(calls[1].argv[2], 'en1');
      } else {
        const up = calls.find((call) => call.argv.includes('up'));
        assert.equal(up?.passwdFile, true, 'password is passed through a file, not argv');
        assert.deepEqual(calls.at(-1)?.argv, ['nmcli', 'connection', 'delete', 'openminutes-hotspot']);
        assert.ok(!(await readdir(h.stateDir)).some((name) => name.endsWith('.pass')));
      }
      for (const call of calls) for (const secret of SECRETS) assert.ok(!call.argv.join(' ').includes(secret));
      assertNoSecrets(h);
    } finally {
      await h.close();
    }
  }
});

test('a failed hotspot join falls back to BLE for the remaining files and restores the network', simulated, async () => {
  const h = await harness(testPrelude({ joinFails: true }), 'win32');
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    assert.deepEqual(pulled.files.map((file) => [file.ok, file.transport]), [[true, 'ble'], [true, 'ble']]);
    const fallback = h.events.find((event) => event.event === 'fallback');
    assert.equal(fallback?.data.reason, 'WIFI_JOIN_FAILED');
    const verbs = (await h.calls()).map((call) => call.argv[2]);
    assert.ok(verbs.includes('disconnect') && verbs.includes('delete'), verbs.join(','));
    assert.ok(!existsSync(path.join(h.stateDir, 'wifi-restore.json')));
    assertNoSecrets(h);
  } finally {
    await h.close();
  }
});

test('an unconfirmed hotspot close is reported as a warning', simulated, async () => {
  const h = await harness(testPrelude({ ignoreClose: 10 }), 'win32');
  try {
    const listed = await connectAndList(h);
    await h.worker.request<PullResult>('pull', pullArgs(h, listed.files.slice(0, 1), 'wifi'), { timeoutMs: 120000 });
    const warning = h.events.find((event) => event.event === 'warning');
    assert.equal(warning?.data.code, 'HOTSPOT_CLOSE_UNCONFIRMED');
  } finally {
    await h.close();
  }
});

test('cancelling a Wi-Fi transfer still leaves the hotspot network and closes the hotspot', simulated, async () => {
  const h = await harness(testPrelude({ files: [['REC20261020_103000.mp3', 400_000]], slowFtp: true }), 'win32');
  try {
    const listed = await connectAndList(h);
    const pending = h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), {
      timeoutMs: 60000,
      onEvent: (event) => { if (event.event === 'progress' && event.data.phase === 'transferring') h.worker.cancel(); },
    });
    const pulled = await pending;
    assert.equal(pulled.cancelled, true);
    assert.equal(pulled.files.length, 0);
    const verbs = (await h.calls()).map((call) => call.argv[2]);
    assert.ok(verbs.includes('disconnect') && verbs.includes('delete'), verbs.join(','));
    assert.ok(!(await readdir(path.join(h.root, 'out'))).some((name) => name.endsWith('.part')));
    const status = await h.worker.request<{ recordingState: string }>('status', {}, { timeoutMs: 20000 });
    assert.equal(status.recordingState, 'STOPPED');
  } finally {
    await h.close();
  }
});

test('cancelling a BLE transfer tells the device to stop sending', simulated, async () => {
  const h = await harness(`${testPrelude({ files: [['REC20261020_103000.mp3', 400_000]] })}
from memotalk.client import FileController
original_sync_control = FileController.sync_control
async def sync_control(self, name, op, *args, **kwargs):
    (worker.STATE_DIR / "cancel.txt").write_text(str(int(op)))
    return await original_sync_control(self, name, op, *args, **kwargs)
FileController.sync_control = sync_control
import asyncio
async def paced_write(self, channel, frame):
    responses = self.device.on_write(channel, frame)
    async def pump():
        for index, (out_channel, response) in enumerate(responses):
            if not self._connected:
                return
            self._dispatch(out_channel, response)
            if index % 16 == 15:
                await asyncio.sleep(0.05)
    asyncio.get_running_loop().create_task(pump())
FakeTransport.write = paced_write
`);
  try {
    const listed = await connectAndList(h);
    const pulled = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'ble'), {
      timeoutMs: 60000,
      onEvent: (event) => { if (event.event === 'progress' && event.data.phase === 'transferring') h.worker.cancel(); },
    });
    assert.equal(pulled.cancelled, true);
    assert.equal(await readFile(path.join(h.stateDir, 'cancel.txt'), 'utf8'), '1');
  } finally {
    await h.close();
  }
});

test('a cancel sent right behind a pull is not lost, and a stale cancel does not stop the next pull', simulated, async () => {
  const h = await harness(`${testPrelude({ files: [['REC20261020_103000.mp3', 400_000]], slowFtp: true })}
import asyncio
original_status = worker.Worker.cmd_status
async def slow_status(self, req_id, args):
    await asyncio.sleep(0.5)
    return await original_status(self, req_id, args)
worker.Worker.cmd_status = slow_status
`, 'win32');
  try {
    const listed = await connectAndList(h);
    // 慢的 status 占着设备锁：拉取和取消都在拉取任务真正开始前被读到。
    // 取消不能被拉取开头的清零吞掉。
    const busy = h.worker.request('status', {}, { timeoutMs: 20000 });
    const pending = h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), { timeoutMs: 60000 });
    h.worker.cancel();
    await busy;
    const pulled = await pending;
    assert.equal(pulled.cancelled, true);
    assert.equal(pulled.files.length, 0);

    // 没有拉取在跑时收到的取消，不影响下一次拉取。
    h.worker.cancel();
    await h.worker.request('status', {}, { timeoutMs: 20000 });
    const next = await h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'ble'), { timeoutMs: 60000 });
    assert.equal(next.cancelled, false);
    assert.deepEqual(next.files.map((file) => file.ok), [true]);
  } finally {
    await h.close();
  }
});

test('a restore file left by a killed worker is applied at startup', simulated, async () => {
  const h = await harness(testPrelude(), 'win32', async (stateDir) => {
    await writeFile(path.join(stateDir, 'wifi-restore.json'),
      JSON.stringify({ platform: 'win32', iface: 'Wi-Fi', profile: 'HomeNet', ssid: 'MemoTalk-S1-TEST' }));
  });
  try {
    await h.worker.request('connect', {}, { timeoutMs: 20000 });
    const verbs = (await h.calls()).map((call) => call.argv.slice(2).join(' '));
    assert.deepEqual(verbs, ['disconnect interface=Wi-Fi', 'delete profile name=MemoTalk-S1-TEST', 'connect name=HomeNet interface=Wi-Fi']);
    assert.ok(!existsSync(path.join(h.stateDir, 'wifi-restore.json')));
  } finally {
    await h.close();
  }
});

test('stdin EOF during a hotspot session restores the network before exiting', simulated, async () => {
  const h = await harness(testPrelude({ files: [['REC20261020_103000.mp3', 400_000]], slowFtp: true }), 'win32');
  try {
    const listed = await connectAndList(h);
    const pending = h.worker.request<PullResult>('pull', pullArgs(h, listed.files, 'wifi'), {
      timeoutMs: 60000,
      onEvent: (event) => { if (event.event === 'progress' && event.data.phase === 'transferring') void h.worker.close(30000); },
    });
    await pending.catch(() => undefined);
    await h.worker.close(30000);
    const verbs = (await h.calls()).map((call) => call.argv[2]);
    assert.ok(verbs.includes('disconnect') && verbs.includes('delete'), verbs.join(','));
    assert.ok(!existsSync(path.join(h.stateDir, 'wifi-restore.json')));
  } finally {
    await h.close();
  }
});

test('a missing recorder is reported with its SDK exception kind', simulated, async () => {
  const h = await harness(`${testPrelude()}
from memotalk.fake import FakeTransport as _FT
class Absent(_FT):
    async def connect(self, target=None, *, timeout=None):
        raise memotalk.DeviceNotFound("no MemoTalk S1 found")
memotalk.MemoTalkClient = lambda **kwargs: real_client(transport=Absent(device))
`);
  try {
    await assert.rejects(h.worker.request('connect', {}, { timeoutMs: 20000 }), (error: { code?: string; detail?: string; message: string }) => {
      assert.equal(error.code, 'DEVICE_NOT_FOUND');
      assert.match(error.detail ?? '', /DeviceNotFound/);
      assert.doesNotMatch(error.message, /DeviceNotFound/);
      return true;
    });
  } finally {
    await h.close();
  }
});

test('live capture uses installed SDK and cleans up on stdin EOF', simulated, () => {
  const result = execute(LIVE_CAPTION_SCRIPT);
  assert.equal(result.status, 0, result.stderr);
  const events = result.stderr.trim().split('\n').map((line) => JSON.parse(line).event);
  assert.ok(events.includes('streaming'));
  assert.ok(events.includes('stopped'));
  assert.equal(result.stdout, '');
});

test('live capture emits SDK audio and resets recording on stop', simulated, () => {
  const prefix = `${setup}
import asyncio
import sys
import threading
from memotalk.client import RecordController
stop_input = threading.Event()
original_start = RecordController.start
async def start_with_immediate_audio(self):
    result = await original_start(self)
    transport.emit_audio(b"x" * 288)
    return result
RecordController.start = start_with_immediate_audio
class Input:
    def __iter__(self):
        stop_input.wait(5)
        yield "stop\\n"
sys.stdin = Input()
class StreamingClient(real_client):
    async def connect(self):
        await super().connect()
        async def emit():
            await asyncio.sleep(0.2)
            for _ in range(3):
                transport.emit_audio(b"x" * 288)
                await asyncio.sleep(0.05)
            stop_input.set()
        asyncio.create_task(emit())
        return self
memotalk.MemoTalkClient = lambda **kwargs: StreamingClient(transport=transport)
`;
  const wrapper = `
namespace = {"__name__": "test_live"}
exec(${JSON.stringify(LIVE_CAPTION_SCRIPT)}, namespace)
code = namespace["main"]()
assert not device.realtime_asr
assert device.record_state.value == 0
assert not transport.is_connected
sys.exit(code)
`;
  const result = execute(wrapper, [], prefix);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'x'.repeat(1152));
  assert.match(result.stderr, /"audio_bytes": 1152/);
});

test('rejected realtime mode is reported as failure without starting recording', simulated, () => {
  const prefix = `${setup}
from memotalk.client import RecordController
from memotalk.models import AckResult
original_set_realtime = RecordController.set_realtime
async def set_realtime(self, enabled):
    if enabled:
        return AckResult(0xA4, 1, False)
    return await original_set_realtime(self, enabled)
RecordController.set_realtime = set_realtime
`;
  const result = execute(LIVE_CAPTION_SCRIPT, [], prefix);
  assert.equal(result.status, 4, result.stderr);
  assert.match(result.stderr, /"event": "error"/);
  assert.match(result.stderr, /"kind": "RuntimeError"/);
  assert.doesNotMatch(result.stderr, /"event": "recording"|"event": "streaming"/);
  assert.equal(result.stdout, '');
});

test('no-record mode leaves an existing recording running', simulated, () => {
  const prefix = `${setup}
import sys
from memotalk.constants import RecordStateCode
device.record_state = RecordStateCode.RECORDING
`;
  const wrapper = `
namespace = {"__name__": "test_live"}
exec(${JSON.stringify(LIVE_CAPTION_SCRIPT)}, namespace)
code = namespace["main"]()
assert device.record_state == RecordStateCode.RECORDING
assert not device.realtime_asr
assert not transport.is_connected
sys.exit(code)
`;
  const result = execute(wrapper, ['--no-record'], prefix);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /"event": "recording"/);
  assert.match(result.stderr, /"event": "stopped"/);
});
