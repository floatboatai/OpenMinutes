# 工程约定

## 入口与装配

- `src/server/index.ts`：创建 `createWorkbenchServer`、创建设备服务 `createDeviceService`，按领域注册路由并启动自动连接调度器。
- `src/ui/main.tsx` 挂载页面；`src/ui/App.tsx` 负责 6 项侧边导航；`src/ui/router.ts` 是纯函数哈希路由（`parseHash` / `buildHash` / `navKey`）：`#/library?stage=failed|ready|transcribed|pending`、`#/rec/:id`、`#/device`、`#/live`、`#/calendar?day=YYYY-MM-DD&rec=<id>`、`#/categories`、`#/settings`、`#/settings/diagnostics`。`#/overview`、空哈希与未知哈希用 `history.replaceState` 改写为 `#/library`。详情页的返回按钮回到应用内的上一条路由，没有时回到 `#/library`。
- `src/contracts/` 保存跨端 DTO（`app.ts`、`device.ts`、`calendar.ts`、`preflight.ts`）、错误模型（`errors.ts`）、不可信输入校验（`input.ts`）及排队/执行中状态判定（`recording-status.ts`）；浏览器端不得导入服务端模块。
- `migrations/` 只追加。`0001_initial.sql` 包含业务表与初始种子；`0002_auto_runtime_settings.sql` 增加录音库、自动转录与重连设置，`0003_auto_pull.sql` 增加自动同步设置，`0004_remove_sdk_dir.sql` 删除旧 SDK 目录设置，`0005_calendar.sql` 增加日历事件与录音关联，`0006_environment_repair.sql` 增加环境修复状态，`0007_device_service.sql` 增加 `last_error_code` / `last_error_detail`、`devices.ble_address` 以及 `device_transport`、`auto_pull_wifi`、`device_user_disconnected` 设置。
- 两个 SDK 的称呼固定：**宿主 SDK**（`sdk/`，Floatboat runtime/host/db/resources，本仓库不改动）与**设备 SDK**（PyPI `memotalk-sdk`）。
- 源码是编辑入口，`dist/` 由 Host 生成；类型与构建通过 `check_workbench_project`，`workbench_runtime open` 应用更新。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `server/http.ts` | 统一 `{ ok: true, data }` / `{ ok: false, error, code, detail?, action? }` 信封与错误映射（见下文「错误模型」） |
| `server/sql.ts` | node:sqlite 薄封装、设置读写、任务记录、标签同步 |
| `server/repo.ts` | 录音列表/详情/分类/统计查询；组合内存队列与数据库状态，投影排队状态并计算全库 `hasActiveTasks` |
| `server/app-route.ts` | `/api/app`、`/api/overview`（统计与 `byCategory`）、`/api/tags` |
| `server/library.ts` | 录音库根目录、分月归档与历史路径兼容 |
| `server/ingest.ts` | 目录扫描导入、设备清单登记、下载文件挂接、去重与命名冲突处理 |
| `server/device/service.ts` | 设备 SDK 的唯一所有者：连接状态机、单一互斥、活动与进度、空闲断开、实时字幕占用、诊断环形缓冲（最近 50 条）、热点残留自愈 |
| `server/device/worker.ts`、`server/device/worker-script.ts` | 常驻 Python worker：运行时写成 `<dataDir>/tools/device/worker.py`，持有一个 `MemoTalkClient`，JSON-lines RPC，按平台入网与恢复、取消、删除 |
| `server/device/sync.ts` | 同步编排：list → `registerDeviceManifest` → `planTransfer` → 网络闸门 → pull → 大小校验 → `attachDownloadedFile` → 自动转录；清理已同步 |
| `server/device/transport.ts` | 纯函数 `planTransfer`、`probeWifiCapable`（缓存 10 分钟） |
| `server/device/errors.ts` | `classifyDeviceError`：设备 SDK 异常类型 → `AppError` |
| `server/device/auto-connect.ts` | 调度器：每 30 秒检查一次，到期且未被用户手动断开时连接、按开关后台同步、用完即断 |
| `server/device/fake-device.ts` | 假录音笔 prelude（仅测试） |
| `server/network-gate.ts` | 无线快传断网窗口：`acquireOffline` 等进行中的 Host 任务、`whenOnline`、`assertOnline` |
| `server/media.ts` | ffmpeg 探测、时长解析、16kHz 单声道 PCM16 分帧解码 |
| `server/transcribe.ts` | Host ASR 会话：参数降级启动、推流、事件收集、收尾与错误归类 |
| `server/organize.ts` | Host LLM 结构化归类：提示词、JSON Schema、文本回退与结论落库 |
| `server/pipeline.ts` | 转录/归类状态机：`job_runs` 记录、失败可重试、自动归类开关；失败分列写 `last_error` / `last_error_code` / `last_error_detail` |
| `server/queue.ts` | 按标签前缀分车道执行任务：`transcribe` 车道并行上限取 `asr_concurrency`（1–8，默认 3），其它车道串行；支持延迟入队（排队可见但不占名额）；保留等待/运行中标签至任务结束，提供快照、`isRunning`、`whenIdle`、单条排队状态与全库录音任务查询；`transcribe:` / `organize:` / `scenes:` 任务执行前等待网络闸门 |
| `server/transcribe-checkpoints.ts` | 断点续转检查点（`transcribe_checkpoints`，按 5 分钟块，带源文件 size+mtime 与参数指纹）与排队意图（`queued_tasks`）的读写 |
| `server/jobs.ts` | `trackTask` 与队列装配、导入/同步后自动转录 |
| `server/calendar.ts`、`calendar-import.ts`、`calendar-digest.ts` | 日历事件、`.ics` 导入、录音关联与建议、会议纪要/日报（调用 Host 前 `assertOnline`） |
| `server/preflight.ts` | 本机环境自检（分组 device/audio/ai/storage，技术原文进 `detail`）；`listHostCapabilities` 是宿主能力的唯一来源 |
| `server/environment-repair.ts`、`server/repair-store.ts` | 让 Floatboat 助手修复本机环境，状态持久化（调用 Host 前 `assertOnline`） |
| `server/runtime-probe.ts`、`server/tools.ts`、`server/paths.ts` | 探测 Python/bleak/设备 SDK/ffmpeg 与工具路径 |
| `server/live.ts`、`server/live-script.ts` | 实时字幕会话、音频落盘与停止后的录音/文本保存；采集进程由设备服务派生 |
| `server/live-audio.ts` | 实时 MP3 解码参数与按秒分帧的 PCM 流 |
| `server/live-asr.ts` | 按需开启实时识别会话、推流与会话重建 |
| `server/routes/*` | 按领域拆分的 HTTP 路由 |

