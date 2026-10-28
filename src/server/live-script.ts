// ABOUTME: 内嵌实时字幕采集脚本，随构建分发并写入数据区后由 Python 执行。

export const LIVE_CAPTION_SCRIPT = String.raw`#!/usr/bin/env python3
"""实时字幕采集：连接录音笔 -> 开启 0xA4 实时音频流 -> 把 288 字节 MP3 帧写到 stdout。

stdout 只输出音频字节；所有诊断信息以 JSON 行写到 stderr。
从 stdin 收到 stop/quit/exit 或 EOF 时优雅收尾（停止录音、关闭 0xA4）。
"""

import argparse
import asyncio
import json
import sys
import threading
import time


def log(event, **fields):
    try:
        sys.stderr.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--sdk", required=True, help="memotalk-ble-skill/scripts 目录")
    parser.add_argument("--no-record", action="store_true", help="不自动开始录音，只订阅已有录音流")
    parser.add_argument("--scan-timeout", type=float, default=12.0, help="扫描等待秒数，期间按键唤醒也能连上")
    args = parser.parse_args()

    sys.path.insert(0, args.sdk)
    try:
        from bleak import BleakClient
        from ble_core import (
            UUID_CHAR_FFF1_WRITE,
            UUID_CHAR_FFF2_NOTIFY,
            UUID_CHAR_FFE1_WRITE,
            UUID_CHAR_FFE2_NOTIFY,
            REC_START,
            REC_STOP,
            cmd_control_recording,
            cmd_read_battery,
            cmd_set_realtime_asr,
            cmd_sync_rtc_time,
            find_or_retrieve_device,
            parse_ffe2_realtime_packet,
        )
    except Exception as error:  # noqa: BLE001
        log("error", stage="import", message="%s: %s" % (type(error).__name__, error))
        return 3

    loop_holder = {}

    def watch_stdin():
        loop = loop_holder.get("loop")
        try:
            for line in sys.stdin:
                if line.strip().lower() in ("stop", "quit", "exit"):
                    break
        except Exception:
            pass
        if loop is not None:
            loop.call_soon_threadsafe(loop_holder["stop"].set)

    async def run():
        loop_holder["loop"] = asyncio.get_running_loop()
        loop_holder["stop"] = asyncio.Event()
        stop = loop_holder["stop"]
        threading.Thread(target=watch_stdin, daemon=True).start()

        device = await find_or_retrieve_device(timeout=max(3.0, args.scan_timeout))
        if not device:
            log("error", stage="scan", message="未发现外设，请按一下录音笔物理键唤醒后重试")
            return 2

        log("found", name=device.name or "", address=device.address)
        out = sys.stdout.buffer
        total = 0
        pcm_unknown = 0

        try:
            async with BleakClient(device, timeout=15.0) as client:
                log("connected")
                frames = asyncio.Queue()

                def on_ffe2(_sender, data):
                    frames.put_nowait(bytes(data))

                await client.start_notify(UUID_CHAR_FFE2_NOTIFY, on_ffe2)
                await client.start_notify(UUID_CHAR_FFF2_NOTIFY, lambda _s, _d: None)
                await client.write_gatt_char(UUID_CHAR_FFF1_WRITE, cmd_sync_rtc_time(), response=False)
                await asyncio.sleep(0.35)
                await client.write_gatt_char(UUID_CHAR_FFF1_WRITE, cmd_set_realtime_asr(True), response=False)
                await asyncio.sleep(0.25)

                if not args.no_record:
                    await client.write_gatt_char(
                        UUID_CHAR_FFE1_WRITE, cmd_control_recording(REC_START), response=False
                    )
                    log("recording", state="started")

                log("streaming")
                last_keepalive = time.time()

                while not stop.is_set():
                    try:
                        packet = await asyncio.wait_for(frames.get(), timeout=0.5)
                    except asyncio.TimeoutError:
                        packet = None

                    if packet is not None:
                        kind, value = parse_ffe2_realtime_packet(packet)
                        if kind == "realtime_audio" and isinstance(value, (bytes, bytearray)):
                            chunk = bytes(value)
                            out.write(chunk)
                            out.flush()
                            total += len(chunk)
                        elif kind == "unknown":
                            pcm_unknown += 1
                        elif kind == "record_state" and isinstance(value, dict):
                            log("record_state", state=value.get("state"), filename=value.get("filename"))

                    if time.time() - last_keepalive > 25:
                        last_keepalive = time.time()
                        try:
                            await client.write_gatt_char(
                                UUID_CHAR_FFF1_WRITE, cmd_read_battery(), response=False
                            )
                        except Exception:
                            pass

                if not args.no_record:
                    try:
                        await client.write_gatt_char(
                            UUID_CHAR_FFE1_WRITE, cmd_control_recording(REC_STOP), response=False
                        )
                        await asyncio.sleep(0.4)
                    except Exception:
                        pass
                try:
                    await client.write_gatt_char(
                        UUID_CHAR_FFF1_WRITE, cmd_set_realtime_asr(False), response=False
                    )
                except Exception:
                    pass
                log("stopped", audio_bytes=total, unknown_packets=pcm_unknown)
            return 0
        except Exception as error:  # noqa: BLE001
            log("error", stage="stream", message="%s: %s" % (type(error).__name__, error))
            return 4

    try:
        return asyncio.run(run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
`;

export function liveScriptSource(): string {
  return LIVE_CAPTION_SCRIPT;
}
