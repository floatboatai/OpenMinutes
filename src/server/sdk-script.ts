// ABOUTME: 用已安装的 memotalk SDK 生成桥接层现有的设备报告。

export const SDK_ACTION_SCRIPT = String.raw`
import argparse
import asyncio
import sys
from memotalk import MemoTalkClient, commands, parsers
from memotalk.constants import Cmd
from memotalk.errors import MemoTalkError


async def run(args):
    async with MemoTalkClient() as dev:
        if args.action == "status":
            info = await dev.info()
            print("设备序列号: " + info.identity.serial)
            print("蓝牙 MAC: " + info.record.mac)
            print("固件版本号: (" + info.firmware.version + ")")
            print("当前电量: %s%%" % info.battery.percent)
            print("剩余存储空间: %s%%" % info.free_space.percent)
            print("存储音频格式: " + info.identity.format_name)
            print("当前录音状态: " + info.record.state.name)
            # Hotspot metadata is optional; never read or print its password.
            try:
                reply = await dev.raw.request(commands.read_wifi_ssid(), code=Cmd.WIFI_SSID, timeout=2.0)
                print("热点 SSID: " + parsers.parse_text(reply))
            except MemoTalkError:
                pass
        elif args.action == "list":
            for index, entry in enumerate(await dev.files.list(), 1):
                print("%s. %s | 格式=%s | 大小=%s B | 时长=%ss | 时间戳=%s" % (
                    index, entry.name, entry.format_name, entry.size,
                    entry.duration_sec, entry.timestamp))
        else:
            saved = await dev.files.download(args.file, args.out_dir, overwrite=True)
            print("saved " + str(saved))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", choices=["status", "list", "download"], required=True)
    parser.add_argument("--file")
    parser.add_argument("--out-dir")
    args = parser.parse_args()
    if args.action == "download" and (not args.file or not args.out_dir):
        parser.error("download requires --file and --out-dir")
    try:
        asyncio.run(run(args))
    except Exception as error:
        print("[X] %s: %s" % (type(error).__name__, error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;
