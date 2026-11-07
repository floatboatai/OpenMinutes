# 录音详情

用户在「录音」页点开一条录音，进入详情页。侧栏仍高亮「录音」，页头面包屑为「录音 › <标题>」。详情页可以播放音频（支持拖动进度条，后端用 HTTP Range 实现），可以人工修正标题、分类、重要度和标签，可以收藏、导出到本机目录；归档、删除（音频文件会移到 `_trash`）、重新转录、重新归类放在「更多」菜单里。

## Sub-features

- `detail-open`：点击行标题进入 `#/rec/<id>`；返回按钮回到应用内的上一个页面（从录音页进入显示「返回录音」，从日历进入显示「返回日历」），没有上一页时回到 `#/library`。
- `detail-primary`：页头只有一个随状态切换的主按钮：待转录显示「开始转录」，待归类显示「AI 归类」，已整理时不显示。还在录音笔里的录音不显示主按钮，只有「这条录音还在录音笔里…」说明和「去录音笔同步」链接（跳到 `#/device`），没有「从设备拉取音频」。
- `detail-playback`：`<audio>` 从 `/api/recordings/<id>/audio` 读取音频；Range 请求返回 206，越界返回 416。
- `detail-title`：「编辑标题」→ 填写「录音标题」→ 回车或「保存标题」，提示「标题已更新」。
- `detail-organize-fields`：右侧「整理」栏可以改分类下拉框、「重要度 N」按钮和「添加标签」输入框。
- `detail-favorite-archive`：「收藏」在页头，「归档」在「更多」里，都可以来回切换，文字随之变化。
- `detail-export`：「导出」把文件复制到导入目录，提示「已导出到本机目录」。
- `detail-delete`：「更多」→「删除」弹出确认框，删除后提示「录音已删除」，并返回录音库。
- `detail-calendar-readonly`：「日程」区只读。未关联时显示「还没有关联日程。」和「在日历中关联」链接；已关联时显示事件标题、时间和「在日历中修改」。链接为 `#/calendar?day=<录制日期>&rec=<id>`，关联只在日历页完成。
- `detail-jobs`：tab「处理记录 N」只显示中文；失败提示是 ErrorNotice，技术原文点「查看详情」才出现。

## How to get to it (user POV)

- 「录音」页里点击某一行的标题区域（`button.row__main`）。
- 日历页里点录音标题。
- 直接访问 `#/rec/<id>`。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件。已按 [目录导入](./directory-import.md) 导入 `REC20261029_101500.mp3`，它的 id 为 1。

- **打开详情。** 运行 `browse.mjs <runId> detail '[{"goto":"#/library"},{"waitFor":"button.row__main"},{"click":"button.row__main"},{"waitText":"返回录音"},{"eval":"location.hash"},{"screenshot":"01-open.png"},{"aria":"01-open.aria.txt"}]'`。预期 hash 为 `#/rec/1`，元数据里的「音频文件」指向 `$R\library\2026-10\…`。
- **音频可加载。** 在同一次调用里追加 `{"eval":"new Promise(r => { const a = document.querySelector('audio'); if (a.readyState >= 1) r(a.duration); else a.addEventListener('loadedmetadata', () => r(a.duration)); })"}`。预期结果为 `6`。
- **Range 协议。** 运行 `curl -s -D - -o /dev/null -H 'Range: bytes=100-199' "$URL/api/recordings/1/audio" | tee $E/detail/range.txt`。预期看到 `206`、`content-range: bytes 100-199/<size>` 和 `accept-ranges: bytes`。再用 `-H 'Range: bytes=999999-'` 请求一次，预期返回 `416`。
- **改标题。** 追加 `{"click":"aria=编辑标题"},{"fill":"aria=录音标题","value":"产品评审"},{"press":"Enter"},{"waitText":"标题已更新"},{"expectText":"产品评审"},{"screenshot":"02-title.png"}`。读回验证：`curl -s "$URL/api/recordings/1"` 返回的 `title` 应为「产品评审」。
- **重要度与标签。** 追加 `{"click":"aria=重要度 4"},{"waitText":"重要度设为 4"},{"fill":"aria=添加标签","value":"周会"},{"press":"Enter"},{"waitText":"已添加标签「周会」"},{"screenshot":"03-fields.png"}`。读回验证：`importance` 为 4，`tags` 包含「周会」。
- **导出。** 收件目录里还留着同名的原文件，直接 `ls` 无法区分是不是导出的。所以先运行 `rm $R/inbox/REC20261029_101500.mp3`，再追加 `{"click":"text=导出"},{"waitText":"已导出到本机目录"}`。然后运行 `ls $R/inbox/ | tee $E/detail/export.txt`，被删掉的文件应该重新出现。
- **删除。** 追加 `{"click":"details.moremenu > summary"},{"click":"text=删除"},{"waitText":"录音已删除"}`（先展开「更多」）。`steps.log` 里应记录 `dialog confirm: 音频文件会移到数据目录的回收站，确认删除这条录音？ -> accepted`。之后 `curl -s "$URL/api/recordings"` 的 `total` 减 1。

- **单一主按钮与在录音笔中的录音（假录音笔）。** 新 runId、`launch.mjs <runId> --no-host --fake-device=wifi`（保持 `auto_pull=0`），运行 `browse.mjs <runId> recording-detail-actions @.claude/skills/verify-openminutes/features/recording-detail-actions.steps.json`。步骤用开发者接口 `POST /api/ingest/manifest` 只登记清单、在录音笔页同步其中 1 条，然后检查：在录音笔中的详情显示「这条录音还在录音笔里」，没有「从设备拉取音频」和「开始转录」，「去录音笔同步」到达 `#/device`；待转录的详情页头只有「开始转录」一个主动作，面包屑为「录音 › …」；从日历进入详情再「返回日历」回到日历页。另外检查断网提示：200 KB 的录音不标「无线快传」，剩下两条较大的标出并在列表下说明会暂时断开外网；最后在 `auto_pull=1` 下断开，「连接」按钮下方显示「连上后会自动同步，较大的录音将通过无线快传，期间电脑会暂时断开外网」。清单登记要带 `sizeBytes`，大小未知的记录不参与提示。

## Gotchas

- 「录音标题」输入框只在点了「编辑标题」之后才存在。判断详情页是否加载完成，请等「返回录音」（从日历进入时是「返回日历」）。
- 「更多」是 `<details class="moremenu">`，里面的菜单项只有展开后才可点击。
- `browse.mjs` 会自动接受 `window.confirm`。要验证「取消删除」这条路径，目前做不到，报告里写「未验证」。
- 每个修改都有自己的 toast：「重要度设为 N」「已添加标签「X」」「标签已移除」「分类已更新」「已收藏」「已归档」。等 toast 出现，再读回接口确认。
- 音频不可用时（文件丢失），分段时标会退回纯文本，播放器也不会出现。这种情况属于另一个场景，需要先手动删掉 `library/` 里的文件来制造。
- 删除会把音频移到 `$R/library/_trash/`，文件名会加上毫秒时间戳前缀（例如 `1793248437717-REC….mp3`）。这个目录是本 run 的 scratch 目录，cleanup 时会一起删掉。如果要把它留作证据，先 `ls $R/library/_trash | tee $E/detail/trash.txt`。
