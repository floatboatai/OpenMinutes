---
name: verify-openminutes
description: 在本机真实拉起 OpenMinutes（录音笔工作台）的服务端 + Web UI，用无头 Chrome/Edge 按用户路径操作并留存截图、ARIA 树、接口响应和日志作为证据。需要证明导入、录音库、详情播放、分类、设置或转录/AI 归类行为时使用；ASR/LLM 成功配方需要额外的隔离 Host 模式，独立模式只验证音频准备与失败路径。
---

# verify-openminutes

用 Floatboat 自带的编译器构建当前工作区，把服务以**独立进程 + 一次性数据目录**跑在随机 `127.0.0.1` 端口，再用 `browse.mjs` 驱动真实页面。所有命令都在仓库根目录执行，只需要 `node`（≥22.16，无 npm 依赖）、本机 Chrome 或 Edge，以及做测试音频用的 `ffmpeg`。

功能清单与逐项操作配方在 [`features/README.md`](features/README.md)。先读它的「基线」与「证据规范」，再挑对应功能文件。

## 边界（先读）

- **独立模式不能验证转录 / AI 归类 / 实时字幕成功。** 无 Host 连接时 ASR 与 LLM 返回 `HOST_NOT_CONNECTED`，只能证明失败如实呈现。转录与 AI 归类的成功配方见 [features/transcribe-success.md](features/transcribe-success.md)，先满足其中的隔离 Host 模式与额度前提；本分支的 launch 尚不提供 Host 模式。实时字幕成功仍不在覆盖范围内。
- **BLE 设备不要碰。** 设备页的「连接并检测」「读取清单」「下载」会通过本机 Python + bleak 真正连无线电。launch 已关闭 `auto_connect` / `auto_pull`，驱动时也不要点这几个按钮。
- **不要驱动不是本次 run 启动的实例。** 用户的 Floatboat 里可能开着同一个应用（数据在 `%APPDATA%\floatboat\workbench\data\workbench.3bb3830b-…`），那是真实数据，绝不读写、绝不 kill。
- 多个 run 可以并行：端口随机、数据目录 / 收件目录 / 归档目录 / 浏览器 profile 都按 runId 隔离。

## Launch

```bash
node .claude/skills/verify-openminutes/scripts/build.mjs          # ~10s；严格类型检查 + 打包到 dist/，失败时打印诊断并 exit 1
node .claude/skills/verify-openminutes/scripts/launch.mjs <runId>  # runId 省略则生成 UUID
```

- 要验收另一个 worktree 或分支的代码时，给每条命令都加上 `OPENMINUTES_ROOT=<那个 checkout 的绝对路径>`。build、run 目录和证据都会落在那个 checkout 里，不需要往它里面复制 skill。
- `build.mjs` 调用 `C:/Program Files/Floatboat/resources/workbench-toolchain/compiler.mjs`（可用 `FLOATBOAT_TOOLCHAIN` 覆盖），产物与 Host 构建一致。改了 `src/` 之后必须重新 build 再 launch，否则验证的是旧代码（doctor 会报 `dist/ is older than src/`）。
- runId 使用 1–80 个字母、数字、下划线或连字符，首字符是字母或数字，不使用 Windows 保留设备名。省略时生成 UUID。已有 scratch 或保留证据的 ID 一律拒绝复用，cleanup 后也要换新 ID。
- `launch.mjs` 在启动子进程前向新建的 scratch 数据库写入隔离设置：`import_dir` / `library_dir` 指向本 run，四个 auto 开关为 `0`。收到本次日志的 ready 后，先用 nonce 核对 PID/generation，再 PATCH 设置。ready、网络、JSON 或 run.json 落盘失败都会停止并等待本次子进程退出，保留日志。可显式传 `--no-host`；本分支始终不连接 Host。
- 目录布局：
  - `.workbench/verify/<runId>/`：`run.json`（url、pid、nonce、各目录）、`data/data.sqlite`、`inbox/`、`library/`、`browser-profile/`。cleanup 会删掉它。
  - `.workbench/verify-evidence/<runId>/`：`server.log` 与每次 `browse.mjs` 的 `<label>/` 子目录。cleanup **不会**删它。
  - 两者都在已被 gitignore 的 `.workbench/` 下。不要改用系统临时目录：应用会把位于 `%TEMP%` 的导入目录强制改回真实的 `~/memo/memotalk/inbox`。

## Doctor

```bash
node .claude/skills/verify-openminutes/scripts/doctor.mjs <runId>
```

只读检查，exit 0 才能继续驱动。它用 run 的 nonce 请求 `/__workbench/health`，确认端口上的进程就是本 run 启动的（pid、generation 一致）；确认隔离设置仍然生效（导入/归档目录指向本 run，四个 auto 开关为 `0`）；确认 `dist/` 不比 `src/` 旧。任何异常（页面空白、接口 404、数据对不上）都先跑它。如果报告设置被改，说明刚才的操作（例如设备页「保存路径」）覆盖了隔离，这个 run 应该 cleanup 后重来。

## Drive

**页面**：`browse.mjs` 每次调用会起一个私有无头浏览器，按步骤执行，然后关闭浏览器。

```bash
node .claude/skills/verify-openminutes/scripts/browse.mjs <runId> <label> '<steps JSON>'
node .claude/skills/verify-openminutes/scripts/browse.mjs <runId> <label> @steps.json
```

