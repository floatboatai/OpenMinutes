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
- 转录成功测试用 `speech.mjs` 的中文 TTS；仅导入/播放测试可用 SKILL.md 的 ffmpeg 正弦波。音频落在 `$R/inbox/`，文件名用 `RECyyyyMMdd_HHmmss.mp3`。
- 接口只用于读回验证，或者用于没有 UI 的能力：`URL=$(node -p "require('./$R/run.json').url")`。

## 证据与跳过的报告方式

- 每个功能至少要有操作前后两份截图或 ARIA，外加一份读回存储值的接口响应（`curl … | tee $E/<label>/….json`）。
- `$E/<label>/console.log` 必须为空。如果不为空，要把内容写进报告。
- 有文件副作用时，要列出对应的磁盘文件：导入的文件在 `$R/library/<yyyy-MM>/`，导出的文件在 `$R/inbox/`。
- Host 模式可验证 ASR/LLM 成功，显式 `--no-host` 只能验证失败路径。报告必须标明模式、实际覆盖和调用次数；完整步骤见转录与归类配方。
- 某个入口没跑到时，要写明尝试过的命令以及没满足的前置条件，不能用别的入口顶替。

## 功能

导航固定 7 项：录音 / 今日 / 录音笔 / 实时字幕 / 日历 / 分类 / 设置，每个功能只有一个入口（入口速查见 SKILL.md「Drive」）。

- [目录导入](./directory-import.md)：录音页头「导入」对话框，扫描收件目录、复制入库并去重。
- [录音库检索](./library-search.md)：全文搜索、阶段/分类/标签筛选、排序和空结果。
- [录音位置列](./library-location.md)：列表「位置」列（录音笔 / 本机 + 文件夹）与点击打开所在文件夹（在 Floatboat 中 / 资源管理器）。
- [录音详情](./recording-detail.md)：面包屑与返回、单一主按钮、Range 播放、改标题、改分类/重要度/标签、收藏、导出、删除、只读日程区。
- [今日：场景时间线](./scenes-today.md)：转录后自动切场景并按模板整理、时间线与卡片联动、空状态与日期切换。
- [导航与单一入口](./navigation.md)：7 项导航、`aria-current` 与 h1 一致、`#/overview` 改写、主界面无技术词。
- [录音笔](./device-connection.md)（只用 `--fake-device`）：点一次「连接」即同步、过程中「暂时断开外网」、诊断里的「无线快传」记录、「清理已同步的录音」、「断开连接」后自动连接暂停；`ble` 模式「已改用蓝牙」；同步中实时字幕被禁用。
- [错误分两层](./error-detail.md)：`absent` 模式「没有找到录音笔」，「查看详情」或 toast「详情」后才出现 `DeviceNotFound`。
- [录音与日程关联](./calendar-link.md)：详情页跳到日历、EventLinker 展开、一键关联、每条录音一个关联控件、详情只读。
- [诊断与高级](./diagnostics.md)：`#/settings/diagnostics` 自动展开，含本机环境、运行时路径、传输方式、最近设备操作、宿主能力、设备协议指令参考、开发者工具；修改 `device_transport` 后用 `/api/settings` 读回。
- [同时转录的录音数](./asr-concurrency.md)：诊断区「转录任务」里的 `asr_concurrency`（1–8，默认 3），保存读回、越界拒绝、改回默认。
- [分类管理](./categories.md)：新建、改名、改色、删除，内置分类不可删。
- [转录与归类](./transcribe-organize.md)：复用 Floatboat Host 验证单条、批量、人工修正与全文检索；显式无 Host 验证失败。
- [转录与归类成功路径](./transcribe-success.md)：可选语言的离线 TTS、能力完整性检查和单条/批量 JSON 配方。

2026-11-08 工作台整改的 e2e 结果：[报告](../reports/2026-11-08-workbench-unify.md)。

实测结果与未修应用问题：[2026-10-29 Host 模式报告](../reports/2026-10-29-host-mode.md)。
