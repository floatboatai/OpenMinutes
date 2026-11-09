# 设置 › 诊断与高级

唯一的技术细节区。默认折叠，从 `#/settings/diagnostics` 进入时自动展开。依次包含本机环境、运行时路径、转录任务、传输方式（自动 / 始终无线快传 / 始终蓝牙）、最近设备操作、宿主能力、设备协议指令参考（开发者）、开发者工具和「复制诊断报告」。

## Sub-features

- `diag-sections`：上述各分区标题都在。
- `diag-transport`：把「传输方式」改为「始终蓝牙」，出现「有未保存的修改」，点「保存设置」后 `/api/settings` 读回 `device_transport=ble`，`/api/diagnostics` 的 `transport.setting` 也为 `ble`、`thresholdBytes` 为 1048576。最后改回「自动」，不影响后续配方。

## How to get to it (user POV)

- 侧边导航「设置」→ 展开「诊断与高级」；出错提示里的「在诊断中查看」/「去诊断与修复」也会跳到这里。

## Driving it with browse.mjs

Preconditions：满足基线条件，普通启动，doctor 的 exit 为 0。

- 运行 `browse.mjs <runId> diagnostics @.claude/skills/verify-openminutes/features/diagnostics.steps.json`。
- 预期页面包含「转录任务」以及其它分区；两个读回 `eval` 分别返回 `"auto"` 和 `setting: "ble"` 的传输信息，`console.log` 为空。

## Gotchas

- 保存设置会一并提交通用分区的目录输入框；隔离实例里这些值来自 launch，没有改动时保存不会破坏隔离，但不要在这一步编辑目录。
- 普通启动时「无线网卡」一栏读的是本机真实探测结果（只读的 `netsh wlan show drivers` 等命令）。
