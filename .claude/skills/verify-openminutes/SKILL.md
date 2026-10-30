---
name: verify-openminutes
description: 在本机隔离启动 OpenMinutes，用无头 Chrome/Edge 验证导入、检索、详情播放、分类和设置；复用正在运行的 Floatboat Host 验证转录和 AI 归类成功路径，留存截图、ARIA、接口和任务证据。
---

# verify-openminutes

用 Floatboat 自带的编译器构建当前工作区，把服务以**独立进程 + 一次性数据目录**跑在随机 `127.0.0.1` 端口，再用 `browse.mjs` 驱动真实页面。所有命令都在仓库根目录执行，只需要 `node`（≥22.16，无 npm 依赖）、本机 Chrome 或 Edge，以及做测试音频用的 `ffmpeg`。

功能清单与逐项操作配方在 [`features/README.md`](features/README.md)。先读它的「基线」与「证据规范」，再挑对应功能文件。

## 边界（先读）

- **默认复用桌面 Floatboat 的 Host，不另起 Host。** launch 检查 Floatboat 进程、本 appId 最新连接配置、监听端口的进程归属，以及只读 `capabilities.list`。任一步失败便停止，不自动降级；显式 `--no-host` 或 `VERIFY_HOST_MODE=none` 才禁用 Host。
- **Host 地址属于本机敏感信息。** 只从 `%APPDATA%/floatboat/workbench/connections/*.json` 读取连接配置，只复制 `hostConnection.url` 到本 run 的 `workbench-config.json`。不复制真实数据目录、端口或其它启动字段；不打印地址、不把配置放入证据、不提交它。cleanup 删除临时配置。
- **真实 ASR/LLM 消耗额度。** 使用 `speech.mjs` 的短语音，每条只点一次转录/归类；失败后先读证据，不盲目重跑配方。`evidence.mjs` 从隔离库统计 `asr.start` 和 `llm.*`，包含自动重试/回退。能力探测不发起计费调用，也不能证明上游模型一定可用。实时字幕/BLE 不在本配方覆盖范围。
- **BLE 设备不要碰。** 设备页的「连接并检测」「读取清单」「下载」会通过本机 Python + bleak 真正连无线电。launch 已关闭 `auto_connect` / `auto_pull`，驱动时也不要点这几个按钮。
- **不要驱动不是本次 run 启动的实例。** 用户的 Floatboat 里可能开着同一个应用（数据在 `%APPDATA%\floatboat\workbench\data\workbench.3bb3830b-…`），那是真实数据，绝不读写、绝不 kill。
- 多个 run 可以并行：端口随机、数据目录 / 收件目录 / 归档目录 / 浏览器 profile 都按 runId 隔离。

## Launch

```bash
node .claude/skills/verify-openminutes/scripts/build.mjs          # ~10s；严格类型检查 + 打包到 dist/，失败时打印诊断并 exit 1
node .claude/skills/verify-openminutes/scripts/launch.mjs <runId>  # runId 省略则生成 UUID
node .claude/skills/verify-openminutes/scripts/launch.mjs <runId> --no-host  # 显式验证无 Host 失败路径
```

- 要验收另一个 worktree 或分支的代码时，给每条命令都加上 `OPENMINUTES_ROOT=<那个 checkout 的绝对路径>`。build、run 目录和证据都会落在那个 checkout 里，不需要往它里面复制 skill。
- 每次使用全新 runId；即使 cleanup 已执行，旧证据目录仍然保留，launch 会拒绝复用该 id，防止读取旧日志的 ready 地址或混合不同运行的证据。
- `build.mjs` 调用 `C:/Program Files/Floatboat/resources/workbench-toolchain/compiler.mjs`（可用 `FLOATBOAT_TOOLCHAIN` 覆盖），产物与 Host 构建一致。改了 `src/` 之后必须重新 build 再 launch，否则验证的是旧代码（doctor 会报 `dist/ is older than src/`）。
- runId 使用 1–80 个字母、数字、下划线或连字符，首字符是字母或数字，不使用 Windows 保留设备名。
- `launch.mjs` 在启动子进程前向新建的 scratch 数据库写入隔离设置：导入与归档目录指向本 run，四个 auto 开关为 `0`。收到本次日志的 ready 后，先用 nonce 核对 PID/generation，再 PATCH 设置。启动失败会停止并等待本次子进程退出，保留日志。
- 目录布局：
  - `.workbench/verify/<runId>/`：`run.json`（应用 url、pid、nonce、各目录、hostMode）、敏感的 `workbench-config.json`、`data/data.sqlite`、`inbox/`、`library/`、`browser-profile/`。cleanup 会删掉它。
  - `.workbench/verify-evidence/<runId>/`：`server.log` 与每次 `browse.mjs` 的 `<label>/` 子目录。cleanup **不会**删它。
  - 两者都在已被 gitignore 的 `.workbench/` 下。不要改用系统临时目录：应用会把位于 `%TEMP%` 的导入目录强制改回真实的 `~/memo/memotalk/inbox`。

