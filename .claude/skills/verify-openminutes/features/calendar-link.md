# 录音与日程关联

关联只在日历页做，每条录音只有一个关联控件（EventLinker），写接口只有 `PATCH /api/recordings/:id {calendarEventId}`。详情页的日程区只读，提供「在日历中关联 / 修改」，跳到 `#/calendar?day=<录制日期>&rec=<id>`，对应的 EventLinker 高亮并展开。

## Sub-features

- `link-jump`：详情页点「在日历中关联」，hash 带 `day`、`rec`，对应 EventLinker 带 `eventlinker--highlight` 且 `aria-expanded=true`。
- `link-suggest`：点建议项「关联到：<事件>」，出现「已关联日程」，接口读回 `calendarEventId`。
- `link-single-control`：日历页同一条录音只有一个 `.eventlinker`。
- `link-readonly`：从日历点录音标题进入详情，显示事件标题和「在日历中修改」，没有可编辑的日程控件；「返回日历」回到日历页。

## How to get to it (user POV)

- 侧边导航「日历」，或详情页日程区的「在日历中关联」链接。

## Driving it with browse.mjs

Preconditions：普通启动；已按 `import-dialog.steps.json` 导入 1 条录音（`$R/inbox/REC20261029_101500.mp3`）。

- 运行 `browse.mjs <runId> calendar-link @.claude/skills/verify-openminutes/features/calendar-link.steps.json`。第一步用 `POST /api/calendar/events` 在录制时间前后各 30 分钟建一个「验证周会」事件。
- 预期 `eval` 依次返回日历 hash、`controls: 1` 与 `calendarEventId`、`"read-only"`；`console.log` 为空。
- 更完整的日历回归（导入 .ics、解除关联、纪要失败文案）见 `scripts/verify-calendar.mjs`。

## Gotchas

- 面包屑是三个行内元素，innerText 中间没有空格，用结构断言而不是 `expectText`。
