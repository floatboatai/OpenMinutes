# 录音详情

用户在录音库里点开一条录音，进入详情页。详情页可以播放音频（支持拖动进度条，后端用 HTTP Range 实现），可以人工修正标题、分类、重要度和标签，可以收藏、归档、导出到本机目录，也可以删除（音频文件会移到 `_trash`）。

## Sub-features

- `detail-open`：点击行标题进入 `#/rec/<id>`；「返回录音库」回到列表。
- `detail-playback`：`<audio>` 从 `/api/recordings/<id>/audio` 读取音频；Range 请求返回 206，越界返回 416。
- `detail-title`：「编辑标题」→ 填写「录音标题」→ 回车或「保存标题」，提示「标题已更新」。
- `detail-organize-fields`：右侧「整理」栏可以改分类下拉框、「重要度 N」按钮和「添加标签」输入框。
- `detail-favorite-archive`：「收藏」「归档」可以来回切换，按钮文字随之变化。
- `detail-export`：「导出」把文件复制到导入目录，提示「已导出到本机目录」。
- `detail-delete`：「删除」弹出确认框，删除后提示「录音已删除」，并返回录音库。

## How to get to it (user POV)

- 录音库里点击某一行的标题区域（`button.row__main`）。
- 直接访问 `#/rec/<id>`。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件。已按 [目录导入](./directory-import.md) 导入 `REC20261029_101500.mp3`，它的 id 为 1。

- **打开详情。** 运行 `browse.mjs <runId> detail '[{"goto":"#/library"},{"waitFor":"button.row__main"},{"click":"button.row__main"},{"waitText":"返回录音库"},{"eval":"location.hash"},{"screenshot":"01-open.png"},{"aria":"01-open.aria.txt"}]'`。预期 hash 为 `#/rec/1`，元数据里的「音频文件」指向 `$R\library\2026-10\…`。
- **音频可加载。** 在同一次调用里追加 `{"eval":"new Promise(r => { const a = document.querySelector('audio'); if (a.readyState >= 1) r(a.duration); else a.addEventListener('loadedmetadata', () => r(a.duration)); })"}`。预期结果为 `6`。
- **Range 协议。** 运行 `curl -s -D - -o /dev/null -H 'Range: bytes=100-199' "$URL/api/recordings/1/audio" | tee $E/detail/range.txt`。预期看到 `206`、`content-range: bytes 100-199/<size>` 和 `accept-ranges: bytes`。再用 `-H 'Range: bytes=999999-'` 请求一次，预期返回 `416`。
- **改标题。** 追加 `{"click":"aria=编辑标题"},{"fill":"aria=录音标题","value":"产品评审"},{"press":"Enter"},{"waitText":"标题已更新"},{"expectText":"产品评审"},{"screenshot":"02-title.png"}`。读回验证：`curl -s "$URL/api/recordings/1"` 返回的 `title` 应为「产品评审」。
- **重要度与标签。** 追加 `{"click":"aria=重要度 4"},{"waitText":"重要度设为 4"},{"fill":"aria=添加标签","value":"周会"},{"press":"Enter"},{"waitText":"已添加标签「周会」"},{"screenshot":"03-fields.png"}`。读回验证：`importance` 为 4，`tags` 包含「周会」。
- **导出。** 收件目录里还留着同名的原文件，直接 `ls` 无法区分是不是导出的。所以先运行 `rm $R/inbox/REC20261029_101500.mp3`，再追加 `{"click":"text=导出"},{"waitText":"已导出到本机目录"}`。然后运行 `ls $R/inbox/ | tee $E/detail/export.txt`，被删掉的文件应该重新出现。
- **删除。** 追加 `{"click":"text=删除"},{"waitText":"录音已删除"}`。`steps.log` 里应记录 `dialog confirm: 音频文件会移动到数据目录的 _trash 子目录… -> accepted`。之后 `curl -s "$URL/api/recordings"` 的 `total` 减 1。

## Gotchas

- 「录音标题」输入框只在点了「编辑标题」之后才存在。判断详情页是否加载完成，请等「返回录音库」。
- `browse.mjs` 会自动接受 `window.confirm`。要验证「取消删除」这条路径，目前做不到，报告里写「未验证」。
- 每个修改都有自己的 toast：「重要度设为 N」「已添加标签「X」」「标签已移除」「分类已更新」「已收藏」「已归档」。等 toast 出现，再读回接口确认。
- 音频不可用时（文件丢失），分段时标会退回纯文本，播放器也不会出现。这种情况属于另一个场景，需要先手动删掉 `library/` 里的文件来制造。
- 删除会把音频移到 `$R/library/_trash/`，文件名会加上毫秒时间戳前缀（例如 `1793248437717-REC….mp3`）。这个目录是本 run 的 scratch 目录，cleanup 时会一起删掉。如果要把它留作证据，先 `ls $R/library/_trash | tee $E/detail/trash.txt`。