## 设置与 API

- 完整 API 列表见中英文 README。设备协议指令参考只在 `GET /api/diagnostics`；宿主 ASR/LLM 能力只在 `GET /api/environment/capabilities`（与诊断视图共用 `listHostCapabilities`）。`GET /api/device` 只读内存与 preflight 缓存，1.5 秒轮询不派生任何子进程。
- 旧的设备细粒度接口（读状态、读清单、单条下载、环境检查、能力清单、摘要、删除设备记录）、创建导入目录接口和 `PUT /api/recordings/:id` 已删除，不保留兼容别名；对应能力分别并入上述设备任务接口、`/api/environment/*` 与 `PATCH /api/recordings/:id`。
- `PATCH /api/settings` 使用 `{ values: { key: string } }`，先校验所有键再写入。路径键为 `import_dir`、`library_dir`、`python_path`、`ffmpeg_path`；开关键为 `auto_transcribe`、`auto_analyze`、`auto_connect`、`auto_pull`、`auto_pull_wifi`、`speaker_diarization`，值只接受 `"0"` / `"1"`；枚举键 `device_transport` 取 `auto` / `wifi` / `ble`。
- `auto_connect_minutes` 接受 1~120 的整数字符串，默认 3；文本键为 `asr_hotwords`、`asr_language`，长度上限 300、20 字符；路径上限 500 字符。`sdk_dir` 读取隐藏、提交忽略；其他未知键拒绝。运行时写入的 `device_serial`、`device_user_disconnected`、`last_auto_connect_at`、`last_auto_pull_at` 可以读取，不能由该接口修改。
- 设置页分为通用（目录）/ 自动化 / 识别 / 诊断与高级（Python/ffmpeg 路径、同时转录的录音数 `asr_concurrency`、传输方式）。`auto_pull_wifi` 默认 `"0"`，其余五个开关默认 `"1"`。
- `asr_language` 当前只写入文件转录结果元数据，未从流水线传给 ASR；实时识别仅传固定 PCM 参数，不读取热词、语言或说话人分离设置。
- 自动连接调度器每 30 秒检查：`auto_connect==='1'`、`device_user_disconnected!=='1'`、当前未连接且不在实时字幕中、已到 `nextAttemptAt`。满足后以 `origin:'auto'` 连接，`auto_pull==='1'` 时后台同步，结束后断开。

