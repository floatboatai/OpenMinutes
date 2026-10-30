# 目录导入

用户把录音笔里的 MP3（U 盘模式或 Wi-Fi 下载）放进导入目录，在设备接入页点「立即扫描」。应用把文件复制到归档目录的 `yyyy-MM/` 子目录，并在录音库登记一条状态为「待转录」的录音。已经导入过的文件再次扫描时会被跳过。

## Sub-features

- `import-scan`：扫描收件目录，导入新的 MP3，并提示导入、跳过、失败各多少个。
- `import-dedupe`：再次扫描同一个文件时，计入「跳过」，不重复登记。
- `import-copy`：源文件留在收件目录，副本落到 `library/<录制年月>/`。
- `import-empty`：收件目录里没有音频时，提示「目录里还没有可导入的音频文件」。
- `import-from-library`：录音库右上角的「导入新录音」会跳转到设备接入页。

## How to get to it (user POV)

- 侧边导航「设备接入」→「扫描导入目录」卡片→「立即扫描」。
- 录音库页右上角「导入新录音」→ 设备接入页 → 同上。

## Driving it with browse.mjs

Preconditions:

- 满足基线条件，doctor 的 exit 为 0。
- 已用 ffmpeg 生成 `$R/inbox/REC20261029_101500.mp3`（6 秒，16 kHz 单声道）。

- **入口与目录状态。** 运行 `browse.mjs <runId> import '[{"goto":"#/library"},{"click":"text=导入新录音"},{"waitText":"扫描导入目录"},{"waitText":"1 个音频文件"},{"eval":"location.hash"},{"screenshot":"01-before.png"},{"aria":"01-before.aria.txt"}]'`。预期 `location.hash` 为 `#/device`，卡片角标显示「1 个音频文件」，路径行显示 `$R\inbox`。
- **扫描导入。** 运行 `browse.mjs <runId> import-scan '[{"goto":"#/device"},{"waitText":"1 个音频文件"},{"click":"text=立即扫描"},{"waitText":"导入 1 个文件，跳过 0 个，失败 0 个","timeout":15000},{"screenshot":"02-after-scan.png"}]'`。预期页面出现成功 toast，扫描结果里列出该文件。
- **副作用读回。** 运行 `curl -s "$URL/api/recordings" | tee $E/import-scan/recordings.json`。预期 `total` 为 1，`status` 为 `ready`，`durationSec` 为 6，`hasAudioFile` 为 true。再运行 `ls $R/library/2026-10/`，应该能看到 `REC20261029_101500.mp3`，同时 `$R/inbox/` 里的原文件仍在。
- **去重。** 不改动收件目录，重复上面的扫描步骤，但把 `waitText` 改成 `"导入 0 个文件，跳过 1 个，失败 0 个"`。之后 `/api/recordings` 的 `total` 仍应为 1。
- **录音库里可见。** 运行 `browse.mjs <runId> import-library '[{"goto":"#/library"},{"waitText":"REC20261029_101500.mp3"},{"expectText":"命中 1 条录音"},{"screenshot":"03-library.png"}]'`。

## Gotchas

- 「导入完成后」是一张一直存在的卡片标题，不能用来判断扫描完成。要等 toast「导入 N 个文件…」。
- 扫描进行中按钮会变灰；如果截图里按钮是灰的，说明截图时扫描还没结束。
- 不要点同页面的「保存路径」：它会把隔离用的 `import_dir` 覆盖成输入框里的值（输入框可能显示用户真实的 SDK 目录），doctor 会因此报错。
- 不要点「连接并检测」「读取清单」，它们会通过 BLE 真正连接设备。本机环境卡片显示 Python「未就绪」时，这两个按钮也只会报错。
- 导入目录不能放在系统临时目录下，否则应用会把它改回真实的 `~/memo/memotalk/inbox`。
- 录制时间是从文件名解析出来的；文件名不符合 `RECyyyyMMdd_HHmmss` 时，会退回到文件时间。
