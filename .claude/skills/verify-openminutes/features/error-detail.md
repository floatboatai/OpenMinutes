# 错误分两层：中文结论 + 查看详情

出错时主行只显示一句中文结论；技术原文（异常类型、退出码、stderr）只在点「查看详情」后展开，展开区提供「复制诊断信息」和「在诊断中查看」。带详情的错误 toast 不会自动消失，toast 上的「详情」打开同样内容的弹窗。

## Sub-features

- `error-headline`（absent）：点「连接」后出现「没有找到录音笔」，页面上没有 `DeviceNotFound`、`Traceback`。
- `error-expand`：页面内 `ErrorNotice`（`role=alert`）的「查看详情」展开后出现 `DeviceNotFound`、「复制诊断信息」「在诊断中查看」；再点一次收起。
- `error-toast-modal`：toast 的「详情」打开「出错详情」弹窗，里面是展开状态的同一条错误。弹窗里点「在诊断中查看」后弹窗关闭，页面停在展开的「诊断与高级」（`details#diagnostics[open]`）。
- `error-readback`：`/api/device` 的 `lastError` 为 `DEVICE_NOT_FOUND`，`message` 是中文，`detail` 含 `DeviceNotFound`。

## How to get to it (user POV)

- 任何出错的位置原地显示；完整的设备操作记录在「设置 › 诊断与高级 › 最近设备操作」。

## Driving it with browse.mjs

Preconditions：`MEMOTALK_TEST_PYTHON` 已设置；`launch.mjs <runId> --no-host --fake-device=absent`，doctor 的 exit 为 0。

- 运行 `browse.mjs <runId> error-detail @.claude/skills/verify-openminutes/features/error-detail.steps.json`。
- 预期最后一个 `eval` 返回 `lastError`，`console.log` 为空。

## Gotchas

- 同一屏可能同时有 toast 和卡片里的 `ErrorNotice`，步骤用 `main .errornotice--error` 精确定位卡片里的那条。
- 无 Host 的转录失败也遵守同样的分层，见 `recipes/host-off.json`。
