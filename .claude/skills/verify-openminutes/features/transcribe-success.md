# 转录与 AI 归类成功路径

本配方使用真实离线 TTS 音频，不写入伪造的转录或归类结果。独立模式只执行第 1 节；第 2–4 节需要 Host 模式。实时字幕不在本配方范围内。

## 前提与额度

- 先按 SKILL.md 完成 build → launch → doctor。仅驱动本 run 的隔离实例，保留四个自动开关为 `0`，不使用用户 Floatboat 应用的数据库。
- 本分支的 `launch.mjs` 仍只有独立模式。须先集成并行 `verify-host-mode` 分支，再按该版本 SKILL.md 的 Host 启动说明创建 run；不要猜测 Host 参数、手工拼 IPC 配置，或直接打开用户的真实实例来替代。
- Host 模式必须通过该版本 doctor，并在设备页「本机环境」确认「语音识别」「文本模型」就绪。将环境截图与 ARIA 保存到 `$E/host-preflight/`。只看到 Host 进程在运行不算通过；`HOST_NOT_CONNECTED`、权限不足或额度不足时停止。
- ASR/LLM 会消耗用户额度。确认允许使用额度后，单条只转录一次、归类一次；批量只处理另外两条。正常共 3 个转录任务、3 个归类任务、最多 18 秒源音频。上游重连或模型结构化输出重试可能增加实际请求数，这不是计费硬上限。失败后保留证据并停止，不自动重试、不点「重新转录」「重新归类」。
- 以下 PowerShell 示例的 runId 为 `voice-success-20261029`。每次换新 runId；`$S`、`$R`、`$E` 先设为实际路径。单条录音必须是新库里的 id 1，批量文件名固定如下。配方含前置断言，不能在已有任务的库里重复执行。

```powershell
$S = '.claude/skills/verify-openminutes/scripts'
$F = '.claude/skills/verify-openminutes/features'
$R = '.workbench/verify/voice-success-20261029'
$E = '.workbench/verify-evidence/voice-success-20261029'
```

## 1. 生成语音、导入与播放（独立模式可执行）

```powershell
node "$S/make-voice.mjs" --language zh-CN --output "$R/inbox/REC20261029_150000.mp3"
node "$S/browse.mjs" voice-success-20261029 voice-import "@$F/voice-import.steps.json"
```

两条命令分别检查退出码，第一条失败不要继续。`--text '今天下午三点项目评审会，请提前十分钟到场。'` 可显式指定文本，省略时就是这句。默认语言是 `zh-CN`，也支持 `en-US`。脚本用 Windows PowerShell `System.Speech` 的启用音色先合成 WAV，再用 ffmpeg 转成 16 kHz、单声道、32 kbps MP3。超过 5 秒时适度加速，低于 3.2 秒时补静音，不截断语句；原始语音超过 10 秒则拒绝，最终 ffprobe 校验 3–6 秒才发布文件。

音色、语言、实际文本、原始时长、变速比、最终时长和 SHA-256 写在 `<文件名>.voice.json`。缺少请求的音色时，默认文本可回退到英语音色和固定英文句子 `The project review is at three today. Please arrive ten minutes early.`，同时打印警告。自定义文本不自动换语言，缺音色就失败；没有可用英语音色或 System.Speech 不可用也会失败，不偷偷使用联网 TTS。

英语只证明英语路径，不能据此宣称中文 ASR 通过。英文验收须复制下面的步骤文件到 `$R`，把关键词「评审」改为 `review`，人工修改标题等中文 UI 文案不用改。音色/系统版本可能改变 MP3 字节，复现以相同文本、语言和媒体参数为准，保留本次音色与哈希用于追踪。

`voice-import.steps.json` 走录音库 → 导入新录音 → 立即扫描 → 录音库 → 详情。它断言 `recording.status=ready`、`hasAudioFile=true`、`transcriptChars=0`、`jobs=[]`，随后通过浏览器原生音频 API 播放并等待 `currentTime>0.25`、`paused=false`、`error=null`，不只验证有 `<audio>` 元素。它不点击 ASR/LLM。

证据在 `$E/voice-import/`：`01-empty`、`02-imported`、`03-playable` 的 PNG/ARIA，完整接口读回和播放状态在 `steps.log`，`console.log` 应为空。另外保存独立响应、媒体和磁盘副作用证据，cleanup 前执行：

