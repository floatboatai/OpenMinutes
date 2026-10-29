// ABOUTME: 页面与服务端共用的录音业务契约；页面只依赖本文件的类型。

export type RecordingStatus =
  | 'pending'
  | 'ready'
  | 'queued_transcribe'
  | 'queued_organize'
  | 'transcribing'
  | 'transcribed'
  | 'analyzing'
  | 'organized'
  | 'failed';

export type RecordingSource = 'folder_import' | 'device_manifest' | 'device_pull' | 'manual' | 'live_caption';

export interface AppInfo {
  name: string;
  version: string;
}

export interface Category {
  id: number;
  slug: string;
  name: string;
  color: string;
  icon: string;
  description: string | null;
  sortOrder: number;
  isSystem: boolean;
  recordingCount: number;
}

export interface TagRef {
  id: number;
  name: string;
}

export interface RecordingSummary {
  id: number;
  filename: string;
  title: string | null;
  source: RecordingSource;
  status: RecordingStatus;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  durationSec: number | null;
  sizeBytes: number | null;
  recordedAt: string | null;
  createdAt: string;
  importance: number | null;
  summary: string | null;
  isFavorite: boolean;
  isArchived: boolean;
  transcriptChars: number;
  hasAudioFile: boolean;
  deviceSerial: string | null;
  tags: TagRef[];
}

export interface TranscriptRecord {
  id: number;
  engine: string;
  language: string | null;
  text: string;
  charCount: number;
  audioMs: number | null;
  createdAt: string;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
}

export interface AnalysisRecord {
  id: number;
  model: string | null;
  title: string | null;
  summary: string | null;
  categorySlug: string | null;
  keyPoints: string[];
  actionItems: string[];
  tags: string[];
  importance: number | null;
  sentiment: string | null;
  createdAt: string;
}

export interface JobRun {
  id: number;
  kind: string;
  status: string;
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface RecordingDetail {
  recording: RecordingSummary;
  transcript: TranscriptRecord | null;
  segments: TranscriptSegment[];
  analysis: AnalysisRecord | null;
  jobs: JobRun[];
  lastError: string | null;
  storagePath: string | null;
}

export interface RecordingListResult {
  items: RecordingSummary[];
  total: number;
  /** 全库任务状态，不受当前筛选和分页影响。 */
  hasActiveTasks: boolean;
}

export interface LiveState {
  active: boolean;
  status: 'idle' | 'starting' | 'listening' | 'error';
  message: string | null;
  startedAt: string | null;
  elapsedMs: number;
  pcmBytes: number;
  audioBytes: number;
  finals: string[];
  partial: string;
  deviceName: string | null;
  lastSaved: { recordingId: number; filePath: string; chars: number } | null;
}

export interface DeviceHero {
  serial: string;
  model: string;
  firmware: string | null;
  batteryPct: number | null;
  freeSpacePct: number | null;
  lastSeenAt: string | null;
  connected: boolean;
  pendingPulls: number;
  readyToTranscribe: number;
}

export interface Overview {
  totalRecordings: number;
  totalDurationSec: number;
  transcribedCount: number;
  organizedCount: number;
  pendingCount: number;
  failedCount: number;
  favoriteCount: number;
  unreviewedToday: number;
  byCategory: Array<{ id: number; name: string; color: string; count: number; durationSec: number }>;
  byStatus: Array<{ status: RecordingStatus; count: number }>;
  recent: RecordingSummary[];
  device: DeviceHero | null;
}

export interface SettingEntry {
  key: string;
  value: string;
}

export interface EnvProbe {
  ok: boolean;
  detail: string;
  resolvedPath: string | null;
}

export interface DeviceEnv {
  python: EnvProbe;
  ffmpeg: EnvProbe;
  bleak: EnvProbe;
  sdk: EnvProbe;
  checkedAt: string;
}

export interface SdkCommand {
  cmdCode: string;
  name: string;
  direction: 'read' | 'write' | 'notify';
  channel: string;
  requestHex: string;
  responseRule: string;
  caution: boolean;
}

export interface CapabilityState {
  domain: string;
  ok: boolean;
  detail: string;
}

export interface DeviceState {
  env: DeviceEnv;
  commands: SdkCommand[];
  capabilities: CapabilityState[];
  devices: Array<{
    id: number;
    serial: string;
    model: string;
    firmware: string | null;
    batteryPct: number | null;
    freeSpacePct: number | null;
    lastSeenAt: string | null;
  }>;
  settings: SettingEntry[];
}

export interface DeviceStatus {
  serial: string | null;
  mac: string | null;
  firmware: string | null;
  batteryPct: number | null;
  freeSpacePct: number | null;
  storageFormat: string | null;
  recordingState: string | null;
  hotspotSsid: string | null;
}

export interface BridgeRunResult {
  ok: boolean;
  action: string;
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  parsedFiles: ParsedDeviceFile[];
  parsedStatus: DeviceStatus | null;
  message: string;
}

export interface ParsedDeviceFile {
  name: string;
  format: string;
  sizeBytes: number | null;
  durationSec: number | null;
  timestamp: number | null;
}

export interface ImportDirectoryState {
  /** 实际生效的目录：未配置时是默认收件目录 */
  directory: string;
  exists: boolean;
  /** 目录里可直接导入的音频文件数 */
  audioFiles: number;
  /** 是否正在使用默认收件目录 */
  isDefault: boolean;
  /** 之前保存的目录已失效（例如落在系统临时目录里），这里是原值 */
  resetFrom: string | null;
  /** 目录里前几个音频文件名，供空态提示展示 */
  sample: string[];
  /** 本次调用是否新建了目录（仅 directory/ensure 返回） */
  created?: boolean;
}

export interface IngestScanResult {
  imported: number;
  skipped: number;
  failed: number;
  ids: number[];
  files: Array<{ filename: string; outcome: 'imported' | 'skipped' | 'failed'; reason?: string }>;
  /** 实际扫描的目录 */
  directory: string;
  /** 扫描前目录不存在，已自动创建 */
  created: boolean;
}

export interface BatchResult {
  accepted: number;
  skipped: number;
  ids: number[];
}
