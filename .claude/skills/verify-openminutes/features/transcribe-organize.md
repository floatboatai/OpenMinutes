# 转录与 AI 归类

应用实例、数据与浏览器保持隔离，ASR/LLM 复用正在运行的 Floatboat Host。启动和敏感信息边界见 [SKILL.md](../SKILL.md)。下面命令在仓库根目录运行；将示例 `host-success` / `host-off` 全部替换为未使用过的 runId。cleanup 保留证据，旧 id 不可复用，也不要在已有数据上整套重跑。

## 覆盖与预算

- 单条转录：详情页原地由排队/转录中到分段全文，切换纯文本，点击非零时标起播。
- 全文检索：归类前标题/摘要仍为空，搜索「蓝色铅笔」命中，再搜索不存在的词得到空结果。
- 单条 AI 归类：标题、摘要、分类、标签、要点、待办、重要度落库，详情与执行记录可见。
- 人工修正：改标题、分类、重要度、添加标签，返回列表再打开，UI 与 GET 读回一致。摘要/要点/待办目前没有人工编辑入口，不宣称覆盖。
- 批量：仅选择两条新录音，批量转录后批量归类，列表自动更新到终态。
- 预算：3 段约 15–19 秒语音，3 个转录任务、3 个归类任务。应用可能重连 ASR 或从 `generateObject` 回退到 `generateText`，必须统计实际调用，不能用任务数代替计费调用数。遇到失败先停止并留证，不自动重放。

## 前置与单条

Floatboat 桌面端运行且曾打开本应用；已有中文 Windows TTS 声音和 ffmpeg。只操作隔离页面，不驱动 Floatboat 原工作台，不碰 BLE。

```powershell
node .claude/skills/verify-openminutes/scripts/build.mjs
node .claude/skills/verify-openminutes/scripts/launch.mjs host-success
node .claude/skills/verify-openminutes/scripts/doctor.mjs host-success
node .claude/skills/verify-openminutes/scripts/speech.mjs host-success 1
node .claude/skills/verify-openminutes/scripts/browse.mjs host-success single '@.claude/skills/verify-openminutes/recipes/host-single.json'
node .claude/skills/verify-openminutes/scripts/evidence.mjs host-success single
```

每条命令成功后才执行下一条。`doctor` 必须报告 `host.mode=floatboat`、`available=true`、`problems=[]`。TTS 变体 1 生成 `REC20261029_120001.mp3`；固定日期用于可复现的录音时间，不代表当前时间。

`host-single.json` 从设备页「立即扫描」导入一条，然后点详情「开始转录」。它等待 `.segment__jump`，并断言状态 `transcribed`、全文非空、至少两个分段、hash 始终为 `#/rec/1`。点击第二段后断言播放器未暂停，`currentTime` 与接口的 `startMs/1000` 差小于 2 秒。最后通过 UI 和 GET 验证全文搜索。

证据 `$E/single/` 包含排队、分段、跳转播放、纯文本、搜索命中/未命中的截图或 ARIA，以及 `detail-1.json`、`job_runs.json`。`steps.log` 记录播放头、接口读回与断言结果。成功后再跑 AI，避免标题/摘要污染全文搜索的证明。

## 归类与人工修正

```powershell
node .claude/skills/verify-openminutes/scripts/browse.mjs host-success organize '@.claude/skills/verify-openminutes/recipes/host-organize.json'
node .claude/skills/verify-openminutes/scripts/evidence.mjs host-success organize
node .claude/skills/verify-openminutes/scripts/browse.mjs host-success correct '@.claude/skills/verify-openminutes/recipes/host-correct.json'
node .claude/skills/verify-openminutes/scripts/evidence.mjs host-success correct
```

归类配方等按钮恢复且出现「重新归类」，再查看 AI 结论和执行记录，不用固定延时猜完成。接口断言所有结构化字段存在，录音标题/摘要/重要度与分析一致。`$E/organize/03-analysis.*` 展示摘要、要点、待办及右侧整理字段；`04-jobs.*` 展示成功记录。

