# MemoTalk Workbench · 录音笔工作台

> 把 MemoTalk S1 录音笔里堆着的 MP3，变成可搜索、可分类、可复盘的文本资产。

`memotalk-workbench` 是 [Floatboat](https://floatboat.ai) 工作台应用的一份完整开源实现，配套硬件客户端 [`memotalk-sdk`](https://github.com/floatboatai/memotalk-sdk) 使用。

An open-source **Floatboat Workbench** app that turns MemoTalk S1 voice-recorder MP3s into searchable, AI-classified text assets: import → transcribe → classify → review.

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
| 详情播放 | HTTP Range 分段播放、按句时标跳转、AI 结论与执行记录三分区 |
| 分类管理 | 新增、就地改名、改色、删除 |
| 设备接入页 | 环境自检（python / `bleak` / SDK / ffmpeg）、路径设置、SDK 指令参考库、手动登记 |

## 快速上手

本应用运行在 **Floatboat 桌面端的工作台运行时**中 —— 它不是独立的 Node 服务，而是一个由 Host 装载的工作台包：

- Host 负责依赖准备、strict TypeScript 检查、server 编译与 UI 打包（产物落在 `dist/`，不入库）；
- SQLite 迁移由 Host 在打开工作台时应用（`migrations/` 只追加，不回改）；
- ASR 与 LLM 通过 Host 能力调用，本仓库不包含、也不需要任何模型密钥。

```bash
pnpm install          # 仅安装 UI 依赖（react / react-dom / lucide-react）
```

之后由 Floatboat 执行 `check_workbench_project` 完成类型检查与构建，`workbench_runtime open` 应用更新。

### 运行时依赖

| 依赖 | 用途 | 缺失时行为 |
| --- | --- | --- |
| `ffmpeg` | 音频探测与解码 | 转录不可用，页面如实提示 |
| `python` + `bleak` + `memotalk-sdk` | BLE 拉取设备录音 | 设备页报告「未就绪」，目录导入路径仍可用 |

工具路径按「设置值 → Floatboat 内置工具 → `PATH` → 命令名」逐级探测，不依赖进程 `PATH`。

## 目录结构

```
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
    bridge.ts      memotalk-sdk 命令行桥接（固定参数，不接受拼接命令）
  ui/              React 界面：概览 / 录音库 / 详情 / 设备 / 分类 / 实时 / 设置
migrations/        只追加的 SQLite 迁移
sdk/               @floatboat/workbench-sdk 契约与类型（Host 提供）
tests/             服务端测试
```

配套文档：[`REQUIREMENTS.md`](REQUIREMENTS.md) · [`ENGINEERING.md`](ENGINEERING.md) · [`DESIGN.md`](DESIGN.md)

## 数据模型

`devices`、`recordings`、`transcripts`、`analyses`、`categories`、`tags`、`recording_tags`、`job_runs`、`sdk_commands`、`settings`。

音频文件存放在 `audio` 数据资源目录，业务库只保存相对文件名；删除录音时文件移入 `audio/_trash` 而不是物理销毁。

## API 速览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/recordings` | 列表：搜索 / 阶段 / 分类 / 标签 / 排序 / 分页 |
| `GET` | `/api/recordings/:id` | 详情（元数据 + 转录 + AI 结论 + 执行记录） |
| `PATCH` | `/api/recordings/:id` | 人工修正标题、分类、标签、重要度 |
| `DELETE` | `/api/recordings/:id` | 删除（文件移入 `audio/_trash`） |
| `GET` | `/api/recordings/:id/audio` | 音频流，HTTP Range（206 + `content-range`，越界 416） |
| `POST` | `/api/recordings/:id/export` | 导出到本机目录 |
| `POST` | `/api/recordings/:id/transcribe` | 单条转录 |
| `POST` | `/api/recordings/:id/organize` | 单条 AI 归类 |
| `POST` | `/api/recordings/batch/transcribe` · `/batch/organize` | 批量转录 / 批量归类 |
| `GET`·`POST` | `/api/ingest/directory` · `/directory/ensure` | 导入目录读取与创建 |
| `POST` | `/api/ingest/scan` | 扫描导入目录 |
| `POST` | `/api/ingest/manifest` | 登记设备清单条目 |
| `GET` | `/api/device` · `/summary` · `/capabilities` | 设备记录、概览、SDK 指令参考库 |
| `POST` | `/api/device/check` · `/list` · `/download` · `/status` | 环境自检、读清单、BLE 拉取、状态 |
| `GET`·`POST` | `/api/live` · `/live/start` · `/live/stop` | 实时字幕 |
| `GET`·`POST` | `/api/categories`；`PATCH`·`DELETE` `/api/categories/:id` | 分类管理 |
| `GET`·`PATCH` | `/api/settings` | 路径、转录与归类开关、热词与语言 |

响应统一为 `{ ok: true, data }` / `{ ok: false, error: { code, message } }` 信封。

## 设计原则（节选）

- **不伪造成功**：BLE 通道未就绪、音频无法播放、ASR 上游失败，页面一律如实报告，并把失败态变成可继续的动作。
- **状态双编码**：一律「文字 + 颜色」，不只靠颜色区分；动画尊重 `prefers-reduced-motion`。
- **列表优先**：一条录音一行，正文最大宽度 1220 px，表格数字使用 tabular-nums 保持纵向对齐。
- **可访问**：仅图标按钮均带 `aria-label` 与 title，分段控件用 `aria-pressed`。

更多取舍见 [`DESIGN.md`](DESIGN.md)。

## 相关仓库

- [`floatboatai/memotalk-sdk`](https://github.com/floatboatai/memotalk-sdk) — MemoTalk S1 的 Python BLE 客户端与命令行工具

## License

[MIT](LICENSE) © Floatboat and MemoTalk
