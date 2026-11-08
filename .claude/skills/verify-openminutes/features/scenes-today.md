# 今日：场景时间线（拾贝 & 串珠 P1）

「今日」页（`#/today?day=YYYY-MM-DD`）把一天里所有录音的转录排成一条时间线：拾贝切场景、匹配模板，串珠按模板字段抽取。录音转录成功后，服务端自动排队整理录音所在的那一天（`scene_bots_enabled`，默认 `1`，launch 不改它）；页头「整理这一天 / 重新整理」手动重跑。只读，没有收件箱。

## 无 Host：空状态与日期切换

前置：`launch.mjs <runId> --no-host`，收件目录放一段正弦波 `REC20261108_101500.mp3`，先跑 `import-dialog.steps.json` 导入。

- 运行 `browse.mjs <runId> scenes-today-empty @.claude/skills/verify-openminutes/features/scenes-today-empty.steps.json`。
- 覆盖：h1 与导航高亮为「今日」；未转录时显示「还没有转录完成的录音」和「还有 1 段录音没有转录」，「整理这一天」禁用；`POST /api/scenes/rebuild` 返回 `INVALID_INPUT`；`GET /api/scenes` 为 `idle`、5 份模板；「前一天」改写哈希为 `#/today?day=2026-11-07`；非法 `day` 回退到今天。

## Host：自动整理成功路径

前置：Host 模式 launch，`speech.mjs <runId> 1` 生成 `REC20261029_120001.mp3`，跑 `import-dialog.steps.json` 导入。会消耗 1 次 ASR 和约 2 次 `llm.generateObject`。

- 运行 `browse.mjs <runId> scenes-today-host @.claude/skills/verify-openminutes/features/scenes-today-host.steps.json`，随后 `evidence.mjs <runId> scenes-today-host`。
- 覆盖：详情页「开始转录」成功后不点任何按钮，`#/today?day=2026-10-29` 自动出现时间线；接口读回 `status: done`、不过期、每个场景都关联录音 1，可抽取模板的场景都有 `extraction.status: done`、`ambient` 不抽取；卡片数与时间线色块数等于场景数；点击色块后对应卡片高亮、`aria-pressed=true`；结束后「重新整理」可用。
- 每个 runId 只跑一次；失败先读 `server.log` 中的 `[scenes]` 行和证据，不要盲目重跑。

## 未覆盖

- 跨文件场景、长静默切分、窗口合并只由 `tests/scenes.test.ts` 覆盖；e2e 只有一段 18 秒语音。
- 「重新整理」按钮的真实重跑未在 e2e 点击（避免重复计费）；接口与状态投影由单测覆盖。
- 服务重启中断后的「上次整理因服务重启中断」只由单测覆盖。
