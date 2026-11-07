# 目录导入

用户把录音笔里的 MP3（U 盘模式或其他方式拷出）放进导入目录，在「录音」页头点「导入」，在对话框里点「扫描并导入」。应用把文件复制到归档目录的 `yyyy-MM/` 子目录，并在录音库登记一条状态为「待转录」的录音。已经导入过的文件再次扫描时会被跳过。整个过程停留在 `#/library`，结果在对话框内显示。

## Sub-features

- `import-scan`：扫描收件目录，导入新的 MP3，对话框内显示「已导入 N 条」等结果。
- `import-dedupe`：再次扫描同一个文件时，计入「已跳过」，不重复登记。
- `import-copy`：源文件留在收件目录，副本落到 `library/<录制年月>/`。
- `import-failed-detail`：导入失败的文件主行只显示中文结论，技术原因收在这一行的「查看详情」里，可以展开和复制。配方：`--no-host` 启动后，在 `$R/library/` 下建一个名为 `2026-11` 的普通文件（占住月份目录，让 mkdir 失败），收件目录放 `REC20261115_090000.mp3`，运行 `browse.mjs <runId> import-failed-detail @.claude/skills/verify-openminutes/features/import-failed-detail.steps.json`。
- `import-empty`：收件目录里没有音频时，对话框提示「文件夹里还没有可以导入的录音文件。」；目录不存在时扫描会自动创建。
- `import-dialog-path`：对话框显示导入目录完整路径、音频数，提供「复制路径」和「在设置中修改目录」（只是跳转，目录只在「设置 › 通用」里改）。

## How to get to it (user POV)

- 侧边导航「录音」→ 页头「导入」→「扫描并导入」。这是唯一入口；录音笔页和空状态里没有导入按钮，空状态只有说明文字和链接。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件，doctor 的 exit 为 0。
- 已用 ffmpeg 生成 `$R/inbox/REC20261029_101500.mp3`（6 秒，16 kHz 单声道）。

- **入口与目录状态。** 运行 `browse.mjs <runId> import '[{"goto":"#/library"},{"waitFor":"aria=搜索录音"},{"click":"text=导入"},{"waitText":"1 个音频文件"},{"eval":"location.hash"},{"screenshot":"01-before.png"},{"aria":"01-before.aria.txt"}]'`。预期 `location.hash` 仍为 `#/library`，对话框显示「1 个音频文件」，路径行显示 `$R\inbox`。
- **扫描导入。** 在同一次调用里追加 `{"click":"text=扫描并导入"},{"waitText":"已导入 1 条","timeout":20000},{"screenshot":"02-after-scan.png"},{"click":"text=关闭"}`。预期对话框内列出该文件，hash 仍为 `#/library`。参考 `features/voice-import.steps.json`。
- **副作用读回。** 运行 `curl -s "$URL/api/recordings" | tee $E/import/recordings.json`。预期 `total` 为 1，`status` 为 `ready`，`durationSec` 为 6，`hasAudioFile` 为 true。再运行 `ls $R/library/2026-10/`，应该能看到 `REC20261029_101500.mp3`，同时 `$R/inbox/` 里的原文件仍在。
- **去重。** 不改动收件目录，重复上面的扫描步骤，等待对话框内显示「已跳过」。之后 `/api/recordings` 的 `total` 仍应为 1。
- **录音库里可见。** 运行 `browse.mjs <runId> import-library '[{"goto":"#/library"},{"waitText":"REC20261029_101500.mp3"},{"expectText":"当前显示 1 条"},{"screenshot":"03-library.png"}]'`。
- **一步跑完。** `browse.mjs <runId> import-dialog @.claude/skills/verify-openminutes/features/import-dialog.steps.json` 依次检查空状态只有说明和「录音笔」链接、对话框显示目录与音频数、「已导入 1 条」、全程 hash 为 `#/library`，最后读回 `/api/recordings`。

## Gotchas

- 等对话框内的结果文字，不要用固定延时；扫描进行中按钮显示「正在扫描…」并变灰。
- 不要在「设置 › 通用」里保存目录：它会把隔离用的 `import_dir` 覆盖成输入框里的值，doctor 会因此报错。
- 没有 `--fake-device` 时不要去录音笔页点「连接」，它会通过 BLE 真正连接录音笔。
- 导入目录不能放在系统临时目录下，否则应用会把它改回真实的 `~/memo/memotalk/inbox`。
- 录制时间是从文件名解析出来的；文件名不符合 `RECyyyyMMdd_HHmmss` 时，会退回到文件时间。
