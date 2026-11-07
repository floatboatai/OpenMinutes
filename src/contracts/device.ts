// ABOUTME: 录音笔设备服务契约：连接状态、同步活动、诊断记录，页面与服务端共用。

import type { AppErrorView } from './errors';
import type { PreflightReport } from './preflight';
import type { SdkCommand } from './app';

export type DeviceConnectionState = 'disconnected' | 'connecting' | 'connected' | 'busy' | 'live';
export type Transport = 'wifi' | 'ble';
export type TransportSetting = 'auto' | 'wifi' | 'ble';
export type DisconnectReason = 'user' | 'idle' | 'auto-done' | 'device_sleep' | 'lost' | 'live';
export type DeviceOrigin = 'user' | 'auto';
export type DeviceActivityKind = 'sync' | 'pull' | 'cleanup';
export type DeviceActivityPhase =
  | 'connecting'
  | 'listing'
  | 'waiting-network'
  | 'preparing'
  | 'transferring'
  | 'restoring'
  | 'finishing'
  | 'deleting';

/** 设备 0x13 清单里的一条文件。 */
export interface ParsedDeviceFile {
  name: string;
  format: string;
  sizeBytes: number | null;
  durationSec: number | null;
  timestamp: number | null;
}

export interface DeviceInfo {
  serial: string;
  model: string;
  firmware: string | null;
  batteryPct: number | null;
  freeSpacePct: number | null;
  lastSeenAt: string | null;
}

export interface DeviceActivity {
  jobId: string;
  kind: DeviceActivityKind;
  phase: DeviceActivityPhase;
  transport: Transport | null;
  file: string | null;
  index: number;
  count: number;
  bytesDone: number;
  bytesTotal: number | null;
  startedAt: string;
  offline: boolean;
  fallback: AppErrorView | null;
  cancelling: boolean;
}

export interface DeviceRecordingOnDevice {
  id: number;
  filename: string;
  sizeBytes: number | null;
  durationSec: number | null;
  recordedAt: string | null;
}

export interface DeviceLastResult {
  jobId: string;
  kind: DeviceActivityKind;
  origin: DeviceOrigin;
  done: number;
  failed: number;
  deferred: number;
  transport: Transport | null;
  fallback: AppErrorView | null;
  error: AppErrorView | null;
  cancelled: boolean;
  finishedAt: string;
}

export interface DeviceView {
  connection: {
    state: DeviceConnectionState;
    origin: DeviceOrigin | null;
    userDisconnected: boolean;
    disconnectReason: DisconnectReason | null;
    since: string | null;
    idleDisconnectAt: string | null;
  };
  device: DeviceInfo | null;
  activity: DeviceActivity | null;
  lastResult: DeviceLastResult | null;
  onDevice: DeviceRecordingOnDevice[];
  /** 用于按钮下方的一行提示。 */
  syncPlan: { transport: Transport; willGoOffline: boolean } | null;
  /** 单条同步达到这个字节数时走无线快传、暂时断开外网；null 表示不会走无线快传。 */
  wifiFromBytes: number | null;
  /** 本次连接内列过清单后才有值。 */
  cleanable: { count: number; bytes: number } | null;
  autoConnect: {
    enabled: boolean;
    intervalMinutes: number;
    nextAttemptAt: string | null;
    lastRunAt: string | null;
    backgroundWifi: boolean;
    /** 「连上后自动同步」：用户点「连接」时会直接同步。 */
    syncOnConnect: boolean;
  };
  lastError: AppErrorView | null;
  environment: { failCount: number };
}

export type DeviceOp = 'connect' | 'status' | 'list' | 'pull' | 'delete' | 'disconnect' | 'cancel' | 'live';

export interface DeviceCallRecord {
  at: string;
  op: DeviceOp;
  origin: DeviceOrigin;
  ok: boolean;
  code: string | null;
  transport: Transport | null;
  bytes: number | null;
  durationMs: number;
  detail: string;
}

export interface HostCapability {
  operation: string;
  status: string;
  declared: boolean;
}

export interface HostCapabilities {
  asr: HostCapability[];
  llm: HostCapability[];
}

export interface DiagnosticsView {
  environment: PreflightReport;
  /** 最近 50 条，内存环形缓冲。 */
  deviceLog: DeviceCallRecord[];
  transport: {
    setting: TransportSetting;
    wifiCapable: boolean;
    platform: string;
    thresholdBytes: number;
    measured: { wifiBps: number | null; bleBps: number | null };
  };
  commands: SdkCommand[];
  capabilities: HostCapabilities;
}