## 设备服务

### 连接状态机

`state: disconnected | connecting | connected | busy | live`，`origin: user | auto`，`disconnectReason: user | idle | auto-done | device_sleep | lost | live`。

- `connect` 幂等：connecting 时返回同一个 promise，已连接直接返回，busy 时返回当前状态不报错。成功后 upsert 设备、写 `devices.ble_address` 与 `device_serial`；用户来源清除 `device_user_disconnected`，并在 `auto_pull==='1'` 时立即同步。
- `disconnect` 有活动时先协作式取消；热点阶段最多等 90 秒、蓝牙阶段 15 秒，再发 `disconnect`，5 秒未退出才终止进程。只有超过 90 秒的硬超时才会杀掉热点阶段的 worker，之后由下次连接的热点自检和 `wifi-restore.json` 恢复。
- 用户会话最后一次操作 10 分钟后以 `idle` 断开；自动会话任务结束后以 `auto-done` 断开（按结束时的 origin 判断）。用户在自动会话里点「连接」或「同步录音」会接管会话：origin 改为 `user`、清除手动断开标记，不再用完即断；正在进行的后台同步结束后，若有推迟的大录音，按用户规则再同步一次；调度器发现 origin 已不是 `auto` 就不再同步或断开。实时字幕结束后的恢复连接只恢复会话（`autoSync:false`），不触发同步，也就不会切到热点；worker 报 `disconnected` 或进程退出时进入 `device_sleep` / `lost`。
- 所有 worker 命令走同一条 promise 链。同步/单条同步/清理进行中为 busy，此时再申请 `sync` / `pull` / `cleanup` / 实时字幕一律 `DEVICE_BUSY`。
- 实时字幕：`startLiveCapture` 记下是否为用户连接，断开 worker 后由服务派生采集脚本并交给 `live.ts`；`releaseFromLive` 结束后按需恢复用户连接。

### worker 协议（stdin / stdout JSON-lines）

启动：`<python> -X utf8 -u <dataDir>/tools/device/worker.py --state-dir <dataDir>/tools/device [--prefer <ble_address>] [--fake-prelude <path>] [--net-platform win32|darwin|linux]`。后两个参数只供测试；不加 `-I`，以免屏蔽用户 site-packages 里的设备 SDK。脚本写成文件再执行，避开 Windows 命令行长度与引号问题。