人工修正配方将标题改为「人工确认的发布计划」、分类 id 改为 2、重要度改为 2、添加「人工复核」。`$E/correct/02-reopened.*` 与 `detail-1.json` 证明重新打开后仍一致。分类 id 依赖当前内置迁移；若迁移改变，先 GET 分类再调整配方。分析记录是 AI 历史快照，不要求它被人工修正覆盖。

## 批量与计数

```powershell
node .claude/skills/verify-openminutes/scripts/speech.mjs host-success 2
node .claude/skills/verify-openminutes/scripts/speech.mjs host-success 3
node .claude/skills/verify-openminutes/scripts/browse.mjs host-success batch '@.claude/skills/verify-openminutes/recipes/host-batch.json'
node .claude/skills/verify-openminutes/scripts/evidence.mjs host-success batch
node .claude/skills/verify-openminutes/scripts/doctor.mjs host-success
```

配方扫描新增两条；在「待转录」筛选中全选并批量转录，回到「全部」观察自动刷新；在「待归类」中全选并批量归类。完成判据为三条记录均 `organized`、`hasActiveTasks=false`，新增两条有全文和 AI 字段。`$E/batch/` 保存前后截图、ARIA、全部详情和 `job_runs`。

`host-calls.json` 是截至留证时的累计值，不能把各 label 的计数相加。Host 模式的 `asr.start` 为启动尝试；`llm.generateObject` 加 `llm.generateText` 为模型请求总数，失败也计入。`sendFrame`/`stop` 是同一识别会话的传输/收尾，不算额外一段识别。该计数来自隔离库 `_workbench_tasks`，不是账单或 token 用量；无 Host 模式的 `HOST_NOT_CONNECTED` 记录只是本地 SDK 尝试，没有向 Host 发请求。

确认所有 `console.log` 为空，查看截图，而不只看脚本退出码。有异常时保存接口和 `job_runs`，报告复现步骤与证据路径；本分支不修应用代码。最后：

```powershell
node .claude/skills/verify-openminutes/scripts/cleanup.mjs host-success
```

## 显式无 Host 失败配方

另开 `launch.mjs host-off --no-host`，doctor 显示 `mode=none, available=false`，这是预期而不是失败。生成语音变体 1 并按目录导入配方导入。详情点击「开始转录」，等待 `HOST_NOT_CONNECTED`，断言错误条可见、状态 `failed`、`jobs[0].status=failure`、全文为空。此流程不产生真实 Host 调用。

可执行步骤（配方包含导入，运行前不要重复导入）：

```powershell
node .claude/skills/verify-openminutes/scripts/launch.mjs host-off --no-host
node .claude/skills/verify-openminutes/scripts/doctor.mjs host-off
node .claude/skills/verify-openminutes/scripts/speech.mjs host-off 1
node .claude/skills/verify-openminutes/scripts/browse.mjs host-off failure '@.claude/skills/verify-openminutes/recipes/host-off.json'
node .claude/skills/verify-openminutes/scripts/evidence.mjs host-off failure
node .claude/skills/verify-openminutes/scripts/cleanup.mjs host-off
```

批量失败测试同样只在 `--no-host` run 中进行。不要用 `waitText:"失败"` 判断列表终态，因为筛选工具栏一直有「失败」；等待「转录已排队」「转录中」消失，再读接口状态。

## 边界与已知行为

- 自动连接、拉取、转录、归类开关均为 0，导入后必须手动触发。
- 排队状态由队列计算，不落数据库，筛选仍按持久化状态统计。
- 能力探测成功只证明连接可用，不保证某个上游模型成功。`LLM_OBJECT_INVALID` 后文本回退成功时，归类 job 可以成功，Host 调用记录仍保留失败请求。
- 实时字幕、长录音续传、BLE、多说话人、其它转录入口与终态停止轮询的请求计数不在上述成功配方覆盖范围。
- 无 Host 场景不能写成“转录可用”；Host 成功也不能代替未执行的入口。
