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
from contextlib import suppress


def log(event, **fields):
    try:
        sys.stderr.write(json.dumps({"event": event, **fields}, ensure_ascii=False) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--no-record", action="store_true", help="不自动开始录音，只订阅已有录音流")
    parser.add_argument("--scan-timeout", type=float, default=12.0, help="扫描等待秒数，期间按键唤醒也能连上")
    args = parser.parse_args()

    try:
        from memotalk import MemoTalkClient
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

        out = sys.stdout.buffer
        total = 0

        try:
            async with MemoTalkClient(scan_timeout=max(3.0, args.scan_timeout)) as dev:
                log("connected")
                target = dev.transport.target
                log("found", name=getattr(target, "name", "") or "", address=getattr(target, "address", ""))
                pump = None
                states = None
                waiter = None
                recording = False
                try:
                    async def pump_audio():
                        nonlocal total
                        async for chunk in dev.stream.audio():
                            out.write(chunk)
                            out.flush()
                            total += len(chunk)

                    async def pump_states():
                        async for state in dev.stream.states():
                            log("record_state", state=state.state.value, filename=state.filename)

                    pump = asyncio.create_task(pump_audio())
                    states = asyncio.create_task(pump_states())
                    # Let both SDK iterators subscribe before the device starts sending.
                    await asyncio.sleep(0)
                    if not await dev.record.set_realtime(True):
                        raise RuntimeError("device rejected realtime audio mode")
                    if not args.no_record:
                        await dev.record.start()
                        recording = True
                        log("recording", state="started")

                    waiter = asyncio.create_task(stop.wait())
                    log("streaming")
                    done, _ = await asyncio.wait([pump, states, waiter], return_when=asyncio.FIRST_COMPLETED)
                    for task in (pump, states):
                        if task in done:
                            await task
                finally:
                    for task in (pump, states, waiter):
                        if task is not None:
                            task.cancel()
                            with suppress(asyncio.CancelledError, Exception):
                                await task
                    try:
                        if recording:
                            await dev.record.stop()
                    finally:
                        if not await dev.record.set_realtime(False):
                            raise RuntimeError("device rejected disabling realtime audio mode")
                log("stopped", audio_bytes=total)
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