- 命令：`connect`、`status`、`list`、`pull {files, outDir, transport}`、`cancel`、`delete {names}`、`disconnect`。
- 输出：`result` / `error {kind, message}` 按 `id` 对应；`event` 有 `progress {phase, file, transport, bytes, total, index, count}`、`fallback {from, to, reason, detail}`、`warning`（如 `HOTSPOT_CLOSE_UNCONFIRMED`）、`disconnected`；另有 `log`。
- `connect` 后先 `sync_time()`（失败不致命），再读 `wifi.hotspot_state()`，残留热点立即 `wifi.disable()` 并回报 `hotspotWasOn`。连接期间每 5 秒检查一次 `is_connected`。
- stdin 由后台线程读取再投递给 asyncio（Windows Proactor 不能对管道 `add_reader`）。stdin EOF 按取消 + 断开处理，先跑完热点会话的 finally（恢复网络、关热点）再退出。
- 所有输出经过 `emit()`：字段名含 `password` / `keyMaterial` / `psk` 的替换为 `***`，当前热点与 FTP 密码字面值全局替换。FTP 下载先写 `<name>.part`，大小校验通过后再改名。

### 传输规划与无线快传

- `planTransfer`：`device_transport==='ble'` 全走蓝牙；平台不是 win32/darwin/linux 或没有无线网卡时不走 Wi-Fi；`origin==='auto' && !auto_pull_wifi` 时只用蓝牙拉大小已知且 < `WIFI_MIN_BATCH_BYTES`（1 MiB）的文件，受 `BACKGROUND_BLE_LIMIT`（3 个 / 150 秒）限制，其余计入 deferred；其他情况本批 ≥ 1 MiB 或含大小未知的文件时走 Wi-Fi。
- 无线网卡探测：win32 `netsh wlan show drivers`（含定位权限提示也算有网卡）；darwin `networksetup -listallhardwareports` 含 `Wi-Fi`；linux `nmcli -t -f TYPE dev` 含 `wifi`。结果缓存 10 分钟；假设备模式直接返回 true。
- 同步前读 `recordingState`，录音或暂停中返回 `DEVICE_RECORDING`，不开热点。只同步 `device_serial = 当前序列号` 的 pending 记录；只挂接 worker 返回的路径，且本地大小必须等于设备上报的 `sizeBytes`，否则按 `TRANSFER_FAILED`。
- Wi-Fi 路径：`dev.wifi.session()` 开热点 → 按平台入网（Windows 写 `wifi-restore.json` 后用 hex SSID、`connectionMode=manual` 的临时 profile，定位权限失败时不带 `interface=`；macOS 用 `join_hotspot(iface)`；Linux 用 `nmcli` + 0600 passwd-file）→ 对 `ftp_config.host:port` 做 TCP 可达性探测（最多 20 秒）→ FTP 串行 `retrbinary` → finally 中离网、删临时 profile → 退出 session 由设备 SDK 关热点并确认 → 重连原网络并删除 `wifi-restore.json` → 若开热点前能连上公网（TCP 探测 223.5.5.5 / 1.1.1.1 / 8.8.8.8 的 53 端口），就等到再次连通才上报 `fallback` 或结果（最多 25 秒，Windows 等到一半时再发一次 `netsh wlan connect`）；超时发 `NETWORK_RESTORE_TIMEOUT` 警告进设备日志。
- 第 1–4 步任一失败都发 `fallback`（`WIFI_UNSUPPORTED` / `WIFI_ENABLE_FAILED` / `WIFI_JOIN_FAILED` / `WIFI_UNREACHABLE` / `WIFI_FTP_FAILED` / `WIFI_TRANSFER_FAILED`），先恢复网络，再用 `files.download` 逐个走蓝牙。worker 启动时发现 `wifi-restore.json` 会先恢复网络。
- 取消是协作式的：FTP 写回调或蓝牙进度回调抛 `CancelledTransfer`；蓝牙再调用 `files.sync_control(name, SyncOp.CANCEL)`。热点阶段绝不硬中断：被中断的热点开关会让录音笔拒绝录音。

### 网络闸门

