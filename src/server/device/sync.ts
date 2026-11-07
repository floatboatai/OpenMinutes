// ABOUTME: 同步编排：读清单 → 登记 → 规划传输 → 网络闸门 → 拉取 → 大小校验 → 挂接 → 自动转录；以及清理已同步的录音。

import { statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { DeviceActivity, DeviceCallRecord, DeviceOrigin, ParsedDeviceFile, Transport, TransportSetting } from '../../contracts/device';
import { AppError, errorView, type AppErrorView } from '../../contracts/errors';
import { attachDownloadedFile, registerDeviceManifest, sanitizeFilename } from '../ingest';
import { resolveStoredPath } from '../library';
import type { NetworkGate } from '../network-gate';
import { containsPath } from '../paths';
import { num, row, rows, str, strOr } from '../sql';
import { classifyDeviceError } from './errors';
import { planTransfer, type TransferPlan } from './transport';
import type { RequestOptions, WorkerCommand, WorkerEvent } from './worker';

export interface WorkerStatus {
  serial: string;
  model: string;
  firmware: string | null;
  batteryPct: number | null;
  freeSpacePct: number | null;
  recordingState: string | null;
  storageFormat: string | null;
}

interface PulledFile {
  name: string;
  ok: boolean;
  path?: string;
  sizeBytes?: number;
  transport?: Transport;
  error?: { kind: string; message: string };
}

/** 设备服务交给编排层的最小能力面，测试可以直接实现它。 */
export interface SyncRuntime {
  db: DatabaseSync;
  origin: DeviceOrigin;
  activity: DeviceActivity;
  gate: NetworkGate;
  platform: string;
  isConnected(): boolean;
  ensureConnected(): Promise<void>;
  request<T>(cmd: WorkerCommand, args?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  refreshStatus(): Promise<WorkerStatus>;
  serial(): string | null;
  setListing(files: ParsedDeviceFile[]): void;
  incomingRoot(): Promise<string>;
  libraryRoot(): string;
  ffmpeg(): Promise<string>;
  afterImport(ids: number[]): number;
  transportSetting(): TransportSetting;
  allowBackgroundWifi(): boolean;
  wifiCapable(): Promise<boolean>;
  isCancelled(): boolean;
  /** 用户停止或断开时触发；用于中止等网之类不经过 worker 的等待。 */
  signal?: AbortSignal;
  /** 协作式取消当前 worker 请求。 */
  cancelWorker?(): void;
  /** 宽限期过后仍不返回时强制结束 worker。 */
  killWorker?(): void;
  /** 取消后等待 worker 自行收尾的时长；热点阶段要给足恢复网络的时间。 */
  cancelGraceMs?(): number;
  /** 拉取多久没有任何事件就算卡住。 */
  pullStallMs?: number;
  /** 实测蓝牙吞吐，用于后台同步的时长预算。 */
  bleBps?(): number | null;
  log(record: Omit<DeviceCallRecord, 'at'>): void;
  measured(transport: Transport, bytesPerSecond: number): void;
}

export interface SyncOutcome {
  done: number;
  failed: number;
  deferred: number;
  transport: Transport | null;
  fallback: AppErrorView | null;
  error: AppErrorView | null;
  cancelled: boolean;
  ids: number[];
  queued: number;
}

export const RECORDING_STATES = new Set(['RECORDING', 'PAUSED', 'RESUMED']);
const NETWORK_WAIT_MS = 180_000;

interface PendingRecord {
  id: number;
  filename: string;
  sizeBytes: number | null;
}

/** 只取当前录音笔、还没有音频文件的待同步记录。 */
export function pendingRecords(db: DatabaseSync, serial: string, ids?: number[]): PendingRecord[] {
  const base = `SELECT id, filename, size_bytes FROM recordings
     WHERE status = 'pending' AND (storage_path IS NULL OR storage_path = '') AND device_serial = ?`;
  const list = ids && ids.length > 0
    ? rows(db, `${base} AND id IN (${ids.map(() => '?').join(',')}) ORDER BY COALESCE(recorded_at, created_at) DESC`, [serial, ...ids])
    : rows(db, `${base} ORDER BY COALESCE(recorded_at, created_at) DESC`, [serial]);
  return list.map((item) => ({ id: num(item.id) ?? 0, filename: strOr(item.filename, ''), sizeBytes: num(item.size_bytes) }))
    .filter((item) => item.filename);
}

/** 带大小的传输时长预算：慢速蓝牙按 3 KB/s 估算，再加两分钟余量。仅作为卡死检测之外的总上限参考。 */
export function pullTimeoutMs(totalBytes: number): number {
  return Math.min(2 * 3600_000, 120_000 + Math.round(totalBytes / 3));
}

/** 连续这么久没有任何进度事件才算卡住；热点入网、FTP 连接都在这个窗口内会上报。 */
export const PULL_STALL_MS = 180_000;
/** worker 请求自身不再计时：卡死由进度看门狗判断，并先协作取消再强制结束。 */
const NO_REQUEST_TIMEOUT = 2_147_483_647;

function applyProgress(activity: DeviceActivity, data: Record<string, unknown>): void {
  const phase = String(data.phase ?? '');
  if (phase === 'preparing' || phase === 'transferring' || phase === 'restoring') activity.phase = phase;
  if (data.transport === 'wifi' || data.transport === 'ble') activity.transport = data.transport;
  activity.file = typeof data.file === 'string' ? data.file : activity.file;
  if (typeof data.index === 'number') activity.index = data.index;
  if (typeof data.count === 'number') activity.count = data.count;
  if (typeof data.bytes === 'number') activity.bytesDone = data.bytes;
  activity.bytesTotal = typeof data.total === 'number' ? data.total : activity.bytesTotal;
}

/** 下载结果必须落在本任务目录内，并与设备上报的大小一致才挂接。 */
function verifiedPath(outDir: string, file: PulledFile, expected: number | null): { path: string } | { error: AppError } {
  if (!file.path || !path.isAbsolute(file.path) || !containsPath(outDir, path.resolve(file.path), process.platform)) {
    return { error: new AppError('TRANSFER_FAILED', undefined, `unexpected path from worker: ${file.path ?? '(none)'}`) };
  }
  let size: number;
  try {
    size = statSync(file.path).size;
  } catch (error) {
    return { error: new AppError('TRANSFER_FAILED', undefined, `downloaded file missing: ${String(error)}`) };
  }
  if (expected !== null && expected > 0 && size !== expected) {
    return { error: new AppError('TRANSFER_FAILED', undefined, `${file.name}: ${size} bytes on disk, device reported ${expected}`) };
  }
  return { path: file.path };
}

async function listDevice(rt: SyncRuntime): Promise<ParsedDeviceFile[]> {
  rt.activity.phase = 'listing';
  const listed = await rt.request<{ files: ParsedDeviceFile[] }>('list', {}, { timeoutMs: 60_000 });
  rt.setListing(listed.files);
  return listed.files;
}

/**
 * 用户来源会先连接；后台来源未连接时直接返回。
 * 传 ids 时只同步这些记录（单条同步），否则读清单并登记新录音后同步全部。
 */
export async function runSync(rt: SyncRuntime, options: { ids?: number[] } = {}): Promise<SyncOutcome> {
  const outcome: SyncOutcome = {
    done: 0, failed: 0, deferred: 0, transport: null, fallback: null, error: null, cancelled: false, ids: [], queued: 0,
  };
  if (!rt.isConnected()) {
    if (rt.origin === 'auto') return outcome;
    rt.activity.phase = 'connecting';
    await rt.ensureConnected();
  }

  const status = await rt.refreshStatus();
  if (status.recordingState && RECORDING_STATES.has(status.recordingState)) {
    throw new AppError('DEVICE_RECORDING', undefined, `recordingState=${status.recordingState}`);
  }
  const serial = status.serial || rt.serial();
  if (!serial) throw new AppError('DEVICE_ERROR', undefined, 'device did not report a serial number');

  const listing = await listDevice(rt);
  if (!options.ids) registerDeviceManifest(rt.db, serial, listing);
  const byName = new Map(listing.map((file) => [sanitizeFilename(file.name), file]));

  const records = pendingRecords(rt.db, serial, options.ids);
  const present = records.filter((record) => byName.has(record.filename));
  for (const missing of records.filter((record) => !byName.has(record.filename))) {
    outcome.failed += 1;
    rt.log({ op: 'pull', origin: rt.origin, ok: false, code: 'FILE_NOT_ON_DEVICE', transport: null, bytes: null, durationMs: 0,
      detail: `${missing.filename} is not in the device listing` });
  }
  if (present.length === 0) {
    rt.activity.phase = 'finishing';
    return outcome;
  }

  const files = present.map((record) => {
    const device = byName.get(record.filename);
    return { record, name: device?.name ?? record.filename, sizeBytes: device?.sizeBytes ?? record.sizeBytes };
  });
  const plan: TransferPlan = planTransfer({
    setting: rt.transportSetting(),
    origin: rt.origin,
    allowBackgroundWifi: rt.allowBackgroundWifi(),
    files: files.map((file) => ({ name: file.name, sizeBytes: file.sizeBytes })),
    wifiCapable: await rt.wifiCapable(),
    platform: rt.platform,
    bleBps: rt.bleBps?.() ?? null,
  });
  outcome.deferred = plan.deferred.length;
  const included = files.filter((file) => plan.include.includes(file.name));
  if (included.length === 0) {
    rt.activity.phase = 'finishing';
    return outcome;
  }

  let transport: Transport = plan.transport;
  let release: (() => void) | null = null;
  if (transport === 'wifi') {
    rt.activity.phase = 'waiting-network';
    rt.activity.transport = 'wifi';
    release = await rt.gate.acquireOffline('device-hotspot', { waitForInFlightMs: NETWORK_WAIT_MS, signal: rt.signal });
    if (rt.isCancelled()) {
      release?.();
      rt.activity.offline = false;
      outcome.cancelled = true;
      return outcome;
    }
    if (!release) {
      transport = 'ble';
      outcome.fallback = errorView('WIFI_FALLBACK', 'NETWORK_IN_USE: transcription tasks did not finish within 180s');
      rt.activity.fallback = outcome.fallback;
    } else {
      rt.activity.offline = true;
    }
  }
  if (rt.isCancelled()) {
    release?.();
    rt.activity.offline = false;
    outcome.cancelled = true;
    return outcome;
  }
  const releaseGate = () => {
    release?.();
    release = null;
    rt.activity.offline = false;
  };

  rt.activity.transport = transport;
  rt.activity.count = included.length;
  rt.activity.index = 0;
  const jobDir = path.join(await rt.incomingRoot(), rt.activity.jobId);
  await mkdir(jobDir, { recursive: true });
  const started = Date.now();
  let lastEventAt = Date.now();
  const onEvent = (event: WorkerEvent) => {
    lastEventAt = Date.now();
    if (event.event === 'progress') {
      applyProgress(rt.activity, event.data);
      if (rt.activity.transport === 'ble') releaseGate();
    } else if (event.event === 'fallback') {
      releaseGate();
      const detail = `${String(event.data.reason ?? 'WIFI_TRANSFER_FAILED')}\n${String(event.data.detail ?? '')}`.trim();
      outcome.fallback = errorView('WIFI_FALLBACK', detail);
      rt.activity.fallback = outcome.fallback;
      rt.activity.transport = 'ble';
      rt.log({ op: 'pull', origin: rt.origin, ok: false, code: String(event.data.reason ?? 'WIFI_FALLBACK'), transport: 'wifi',
        bytes: null, durationMs: Date.now() - started, detail });
    } else if (event.event === 'warning') {
      rt.log({ op: 'pull', origin: rt.origin, ok: false, code: String(event.data.code ?? 'WARNING'), transport: 'wifi',
        bytes: null, durationMs: 0, detail: String(event.data.detail ?? '') });
    }
  };

  // 卡死看门狗：长时间没有事件时先协作取消，等 worker 自己恢复网络并返回；宽限期过后才强制结束。
  const stallMs = rt.pullStallMs ?? PULL_STALL_MS;
  let stalled: AppError | null = null;
  let killTimer: NodeJS.Timeout | null = null;
  const watchdog = setInterval(() => {
    if (stalled || Date.now() - lastEventAt < stallMs) return;
    stalled = new AppError('DEVICE_TIMEOUT', undefined,
      `pull made no progress for ${Math.round((Date.now() - lastEventAt) / 1000)}s (phase=${rt.activity.phase}, transport=${rt.activity.transport ?? '-'})`);
    rt.log({ op: 'pull', origin: rt.origin, ok: false, code: 'DEVICE_TIMEOUT', transport: rt.activity.transport, bytes: null,
      durationMs: Date.now() - started, detail: stalled.detail ?? '' });
    rt.cancelWorker?.();
    killTimer = setTimeout(() => rt.killWorker?.(), rt.cancelGraceMs?.() ?? 15_000);
    killTimer.unref?.();
  }, Math.max(10, Math.min(5_000, Math.floor(stallMs / 4))));
  watchdog.unref?.();
  const stopWatchdog = () => {
    clearInterval(watchdog);
    if (killTimer) clearTimeout(killTimer);
  };

  let pulled: { files: PulledFile[]; cancelled: boolean };
  try {
    pulled = await rt.request<{ files: PulledFile[]; cancelled: boolean }>('pull', {
      files: included.map((file) => ({ name: file.name, size: file.sizeBytes })),
      outDir: jobDir,
      transport,
    }, { timeoutMs: NO_REQUEST_TIMEOUT, onEvent });
  } catch (error) {
    stopWatchdog();
    releaseGate();
    await removeJobDir(rt, jobDir);
    throw stalled ?? error;
  }
  stopWatchdog();
  releaseGate();

  rt.activity.phase = 'finishing';
  // 卡住后 worker 自行停下：已经落盘的文件照常挂接，没有返回的算失败，并给出超时原因。
  outcome.cancelled = pulled.cancelled && !stalled;
  if (stalled) {
    const returned = new Set(pulled.files.map((file) => file.name));
    const missing = included.filter((file) => !returned.has(file.name)).length;
    if (missing > 0) {
      outcome.failed += missing;
      outcome.error = (stalled as AppError).toView();
    }
  }
  const ffmpeg = await rt.ffmpeg();
  const bytesBy: Record<Transport, number> = { wifi: 0, ble: 0 };
  for (const file of pulled.files) {
    const entry = included.find((item) => item.name === file.name);
    if (!entry) continue;
    if (!file.ok) {
      outcome.failed += 1;
      const failure = classifyDeviceError(file.error?.kind ?? 'Error', file.error?.message ?? '', 'pull');
      outcome.error = outcome.error ?? failure.toView();
      continue;
    }
    const checked = verifiedPath(jobDir, file, entry.sizeBytes);
    if ('error' in checked) {
      outcome.failed += 1;
      outcome.error = outcome.error ?? checked.error.toView();
      rt.log({ op: 'pull', origin: rt.origin, ok: false, code: checked.error.code, transport: file.transport ?? transport,
        bytes: file.sizeBytes ?? null, durationMs: 0, detail: checked.error.detail ?? '' });
      continue;
    }
    const attached = await attachDownloadedFile(rt.db, rt.libraryRoot(), ffmpeg, checked.path, entry.record.filename, serial);
    if (attached.ok && attached.id) {
      outcome.done += 1;
      outcome.ids.push(attached.id);
      bytesBy[file.transport ?? transport] += file.sizeBytes ?? 0;
    } else {
      outcome.failed += 1;
    }
  }
  const durationMs = Math.max(1, Date.now() - started);
  const usedWifi = bytesBy.wifi > 0;
  outcome.transport = usedWifi ? 'wifi' : (bytesBy.ble > 0 ? 'ble' : transport);
  for (const kind of ['wifi', 'ble'] as const) {
    if (bytesBy[kind] > 0 && (bytesBy.wifi === 0 || bytesBy.ble === 0)) rt.measured(kind, Math.round(bytesBy[kind] * 1000 / durationMs));
  }
  const totalDone = bytesBy.wifi + bytesBy.ble;
  rt.log({
    op: 'pull', origin: rt.origin, ok: outcome.failed === 0, code: outcome.error?.code ?? null, transport: outcome.transport,
    bytes: totalDone, durationMs,
    detail: `${outcome.done} ok, ${outcome.failed} failed, ${outcome.deferred} deferred; ${transportLabel(outcome.transport)} ${Math.round(totalDone * 1000 / durationMs)} B/s${outcome.cancelled ? '; cancelled' : ''}`,
  });

  outcome.queued = rt.afterImport(outcome.ids);
  await removeJobDir(rt, jobDir);
  await rt.refreshStatus().catch(() => undefined);
  return outcome;
}

function transportLabel(transport: Transport | null): string {
  return transport === 'wifi' ? '无线快传' : transport === 'ble' ? '蓝牙' : '-';
}

async function removeJobDir(rt: SyncRuntime, jobDir: string): Promise<void> {
  const root = await rt.incomingRoot();
  const resolved = path.resolve(jobDir);
  if (!path.isAbsolute(resolved) || resolved === path.resolve(root) || !containsPath(root, resolved, process.platform)) return;
  await rm(resolved, { recursive: true, force: true }).catch(() => undefined);
}

/** 只删库中存在、属于当前录音笔、本地文件仍在且大小与设备一致的录音。 */
export function cleanupCandidates(db: DatabaseSync, serial: string, listing: ParsedDeviceFile[], libraryDir: string): ParsedDeviceFile[] {
  const out: ParsedDeviceFile[] = [];
  for (const file of listing) {
    if (!file.sizeBytes) continue;
    const found = row(db,
      `SELECT storage_path FROM recordings
        WHERE device_serial = ? AND filename = ? AND storage_path IS NOT NULL AND storage_path <> ''
        ORDER BY id DESC LIMIT 1`,
      [serial, sanitizeFilename(file.name)]);
    const stored = resolveStoredPath(found ? str(found.storage_path) : null, libraryDir);
    if (!stored) continue;
    try {
      if (statSync(stored).size === file.sizeBytes) out.push(file);
    } catch {
      /* 本地文件已不在：不删设备上的副本 */
    }
  }
  return out;
}

export interface CleanupOutcome {
  done: number;
  failed: number;
  deferred: number;
  transport: Transport | null;
  fallback: AppErrorView | null;
  error: AppErrorView | null;
  cancelled: boolean;
  bytes: number;
}

export async function runCleanup(rt: SyncRuntime): Promise<CleanupOutcome> {
  if (!rt.isConnected()) throw new AppError('DEVICE_DISCONNECTED');
  const status = await rt.refreshStatus();
  const serial = status.serial || rt.serial();
  if (!serial) throw new AppError('DEVICE_ERROR', undefined, 'device did not report a serial number');
  const listing = await listDevice(rt);
  const candidates = cleanupCandidates(rt.db, serial, listing, rt.libraryRoot());
  const outcome: CleanupOutcome = { done: 0, failed: 0, deferred: 0, transport: null, fallback: null, error: null, cancelled: false, bytes: 0 };
  if (candidates.length === 0) return outcome;
  rt.activity.phase = 'deleting';
  rt.activity.count = candidates.length;
  const started = Date.now();
  const result = await rt.request<{ files: Array<{ name: string; ok: boolean; error?: { kind: string; message: string } }> }>(
    'delete', { names: candidates.map((file) => file.name) }, { timeoutMs: 30_000 + candidates.length * 5_000 });
  const deleted = new Set<string>();
  for (const file of result.files) {
    if (file.ok) {
      outcome.done += 1;
      deleted.add(file.name);
      outcome.bytes += candidates.find((item) => item.name === file.name)?.sizeBytes ?? 0;
    } else {
      outcome.failed += 1;
      outcome.error = outcome.error ?? classifyDeviceError(file.error?.kind ?? 'DeleteFailed', file.error?.message ?? '', 'delete').toView();
    }
  }
  rt.setListing(listing.filter((file) => !deleted.has(file.name)));
  rt.log({ op: 'delete', origin: rt.origin, ok: outcome.failed === 0, code: outcome.error?.code ?? null, transport: 'ble',
    bytes: outcome.bytes, durationMs: Date.now() - started,
    detail: `deleted ${[...deleted].join(', ') || '-'}${outcome.failed ? `; ${outcome.failed} failed` : ''}` });
  await rt.refreshStatus().catch(() => undefined);
  return outcome;
}
