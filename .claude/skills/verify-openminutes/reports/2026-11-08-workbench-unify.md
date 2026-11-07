# 2026-11-08 工作台整改（统一入口 · 默认无线快传 · 错误分层）验收记录

分支 `redreamality/workbench-unify-entry-wifi`，未提交的工作区。所有运行都是隔离实例（`--no-host`），没有接触真实 Floatboat 数据，也没有对真实录音笔执行任何操作；录音笔一律是 `--fake-device`。假设备 prelude 会让 `netsh` / `nmcli` / `networksetup` 调用直接抛错，各 run 的 `server.log` 里没有出现这类错误。

## 单元测试

- `MEMOTALK_TEST_PYTHON=.workbench/test-python/Scripts/python.exe pnpm test:ci`：exit 0。`pnpm test` 154 项全过、0 跳过（含 `tests/sdk.test.ts` 的 Wi-Fi 三平台序列、回退、取消、关热点未确认、密码不外泄、启动恢复）；`pnpm test:verification` 31 项全过。
- 新增：`device-transport`、`device-errors`、`http-envelope`、`network-gate`、`device-service`、`device-sync`、`device-routes`、`router`；扩充 `preflight`（分组与 label 不含包名）、`pipeline-routes`（批量 `{stage}`）。夹具在 `tests/support/device-fixture.ts`（TS 假 worker）。

## e2e

| 步骤文件 | runId | 启动 | 结果 | 证据 |
|---|---|---|---|---|
| `features/navigation.steps.json` | `wsd-nav-1` | 普通 | 通过 | `.workbench/verify-evidence/wsd-nav-1/navigation2/` |
| `features/import-dialog.steps.json` | `wsd-nav-1` | 普通 | 通过 | `.workbench/verify-evidence/wsd-nav-1/import-dialog/` |
| `features/diagnostics.steps.json` | `wsd-nav-1` | 普通 | 通过 | `.workbench/verify-evidence/wsd-nav-1/diagnostics/` |
| `features/calendar-link.steps.json` | `wsd-nav-1` | 普通 | 通过 | `.workbench/verify-evidence/wsd-nav-1/calendar-link2/` |
| `features/device-connection.steps.json` | `wsd-wifi-2` | `--fake-device=wifi` | 通过：一次点击 7.6 秒同步 3 条，过程中出现「暂时断开外网」，主视图未出现技术词 | `.workbench/verify-evidence/wsd-wifi-2/device-connection/` |
| `features/recording-detail-actions.steps.json` | `wsd-detail-1` | `--fake-device=wifi` | 通过 | `.workbench/verify-evidence/wsd-detail-1/recording-detail-actions/` |
| `features/live-busy.steps.json` | `wsd-live-1` | `--fake-device=wifi` | 通过：发起同步 65 ms 后「开始实时字幕」已禁用 | `.workbench/verify-evidence/wsd-live-1/live-busy/` |
| `features/device-fallback.steps.json` | `wsd-ble-1` | `--fake-device=ble` | 通过 | `.workbench/verify-evidence/wsd-ble-1/device-fallback/` |
| `features/error-detail.steps.json` | `wsd-absent-1` | `--fake-device=absent` | 通过 | `.workbench/verify-evidence/wsd-absent-1/error-detail/` |
| `tests/e2e-preflight.mjs`（无 Host + 模拟 Host） | `preflight-nohost-1794081139629`、`preflight-fixture-1794081153975` | 脚本自起 | 通过 | 同名证据目录 |

- 每个 label 的 `console.log` 都是 0 字节；接口读回 JSON 记在各自的 `steps.log`。
- 首次尝试记录：`wsd-nav-1/navigation`、`calendar-link`、`wsd-wifi-1/device-connection` 是步骤本身的断言写错（默认折叠的检查方式、面包屑无空格、设备记录是 `li` 不是表格），修正步骤后用新 label 或新 runId 重跑通过。
- 每个 run 结束后都执行了 `cleanup.mjs <runId>`，没有遇到 EPERM；`.workbench/verify/` 下没有遗留的 run 目录。

## 测试中发现并修复的问题

- `src/server/device/service.ts`：主动断开时 worker 退出回调先把状态改成 `disconnected / device_sleep`，`disconnect()` 之后才写入真实原因。页面轮询可能短暂显示「录音笔已休眠或离开范围」，自动连接的 tick 也可能在这个窗口里抢先重连，随后被 `disconnect()` 覆盖状态。现在只有仍是当前 worker 的意外退出才走「已休眠」分支。由 `device-service.test.ts` 的后台会话用例覆盖（断开过程中只允许出现 `auto-done`）。
- `scripts/doctor.mjs`：`tests/e2e-preflight.mjs` 的模拟 Host 分支在 HEAD 上就会报 `HOST_MODE_CONFIG_MISMATCH`。新增 `hostMode: 'fixture'`（只接受回环地址、不探测），测试在 run.json 里声明该模式。

## 未覆盖

- 真实录音笔与真实 Wi-Fi 切换（Windows netsh 实网、定位权限关闭、实测吞吐）按计划 §8.5 由用户本人执行。
- macOS / Linux 入网只有桩测。