- 走 Wi-Fi 前 `acquireOffline('device-hotspot', { waitForInFlightMs: 180_000 })`：先暂停新任务，再等进行中的 `transcribe:` / `organize:` 任务结束；超时恢复闸门并返回 null，本批改走蓝牙（`fallback` 原因 `NETWORK_IN_USE`）。收到 `fallback` 或最终结果后立即 `release()`。
- 断网期间新的转录/归类任务排队等待，不报错；队列外的 Host 调用（日历纪要、环境修复）先 `assertOnline()`，断网时抛 `NETWORK_PAUSED`。

### 假设备（只用于测试）

设置 `OPENMINUTES_FAKE_DEVICE=wifi|ble|absent` 时，worker 加载 `fake-device.ts` 写出的 prelude：用设备 SDK 自带的 `FakeMemoTalk` 替换真实录音笔，`OPENMINUTES_FAKE_DEVICE_AUDIO_DIR` 提供真实 mp3 字节；`subprocess` 遇到 `netsh` / `nmcli` / `networksetup` 直接抛错。`wifi` 模式用内存 FTP；`ble` 模式入网失败以测试回退；`absent` 模式连接抛 `DeviceNotFound`。verify skill 的 `launch.mjs --fake-device=<mode>` 负责设置这些变量。

### 设备 SDK 能力矩阵

| memotalk-sdk 能力 | 去向 |
| --- | --- |
| `connect()` / `close()`（`prefer`） | worker `connect` / `disconnect`，`prefer = devices.ble_address` |
| `info()` / `battery()` / `firmware()` / `identity()` / `free_space()`、`record.state()` | worker `status` → 录音笔卡片；同步前检查录音状态 |
| `sync_time()` | 连接后自动执行，无入口 |
| `record.*` / `stream.*` / `set_realtime` | 只由实时字幕采集脚本使用，由设备服务派生 |
| `files.list()` / `files.download()` / `files.sync_control(CANCEL)` / `files.delete()` | worker `list` / 蓝牙 `pull` / 「停止」/ 「清理已同步的录音」 |
| `wifi.session()`、`NetworkSession.open_ftp` / `list_audio_files`、`join_hotspot()`（仅 macOS） | worker `pull` 的无线快传部分 |
| `wifi.hotspot_state()` / `disable()` | 连接时关闭残留热点 |
| `wifi.credentials()` | 只在 session 内部使用，不展示、不记录 |
| `files.download_all()` | 不用：由编排逐个下载，才能报告进度、支持取消 |
| `files.clear_all()` | 不接入：不可逆，「清理已同步」已覆盖安全子集 |
| `settings.*`（休眠时长、最长录音、U 盘模式）、`has_import_file()`、`raw.*` | 本次不接入（录音笔设置见 REQUIREMENTS「待评估」） |

## 错误模型

- `src/contracts/errors.ts` 定义 `AppError(code, message?, detail?, action?)`、`AppErrorView` 与 `ERROR_COPY`（每个 code 的默认中文文案和可选 action），UI 与服务端共用。
- `http.ts` 的判断顺序：`AppError` 原样输出 → `BadInput` 为 `INVALID_INPUT` → Node 系统错误（带 `errno` / `syscall`）按 errno 映射：EACCES/EPERM → `NO_PERMISSION`、ENOSPC → `DISK_FULL`、ENOENT → `FILE_MOVED`，其余 `INTERNAL_ERROR`，原文进 `detail` → 带字符串 `code` 的业务错误保留 message → 其他异常为 `INTERNAL_ERROR`，stack 截断 2000 字进 `detail`。
- `device/errors.ts` 把设备 SDK 异常类型映射为 `DEVICE_NOT_FOUND`、`DEVICE_DISCONNECTED`、`DEVICE_TIMEOUT`、`DEVICE_RECORDING`、`FILE_NOT_ON_DEVICE`、`DELETE_FAILED`、`TRANSFER_FAILED`、`BLUETOOTH_UNAVAILABLE`、`RUNTIME_MISSING`、`DEVICE_ERROR`；`detail` 为 `kind: message`、操作与退出码、stderr 尾部。
- 转录、归类、实时字幕、日历纪要、环境修复、导入同样只把中文结论放进 `error` / `last_error`，宿主错误码、requestId、ffmpeg stderr、runId、幂等键一律进 `detail`。`job_runs.message` 只写中文，原文写进 `detail_json`。
- UI 用 `ErrorNotice` 显示：主行中文 + 可选 action + 「重试」；有 detail 时「查看详情」展开 code 与 detail，可「复制诊断信息」或「在诊断中查看」。toast 只显示 message，带 detail 时附「详情」并且不自动消失。