## Doctor

```bash
node .claude/skills/verify-openminutes/scripts/doctor.mjs <runId>
```

只读检查，exit 0 才能继续驱动。它用 run 的 nonce 请求 `/__workbench/health`，确认端口上的进程就是本 run 启动的（pid、generation 一致）；确认隔离设置仍然生效（导入/归档目录指向本 run，四个 auto 开关为 `0`）；确认 `dist/` 不比 `src/` 旧。任何异常（页面空白、接口 404、数据对不上）都先跑它。如果报告设置被改，说明刚才的操作（例如设备页「保存路径」）覆盖了隔离，这个 run 应该 cleanup 后重来。

Host 模式另检查 Floatboat 监听归属，并发送一次 `capabilities.list`。输出 `host: {mode, available, probe}`，不输出连接地址或能力响应原文；显式无 Host 模式显示 `mode: "none", available: false`，不调用 Host。Floatboat 重启后旧地址可能失效，此时 cleanup 后重新 launch。

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

成功路径用中文语音而不是正弦波。Windows 需已安装中文 `System.Speech` 声音，脚本选用首个启用的中文声音，在 scratch 合成 WAV，再转为 16 kHz 单声道 MP3；不调用云 TTS。三个变体内容不同，避免导入去重。成功配方和调用预算见 [转录与归类](features/transcribe-organize.md)。

```bash
node .claude/skills/verify-openminutes/scripts/speech.mjs <runId> 1
```

下面的正弦波仅用于导入/播放/无 Host 失败测试，不能验证识别成功：

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
- Host 成功必须同时有 UI 终态、接口文本/分析结果和 `job_runs` 成功记录。运行 `node .claude/skills/verify-openminutes/scripts/evidence.mjs <runId> <label>` 保存接口读回、只读 `job_runs` 和 Host 调用统计。该脚本只打开本 run 的 SQLite，不打开 Floatboat 真实数据库。

## Cleanup

```bash
node .claude/skills/verify-openminutes/scripts/cleanup.mjs <runId>
```

cleanup 只会 kill `run.json` 里记录的 pid，并且要先用 nonce 确认这个进程确实属于本 run。确认后删除 `.workbench/verify/<runId>/`，最后打印 `evidenceKept` 路径。不要按进程名 kill：用户自己的 Chrome 和 Floatboat 也在跑。每次失败的尝试之后也要跑一遍 cleanup。`browse.mjs` 在退出时会自己关掉浏览器。要确认是否有残留的无头浏览器，用：

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
| `scripts/speech.mjs <runId> [1\|2\|3]` | 本机中文 TTS 测试语音，每段约 15–19 秒 |
| `scripts/evidence.mjs <runId> <label>` | 保存接口读回、job_runs、Host 调用次数 |
| `scripts/host.mjs` | Host 发现、监听归属检查、无计费能力探测 |
| `scripts/host.test.mjs` | `node --test` 运行 Host 发现与脱敏测试，不接触真实 Host |
| `scripts/make-voice.mjs --output <RECyyyyMMdd_HHmmss.mp3> [--language zh-CN\|en-US]` | 离线 TTS 生成 16 kHz 单声道 MP3，见 features/transcribe-success.md |
| `scripts/run-safety.test.mjs` | `node --test` 运行隔离 fixture 回归，不连接 Host/BLE |

维护功能清单：应用变化后用 `/pstack:maintain-verification-skill` 更新 `features/`。
