# 转录与归类（Host 边界）

转录用 ffmpeg 把 MP3 解码成 16 kHz PCM，再通过 Floatboat Host 的 ASR 流式识别；AI 归类调用 Host 的 LLM 输出结构化结论。这两项能力都依赖 Host 连接。本 skill 独立启动的实例没有 Host 连接，所以**本文件只验证失败是否如实呈现、是否可以重试**。成功路径见 [transcribe-success.md](./transcribe-success.md)，需要 Host 模式。

## Sub-features

- `asr-unavailable`：「开始转录」→ 状态变为「失败」，详情页出现「上次处理未成功：语音识别无法启动。…HOST_NOT_CONNECTED…」，「执行记录」里多一条 failure。
- `llm-unavailable`：没有转录文本时「AI 归类」按钮被禁用；即使通过接口强行触发，也只会失败，不会写入伪造的结论。
- `env-report`：设备接入页「本机环境」的「语音识别」「文本模型」两行显示 `HOST_NOT_CONNECTED` 和「未就绪」。
- `asr-success` / `llm-success`：转到 [成功路径配方](./transcribe-success.md)，先确认隔离 Host 模式及额度前提；独立模式只执行其中的 TTS 导入/播放。

## How to get to it (user POV)

- 详情页顶部的「开始转录」或空状态里的「开始转录」，以及「AI 归类」。
- 录音库勾选多条后，批量操作栏里的批量转录 / 批量归类。
- 设备接入页的「本机环境」卡片。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件，已导入一条录音（id 为 1），状态为「待转录」。

- **触发转录。** 运行 `browse.mjs <runId> asr '[{"goto":"#/rec/1"},{"waitText":"返回录音库"},{"screenshot":"01-before.png"},{"click":"text=开始转录"},{"waitText":"转录任务已排队"},{"screenshot":"02-queued.png"},{"waitText":"HOST_NOT_CONNECTED","timeout":15000},{"expectText":"失败"},{"eval":"location.hash"},{"screenshot":"03-failed.png"},{"click":"text=执行记录 1"},{"screenshot":"04-jobs.png"}]'`。整个过程**不离开页面**：页面先显示「转录已排队」，约 3 秒内原地变为「失败」并出现错误条，`location.hash` 始终是 `#/rec/1`。
- **终态后停止轮询。** 页面到达终态后，统计请求次数。eval 里有引号，所以把下面的步骤存成 `$R/poll.json`，再用 `browse.mjs <runId> asr-poll @$R/poll.json` 运行（这一步需要另一条还没转录过的录音，这里用 id 2）：

  ```json
  [{"goto":"#/rec/2"},{"waitText":"返回录音库"},
   {"eval":"(() => { window.__calls = 0; const f = window.fetch; window.fetch = (...a) => { window.__calls++; return f(...a); }; return true; })()"},
   {"click":"text=开始转录"},{"waitText":"HOST_NOT_CONNECTED","timeout":15000},
   {"eval":"(() => { window.__calls = 0; return true; })()"},{"sleep":10000},
   {"eval":"window.__calls"}]
  ```

  预期最后一次 eval 的结果为 `0`。如果大于 0，说明终态后仍在轮询。
- **批量转录自动刷新。** 导入两条新录音后运行 `browse.mjs <runId> batch '[{"goto":"#/library"},{"waitText":"命中 2 条录音"},{"click":"aria=全选当前页"},{"click":"text=批量转录"},{"waitText":"已排队 2 条转录任务"},{"waitText":"转录已排队"},{"screenshot":"01-queued.png"},{"waitNoText":"转录已排队","timeout":15000},{"screenshot":"02-failed.png"}]'`。整个过程不刷新页面，列表会从「转录已排队」自动变成「失败」。不要用 `waitText:"失败"` 判断：工具栏上的「失败」筛选按钮一直存在，会立刻命中。读回验证：`curl -s "$URL/api/recordings"` 中 `hasActiveTasks` 为 false，两条记录的 `status` 都是 `failed`。
- **读回。** 运行 `curl -s "$URL/api/recordings/1" | tee $E/asr/detail.json`。预期 `data.recording.status` 为 `failed`，`data.lastError` 包含 `ASR_START_FAILED`，`data.jobs[0]` 的 `kind` 为 `transcribe`、`status` 为 `failure`；`data.recording.transcriptChars` 仍为 0，也就是没有伪造文本。
- **环境报告。** 运行 `browse.mjs <runId> env '[{"goto":"#/device"},{"waitText":"本机环境"},{"aria":"env.aria.txt"}]'`。预期 `env.aria.txt` 中「语音识别」「文本模型」两行都是 `HOST_NOT_CONNECTED` / 「未就绪」。

## Gotchas

- 以上配方要求被测代码包含 PR #3（main 上的 0bbad18，排队状态与轮询修复）。更早的代码里，点「开始转录」后页面停在「待转录」不会刷新，要离开再回来才能看到结果；如果原地 `waitText` 超时，先确认被测代码里已有 `queued_transcribe` 状态（`grep -r queued_transcribe src/`）。
- 排队状态（「转录已排队」「归类已排队」）是服务端根据队列临时算出来的，不写入数据库。阶段筛选和概览计数仍按数据库状态统计，所以排队中的录音会出现在「待转录」tab 里，但显示的是「转录已排队」标签，这是预期行为。
- 服务进程在任务中途退出后，下次启动会把残留的 `transcribing`/`analyzing` 恢复为 `failed`，并写入「上次处理因服务重启中断，可重新开始」，残留的 `running` 任务记录也会一并收尾（PR #6，main 上的 11627cd）。如果重启后录音库仍在持续轮询，说明被测代码不包含这个修复，或者恢复逻辑出了回归。
- `launch.mjs` 已经关闭了 `auto_transcribe` / `auto_analyze`。导入之后不会自动排队转录，必须手动触发。
- 失败之后，「执行记录」分区的标题会带上计数（例如「执行记录 1」），所以 `text=` 选择器要写成带数字的完整文字。
- 不要在报告里把这里的结果写成「转录可用」。这里证明的只是失败路径。