## 排队状态与轮询

- `queue.ts` 的内存标签覆盖等待及运行中的任务，任务完成或失败后由 `finally` 清理；`queuedRecordingStatus` 查询单条录音，`hasRecordingTasks` 查询全库转录/归类任务。代码依据：`src/server/queue.ts:8`、`src/server/queue.ts:25`、`src/server/queue.ts:31`。
- `repo.ts` 在摘要与详情响应中临时投影 `queued_transcribe` / `queued_organize`，对应「转录已排队 / 归类已排队」，不写入数据库。数据库中的 `transcribing` / `analyzing` 优先于队列投影；阶段筛选仍使用数据库状态。代码依据：`src/server/repo.ts:30`、`src/server/repo.ts:59`、`src/server/repo.ts:202`；标签见 `src/ui/components/ui.tsx:125`。
- 列表结果为 `{ items, total, hasActiveTasks }`。`hasActiveTasks` 同时检查内存录音任务与数据库中的执行中状态，是全库信号，不受当前搜索、筛选、分页影响。代码依据：`src/contracts/app.ts:115`、`src/server/repo.ts:150`。
- 单条转录/归类在音频/文本前置校验通过后，对排队或执行中的录音返回 `BUSY`；批量接口跳过这些录音并计入 `skipped`。批量路由先于 `:id` 注册，避免 `batch` 被识别成录音 ID。代码依据：`src/server/routes/pipeline.ts:13`、`src/server/routes/pipeline.ts:25`、`src/server/routes/pipeline.ts:46`、`src/server/routes/pipeline.ts:66`、`src/server/routes/pipeline.ts:84`。
- 共享 `isBusyStatus` 包含两种排队状态及 `transcribing` / `analyzing`。详情页据当前录音状态每 2600ms 轮询，退出这些状态后停止；录音库根据 `hasActiveTasks` 以相同间隔轮询，全库均无排队/执行中任务后停止，不能只判断当前列表行。代码依据：`src/contracts/recording-status.ts:1`、`src/ui/pages/Detail.tsx:51`、`src/ui/pages/Library.tsx:54`、`src/ui/useApi.ts:48`。

## 持久化对象

`devices`、`recordings`、`transcripts`、`analyses`、`categories`、`tags`、`recording_tags`、`job_runs`、`sdk_commands`、`settings`、`calendar_events`、`environment_repairs`。

- `library.ts` 统一录音库位置与路径解析。`library_dir` 默认 `~/memo/memotalk/raw`；目录导入与录音笔同步复制到 `<library_dir>/<yyyy-MM>/`，实时录音也写入月目录。月份使用本地时区，录制时间无法解析时回退到当前月份。
- 新版 `recordings.storage_path` 保存完整目标路径，默认目录或绝对路径配置下为绝对路径。目录配置应使用绝对路径或 `~/...`；当前设置校验并不拒绝相对路径。历史相对文件名由 `resolveAudioFile` 从 Host 数据资源 `audio` 解析，`resolveStoredPath` 则使用调用方提供的兜底目录。修改 `library_dir` 不会迁移已有文件或重写其路径。
- 录音笔同步先暂存到 `app.resources.path('audio', '_incoming', 'write')` 下每个任务独立的 `<jobId>/` 目录，大小校验通过后复制进录音库，任务结束删除该目录；`import_dir` 不是同步暂存目录。目录扫描只处理当前层支持的音频文件，不递归，且保留来源文件。
- 删除录音时尝试 `rename` 到当前 `<library_dir>/_trash/<毫秒时间戳>-<原存储文件名>`。无论移动是否成功，随后都会删除录音、转录、分析、标签关联、任务记录并清理孤立标签；移动失败返回 `audioMovedToTrash: null`。没有恢复接口，不应把回收站视为完整的数据备份。
- `POST /api/recordings/:id/export` 只复制音频，默认目标为解析后的 `import_dir`（默认 `~/memo/memotalk/inbox`），请求体 `directory` 可覆盖目标。目录自动创建，文件使用原始 `filename`，同名目标可能被覆盖；不存在独立的导出目录设置。