```powershell
$run = Get-Content "$R/run.json" -Raw | ConvertFrom-Json
Invoke-WebRequest "$($run.url)/api/recordings" -OutFile "$E/voice-import/recordings.json"
Invoke-WebRequest "$($run.url)/api/recordings/1" -OutFile "$E/voice-import/detail.json"
Copy-Item "$R/inbox/REC20261029_150000.mp3*" "$E/voice-import/"
Get-ChildItem "$R/library" -Recurse -File | Select-Object FullName,Length |
  ConvertTo-Json | Set-Content "$E/voice-import/library-files.json"
Get-FileHash "$R/inbox/REC20261029_150000.mp3","$R/library/2026-10/REC20261029_150000.mp3" |
  ConvertTo-Json | Set-Content "$E/voice-import/file-hashes.json"
```

预期列表只有一条录音、`durationSec` 约为 5（应用取整）；源文件和归档副本均存在且 SHA-256 相同。本配方不更改「保存路径」。

## 2. 单条转录、全文检索、分段跳播

只在通过 Host 前置检查后执行：

```powershell
node "$S/browse.mjs" voice-success-20261029 single-success "@$F/transcribe-success.steps.json"
```

这个文件包含本节和第 3 节，每次运行会消费一次转录和一次归类。任一步失败即停止，不重新运行整个文件；读回当前接口、截图/ARIA 和服务日志，报告最后完成的步骤。

1. 打开 `#/rec/1`，保存操作前 `01-before`，点击「开始转录」，等待「转录任务已排队」，保存 `02-accepted` 和即时接口响应。过渡状态是 `queued_transcribe` / `transcribing`，页面显示「转录已排队」/「转录中」；队列很快时不保证两个瞬态都捕捉到，要注明实际观察到的状态，不为补截图再次消费额度。
2. 不刷新、不跳页等待终态（上限 120 秒）。`recording.status=transcribed` 表示已转录，但当前 UI 标签实际叫「待归类」，不是「已转录」。断言路由仍为 `#/rec/1`，`transcriptChars>0`，`transcript.text` 含「评审」，`lastError=null`，`jobs` 有 `kind=transcribe,status=success,finishedAt`。切换「纯文本」，DOM 全文必须与接口完全相等，留 `03-transcript` PNG/ARIA。ASR 标点/数字写法可不同，关键词和语义需人工对照实际 TTS 文本。
3. 关闭「纯文本」，验证 `segments` 非空，每段有非空 `text`、有限非负 `startMs` 和 `endMs>=startMs`，页面时标按钮数量与段数相同。保存 `04-segments` PNG/ARIA，人工核对每段文本和格式化时标对应接口毫秒值。
4. 脚本优先选非零且可播放的时标，没有则选第一段，真实点击 `.segment__jump`。监听 `seeked`，确认落点距 `startMs/1000` 不超过 0.5 秒，随后播放头前进且未暂停，保存 `05-seek` PNG/ARIA 和播放数值。3–6 秒短句可能只有一段且从 0 开始，这时只证明起点跳播，报告「非零时标跳播未覆盖」；不要伪造 segments 或无限追加调用。
5. 返回录音库，输入「评审」，等待筛选生效和一条命中，`GET /api/recordings?q=<URL 编码的评审>` 必须含 id 1，保存 `06-search` PNG/ARIA 与响应。这一步发生在归类之前，文件名不含关键词、标题/摘要仍为空，因而能证明命中转录全文而不是 AI 标题。

## 3. AI 归类与人工保存

同一份 `transcribe-success.steps.json` 接着执行：

1. 从检索结果回详情，点击「AI 归类」，保存 `07-organize-accepted` PNG/ARIA。过渡状态为 `queued_organize` / `analyzing`（归类已排队 / 归类中），终态是 `organized`，UI 叫「已归档」。等待终态上限 120 秒，不能仅凭 toast 判断成功。
2. 打开「AI 结论」，读回 `GET /api/recordings/1`，按下表逐项核对；`08-organized` PNG/ARIA 必须包含页面标题、摘要、分类、标签、要点、待办和重要度。模型措辞不做完全相等断言，但这句会议通知应提取会议主题及提前到场事项；字段为空或语义不符均需报告，不重试掩盖。
3. 点击「编辑标题」，填「人工确认的项目评审」，点「保存标题」，等「标题已更新」。重新 GET 确认 `recording.title` 精确相等、状态仍是 `organized`，原始 `analysis` 不变。保存 `09-edited` PNG/ARIA 与响应。这里验证人工标题入口，不声称其它人工字段入口已验证。
4. 打开「执行记录 2」，保存 `10-jobs` PNG/ARIA，确认转录、归类各一条成功。数据库表名是 `job_runs`，详情 API 的字段叫 `data.jobs`，没有 `data.job_runs`。本配方不直接写库。

