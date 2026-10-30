# OpenMinutes 验证地图

本目录维护 OpenMinutes（录音笔工作台）面向用户的行为，以及每个行为的验证配方。驱动之前先读这一页，再打开对应的功能文件。下文的 `S` 指 `.claude/skills/verify-openminutes/scripts`，`R` 指 `.workbench/verify/<runId>`，`E` 指 `.workbench/verify-evidence/<runId>`。

## 基线前置条件

- 已执行 `node $S/build.mjs` 和 `node $S/launch.mjs <runId>`，并且 `node $S/doctor.mjs <runId>` 的 exit 为 0。
- 刚启动的实例里没有任何录音。分类表只有迁移写入的内置分类，设置里的 `import_dir` 指向 `$R/inbox`，`library_dir` 指向 `$R/library`，四个 auto 开关都是 `0`。
- 只驱动本 run 启动的实例。用户在 Floatboat 里打开的同一个应用是真实数据，不要碰。

## 驱动约定

- 页面操作统一用 `node $S/browse.mjs <runId> <label> '<steps>'`。每个功能使用独立的 label，证据会落在 `$E/<label>/`。
- 选择器的优先级：`aria=<aria-label>`，其次 `text=<完整可见文字>`，最后才是 CSS。
- 等待一律用 `waitText` / `waitFor` 等待可观察的结果（通常是 toast 文案），不要用固定的 `sleep` 代替。
- 一般导入测试可用 SKILL.md 的正弦音频；ASR 使用 [成功路径配方](./transcribe-success.md) 的 `make-voice.mjs` 离线语音，生成到 `$R/inbox/`，文件名用 `RECyyyyMMdd_HHmmss.mp3`。
- 接口只用于读回验证，或者用于没有 UI 的能力：`URL=$(node -p "require('./$R/run.json').url")`。

## 证据与跳过的报告方式

- 每个功能至少要有操作前后两份截图或 ARIA，外加一份读回存储值的接口响应（`curl … | tee $E/<label>/….json`）。
- `$E/<label>/console.log` 必须为空。如果不为空，要把内容写进报告。
- 有文件副作用时，要列出对应的磁盘文件：导入的文件在 `$R/library/<yyyy-MM>/`，导出的文件在 `$R/inbox/`。
- 独立模式下 ASR/LLM 只能证明「失败如实呈现」。成功路径须满足 [Host 前提](./transcribe-success.md#前提与额度)，未连接 Host 时报告「成功路径未验证：缺少 Host 连接」。
- 某个入口没跑到时，要写明尝试过的命令以及没满足的前置条件，不能用别的入口顶替。

## 功能

- [目录导入](./directory-import.md)：把 MP3 放进收件目录，扫描、复制入库并去重。
- [录音库检索](./library-search.md)：全文搜索、阶段/分类/标签筛选、排序和空结果。
- [录音详情](./recording-detail.md)：Range 播放、改标题、改分类/重要度/标签、收藏、导出、删除。
- [分类管理](./categories.md)：新建、改名、改色、删除，内置分类不可删。
- [转录与归类（Host 边界）](./transcribe-organize.md)：独立运行时验证失败如实呈现，成功路径需要 Floatboat。
- [转录与归类成功路径](./transcribe-success.md)：离线 TTS 导入/播放、Host 单条转录/全文检索/分段跳播、AI 归类/人工保存、批量转录与归类。附可运行的 JSON 步骤，需 Host 模式且消费额度；实时字幕不在范围内。