## 外部副作用

- **Host ASR**：把本机音频解码后流式送出，只保存文本与分段，不上传音频原件。
- **Host LLM**：只发送转写文本与分类说明，返回结构化 JSON Schema 校验后的对象。
- **本机进程**：`ffmpeg` 用于解码/探测；`python` 只由设备服务派生两类固定脚本：常驻设备 worker（连接、状态、清单、同步、删除）和实时字幕采集脚本，同一时间只有一个进程占用录音笔。不接受用户拼接的任意命令，也不加载 SDK 源码目录。
- **本机网络**：手动同步走无线快传时，worker 会临时连上录音笔热点（Windows `netsh`、macOS `networksetup` / `join_hotspot`、Linux `nmcli`），完成后删除临时 profile 并连回原网络。热点密码只在 worker 内存里使用。后台任务默认不改变网络。
- **录音笔存储**：「清理已同步的录音」会删除录音笔上的文件（不可逆）。删除前重新读清单，只删库中有记录、本地文件存在且大小一致的文件，并要求用户二次确认，结果写入诊断记录。
- 文件转录与归类流水线维护录音状态和 `job_runs`，失败分列保存 `last_error` / `last_error_code` / `last_error_detail`。设备操作的结果写入设备服务的 `lastResult` / `lastError` 和诊断环形缓冲；导入按文件返回 `{outcome, reason, detail}`。

## 可执行验证

1. `check_workbench_project`：strict 类型检查 + server 编译 + UI 打包。
2. `workbench_runtime open` 后用浏览器执行主流程：`POST /api/ingest/scan` → `POST /api/recordings/:id/transcribe` → 轮询 `GET /api/recordings/:id` → `POST /api/recordings/:id/organize`。
3. 用 16kHz 单声道 MP3（与设备格式一致）验证 ffmpeg 解码与 ASR 帧序，确认 `transcripts.text` 与 `segments_json` 落库。
4. 用 `curl -H 'Range: bytes=100-199' GET /api/recordings/:id/audio` 验证 206 + `content-range` + `accept-ranges`，并在页面播放中拖动进度条，确认 `currentTime` 从新位置继续前进。
5. 点详情页分段时标，确认 `audio.currentTime` 跳到该句 `startMs`、播放从新位置继续、当前句高亮；音频不可用时时标退回纯文本。
6. 无 `bleak` 时应验证录音笔页提示「录音笔组件还没准备好」并链接到诊断区，且「导入」对话框仍可用。
7. 设备流程只用假录音笔验证（verify skill 的 `launch.mjs --fake-device=wifi|ble|absent`）。对真实录音笔执行同步会真实切换本机 Wi-Fi，agent 不执行；真机验收由用户按清单进行（无线快传进度与网络恢复、关闭定位服务后的回退、停止、断开后不自动重连、同步期间转录排队）。

## 容错策略

