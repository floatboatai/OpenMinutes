import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseStatus, probeSdk, pythonRuntimeEnv } from '../src/server/bridge.ts';
import { SDK_ACTION_SCRIPT } from '../src/server/sdk-script.ts';
import { LIVE_CAPTION_SCRIPT } from '../src/server/live-script.ts';

const python = process.env.MEMOTALK_TEST_PYTHON;
const simulated = { skip: !python && 'Set MEMOTALK_TEST_PYTHON to a Python with memotalk-sdk installed' };
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

test('SDK status adapter preserves the device report contract', simulated, () => {
  const result = execute(SDK_ACTION_SCRIPT, ['--action', 'status']);
  assert.equal(result.status, 0, result.stderr);
  const status = parseStatus(result.stdout);
  assert.equal(status?.serial, 'L0m0J06000074305');
  assert.equal(status?.batteryPct, 50);
  assert.equal(status?.firmware, '2.0.6');
  assert.equal(status?.freeSpacePct, 99);
  assert.equal(status?.hotspotSsid, 'MemoTalk-S1-TEST');
});

test('SDK list and download use package APIs without a source directory', simulated, async () => {
  const list = execute(SDK_ACTION_SCRIPT, ['--action', 'list']);
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /格式=MP3.*大小=\d+ B.*时长=\d+s.*时间戳=\d+/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'openminutes-download-'));
  try {
    const name = /1\. (.*?) \|/.exec(list.stdout)?.[1];
    assert.ok(name);
    const download = execute(SDK_ACTION_SCRIPT, ['--action', 'download', '--file', name, '--out-dir', root]);
    assert.equal(download.status, 0, download.stderr);
    assert.ok((await readFile(path.join(root, name))).length > 0);
    const missing = execute(SDK_ACTION_SCRIPT, ['--action', 'download', '--file', 'missing.mp3', '--out-dir', root]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /\[X\]/);
    const invalid = execute(SDK_ACTION_SCRIPT, ['--action', 'download']);
    assert.equal(invalid.status, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
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

test('optional hotspot read failure does not fail the device status report', simulated, () => {
  const prefix = `${setup}
from memotalk.client import RawController
from memotalk.constants import Cmd
from memotalk.errors import MemoTalkError
original_request = RawController.request
async def request(self, frame, **kwargs):
    if kwargs.get("code") == Cmd.WIFI_SSID:
        raise MemoTalkError("hotspot unavailable")
    return await original_request(self, frame, **kwargs)
RawController.request = request
`;
  const result = execute(SDK_ACTION_SCRIPT, ['--action', 'status'], prefix);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseStatus(result.stdout)?.serial, 'L0m0J06000074305');
  assert.equal(parseStatus(result.stdout)?.hotspotSsid, null);
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
