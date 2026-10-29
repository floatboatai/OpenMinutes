# 工程约定

## 入口与装配

- `src/server/index.ts`：只做装配，创建 `createWorkbenchServer` 并按领域注册路由。
- `src/ui/main.tsx` 挂载页面；`src/ui/App.tsx` 负责侧边导航与哈希路由（`#/overview`、`#/library`、`#/rec/:id`、`#/device`、`#/categories`、`#/settings`）。
- `src/contracts/` 保存跨端 DTO（`app.ts`）与不可信输入校验（`input.ts`）；浏览器端不得导入服务端模块。
- `migrations/` 只追加。`0001_initial.sql` 已包含全部业务表与分类、SDK 指令、设置种子。
- 源码是编辑入口，`dist/` 由 Host 生成；类型与构建通过 `check_workbench_project`，`workbench_runtime open` 应用更新。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `server/http.ts` | 统一 `{ ok, data \| error }` 信封与错误码映射 |
| `server/sql.ts` | node:sqlite 薄封装、设置读写、任务记录、标签同步 |
| `server/repo.ts` | 录音列表/详情/分类/总览的读取查询 |
| `server/ingest.ts` | 目录扫描导入、设备清单登记、下载文件挂接、去重与命名冲突处理 |
| `server/media.ts` | ffmpeg 探测、时长解析、16kHz 单声道 PCM16 分帧解码 |
| `server/transcribe.ts` | Host ASR 会话：参数降级启动、推流、事件收集、收尾与错误归类 |
| `server/organize.ts` | Host LLM 结构化归类：提示词、JSON Schema、文本回退与结论落库 |
| `server/pipeline.ts` | 转录/归类状态机：`job_runs` 记录、失败可重试、自动归类开关 |
| `server/queue.ts` | 串行队列，避免同时占满 Host ASR 在途上限 |
| `server/bridge.ts` | SDK 桥接：探测 Python/bleak/SDK/ffmpeg，以固定参数调用 SDK 命令行 |
| `server/routes/*` | 按领域拆分的 HTTP 路由 |

## 持久化对象

`devices`、`recordings`、`transcripts`、`analyses`、`categories`、`tags`、`recording_tags`、`job_runs`、`sdk_commands`、`settings`。

- `library.ts` 统一录音库位置与路径解析。`library_dir` 默认 `~/memo/memotalk/raw`；目录导入与设备下载复制到 `<library_dir>/<yyyy-MM>/`，实时录音也写入月目录。月份使用本地时区，录制时间无法解析时回退到当前月份。
- 新版 `recordings.storage_path` 保存完整目标路径，默认目录或绝对路径配置下为绝对路径。目录配置应使用绝对路径或 `~/...`；当前设置校验并不拒绝相对路径。历史相对文件名由 `resolveAudioFile` 从 Host 数据资源 `audio` 解析，`resolveStoredPath` 则使用调用方提供的兜底目录。修改 `library_dir` 不会迁移已有文件或重写其路径。
- BLE 下载先暂存到 `app.resources.path('audio', '_incoming', 'write')`，再复制进录音库；`import_dir` 不是 BLE 暂存目录。目录扫描只处理当前层支持的音频文件，不递归，且保留来源文件。
- 删除录音时尝试 `rename` 到当前 `<library_dir>/_trash/<毫秒时间戳>-<原存储文件名>`。无论移动是否成功，随后都会删除录音、转录、分析、标签关联、任务记录并清理孤立标签；移动失败返回 `audioMovedToTrash: null`。没有恢复接口，不应把回收站视为完整的数据备份。
- `POST /api/recordings/:id/export` 只复制音频，默认目标为解析后的 `import_dir`（默认 `~/memo/memotalk/inbox`），请求体 `directory` 可覆盖目标。目录自动创建，文件使用原始 `filename`，同名目标可能被覆盖；不存在独立的导出目录设置。

## 外部副作用

