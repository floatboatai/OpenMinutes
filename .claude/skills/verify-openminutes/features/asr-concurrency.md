# 设置 › 诊断与高级 › 同时转录的录音数

转录最多同时进行 N 条（`asr_concurrency`，1–8，默认 3）；归类、场景整理仍一条一条执行。唯一入口在「设置 › 诊断与高级 › 转录任务」，保存后对之后开始的转录生效，执行中的不打断。

## Sub-features

- `asr-concurrency-default`：展开诊断区后可见「转录任务」分区与「同时转录的录音数」输入框，初值与 `/api/settings` 读回的 `asr_concurrency` 都是 `3`。
- `asr-concurrency-save`：改为 `5` 后出现「有未保存的修改」，点「保存设置」提示「设置已保存」，读回 `5`。
- `asr-concurrency-reject`：填 `9` 保存，提示「…需为 1~8 的整数」，修改仍未保存，读回仍是 `5`。
- 最后改回 `3`，不影响后续配方。

并行上限是否真的生效（同时只跑 N 条、归类串行、调大立即补位）由单测 `tests/queue-lanes.test.ts` 与 `tests/settings.test.ts` 覆盖；断点续转与重启恢复见 `tests/transcribe-resume.test.ts`、`tests/startup-recovery.test.ts`。页面上没有可单独观察并行数的入口。

## How to get to it (user POV)

- 侧边导航「设置」→ 展开「诊断与高级」→「转录任务」。

## Driving it with browse.mjs

Preconditions：满足基线条件，普通启动（不需要 Host），doctor 的 exit 为 0。

- 运行 `browse.mjs <runId> asr-concurrency @.claude/skills/verify-openminutes/features/asr-concurrency.steps.json`（PowerShell 中 `@file` 参数整体加引号）。
- 预期 4 个读回 `eval` 依次返回 `"3"`、`"5"`、`"5"`、`"3"`，`console.log` 为空。

## Gotchas

- 保存设置会一并提交整页的设置草稿；隔离实例里目录等值来自 launch，不要在这一步编辑其它字段。
- 校验失败的 toast 文案来自服务端 `normalize`，包含设置键名；这是诊断区里的既有表现。