步骤与选择器的完整说明写在脚本头部注释里。选择器优先用 `aria=<aria-label>`（例如 `aria=搜索录音`），其次 `text=<完整可见文字>`（例如 `text=立即扫描`），最后才用 CSS（例如 `button.row__main`）。任何一步失败都会打印 `FAIL …` 并以 exit 1 结束，`steps.log` 里保留已完成的步骤。步骤里如果有 `eval`，并且 JS 中含有引号，请先把步骤写进 JSON 文件，再用 `@file` 传入；在 shell 单引号里多层转义很容易写坏，表现为 `SyntaxError: Invalid or unexpected token`。

示例：打开录音库并进入第一条录音的详情。

```bash
node .claude/skills/verify-openminutes/scripts/browse.mjs <runId> open-detail '[{"goto":"#/library"},{"waitFor":"button.row__main"},{"click":"button.row__main"},{"waitText":"返回录音库"},{"eval":"location.hash"},{"screenshot":"detail.png"},{"aria":"detail.aria.txt"}]'
```

页面路由：`#/overview`、`#/library`、`#/rec/<id>`、`#/live`、`#/device`、`#/categories`、`#/settings`。侧边导航是 `navigation "主导航"` 下的按钮（概览 / 录音库 / 实时字幕 / 设备接入 / 分类 / 设置）。

**接口**：直接用 curl 打 `run.json` 里的 url，不需要鉴权。响应格式是 `{ ok, data | error }`。

```bash
URL=$(node -p "require('./.workbench/verify/<runId>/run.json').url")
curl -s "$URL/api/recordings"
```

**测试音频**：设备录音是 16 kHz 单声道 MP3，文件名形如 `RECyyyyMMdd_HHmmss.mp3`（录制时间就从文件名解析）。

```bash
ffmpeg -hide_banner -loglevel error -f lavfi -i "sine=frequency=440:duration=6" -ar 16000 -ac 1 -b:a 32k ".workbench/verify/<runId>/inbox/REC20261029_101500.mp3"
```

## Evidence

证据目录是 `.workbench/verify-evidence/<runId>/`，cleanup 之后仍然保留。每次 `browse.mjs` 会在 `<label>/` 下写入 `steps.log`（每一步及其结果）、`console.log`（页面 error/warning 与未捕获异常，应为空）、`*.png` 和 `*.aria.txt`。接口证据请自己用 `curl … | tee "$EVIDENCE/<label>/xxx.json"` 存进同一个目录。`server.log` 是服务端的 stdout/stderr。

证明标准：

- 走真实的用户路径：点按钮、填表单、拖文件进收件目录。不要直接调内部 setter，也不要直接写 SQLite。接口路径只用来补充第二视角的验证，或用于没有 UI 的能力。
- 既要留下动作前后的状态，也要留下最终画面：至少一张操作前、一张操作后的截图或 ARIA。
- 副作用要单独核对：导入后 `library/<yyyy-MM>/` 下真的出现了文件；删除后文件被移进 `library/_trash/`；修改后再 `GET` 一次读回存储的值。
- 报告时写清楚用的是哪个功能、哪个入口。功能文件里列出的其它入口如果没跑，要明确写「未验证」，不能拿别的路径代替。
- 独立模式遇到 Host 能力（ASR/LLM）时，只能证明「失败如实呈现」。Host 成功配方的未执行项必须明确标为未验证。

## Cleanup

```bash
node .claude/skills/verify-openminutes/scripts/cleanup.mjs <runId>
```

cleanup 先校验 runId、绝对路径和 realpath containment，拒绝路径组件及 scratch 内的符号链接或 junction。它只会 kill `run.json` 记录且 nonce/PID/generation 身份匹配的进程；身份不匹配或进程未退出则报错并保留 scratch。删除前会再次校验路径，只删除 `.workbench/verify/<runId>/` 并打印 `evidenceKept`。不要按进程名 kill。每次失败的尝试之后也要跑一遍 cleanup；异常链接需先人工检查，不能绕过校验。`browse.mjs` 在退出时会自己关掉浏览器。要确认是否有残留的无头浏览器，用：

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*verify*browser-profile*' } | Select-Object ProcessId"
```

## Helpers

| 脚本 | 作用 |
| --- | --- |
| `scripts/build.mjs` | 用 Floatboat 编译器构建 `dist/` |
| `scripts/launch.mjs [runId]` | 启动隔离实例，并写入 `run.json` |
| `scripts/doctor.mjs <runId>` | 只读体检，exit 0 才可以继续驱动 |
| `scripts/browse.mjs <runId> <label> <steps>` | 无头浏览器驱动页面，并留存证据 |
| `scripts/cleanup.mjs <runId>` | 停掉本 run 的进程并删除 scratch，保留证据 |
| `scripts/make-voice.mjs --output <RECyyyyMMdd_HHmmss.mp3> [--language zh-CN\|en-US] [--text <短句>]` | 离线 TTS → 16 kHz 单声道 MP3，详见成功路径配方 |
| `scripts/run-safety.test.mjs` | `node --test` 运行隔离 fixture 回归，不连接 Host/BLE |

维护功能清单：应用变化后用 `/pstack:maintain-verification-skill` 更新 `features/`。
