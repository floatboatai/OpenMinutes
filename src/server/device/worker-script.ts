// ABOUTME: 设备 worker 的 Python 源码：持有一个 MemoTalkClient，按 JSON-lines RPC 执行连接、清单、同步（无线快传优先，蓝牙回退）与删除。

const NETWORK_PART = String.raw`#!/usr/bin/env python3
"""OpenMinutes device worker.

stdin:  one JSON command per line  {"id": 1, "cmd": "connect", "args": {...}}
stdout: one JSON message per line  result / error / event / log
Secrets (hotspot and FTP passwords) are only held in memory and scrubbed from every output.
"""

import argparse
import asyncio
import contextlib
import json
import os
import re
import runpy
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

SECRETS = set()
SECRET_KEYS = ("password", "keymaterial", "psk")
OUT_LOCK = threading.Lock()
LOCATION_HINT = re.compile(r"location|定位|位置", re.I)
HOTSPOT_PROFILE = "openminutes-hotspot"
STATE_DIR = Path(".")
NET_PLATFORM = "linux"


def scrub(value):
    if isinstance(value, dict):
        return {
            key: ("***" if any(word in str(key).lower() for word in SECRET_KEYS) else scrub(item))
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [scrub(item) for item in value]
    if isinstance(value, str):
        for secret in SECRETS:
            if secret:
                value = value.replace(secret, "***")
        return value
    return value


class ScrubbingStream:
    def __init__(self, stream):
        self._stream = stream

    def write(self, text):
        return self._stream.write(scrub(text))

    def flush(self):
        return self._stream.flush()

    def __getattr__(self, name):
        return getattr(self._stream, name)


def emit(payload):
    line = json.dumps(scrub(payload), ensure_ascii=False)
    with OUT_LOCK:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def log(message, level="info"):
    emit({"type": "log", "level": level, "message": message})


def error_payload(error):
    return {"kind": type(error).__name__, "message": str(error)[:2000]}


class CancelledTransfer(Exception):
    """Raised from progress callbacks when the user asked to stop."""


class WifiJoinFailed(Exception):
    pass


class WifiUnreachable(Exception):
    pass


class SizeMismatch(Exception):
    pass


# ---------------------------------------------------------------------------
# platform networking (module level so tests and the fake prelude can replace it)
# ---------------------------------------------------------------------------
def oem_encoding():
    if sys.platform != "win32":
        return "utf-8"
    try:
        import ctypes

        return "cp%d" % ctypes.windll.kernel32.GetOEMCP()
    except Exception:
        return "utf-8"


def decode_output(raw):
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode(oem_encoding(), errors="replace")


def run_cmd(args, timeout=25):
    proc = subprocess.run(args, capture_output=True, timeout=timeout)
    return proc.returncode, decode_output(proc.stdout), decode_output(proc.stderr)


def restore_path():
    return STATE_DIR / "wifi-restore.json"


def write_restore(state):
    restore_path().write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def read_restore():
    try:
        return json.loads(restore_path().read_text(encoding="utf-8"))
    except Exception:
        return None


def clear_restore():
    with contextlib.suppress(FileNotFoundError):
        restore_path().unlink()


def parse_interfaces(text):
    iface = None
    profile = None
    for line in text.splitlines():
        key, sep, value = line.partition(":")
        if not sep:
            continue
        key = key.strip().lower()
        value = value.strip()
        if key in ("name", "名称") and iface is None:
            iface = value or None
        elif key in ("profile", "配置文件") and profile is None:
            profile = value or None
    return iface, profile


def xml_escape(text):
    return (
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        .replace('"', "&quot;").replace("'", "&apos;")
    )


def profile_xml(ssid, password):
    hex_ssid = ssid.encode("utf-8").hex().upper()
    return (
        '<?xml version="1.0"?>\n'
        '<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">\n'
        "  <name>" + xml_escape(ssid) + "</name>\n"
        "  <SSIDConfig><SSID><hex>" + hex_ssid + "</hex><name>" + xml_escape(ssid) + "</name></SSID></SSIDConfig>\n"
        "  <connectionType>ESS</connectionType>\n"
        "  <connectionMode>manual</connectionMode>\n"
        "  <MSM><security>\n"
        "    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>\n"
        "    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>"
        + xml_escape(password)
        + "</keyMaterial></sharedKey>\n"
        "  </security></MSM>\n"
        "</WLANProfile>\n"
    )


def tail(text, limit=300):
    return (text or "").strip()[-limit:]


def join_windows(net):
    code, out, err = run_cmd(["netsh", "wlan", "show", "interfaces"])
    iface, profile = (None, None)
    if code == 0 and not LOCATION_HINT.search(out + err):
        iface, profile = parse_interfaces(out)
    state = {"platform": "win32", "iface": iface, "profile": profile, "ssid": net.ssid}
    write_restore(state)
    xml_path = STATE_DIR / ("hotspot-%d.xml" % os.getpid())
    xml_path.write_text(profile_xml(net.ssid, net.password), encoding="utf-8")
    try:
        code, out, err = run_cmd(["netsh", "wlan", "add", "profile", "filename=" + str(xml_path), "user=current"])
    finally:
        with contextlib.suppress(FileNotFoundError):
            xml_path.unlink()
    if code != 0:
        raise WifiJoinFailed("netsh add profile failed: " + tail(out + err))
    args = ["netsh", "wlan", "connect", "name=" + net.ssid, "ssid=" + net.ssid]
    if iface:
        args.append("interface=" + iface)
    code, out, err = run_cmd(args)
    if code != 0:
        raise WifiJoinFailed("netsh connect failed: " + tail(out + err))
    return state


def mac_wifi_device(text):
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if re.search(r"Hardware Port:\s*(Wi-?Fi|AirPort)", line, re.I):
            for follow in lines[index + 1 : index + 3]:
                matched = re.match(r"\s*Device:\s*(\S+)", follow)
                if matched:
                    return matched.group(1)
    return None


def join_darwin(net):
    code, out, err = run_cmd(["networksetup", "-listallhardwareports"])
    iface = mac_wifi_device(out) if code == 0 else None
    if not iface:
        raise WifiJoinFailed("no Wi-Fi hardware port found: " + tail(out + err))
    state = {"platform": "darwin", "iface": iface, "profile": None, "ssid": net.ssid}
    write_restore(state)
    address = net.join_hotspot(iface)
    if not address:
        raise WifiJoinFailed("joined hotspot but no address on " + iface)
    return state


def join_linux(net):
    state = {"platform": "linux", "iface": None, "profile": HOTSPOT_PROFILE, "ssid": net.ssid}
    write_restore(state)
    run_cmd(["nmcli", "connection", "delete", HOTSPOT_PROFILE])
    code, out, err = run_cmd([
        "nmcli", "connection", "add", "type", "wifi", "con-name", HOTSPOT_PROFILE, "ssid", net.ssid,
        "wifi-sec.key-mgmt", "wpa-psk", "connection.autoconnect", "no",
    ])
    if code != 0:
        raise WifiJoinFailed("nmcli add failed: " + tail(out + err))
    secret = STATE_DIR / ("nm-%d.pass" % os.getpid())
    fd = os.open(str(secret), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write("802-11-wireless-security.psk:" + net.password + "\n")
        code, out, err = run_cmd(["nmcli", "--wait", "20", "connection", "up", HOTSPOT_PROFILE, "passwd-file", str(secret)])
    finally:
        with contextlib.suppress(FileNotFoundError):
            secret.unlink()
    if code != 0:
        raise WifiJoinFailed("nmcli up failed: " + tail(out + err))
    return state


def join_network(net):
    if NET_PLATFORM == "win32":
        return join_windows(net)
    if NET_PLATFORM == "darwin":
        return join_darwin(net)
    if NET_PLATFORM == "linux":
        return join_linux(net)
    raise WifiJoinFailed("unsupported platform " + NET_PLATFORM)


def leave_network(state):
    """Leave the hotspot and remove the temporary profile. Best effort, never raises."""
    if not state:
        return
    plat = state.get("platform")
    iface = state.get("iface")
    ssid = state.get("ssid") or ""
    try:
        if plat == "win32":
            args = ["netsh", "wlan", "disconnect"] + (["interface=" + iface] if iface else [])
            run_cmd(args)
            if ssid:
                run_cmd(["netsh", "wlan", "delete", "profile", "name=" + ssid])
        elif plat == "darwin" and iface and ssid:
            run_cmd(["networksetup", "-removepreferredwirelessnetwork", iface, ssid])
        elif plat == "linux":
            run_cmd(["nmcli", "connection", "delete", HOTSPOT_PROFILE])
    except Exception as error:  # noqa: BLE001
        log("leave network failed: %s: %s" % (type(error).__name__, error), "warn")


def reconnect_original(state):
    """Reconnect the network we were on; macOS and Linux rely on auto-reconnect."""
    try:
        if state and state.get("platform") == "win32" and state.get("profile"):
            args = ["netsh", "wlan", "connect", "name=" + state["profile"]]
            if state.get("iface"):
                args.append("interface=" + state["iface"])
            run_cmd(args)
    except Exception as error:  # noqa: BLE001
        log("reconnect failed: %s: %s" % (type(error).__name__, error), "warn")
    finally:
        clear_restore()


NETWORK_RESTORE_WAIT = 25.0
PROBE_HOSTS = (("223.5.5.5", 53), ("1.1.1.1", 53), ("8.8.8.8", 53))


def network_usable():
    """True when at least one well-known public host accepts a TCP connection."""
    for host, port in PROBE_HOSTS:
        try:
            socket.create_connection((host, port), timeout=1.0).close()
            return True
        except OSError:
            continue
    return False


def wait_network_back(state, timeout=None):
    """netsh connect only queues the request and macOS/Linux rejoin on their own:
    poll until traffic flows again so queued AI jobs do not start while still offline.
    Returns (usable, seconds waited)."""
    timeout = NETWORK_RESTORE_WAIT if timeout is None else timeout
    started = time.monotonic()
    retried = False
    while True:
        if network_usable():
            return True, time.monotonic() - started
        elapsed = time.monotonic() - started
        if elapsed >= timeout:
            return False, elapsed
        if not retried and elapsed >= timeout / 2 and state and state.get("platform") == "win32" and state.get("profile"):
            retried = True
            args = ["netsh", "wlan", "connect", "name=" + state["profile"]]
            if state.get("iface"):
                args.append("interface=" + state["iface"])
            with contextlib.suppress(Exception):
                run_cmd(args)
        time.sleep(1.0)


def wait_reachable(host, port, timeout, cancelled):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cancelled():
            return False
        try:
            socket.create_connection((host, port), timeout=1.0).close()
            return True
        except OSError:
            time.sleep(1.0)
    return False
`;