- ASR 启动按「完整参数 → 基础参数」逐级降级；可选开关（语义标点、说话人分离、热词）被服务端拒绝时不阻断转录，降级过程记录在任务错误信息中。
- 文件转录按 5 分钟音频分块，每块单独开 ASR 会话。实测长会话会中途收到 `ASR_UPSTREAM_FAILED`，之后 `sendFrame` 报 `ASR_AUDIO_SEND_FAILED` / `ASR_SESSION_NOT_RUNNING`；此时保留已确认句子，从最后一句结束处开新会话续传（每块最多 4 次，全程最多 16 次）。会话 `text` 只保证最近内容，最终文本一律用逐句结果拼接。
- 断点续转：每块识别完成即写 `transcribe_checkpoints`；再次转录时先比对源文件 size+mtime 与参数指纹（分块秒数、说话人分离、热词），一致则跳过已完成块（不送 ASR，用存下的分段按原偏移拼接），不一致则清空重来。60 分钟上限只计实际送识别的耗时。写入 `transcripts` 成功后删除检查点，失败保留。
- 识别服务会话已满（Host 以 429 拒绝 `asr.start`，例如超过 8 个活动会话；Host 客户端不保留 HTTP 状态，按错误码 `isCapacityError` 判断）时抛 `ASR_BUSY`：录音恢复执行前状态，`job_runs` 记 `interrupted`，`jobs.ts` 按 5 秒递增到 1 分钟延迟重新排队，最多 30 次后才以 `ASR_BUSY` 失败。
- 重启恢复：`recoverInterruptedTasks` 把 `transcribing` / `analyzing` 录音退回 `ready`/`transcribed` 并补写 `queued_tasks`，`running` 的 `job_runs` 标 `interrupted`；`index.ts` 在 `listen()` 之后用 `resumeQueuedTasks` 按排队顺序延迟 2 秒重新入队（已在内存队列中的跳过），转录从检查点继续。
- 转录诊断：每次转录的阶段轨迹（会话、续传、失败请求 ID）写入 `job_runs.detail_json.trace`，运行中 `job_runs.message` 实时更新进度，详情页据此显示。
- LLM 优先 `generateObject`；若服务端拒绝该 JSON Schema，回退 `generateText` 并本地抽取 JSON，再做字段收敛与分类枚举校验。
- 实时字幕的识别会话**按需开启**：只在收到第一帧 PCM 时才 `asr.start`，避免连接/等待阶段空转到 60 秒被服务端回收；会话被回收或上游异常时自动重建（连续失败 4 次熔断并提示重开）。
- 工具路径（python/ffmpeg）按「设置值 → Floatboat 内置工具 → PATH → 命令名」探测，避免依赖进程 PATH。
- `resolveImportDir` 在 `import_dir` 为空或位于系统临时目录时回落到 `~/memo/memotalk/inbox`；只有非空的临时目录配置会被写回默认值。`POST /api/ingest/scan` 显式传入 `directory` 时直接使用并保存该路径，不经过这项回退。扫描前若目录不存在会先创建，创建失败报告 `DIR_NOT_CREATABLE`。
- 录音笔同步：无线快传任何阶段失败自动改用蓝牙；关热点未确认时记 `HOTSPOT_CLOSE_UNCONFIRMED` 警告，下次连接先检查并关闭残留热点；进程被硬杀后，下次启动 worker 按 `wifi-restore.json` 恢复网络。

## 已知边界

- 应用不会伪造设备连接成功；录音笔连接依赖用户本机 Python + bleak + 设备 SDK + 真实录音笔。
- 无线快传的 Windows 路径必须真机验收；macOS 与 Linux 只有桩测，属于实验性支持。`WIFI_MIN_BATCH_BYTES`（1 MiB）需要按真机实测的无线与蓝牙吞吐调整。
- 无线快传窗口内 Floatboat Host 自身的联网行为（登录心跳等）不受本应用控制，需在真机验收中观察。
- 内嵌播放的拖动进度条依赖 `GET /api/recordings/:id/audio` 自身实现的 HTTP Range 支持（`206` + `content-range` + `accept-ranges: bytes`，含 `bytes=-N` 后缀区间、越界 `416`）。只回 `200` 全量时浏览器无法 seek，播放头会退回拖动前的位置。
- 播放依赖 Host 对 `Response` 与流式 body 的透传；确实拿不到时页面提示改用「导出」。
