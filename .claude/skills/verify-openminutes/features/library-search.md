# 录音库检索

录音库一条录音占一行。用户可以按标题、摘要、转录全文搜索，按处理阶段、分类、标签筛选，并切换排序。没有命中时会显示明确的空状态，和「录音库还是空的」区分开。

## Sub-features

- `library-list`：列出全部录音，表头显示「命中 N 条录音」。
- `library-search`：搜索框按标题、摘要、转录全文匹配；无结果时显示「没有符合条件的录音」。
- `library-stage`：分段控件「全部 / 待转录 / 待归类 / 已归档 / 失败」。
- `library-category-tag`：「按分类筛选」「按标签筛选」两个下拉框。
- `library-sort`：「排序方式」可选最近入库、录音时间、时长最长、重要度高。
- `library-auto-refresh`：有排队或进行中的任务时（`/api/recordings` 返回 `hasActiveTasks: true`），列表会自动刷新到终态，然后停止轮询。配方见 [转录与归类](./transcribe-organize.md) 的「批量转录自动刷新」。
- `library-empty`：实例里一条录音都没有时，显示「录音库还是空的」。

## How to get to it (user POV)

- 侧边导航「录音库」，或直接访问 `#/library`。
- 详情页的「返回录音库」。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件。按 [目录导入](./directory-import.md) 导入两个文件：`REC20261029_101500.mp3`（6 秒）和 `REC20261029_113000.mp3`（4 秒）。
- 搜索只会命中已经有标题、摘要或转录的字段。独立运行时没有转录文本，所以先在详情页把第一条录音的标题改成「产品评审」（见 [录音详情](./recording-detail.md)）。

- **空库。** 在导入任何文件之前运行 `browse.mjs <runId> lib-empty '[{"goto":"#/library"},{"waitText":"录音库还是空的"},{"screenshot":"empty.png"}]'`。
- **列表。** 运行 `browse.mjs <runId> lib '[{"goto":"#/library"},{"waitText":"命中 2 条录音"},{"screenshot":"01-list.png"},{"aria":"01-list.aria.txt"}]'`。
- **搜索命中。** 在同一次调用里追加 `{"fill":"aria=搜索录音","value":"产品评审"},{"waitText":"命中 1 条录音"},{"expectNoText":"REC20261029_113000.mp3"},{"screenshot":"02-hit.png"}`。
- **搜索无结果。** 追加 `{"fill":"aria=搜索录音","value":"zzz-no-match"},{"waitText":"没有符合条件的录音"},{"screenshot":"03-miss.png"}`。
- **清空搜索。** 追加 `{"fill":"aria=搜索录音","value":""},{"waitText":"命中 2 条录音"}`。
- **阶段筛选。** 先在第一条录音的详情页点一次「开始转录」，让它因为 `HOST_NOT_CONNECTED` 进入失败状态（见 [转录与归类](./transcribe-organize.md)）。然后追加 `{"click":"text=失败"},{"waitText":"命中 1 条录音"},{"screenshot":"04-failed.png"}`，再用 `curl -s "$URL/api/recordings?stage=failed"` 核对，`total` 应为 1。
- **排序。** 追加 `{"click":"text=全部"},{"waitText":"命中 2 条录音"},{"select":"aria=排序方式","value":"duration"},{"sleep":300},{"eval":"[...document.querySelectorAll('.row__title')].map(e => e.innerText)"}`。预期 6 秒的那条排在前面。

## Gotchas

- 搜索带防抖。要等「命中 N 条录音」或空状态文字出现，不要截完图马上断言。
- 表头的「命中 N 条录音」后面可能接「· K 个筛选条件生效」，所以断言时用包含匹配，不要用完全相等。
- 「失败」既是阶段按钮，也是行内状态标签的文字。`text=失败` 会命中第一个可见的元素，也就是工具栏里的那个按钮；如果要点行内的标签，请改用 CSS 选择器。
- 分类和标签下拉框的 option value 是 id 或名称，而不是显示文字；显示文字里还附带「（条数）」。
