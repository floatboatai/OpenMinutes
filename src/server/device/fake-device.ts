// ABOUTME: 假设备 prelude（只用于测试）：设置 OPENMINUTES_FAKE_DEVICE 时由 worker 加载，用 SDK 自带模拟器替换真实录音笔，并禁止调用系统网络命令。

export const FAKE_DEVICE_PRELUDE = String.raw`
"""Fake recorder for OpenMinutes tests. Modes: wifi | ble | absent."""

import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

import memotalk
from memotalk.client import NetworkSession
from memotalk.fake import FakeMemoTalk, FakeTransport, make_file_entry

worker = sys.modules["__main__"]
MODE = os.environ.get("OPENMINUTES_FAKE_DEVICE", "wifi")
AUDIO_DIR = os.environ.get("OPENMINUTES_FAKE_DEVICE_AUDIO_DIR")
FORBIDDEN = {"netsh", "netsh.exe", "nmcli", "networksetup"}

_real_run = subprocess.run
_real_popen = subprocess.Popen


def _guard(args):
    head = args[0] if isinstance(args, (list, tuple)) and args else str(args).split(" ")[0]
    if Path(str(head)).name.lower() in FORBIDDEN:
        raise AssertionError("fake device must never touch the system network: %s" % head)


def _run(args, *rest, **kwargs):
    _guard(args)
    return _real_run(args, *rest, **kwargs)


class _Popen(_real_popen):
    def __init__(self, args, *rest, **kwargs):
        _guard(args)
        super().__init__(args, *rest, **kwargs)


subprocess.run = _run
subprocess.Popen = _Popen

# Deleted files survive worker restarts, like a real recorder.
deleted_path = worker.STATE_DIR / "fake-deleted.json"
try:
    deleted = set(json.loads(deleted_path.read_text(encoding="utf-8")))
except Exception:
    deleted = set()

blobs = {}
entries = []
base_ts = 1792492200
if AUDIO_DIR and Path(AUDIO_DIR).is_dir():
    for index, path in enumerate(sorted(Path(AUDIO_DIR).glob("*.mp3"))):
        data = path.read_bytes()
        name = path.name
        blobs[name] = data
        entries.append(make_file_entry(name, size=len(data), duration_sec=max(1, len(data) * 8 // 128000),
                                       timestamp=base_ts + index * 3600))
else:
    for index, (name, size) in enumerate([
        ("REC20261020_103000.mp3", 2 * 1024 * 1024),
        ("REC20261020_143000.mp3", 1536 * 1024),
        ("REC20261021_090000.mp3", 200 * 1024),
    ]):
        entries.append(make_file_entry(name, size=size, duration_sec=max(1, size * 8 // 128000),
                                       timestamp=base_ts + index * 3600))
entries = [entry for entry in entries if entry.name not in deleted]

device = FakeMemoTalk(files=entries)
_pseudo = device._file_bytes
device._file_bytes = lambda entry: blobs.get(entry.name) or _pseudo(entry)
_delete = device._cmd_92


def _cmd_92(payload, channel):
    answer = _delete(payload, channel)
    deleted.add(payload.decode("ascii", errors="replace"))
    deleted_path.write_text(json.dumps(sorted(deleted)), encoding="utf-8")
    return answer


device._cmd_92 = _cmd_92


class PacedTransport(FakeTransport):
    """The stock simulator queues every 0x84 packet at once and overflows the SDK's
    4096-slot subscription; real BLE trickles packets, so deliver them in batches."""

    async def write(self, channel, frame):
        if not self._connected:
            raise memotalk.ConnectionLost("fake link is down")
        responses = self.device.on_write(channel, frame)

        async def pump():
            for index, (out_channel, response) in enumerate(responses):
                if not self._connected:
                    return
                self._dispatch(out_channel, response)
                if index % 256 == 255:
                    await asyncio.sleep(0.002)

        asyncio.get_running_loop().create_task(pump())


class AbsentTransport(PacedTransport):
    async def connect(self, target=None, *, timeout=None):
        raise memotalk.DeviceNotFound("no MemoTalk S1 / AI-PEN found (simulated)")


transport = AbsentTransport(device) if MODE == "absent" else PacedTransport(device)
_real_client = memotalk.MemoTalkClient
memotalk.MemoTalkClient = lambda **kwargs: _real_client(transport=transport)


class FakeFtp:
    """In-memory FTP over the simulator's files: LIST / TYPE / SIZE / RETR."""

    def _entry(self, name):
        return next((item for item in device.files if item.name == name), None)

    def retrlines(self, cmd, callback):
        for item in device.files:
            callback("-rw-r--r-- 1 ftp ftp %d Oct 20 10:30 %s" % (item.size, item.name))

    def voidcmd(self, cmd):
        return "200 ok"

    def size(self, name):
        item = self._entry(name)
        return item.size if item else None

    def retrbinary(self, cmd, callback, blocksize=8192):
        name = cmd.split(" ", 1)[1]
        item = self._entry(name)
        if item is None:
            raise OSError("550 %s not found" % name)
        data = device._file_bytes(item)
        for offset in range(0, len(data), blocksize):
            callback(data[offset:offset + blocksize])

    def close(self):
        pass


def _noop_join(net):
    state = {"platform": "fake", "iface": None, "profile": None, "ssid": net.ssid}
    worker.write_restore(state)
    return state


def _failing_join(net):
    raise worker.WifiJoinFailed("simulated: this computer cannot join the recorder hotspot")


worker.join_network = _noop_join if MODE == "wifi" else _failing_join
worker.leave_network = lambda state: None
worker.reconnect_original = lambda state: worker.clear_restore()
worker.wait_reachable = lambda host, port, timeout, cancelled: True
NetworkSession.open_ftp = lambda self, timeout=10.0: FakeFtp()
`;