- **Host ASR**：把本机音频解码后流式送出，只保存文本与分段，不上传音频原件。
- **Host LLM**：只发送转写文本与分类说明，返回结构化 JSON Schema 校验后的对象。
- **本机进程**：`ffmpeg` 用于解码/探测；`python` 以固定脚本和参数调用 PyPI `memotalk-sdk` 的 `MemoTalkClient`（状态、清单、下载及实时流），不接受用户拼接的任意命令，也不加载 SDK 源码目录。
- 所有外部写操作先落状态再执行，失败保留 `last_error` 与 `job_runs` 记录。

## 可执行验证

1. `check_workbench_project`：strict 类型检查 + server 编译 + UI 打包。
2. `workbench_runtime open` 后用浏览器执行主流程：`POST /api/ingest/scan` → `POST /api/recordings/:id/transcribe` → 轮询 `GET /api/recordings/:id` → `POST /api/recordings/:id/organize`。
3. 用 16kHz 单声道 MP3（与设备格式一致）验证 ffmpeg 解码与 ASR 帧序，确认 `transcripts.text` 与 `segments_json` 落库。
4. 用 `curl -H 'Range: bytes=100-199' GET /api/recordings/:id/audio` 验证 206 + `content-range` + `accept-ranges`，并在页面播放中拖动进度条，确认 `currentTime` 从新位置继续前进。
5. 点详情页分段时标，确认 `audio.currentTime` 跳到该句 `startMs`、播放从新位置继续、当前句高亮；音频不可用时时标退回纯文本。
6. 无 `bleak` 时应验证设备页如实报告「未就绪」，且目录导入路径仍可用。

## 容错策略

- ASR 启动按「完整参数 → 基础参数」逐级降级；可选开关（语义标点、说话人分离、热词）被服务端拒绝时不阻断转录，降级过程记录在任务错误信息中。
- 文件转录按 5 分钟音频分块，每块单独开 ASR 会话。实测长会话会中途收到 `ASR_UPSTREAM_FAILED`，之后 `sendFrame` 报 `ASR_AUDIO_SEND_FAILED` / `ASR_SESSION_NOT_RUNNING`；此时保留已确认句子，从最后一句结束处开新会话续传（每块最多 4 次，全程最多 16 次）。会话 `text` 只保证最近内容，最终文本一律用逐句结果拼接。
- 转录诊断：每次转录的阶段轨迹（会话、续传、失败请求 ID）写入 `job_runs.detail_json.trace`，运行中 `job_runs.message` 实时更新进度，详情页据此显示。
- LLM 优先 `generateObject`；若服务端拒绝该 JSON Schema，回退 `generateText` 并本地抽取 JSON，再做字段收敛与分类枚举校验。
- 实时字幕的识别会话**按需开启**：只在收到第一帧 PCM 时才 `asr.start`，避免连接/等待阶段空转到 60 秒被服务端回收；会话被回收或上游异常时自动重建（连续失败 4 次熔断并提示重开）。
- 工具路径（python/ffmpeg）按「设置值 → Floatboat 内置工具 → PATH → 命令名」探测，避免依赖进程 PATH。
- `resolveImportDir` 在 `import_dir` 为空或位于系统临时目录时回落到 `~/memo/memotalk/inbox`；只有非空的临时目录配置会被写回默认值。`POST /api/ingest/scan` 显式传入 `directory` 时直接使用并保存该路径，不经过这项回退；`/api/ingest/directory/ensure` 则在保存后重新解析目录。扫描前若目录不存在会先创建，创建失败报告 `DIR_NOT_CREATABLE`。

## 已知边界

- 应用不会伪造设备连接成功；BLE 通道依赖用户本机 Python + bleak + 真实设备。
- 内嵌播放的拖动进度条依赖 `GET /api/recordings/:id/audio` 自身实现的 HTTP Range 支持（`206` + `content-range` + `accept-ranges: bytes`，含 `bytes=-N` 后缀区间、越界 `416`）。只回 `200` 全量时浏览器无法 seek，播放头会退回拖动前的位置。
- 播放依赖 Host 对 `Response` 与流式 body 的透传；确实拿不到时页面提示改用「导出」。