const WORKER_PART = String.raw`

# ---------------------------------------------------------------------------
# worker
# ---------------------------------------------------------------------------
WIFI_REASONS = {
    "enable": "WIFI_ENABLE_FAILED",
    "join": "WIFI_JOIN_FAILED",
    "reach": "WIFI_UNREACHABLE",
    "ftp": "WIFI_FTP_FAILED",
    "transfer": "WIFI_TRANSFER_FAILED",
}
RECORDING_STATES = ("RECORDING", "PAUSED", "RESUMED")


class Worker:
    def __init__(self, args, memotalk):
        self.args = args
        self.memotalk = memotalk
        self.dev = None
        self.loop = None
        self.inbox = None
        self.lock = asyncio.Lock()
        self.cancel = threading.Event()
        self.tasks = set()
        self.closing = False
        self.stopped = False

    # -- plumbing ------------------------------------------------------------
    def read_stdin(self):
        try:
            for line in sys.stdin:
                self.loop.call_soon_threadsafe(self.inbox.put_nowait, line)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.inbox.put_nowait, None)

    def progress(self, req_id, **data):
        emit({"id": req_id, "type": "event", "event": "progress", "data": data})

    async def main(self):
        self.loop = asyncio.get_running_loop()
        self.inbox = asyncio.Queue()
        pending = read_restore()
        if pending:
            log("restoring network left by an interrupted hotspot session")
            await asyncio.to_thread(leave_network, pending)
            await asyncio.to_thread(reconnect_original, pending)
        threading.Thread(target=self.read_stdin, daemon=True).start()
        watchdog = asyncio.create_task(self.watch())
        try:
            while not self.stopped:
                line = await self.inbox.get()
                if line is None:
                    # Node went away: stop transfers, let hotspot cleanup finish, then close.
                    self.cancel.set()
                    await self.drain()
                    await self.close_device()
                    break
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except ValueError:
                    log("ignored non-JSON input", "warn")
                    continue
                if message.get("cmd") == "cancel":
                    self.cancel.set()
                    emit({"id": message.get("id"), "type": "result", "data": {"cancelling": True}})
                    continue
                if message.get("cmd") in ("pull", "delete"):
                    # Clear here, in arrival order: a cancel that follows this line must still win,
                    # even if it is read before the task gets to run.
                    self.cancel.clear()
                task = asyncio.create_task(self.dispatch(message))
                self.tasks.add(task)
                task.add_done_callback(self.tasks.discard)
            await self.drain()
        finally:
            watchdog.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await watchdog

    async def drain(self):
        while self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)

    async def watch(self):
        while True:
            await asyncio.sleep(5.0)
            if self.dev is None or self.closing or self.lock.locked():
                continue
            if not self.dev.is_connected:
                emit({"type": "event", "event": "disconnected", "data": {"reason": "ConnectionLost"}})
                self.dev = None
                self.stopped = True
                self.inbox.put_nowait("")
                return

    async def dispatch(self, message):
        req_id = message.get("id")
        cmd = message.get("cmd")
        args = message.get("args") or {}
        async with self.lock:
            handler = getattr(self, "cmd_" + str(cmd), None)
            if handler is None:
                emit({"id": req_id, "type": "error", "error": {"kind": "UnknownCommand", "message": str(cmd)}})
                return
            try:
                data = await handler(req_id, args)
                emit({"id": req_id, "type": "result", "data": data})
            except Exception as error:  # noqa: BLE001
                emit({"id": req_id, "type": "error", "error": error_payload(error)})

    def require_device(self):
        if self.dev is None or not self.dev.is_connected:
            raise self.memotalk.ConnectionLost("recorder is not connected")
        return self.dev

    async def close_device(self):
        if self.dev is None:
            return
        self.closing = True
        with contextlib.suppress(Exception):
            await self.dev.close()
        self.dev = None

    # -- commands ------------------------------------------------------------
    async def cmd_connect(self, req_id, args):
        if self.dev is not None and self.dev.is_connected:
            target = self.dev.transport.target
            return {"address": getattr(target, "address", None), "hotspotWasOn": False, "timeSynced": False}
        options = {"scan_timeout": 6.0}
        if self.args.prefer:
            options["prefer"] = self.args.prefer
        dev = self.memotalk.MemoTalkClient(**options)
        await dev.connect()
        self.dev = dev
        time_synced = False
        try:
            time_synced = bool(await dev.sync_time())
        except Exception as error:  # noqa: BLE001
            log("sync_time failed: %s: %s" % (type(error).__name__, error), "warn")
        hotspot_was_on = False
        try:
            if await dev.wifi.hotspot_state():
                hotspot_was_on = True
                await dev.wifi.disable()
        except Exception as error:  # noqa: BLE001
            log("hotspot self-check failed: %s: %s" % (type(error).__name__, error), "warn")
        target = dev.transport.target
        return {"address": getattr(target, "address", None), "hotspotWasOn": hotspot_was_on, "timeSynced": time_synced}

    async def cmd_status(self, req_id, args):
        dev = self.require_device()
        identity = await dev.identity()
        battery = await dev.battery()
        firmware = await dev.firmware()
        free_space = await dev.free_space()
        record = await dev.record.state()
        version = getattr(firmware, "version", None) or getattr(firmware, "raw", None)
        return {
            "serial": identity.serial,
            "model": "MemoTalk S1",
            "firmware": version,
            "batteryPct": battery.percent,
            "freeSpacePct": free_space.percent,
            "recordingState": record.state.name,
            "storageFormat": identity.format_name,
        }

    async def cmd_list(self, req_id, args):
        dev = self.require_device()
        files = []
        for entry in await dev.files.list():
            files.append({
                "name": entry.name,
                "format": entry.format_name,
                "sizeBytes": entry.size,
                "durationSec": entry.duration_sec,
                "timestamp": entry.timestamp,
            })
        return {"files": files}

    async def cmd_delete(self, req_id, args):
        dev = self.require_device()
        results = []
        for name in args.get("names") or []:
            try:
                await dev.files.delete(str(name))
                results.append({"name": name, "ok": True})
            except Exception as error:  # noqa: BLE001
                results.append({"name": name, "ok": False, "error": error_payload(error)})
        return {"files": results}

    async def cmd_disconnect(self, req_id, args):
        await self.close_device()
        self.stopped = True
        self.inbox.put_nowait("")
        return {"disconnected": True}

    async def cmd_pull(self, req_id, args):
        dev = self.require_device()
        files = [f for f in (args.get("files") or []) if f.get("name")]
        out_dir = Path(args.get("outDir") or ".")
        out_dir.mkdir(parents=True, exist_ok=True)
        results = {}
        remaining = list(files)
        counter = {"index": 0, "count": len(files)}
        if args.get("transport") == "wifi" and remaining:
            remaining = await self.pull_wifi(req_id, dev, remaining, out_dir, results, counter)
        if remaining and not self.cancel.is_set():
            await self.pull_ble(req_id, dev, remaining, out_dir, results, counter)
        ordered = [results[f["name"]] for f in files if f["name"] in results]
        return {"files": ordered, "cancelled": self.cancel.is_set()}

    # -- Wi-Fi hotspot + FTP -------------------------------------------------
    async def pull_wifi(self, req_id, dev, files, out_dir, results, counter):
        remaining = list(files)
        stage = "enable"
        failure = None
        joined = None
        online_before = False
        self.progress(req_id, phase="preparing", transport="wifi", file=None, bytes=0, total=None,
                      index=0, count=counter["count"])
        try:
            async with dev.wifi.session() as net:
                SECRETS.add(net.password)
                SECRETS.add(net.ftp_config.password)
                try:
                    if self.cancel.is_set():
                        raise CancelledTransfer()
                    # Only wait for the network to come back afterwards if it was usable before.
                    online_before = await asyncio.to_thread(network_usable)
                    stage = "join"
                    joined = await asyncio.to_thread(join_network, net)
                    stage = "reach"
                    reachable = await asyncio.to_thread(
                        wait_reachable, net.ftp_config.host, net.ftp_config.port, 20.0, self.cancel.is_set)
                    if self.cancel.is_set():
                        raise CancelledTransfer()
                    if not reachable:
                        raise WifiUnreachable("%s not reachable within 20s" % net.ftp_config.address)
                    stage = "ftp"
                    ftp = await asyncio.to_thread(net.open_ftp)
                    try:
                        names = await asyncio.to_thread(net.list_audio_files, ftp)
                        by_lower = {name.lower(): name for name in names}
                        stage = "transfer"
                        for item in list(remaining):
                            if self.cancel.is_set():
                                raise CancelledTransfer()
                            remote = by_lower.get(item["name"].lower())
                            if remote is None:
                                continue  # left for BLE
                            counter["index"] += 1
                            path, size = await asyncio.to_thread(
                                self.ftp_fetch, ftp, remote, item, out_dir, req_id, counter)
                            results[item["name"]] = {"name": item["name"], "path": str(path), "sizeBytes": size,
                                                     "transport": "wifi", "ok": True}
                            remaining.remove(item)
                    finally:
                        with contextlib.suppress(Exception):
                            ftp.close()
                except CancelledTransfer:
                    pass
                except Exception as error:  # noqa: BLE001
                    failure = (stage, error)
                finally:
                    self.progress(req_id, phase="restoring", transport="wifi", file=None, bytes=0, total=None,
                                  index=counter["index"], count=counter["count"])
                    await asyncio.to_thread(leave_network, joined or read_restore())
        except Exception as error:  # noqa: BLE001
            if failure is None:
                failure = (stage, error)
        report = dev.wifi.last_close_report
        if report is not None and not report.get("confirmed", True):
            emit({"id": req_id, "type": "event", "event": "warning",
                  "data": {"code": "HOTSPOT_CLOSE_UNCONFIRMED", "detail": str(report.get("error") or "")}})
        restore = joined or read_restore()
        await asyncio.to_thread(reconnect_original, restore)
        if restore and online_before:
            # Node reopens the network gate on our result/fallback: report only once the network works.
            usable, waited = await asyncio.to_thread(wait_network_back, restore)
            if not usable:
                emit({"id": req_id, "type": "event", "event": "warning",
                      "data": {"code": "NETWORK_RESTORE_TIMEOUT",
                               "detail": "original network not usable %.0fs after leaving the hotspot" % waited}})
        if failure is not None and remaining and not self.cancel.is_set():
            stage_name, error = failure
            unsupported = type(error).__name__ == "CapabilityUnavailable"
            reason = "WIFI_UNSUPPORTED" if unsupported else WIFI_REASONS.get(stage_name, "WIFI_TRANSFER_FAILED")
            emit({"id": req_id, "type": "event", "event": "fallback",
                  "data": {"from": "wifi", "to": "ble", "reason": reason,
                           "detail": "%s: %s" % (type(error).__name__, error)}})
        return remaining

    def ftp_fetch(self, ftp, remote, item, out_dir, req_id, counter):
        expected = item.get("size") or None
        total = expected
        with contextlib.suppress(Exception):
            ftp.voidcmd("TYPE I")
            reported = ftp.size(remote)
            if reported:
                total = int(reported)
        part = out_dir / (item["name"] + ".part")
        state = {"done": 0, "last": 0.0}

        def write(chunk):
            if self.cancel.is_set():
                raise CancelledTransfer()
            handle.write(chunk)
            state["done"] += len(chunk)
            now = time.monotonic()
            if now - state["last"] >= 0.25:
                state["last"] = now
                self.progress(req_id, phase="transferring", transport="wifi", file=item["name"],
                              bytes=state["done"], total=total, index=counter["index"], count=counter["count"])

        try:
            with open(part, "wb") as handle:
                ftp.retrbinary("RETR " + remote, write, blocksize=32768)
            size = part.stat().st_size
            if expected and size != expected:
                raise SizeMismatch("%s: got %d bytes, device reported %d" % (item["name"], size, expected))
            final = out_dir / item["name"]
            os.replace(part, final)
            return final, size
        except BaseException:
            with contextlib.suppress(FileNotFoundError):
                part.unlink()
            raise

    # -- BLE -----------------------------------------------------------------
    async def pull_ble(self, req_id, dev, files, out_dir, results, counter):
        sync_op = self.memotalk.SyncOp
        for item in files:
            if self.cancel.is_set():
                return
            name = item["name"]
            counter["index"] += 1
            size = item.get("size") or None
            state = {"last": 0.0}

            def on_progress(received, total_packets, _name=name, _size=size):
                if self.cancel.is_set():
                    raise CancelledTransfer()
                now = time.monotonic()
                if now - state["last"] >= 0.25 or received == total_packets:
                    state["last"] = now
                    done = received * 320
                    if _size:
                        done = min(done, _size)
                    self.progress(req_id, phase="transferring", transport="ble", file=_name, bytes=done,
                                  total=_size, index=counter["index"], count=counter["count"])

            try:
                path = await dev.files.download(name, out_dir, size=size, overwrite=True, progress=on_progress)
                results[name] = {"name": name, "path": str(path), "sizeBytes": Path(path).stat().st_size,
                                 "transport": "ble", "ok": True}
            except CancelledTransfer:
                with contextlib.suppress(Exception):
                    await dev.files.sync_control(name, sync_op.CANCEL)
                return
            except Exception as error:  # noqa: BLE001
                results[name] = {"name": name, "transport": "ble", "ok": False, "error": error_payload(error)}
                if not dev.is_connected:
                    return


def main():
    global STATE_DIR, NET_PLATFORM
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--prefer")
    parser.add_argument("--fake-prelude")
    parser.add_argument("--net-platform", choices=["win32", "darwin", "linux"])
    args = parser.parse_args()
    STATE_DIR = Path(args.state_dir)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    platform = sys.platform
    NET_PLATFORM = args.net_platform or ("linux" if platform.startswith("linux") else platform)
    sys.stderr = ScrubbingStream(sys.stderr)

    try:
        import memotalk
    except Exception as error:  # noqa: BLE001
        emit({"type": "event", "event": "fatal", "data": error_payload(error)})
        return 3
    if args.fake_prelude:
        runpy.run_path(args.fake_prelude, run_name="openminutes_fake_prelude")

    worker = Worker(args, memotalk)
    try:
        asyncio.run(worker.main())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

export const DEVICE_WORKER_SCRIPT = NETWORK_PART + WORKER_PART;
