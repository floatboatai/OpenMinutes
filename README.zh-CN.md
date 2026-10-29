[English](README.md) | 简体中文

# OpenMinutes

> 把 MemoTalk S1 录音笔里堆着的 MP3，变成可搜索、可分类、可复盘的文本资产。

`OpenMinutes`（原名 `memotalk-workbench`）是 [Floatboat](https://floatboat.ai) 工作台应用的一份完整开源实现，配套硬件客户端 [`memotalk-sdk`](https://github.com/floatboatai/memotalk-sdk) 使用。

---

## 它解决什么问题

录音笔的典型困境：素材每天在增长，但你听不回去、也找不回来。

这个工作台把「导入 → 转录 → 归类 → 检索」做成一条闭环流水线，每条录音在列表上都有明确阶段标签（待拉取 / 待转录 / 转录中 / 待归类 / 归类中 / 已归档 / 失败），批量操作按当前筛选执行。

## 功能

| 能力 | 说明 |
| --- | --- |
| 三种接入入口 | 目录扫描导入、设备文件清单登记、BLE 直连拉取（依赖本机 Python + `bleak` + 真实设备） |
| 流式转录 | `ffmpeg` 解码为 16 kHz 单声道 PCM16，经 Host ASR 流式识别，落库全文与分段时间轴 |
| AI 归类 | Host LLM 结构化输出标题、摘要、分类、标签、要点、待办、重要度，并支持人工修正 |
| 检索复盘 | 全文搜索（正文 + 标题 + 摘要）、分类/标签/阶段筛选、时间排序、批量处理 |
| 详情播放 | HTTP Range 分段播放、按句时标跳转，转录全文、AI 结论与执行记录分区展示 |
| 分类管理 | 新增、就地改名、改色、删除 |
| 设备接入页 | 环境自检（Python / `bleak` / SDK / `ffmpeg`）、路径设置、SDK 指令参考库、手动登记 |

## 快速上手

本应用运行在 **Floatboat 桌面端的工作台运行时**中。它不是独立的 Node 服务，而是一个由 Host 装载的工作台包。

- Host 负责依赖准备、strict TypeScript 检查、server 编译与 UI 打包（产物落在 `dist/`，不入库）。
- SQLite 迁移由 Host 在打开工作台时应用（`migrations/` 只追加，不回改）。
- ASR 与 LLM 通过 Host 能力调用，本仓库不包含、也不需要任何模型密钥。

```bash
pnpm install          # 安装 UI 依赖、类型定义和测试工具
```

之后由 Floatboat 执行 `check_workbench_project` 完成类型检查与构建，`workbench_runtime open` 应用更新。这些是 Host 操作，不是 package scripts。

### 运行时依赖

| 依赖 | 用途 | 缺失时行为 |
| --- | --- | --- |
| `ffmpeg` | 音频探测与解码 | 转录不可用，页面如实提示 |
| `python` + `bleak` + `memotalk-sdk` | BLE 拉取设备录音 | 设备页报告「未就绪」，目录导入路径仍可用 |

工具路径按「设置值 → Floatboat 内置工具 → `PATH` → 命令名」逐级探测，不仅依赖进程 `PATH`。

在设备页查看实际使用的 Python 解释器，将 SDK 安装到同一个环境：

```bash
uv pip install --python "/path/to/python" "memotalk-sdk>=0.1.0"
"/path/to/python" -m memotalk.cli --version
```

Windows 可使用解释器的 `python.exe` 绝对路径。在 PowerShell 中执行版本检查时，需在带引号的解释器路径前加上 `&`。若使用虚拟环境，在设置中选择该环境的 Python。
SDK 会自动安装 `bleak`；无需克隆 SDK 源码或配置 SDK 目录。
应用通过 `from memotalk import MemoTalkClient` 调用设备 API 和实时音频流。
升级时会清理旧的 `sdk_dir` 配置，其余路径、识别与自动化设置保留。

### SDK 回归验证

`pnpm test` 运行服务端测试。SDK 集成测试使用包内模拟设备，不连接真实录音笔；
设置环境变量 `MEMOTALK_TEST_PYTHON` 为安装了 `memotalk-sdk` 的解释器路径后运行。
未设置时跳过 SDK 集成用例，设置接口与迁移测试仍会执行。

## 目录结构

```text
src/
  contracts/       跨端 DTO（app.ts）与不可信输入校验（input.ts）
  server/          Node 服务端：装配、路由、领域逻辑
    routes/        按领域拆分的 HTTP 路由
    http.ts        统一 { ok, data | error } 信封与错误码映射
    sql.ts         node:sqlite 薄封装、设置读写、任务记录
    ingest.ts      目录扫描、清单登记、去重与命名冲突处理
    media.ts       ffmpeg 探测、时长解析、PCM16 分帧
    transcribe.ts  Host ASR 会话：参数降级、推流、续传、错误归类
    organize.ts    Host LLM 结构化归类与文本回退
    pipeline.ts    转录/归类状态机与重试
    bridge.ts      memotalk-sdk Python API 桥接（固定参数，不接受拼接命令）
  ui/              React 界面：概览 / 录音库 / 详情 / 设备 / 分类 / 实时 / 设置
migrations/        只追加的 SQLite 迁移
sdk/               @floatboat/workbench-sdk 契约与类型（Host 提供）
tests/             服务端测试
```

配套文档（中文）：[需求](REQUIREMENTS.md)、[工程约定](ENGINEERING.md)、[设计](DESIGN.md)。

## 数据模型

`devices`、`recordings`、`transcripts`、`analyses`、`categories`、`tags`、`recording_tags`、`job_runs`、`sdk_commands`、`settings`。

### 存储与目录

- `import_dir` 是扫描来源，也是默认音频导出目录，默认值为 `~/memo/memotalk/inbox`。扫描会创建缺失的目录，只读取当前层文件，将支持的音频（`.mp3`、`.wav`、`.m4a`、`.aac`、`.ogg`、`.flac`、`.amr`、`.opus`）复制进录音库，保留原文件。
- `library_dir` 默认为 `~/memo/memotalk/raw`。目录导入与 BLE 拉取均复制到 `<library_dir>/<yyyy-MM>/`，月份按文件名推断的录制时间或兜底时间确定。实时录音也写入月目录。这些目录设置请使用绝对路径或 `~/...`；修改录音库设置不会迁移已有文件。
- 新版 `recordings.storage_path` 保存完整目标路径（默认目录或绝对路径配置下为绝对路径）。历史相对文件名仍从 Host 的 `audio` 数据资源解析。BLE 下载先暂存到 Host 的 `audio/_incoming`，不是 `import_dir`。
- 删除时先尝试把音频移动到**当前**录音库设置下的 `<library_dir>/_trash/<毫秒时间戳>-<原存储文件名>`，再删除录音及其转录、分析、标签关联和任务历史。移动失败仍会删除数据库记录，此时 `audioMovedToTrash` 为 `null`。目前没有恢复 API。
- 导出按原始 `filename` 将音频复制到 `import_dir`，也可由请求体的 `directory` 指定目标目录。缺失的目标目录会自动创建，同名文件可能被覆盖。详情页使用默认目标，没有独立的导出目录设置。

解析 `import_dir` 时，空值回落到默认目录；系统临时目录内的路径会被替换为默认目录并写回设置。扫描请求显式传入 `directory` 时则直接使用并保存该路径，不经过临时目录回退。

## API 速览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/recordings` | 列表：搜索 / 阶段 / 分类 / 标签 / 排序 / 分页 |
| `GET` | `/api/recordings/:id` | 详情（元数据 + 转录 + AI 结论 + 执行记录） |
| `PATCH` | `/api/recordings/:id` | 人工修正标题、分类、标签、重要度 |
| `DELETE` | `/api/recordings/:id` | 删除录音，尝试将音频移入 `<library_dir>/_trash/<毫秒时间戳>-<原存储文件名>` |
| `GET` | `/api/recordings/:id/audio` | 音频流，HTTP Range（206 + `content-range`，越界 416） |
| `POST` | `/api/recordings/:id/export` | 默认复制音频到 `import_dir`，可用请求体字段 `directory` 覆盖目标目录 |
| `POST` | `/api/recordings/:id/transcribe` | 单条转录 |
| `POST` | `/api/recordings/:id/organize` | 单条 AI 归类 |
| `POST` | `/api/recordings/batch/transcribe`, `/api/recordings/batch/organize` | 批量转录 / 批量归类 |
| `GET` | `/api/ingest/directory` | 读取导入目录信息 |
| `POST` | `/api/ingest/directory/ensure` | 创建导入目录 |
| `POST` | `/api/ingest/scan` | 扫描导入目录 |
| `POST` | `/api/ingest/manifest` | 登记设备清单条目 |
| `GET` | `/api/device`, `/api/device/summary`, `/api/device/capabilities` | 设备记录、概览、SDK 指令参考库 |
| `POST` | `/api/device/check`, `/api/device/list`, `/api/device/download`, `/api/device/status` | 环境自检、读清单、BLE 拉取、状态 |
| `GET` | `/api/live` | 实时字幕状态 |
| `POST` | `/api/live/start`, `/api/live/stop` | 开始或停止实时字幕 |
| `GET`, `POST` | `/api/categories` | 列出或新增分类 |
| `PATCH`, `DELETE` | `/api/categories/:id` | 修改或删除分类 |
| `GET`, `PATCH` | `/api/settings` | 路径、转录与归类开关、热词与语言 |

JSON 响应统一为 `{ ok: true, data }` / `{ ok: false, error: { code, message } }` 信封。音频接口成功时返回音频流。

## 设计原则（节选）

- **不伪造成功**：BLE 通道未就绪、音频无法播放、ASR 上游失败，页面一律如实报告，并把失败态变成可继续的动作。
- **状态双编码**：一律「文字 + 颜色」，不只靠颜色区分；动画尊重 `prefers-reduced-motion`。
- **列表优先**：一条录音一行，正文最大宽度 1220 px，表格数字使用 `tabular-nums` 保持纵向对齐。
- **可访问**：仅图标按钮均带 `aria-label` 与 `title`，分段控件用 `aria-pressed`。

更多取舍见 [DESIGN.md](DESIGN.md)。

## 相关仓库

- [`floatboatai/memotalk-sdk`](https://github.com/floatboatai/memotalk-sdk)：MemoTalk S1 的 Python BLE 客户端与命令行工具

## 许可证

[MIT](LICENSE) © Floatboat and MemoTalk