| 验收概念 | 实际读回字段与期望 |
| --- | --- |
| 状态、转录 | `data.recording.status=organized`，`transcriptChars>0`；`data.transcript.text` 和 `data.segments` 仍保留 |
| title / summary | `data.recording.title/summary` 非空，人工修改前与 `data.analysis.title/summary` 一致 |
| category | `recording.categoryId/categoryName` 非空；`analysis.categorySlug` 应对应 `GET /api/categories` 中同 id 的 slug；UI 分类下拉框选择该名称 |
| tags | `recording.tags[].name` 和 `analysis.tags[]` 按集合相等，页面标签可见 |
| keyPoints | `analysis.keyPoints` 为非空字符串数组，逐项出现在「要点」 |
| actions | 概念名为 actions，实际字段是 `analysis.actionItems`，为非空字符串数组，逐项出现在「待办事项」 |
| importance | `recording.importance` 为 1–5 的整数，与 `analysis.importance` 一致，`aria-label="重要度 N"` 的按钮 `aria-pressed=true` |
| job_runs | `data.jobs` 含本次 `transcribe` 和 `organize` 的 `status=success`、非空 `finishedAt`；`lastError=null` |

所有 eval 读回响应会保留在 `steps.log`。额外用第 1 节的 `Invoke-WebRequest` 保存最终详情与 `/api/categories` 为 `$E/single-success/detail.json`、`categories.json`。若失败在终态前，也保存当前响应，不把旧成功 job 当本次成功。

## 4. 批量转录与批量归类

单条成功后，再生成两条不同文件名的语音。每条都走 TTS，勿把同一文件改名复制来碰运气绕过去重。原来的 id 1 保留为 `organized`。

```powershell
node "$S/make-voice.mjs" --output "$R/inbox/REC20261029_150100.mp3"
node "$S/make-voice.mjs" --output "$R/inbox/REC20261029_150200.mp3"
node "$S/browse.mjs" voice-success-20261029 batch-success "@$F/batch-success.steps.json"
```

每条命令成功后才执行下一条。脚本扫描新增两条，进入录音库精确勾选这两个文件（不全选已有成功录音），点击「批量转录」，等待「已排队 2 条转录任务」。它不刷新页面、不重新导航，按 `.table__body .row .col-status` 等待两行自动变为「待归类」，而非等待工具栏始终存在的文字。

转录完成后重新勾选这两行，点击「批量归类」，等「已排队 2 条归类任务」，仍在同一页面等三行都成为「已归档」。每阶段最多等 120 秒。`01-selected`、`02-transcribe-accepted`、`03-transcribed`、`04-organize-accepted`、`05-organized` 各保留 PNG/ARIA。

读回 `/api/recordings`，两阶段终态都要求 `hasActiveTasks=false`；分别 GET 两个新 id，转录后要求 `status=transcribed`、`transcriptChars>0`、全文含「评审」、`segments` 非空、转录 job 成功。归类后要求 `status=organized` 及第 3 节字段表的完整断言。脚本保留列表与详情响应于 `steps.log`，人工再按表核对模型语义、分类 slug 和字段一致性，并保存各 id 的 `detail-<id>.json`。

`organize` 失败时应用可能回到 `transcribed`，因此「不再忙」不等于成功，必须看到 `organized` 和成功 job。禁止用直接 POST 批量接口替代勾选入口；API 只做读回。

## 清理与报告

保留所有 `.voice.json`、测试 MP3、接口响应、PNG/ARIA、空或非空的 `console.log` 和 `server.log`，再运行 doctor、cleanup。报告分别列出：音频生成/导入/播放、单条 ASR、检索、分段与非零跳播、单条 LLM/人工修改、两个批量入口。没有 Host 时只将第 1 节标为通过，其余标为「未验证：缺少 Host 连接」，不能用失败路径或模拟响应代替成功。
