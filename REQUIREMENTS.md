# 录音笔工作台

MemoTalk S1 录音笔的录音资产管理中枢。把录音笔采集的 MP3 录音导入本地后，完成「转录 → AI 归类 → 检索复盘」的闭环。

业务主流程：
1) 接入：三种入口。a) 目录导入：扫描 `import_dir` 当前层的音频文件（MP3、WAV、M4A、AAC、OGG、FLAC、AMR、OPUS），复制到 `<library_dir>/<yyyy-MM>/` 并登记，保留来源文件；b) 设备清单：粘贴/录入设备 0x13 文件列表条目（文件名、格式、时间戳、大小、时长秒）登记为待导入；c) 设备拉取：调用用户本机配置的 Python 和从 PyPI 安装的 memotalk-sdk 执行 BLE 拉取，先下载到 Host 的 `audio/_incoming` 再复制进录音库月目录（需自检 Python、bleak 和 memotalk 包导入，缺失时如实报告未就绪，不得伪造成功）。
2) 转录：用 ffmpeg 把 MP3 解码为 16kHz 单声道 PCM16，通过 Host ASR 流式识别，落库完整文本与分段；记录字节数与耗时，失败保留可重试状态。
3) 归类：调用 Host LLM 结构化输出，生成标题、摘要、分类、标签、要点、待办事项、重要度，写回录音记录并支持用户手工修正。
4) 检索：列表支持全文搜索（转录文本+标题+摘要）、分类筛选、标签筛选、状态筛选、时间排序；详情页展示元数据、转录全文、AI 结论、操作历史。
5) 设备页：展示初始种子中的 24 条 BLE 指令参考库、环境自检结果、导入目录设置、连接状态与待拉取录音。没有 SDK 源码路径设置；Python 与 ffmpeg 路径在设置页编辑。
6) 实时字幕：从设备接收实时音频并识别，停止后有音频或文本时保存录音；音频写入录音库月目录，已有文本可按自动归类开关继续处理。
7) 设置：录音库/导入目录、Python/ffmpeg 路径，自动转录、自动归类、自动重连、自动拉取、说话人分离开关，1~120 分钟重连间隔（默认 3），热词与语言。开关默认启用。当前语言只写入文件转录结果元数据，未传给 ASR；实时识别不读取这些热词、语言与说话人设置。具体 API 与可写键见 README。

持久化对象：devices、recordings、transcripts、analyses、categories、tags、recording_tags、job_runs、sdk_commands、settings。全部使用正式 SQLite 迁移建表，分类与 SDK 指令做种子数据。

任务反馈以当前实现为准：
- 服务端将内存队列临时投影为 `queued_transcribe`（转录已排队）/ `queued_organize`（归类已排队），不落库；执行中的数据库状态优先。代码依据：`src/server/queue.ts:25`、`src/server/repo.ts:59`。
- 单条任务在前置校验通过后，对已排队/执行中录音返回 `BUSY`；批量任务跳过这些录音。代码依据：`src/server/routes/pipeline.ts:25`、`src/server/routes/pipeline.ts:46`、`src/server/routes/pipeline.ts:66`、`src/server/routes/pipeline.ts:84`。
- 列表接口返回全库任务信号 `hasActiveTasks`，录音库据此轮询；详情页依据当前录音的排队/执行中状态轮询。间隔均为 2600ms，详情退出忙碌状态、录音库全库任务结束后分别停止。代码依据：`src/server/repo.ts:150`、`src/ui/pages/Library.tsx:54`、`src/ui/pages/Detail.tsx:51`、`src/contracts/recording-status.ts:1`。

存储行为以当前实现为准：
- `import_dir` 默认 `~/memo/memotalk/inbox`，`library_dir` 默认 `~/memo/memotalk/raw`。目录使用绝对路径或 `~/...`。修改录音库设置不会移动已有文件；新版 `storage_path` 保存完整目标路径（默认或绝对路径配置下为绝对路径），历史相对文件名仍从 Host 的 `audio` 资源读取。
- 导出只复制音频，默认写入 `import_dir`；API 请求体可用 `directory` 指定其他目录，详情页不指定。目标目录缺失时创建，同名文件可能被覆盖。
- 删除先尝试把音频移到当前 `<library_dir>/_trash/<毫秒时间戳>-<原存储文件名>`，随后删除相关业务记录；文件移动失败也会删除记录。没有恢复 API。
