# 录音笔：连接、同步、清理、断开

连接、断开、同步、单条同步、停止、清理只在「录音笔」页。开着「连上录音笔后自动同步」时，点一次「连接」就完成同步。大录音默认走无线快传，期间按钮附近提示「暂时断开外网」；主界面不出现 Wi-Fi、FTP、热点等技术词。无线快传失败时自动改用蓝牙，原因只在「查看详情」里。手动断开后自动连接暂停，直到再点「连接」。

**只用 `--fake-device`。** 真实录音笔的同步会切换本机 Wi-Fi，清理会删除录音笔上的文件，禁止在验证里对真实录音笔操作。

## Sub-features

- `device-one-click`（wifi）：点「连接」后等到「已同步 3 条录音」，过程中出现「暂时断开外网」。
- `device-diagnostics-log`（wifi）：「设置 › 诊断与高级 › 最近设备操作」里有一条传输为「无线快传」的记录。
- `device-cleanup`（wifi）：「清理已同步的录音（3 条 · 3.5 MB）」，确认后出现「已清理 3 条」，`cleanable.count` 为 0。
- `device-disconnect`（wifi）：「断开连接」后显示「已手动断开，自动连接暂停」，`/api/device` 为 `state=disconnected`、`userDisconnected=true`。
- `device-fallback`（ble）：同步完成后出现「已改用蓝牙」的提示（`role=status`）；点「查看详情」前看不到 `WIFI_JOIN_FAILED`，点之后才看到。
- `live-busy`（wifi）：同步进行中打开「实时字幕」，「开始实时字幕」被禁用并显示「录音笔正在同步」，同步结束后恢复可用。
- `live-connecting`（absent）：连接进行中打开「实时字幕」，横幅写「录音笔正在连接，请稍候。」（不是「正在同步」），连接结束后「开始实时字幕」恢复可用。

## How to get to it (user POV)

- 侧边导航「录音笔」→「连接」。设置项「连上录音笔后自动同步」「后台自动同步大录音时也用无线快传」在「设置 › 自动化」，传输方式覆盖在「设置 › 诊断与高级」。

## Driving it with browse.mjs

Preconditions：`MEMOTALK_TEST_PYTHON` 指向装了 `memotalk-sdk==0.1.0` 的解释器（`uv venv .workbench/test-python` + `uv pip install --python .workbench/test-python/Scripts/python.exe memotalk-sdk==0.1.0`）。每个配方用一个新的 runId。

| 配方 | 启动 | 命令 |
|---|---|---|
| 一次点击、诊断记录、清理、断开 | `launch.mjs <runId> --no-host --fake-device=wifi` | `browse.mjs <runId> device-connection @.claude/skills/verify-openminutes/features/device-connection.steps.json` |
| 改用蓝牙与查看详情 | `launch.mjs <runId> --no-host --fake-device=ble` | `browse.mjs <runId> device-fallback @.claude/skills/verify-openminutes/features/device-fallback.steps.json` |
| 同步中实时字幕被禁用 | `launch.mjs <runId> --no-host --fake-device=wifi` | `browse.mjs <runId> live-busy @.claude/skills/verify-openminutes/features/live-busy.steps.json` |
| 连接中实时字幕显示「正在连接」而不是「正在同步」 | `launch.mjs <runId> --no-host --fake-device=absent` | `browse.mjs <runId> live-connecting @.claude/skills/verify-openminutes/features/live-connecting.steps.json` |

- 前两个配方的第一步用 `PATCH /api/settings {auto_pull:'1'}` 打开自动同步（launch 默认关闭四个 auto 开关）；live-busy 保持关闭，由 `POST /api/device/sync` 发起同步后立即切到 `#/live`。
- 预期每个 `eval` 都返回值、`console.log` 为空。读回 JSON 记录在 `steps.log` 里。

## Gotchas

- 无线快传阶段可能短于 1.5 秒的轮询间隔，所以「连接」点击和过程观察放在同一个 `eval` 里，每 30 ms 采样一次页面文字。
- 清理确认框由 `browse.mjs` 自动接受，确认文字记在 `steps.log`。
- 假设备 prelude 会让任何 `netsh` / `nmcli` / `networksetup` 调用直接抛错；如果 `server.log` 里出现这类 AssertionError，说明代码绕过了假设备路径，需要修。
- 假设备的序列号是模拟器自带的占位串（形如 `{{SERIAL_xxxx}}`），只在假设备下出现。
