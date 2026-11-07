// ABOUTME: 设备服务：录音笔 SDK 的唯一所有者。连接状态机、单一互斥、同步/清理编排、空闲断开、实时字幕占用、诊断环形缓冲。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { WorkbenchServer } from '../../../sdk/runtime.mjs';
import type {
  DeviceActivity,
  DeviceActivityKind,
  DeviceCallRecord,
  DeviceConnectionState,
  DeviceInfo,
  DeviceLastResult,
  DeviceOrigin,
  DeviceRecordingOnDevice,
  DeviceView,
  DisconnectReason,
  ParsedDeviceFile,
  Transport,
  TransportSetting,
} from '../../contracts/device';
import { AppError, type AppErrorView } from '../../contracts/errors';
import { upsertDevice } from '../ingest';
import { autoTranscribeIfEnabled } from '../jobs';
import { libraryRoot } from '../library';
import { networkGate, type NetworkGate } from '../network-gate';
import { resolveFfmpeg } from '../runtime-probe';
import { nowIso, numOr, readSetting, rows, strOr, writeSetting } from '../sql';
import { classifyDeviceError } from './errors';
import { cleanupCandidates, pendingRecords, runCleanup, runSync, type CleanupOutcome, type SyncOutcome, type SyncRuntime, type WorkerStatus } from './sync';
import { cachedWifiCapable, parseTransportSetting, planTransfer, probeWifiCapable, WIFI_MIN_BATCH_BYTES } from './transport';
import { spawnDeviceWorker, type RequestOptions, type SpawnWorker, type WorkerCommand, type WorkerHandle } from './worker';

export const IDLE_DISCONNECT_MS = 10 * 60_000;
const HOTSPOT_CANCEL_WAIT_MS = 90_000;
const BLE_CANCEL_WAIT_MS = 15_000;
const MEASURED_KEYS = { wifi: 'device_wifi_bps', ble: 'device_ble_bps' } as const;

export interface DeviceServiceOptions {
  resolvePython: () => Promise<string | null>;
  spawnWorker?: SpawnWorker;
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  gate?: NetworkGate;
  idleDisconnectMs?: number;
  /** 拉取多久没有任何进度事件就算卡住（测试可调小）。 */
  pullStallMs?: number;
  logLimit?: number;
}

export interface LiveCaptureOptions {
  scriptPath: string;
  pythonCommand: string;
  env: NodeJS.ProcessEnv;
  scanTimeoutSec: number;
}

function newActivity(jobId: string, kind: DeviceActivityKind): DeviceActivity {
  return {
    jobId,
    kind,
    phase: 'connecting',
    transport: null,
    file: null,
    index: 0,
    count: 0,
    bytesDone: 0,
    bytesTotal: null,
    startedAt: new Date().toISOString(),
    offline: false,
    fallback: null,
    cancelling: false,
  };
}

export class DeviceService {
  private readonly app: WorkbenchServer;
  private readonly resolvePython: () => Promise<string | null>;
  private readonly platform: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly logLimit: number;
  private readonly idleDisconnectMs: number;
  private readonly pullStallMs: number | undefined;
  private readonly spawnWorker: SpawnWorker;
  private readonly gate: NetworkGate;

  private state: DeviceConnectionState = 'disconnected';
  private origin: DeviceOrigin | null = null;
  private disconnectReason: DisconnectReason | null = null;
  private stateSince = new Date();
  private worker: WorkerHandle | null = null;
  private connecting: Promise<void> | null = null;
  private activity: DeviceActivity | null = null;
  private activityDone: Promise<unknown> = Promise.resolve();
  private lastResult: DeviceLastResult | null = null;
  private lastError: AppErrorView | null = null;
  private status: WorkerStatus | null = null;
  private serial: string | null = null;
  private listing: ParsedDeviceFile[] | null = null;
  private cleanable: { count: number; bytes: number } | null = null;
  private readonly deviceLog: DeviceCallRecord[] = [];
  private resumeAfterLive = false;
  private liveHandle: { child: ChildProcessWithoutNullStreams; release: () => Promise<void> } | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private idleDeadline: number | null = null;
  private abort: AbortController | null = null;
  private nextAttemptAt = 0;
  /** 用户接管了正在进行的后台同步：结束后若有推迟的录音，再按用户规则同步一次。 */
  private followUpSync = false;

  constructor(app: WorkbenchServer, options: DeviceServiceOptions) {
    this.app = app;
    this.resolvePython = options.resolvePython;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.logLimit = options.logLimit ?? 50;
    this.idleDisconnectMs = options.idleDisconnectMs ?? IDLE_DISCONNECT_MS;
    this.pullStallMs = options.pullStallMs;
    this.spawnWorker = options.spawnWorker ?? spawnDeviceWorker;
    this.gate = options.gate ?? networkGate;
  }

  private get db() {
    return this.app.database;
  }

  // -- view ------------------------------------------------------------------
  view(): DeviceView {
    const intervalMinutes = Number(readSetting(this.db, 'auto_connect_minutes', '3')) || 3;
    const lastRun = readSetting(this.db, 'last_auto_connect_at');
    return {
      connection: {
        state: this.state,
        origin: this.origin,
        userDisconnected: readSetting(this.db, 'device_user_disconnected', '0') === '1',
        disconnectReason: this.disconnectReason,
        since: this.stateSince.toISOString(),
        idleDisconnectAt: this.state === 'connected' && this.origin === 'user' && this.idleDeadline !== null
          ? new Date(this.idleDeadline).toISOString()
          : null,
      },
      device: this.deviceInfo(),
      activity: this.activity ? { ...this.activity } : null,
      lastResult: this.lastResult,
      onDevice: this.listing ? this.onDevice() : [],
      syncPlan: this.planPreview(),
      wifiFromBytes: this.wifiFromBytes(),
      cleanable: this.cleanable,
      autoConnect: {
        enabled: readSetting(this.db, 'auto_connect', '1') === '1',
        intervalMinutes,
        nextAttemptAt: this.nextAttemptAt ? new Date(this.nextAttemptAt).toISOString() : null,
        lastRunAt: lastRun || null,
        backgroundWifi: readSetting(this.db, 'auto_pull_wifi', '0') === '1',
        syncOnConnect: this.autoPullOn(),
      },
      lastError: this.lastError,
      environment: { failCount: 0 },
    };
  }

  /** 自动连接调度器写入下次尝试时间；页面据此显示倒计时。 */
  setNextAttempt(at: number): void {
    this.nextAttemptAt = at;
  }

  private deviceInfo(): DeviceInfo | null {
    if (!this.status?.serial) return null;
    return {
      serial: this.status.serial,
      model: this.status.model || 'MemoTalk S1',
      firmware: this.status.firmware ?? null,
      batteryPct: this.status.batteryPct ?? null,
      freeSpacePct: this.status.freeSpacePct ?? null,
      lastSeenAt: nowIso(),
    };
  }

  private onDevice(): DeviceRecordingOnDevice[] {
    if (!this.listing || !this.serial) return [];
    const known = new Map(
      rows(this.db, `SELECT id, filename, size_bytes, duration_sec, recorded_at FROM recordings
        WHERE device_serial = ? AND status = 'pending' AND (storage_path IS NULL OR storage_path = '')`, [this.serial])
        .map((item) => [strOr(item.filename, ''), item]),
    );
    return this.listing
      .map((file) => {
        const record = known.get(file.name);
        if (!record) return null;
        return {
          id: numOr(record.id, 0),
          filename: file.name,
          sizeBytes: file.sizeBytes,
          durationSec: file.durationSec,
          recordedAt: record.recorded_at ? strOr(record.recorded_at, '') : null,
        };
      })
      .filter((item): item is DeviceRecordingOnDevice => item !== null);
  }

  /**
   * 按钮下方的一行提示：这批待同步录音会用哪种传输方式。
   * 未连接时按库里已知的待同步记录估算，「连接」前就能提示会不会暂时断开外网。
   */
  private planPreview(): { transport: Transport; willGoOffline: boolean } | null {
    if (this.state === 'busy' || this.activity || this.state === 'live' || this.state === 'connecting') return null;
    const serial = this.serial ?? readSetting(this.db, 'device_serial');
    const pending = this.listing
      ? this.onDevice().map((item) => ({ name: item.filename, sizeBytes: item.sizeBytes }))
      : serial
        ? pendingRecords(this.db, serial)
          // 只登记了清单、大小未知的记录不算：连上后会按录音笔里的实际大小决定。
          .filter((item) => item.sizeBytes !== null)
          .map((item) => ({ name: item.filename, sizeBytes: item.sizeBytes }))
        : [];
    if (pending.length === 0) return null;
    const plan = planTransfer({
      setting: this.transportSetting(),
      origin: 'user',
      allowBackgroundWifi: true,
      files: pending,
      wifiCapable: cachedWifiCapable() ?? true,
      platform: this.platform,
    });
    return { transport: plan.transport, willGoOffline: plan.transport === 'wifi' };
  }

  /** 单条同步达到这个大小就走无线快传（会暂时断开外网）；null 表示不会用无线快传。 */
  private wifiFromBytes(): number | null {
    const setting = this.transportSetting();
    const probe = planTransfer({
      setting,
      origin: 'user',
      allowBackgroundWifi: true,
      files: [{ name: 'probe', sizeBytes: WIFI_MIN_BATCH_BYTES }],
      wifiCapable: cachedWifiCapable() ?? true,
      platform: this.platform,
    });
    if (probe.transport !== 'wifi') return null;
    return setting === 'wifi' ? 0 : WIFI_MIN_BATCH_BYTES;
  }

  transportSetting(): TransportSetting {
    return parseTransportSetting(readSetting(this.db, 'device_transport', 'auto'));
  }

  private allowBackgroundWifi(): boolean {
    return readSetting(this.db, 'auto_pull_wifi', '0') === '1';
  }

  // -- diagnostics -----------------------------------------------------------
  log(record: Omit<DeviceCallRecord, 'at'>): void {
    this.deviceLog.push({ at: nowIso(), ...record });
    if (this.deviceLog.length > this.logLimit) {
      this.deviceLog.splice(0, this.deviceLog.length - this.logLimit);
    }
  }

  logSnapshot(): DeviceCallRecord[] {
    return this.deviceLog.slice();
  }

  measuredSpeeds(): { wifiBps: number | null; bleBps: number | null } {
    const read = (key: string): number | null => {
      const value = Number(readSetting(this.db, key));
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    return { wifiBps: read(MEASURED_KEYS.wifi), bleBps: read(MEASURED_KEYS.ble) };
  }

  // -- connection ------------------------------------------------------------
  isConnected(): boolean {
    return this.state === 'connected' || this.state === 'busy';
  }

  private setState(state: DeviceConnectionState, reason: DisconnectReason | null = null): void {
    this.state = state;
    if (reason !== null) this.disconnectReason = reason;
    this.stateSince = new Date();
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    if (this.origin !== 'user') return;
    const timer = setTimeout(() => {
      this.idleTimer = null;
      this.idleDeadline = null;
      // 传输或连接进行中不算空闲；活动结束时 finishActivity 会重新计时。
      if (this.activity || this.connecting) return;
      void this.disconnect({ reason: 'idle' }).catch(() => undefined);
    }, this.idleDisconnectMs);
    timer.unref?.();
    this.idleTimer = timer;
    this.idleDeadline = Date.now() + this.idleDisconnectMs;
  }

  private disarmIdleTimer(): void {
    this.idleDeadline = null;
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * autoSync 默认跟随来源：用户点「连接」= 连上并按设置同步；
   * 实时字幕结束后的恢复连接传 false，只恢复会话，不悄悄同步（也就不会切热点）。
   */
  connect(options: { origin: DeviceOrigin; autoSync?: boolean }): Promise<DeviceView> {
    if (this.state === 'live') return Promise.reject(new AppError('DEVICE_BUSY', undefined, '实时字幕正在使用录音笔'));
    const autoSync = options.autoSync ?? options.origin === 'user';
    if (options.origin === 'user') this.promoteToUser(autoSync);
    // 放在 connecting 清空之后再同步，否则同步会被「正在连接」拦下。
    if (this.connecting) return this.connecting.then(() => this.afterUserConnect(options.origin, autoSync));
    if (this.state === 'busy' || this.state === 'connected') return Promise.resolve(this.afterUserConnect(options.origin, autoSync));
    return this.sharedConnect(options).then(() => this.afterUserConnect(options.origin, autoSync));
  }

  /** 一次点击完成主任务：用户连接且「连上后自动同步」开启时立即同步。 */
  private afterUserConnect(origin: DeviceOrigin, autoSync: boolean): DeviceView {
    if (origin === 'user' && autoSync && this.autoPullOn() && !this.activity && this.state === 'connected') {
      void this.sync({ origin: 'user' }).catch(() => undefined);
    }
    return this.view();
  }

  private autoPullOn(): boolean {
    return readSetting(this.db, 'auto_pull', '1') === '1';
  }

  /**
   * 用户在后台会话（正在自动连接、已连上或正在后台同步）中点了连接/同步：
   * 会话改为用户会话，不再「用完即断」；后台同步因限制推迟的大录音，结束后按用户规则补同步。
   */
  private promoteToUser(autoSync: boolean): void {
    if (this.origin !== 'auto' || (!this.connecting && !this.isConnected())) return;
    this.origin = 'user';
    this.lastError = null;
    writeSetting(this.db, 'device_user_disconnected', '0');
    this.log({ op: 'connect', origin: 'user', ok: true, code: null, transport: null, bytes: null, durationMs: 0,
      detail: 'user took over the background session' });
    if (this.activity) {
      if (autoSync && this.autoPullOn()) this.followUpSync = true;
    } else if (this.state === 'connected') {
      this.armIdleTimer();
    }
  }

  /** 所有连接都经过这里，保证同一时间只有一个 worker 在连录音笔。 */
  private sharedConnect(options: { origin: DeviceOrigin }): Promise<void> {
    if (this.connecting) return this.connecting;
    const run = this.doConnect(options).finally(() => {
      this.connecting = null;
    });
    this.connecting = run;
    return run;
  }

  private async doConnect(options: { origin: DeviceOrigin }): Promise<void> {
    this.setState('connecting');
    this.origin = options.origin;
    if (options.origin === 'user') this.lastError = null;
    let handle: WorkerHandle;
    try {
      const python = await this.resolvePython();
      if (!python) {
        throw new AppError('RUNTIME_MISSING', undefined, '环境自检没有找到可用的 Python 解释器；请到「设置 › 诊断与高级」重新检测。');
      }
      handle = await this.spawnWorker({
        python,
        stateDir: await this.stateDir(),
        prefer: this.rememberedAddress(),
        env: this.env,
      });
    } catch (error) {
      this.handleFailure(error, 'connect', this.origin ?? options.origin);
      throw error;
    }
    this.worker = handle;
    handle.onExit(() => {
      // 主动断开时 terminateWorker 已先摘下 worker，断开原因由调用方设置；
      // 否则这里会短暂显示「已休眠」，自动连接也可能在这个窗口里抢先重连。
      if (this.worker !== handle) {
        this.status = null;
        return;
      }
      this.onWorkerExit();
    });
    try {
      const connected = await handle.request<{ address: string | null; hotspotWasOn: boolean; timeSynced: boolean }>(
        'connect', {}, { timeoutMs: 45_000 },
      );
      if (connected.hotspotWasOn) {
        this.log({ op: 'connect', origin: options.origin, ok: true, code: 'HOTSPOT_RESIDUE_CLOSED', transport: null,
          bytes: null, durationMs: 0, detail: '已关闭上次中断残留的录音笔热点' });
      }
      const status = await handle.request<WorkerStatus>('status', {}, { timeoutMs: 15_000 });
      if (!status?.serial) throw new AppError('DEVICE_ERROR', undefined, '录音笔没有上报序列号');
      this.status = status;
      this.serial = status.serial;
      this.persistDevice(connected.address, status);
      // 连接过程中可能已被用户接管（promoteToUser），按当前来源处理。
      if (this.origin === 'user') writeSetting(this.db, 'device_user_disconnected', '0');
      this.setState('connected', null);
      this.armIdleTimer();
    } catch (error) {
      await this.terminateWorker(true);
      this.handleFailure(error, 'connect', this.origin ?? options.origin);
      throw error;
    }
  }

  private rememberedAddress(): string | null {
    const found = rows(this.db,
      'SELECT ble_address AS value FROM devices WHERE ble_address IS NOT NULL ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1');
    const value = found[0] ? strOr(found[0].value, '') : '';
    return value || null;
  }

  private persistDevice(address: string | null, status: WorkerStatus): void {
    if (!status.serial) return;
    upsertDevice(this.db, status.serial, {
      firmware: status.firmware ?? undefined,
      storageFormat: status.storageFormat ?? undefined,
      batteryPct: status.batteryPct ?? undefined,
      freeSpacePct: status.freeSpacePct ?? undefined,
    });
    writeSetting(this.db, 'device_serial', status.serial);
    if (address) {
      const update = this.db.prepare('UPDATE devices SET ble_address = ? WHERE serial = ?');
      update.run(address, status.serial);
    }
  }

  async refreshStatus(): Promise<WorkerStatus> {
    if (!this.worker) return this.status ?? emptyStatus();
    const status = await this.worker.request<WorkerStatus>('status', {}, { timeoutMs: 15_000 });
    this.status = status;
    if (status.serial) {
      this.serial = status.serial;
      this.persistDevice(null, status);
    }
    return status;
  }

  private toAppError(error: unknown, op: string): AppError {
    if (error instanceof AppError) return error;
    const record = error as { kind?: string; message?: string };
    return classifyDeviceError(record.kind ?? 'Error', record.message ?? String(error), op);
  }

  /** 后台来源的失败（录音笔休眠、不在范围内）只进诊断日志，不在页面上显示为错误。 */
  private handleFailure(error: unknown, op: DeviceCallRecord['op'], origin: DeviceOrigin): void {
    const appError = this.toAppError(error, op);
    if (origin === 'user') this.lastError = appError.toView();
    this.log({ op, origin, ok: false, code: appError.code, transport: null, bytes: null, durationMs: 0, detail: appError.detail ?? '' });
    if (this.state !== 'live') this.setState('disconnected', origin === 'user' ? 'lost' : null);
  }

  private onWorkerExit(): void {
    this.worker = null;
    this.status = null;
    // 录音笔已不在：不再提供逐条同步和清理入口。
    this.listing = null;
    this.cleanable = null;
    if (this.state === 'live' || this.state === 'disconnected') return;
    this.setState('disconnected', 'device_sleep');
    this.disarmIdleTimer();
  }

  private async stateDir(): Promise<string> {
    const audioDir = await this.app.resources.path('audio', undefined, 'write');
    return path.join(path.dirname(audioDir), 'tools', 'device');
  }

  private async terminateWorker(polite: boolean): Promise<void> {
    const handle = this.worker;
    this.worker = null;
    if (!handle) return;
    if (polite) await handle.request('disconnect', {}, { timeoutMs: 8000 }).catch(() => undefined);
    await handle.close(5000).catch(() => undefined);
    if (!handle.exited) handle.kill();
  }

  async disconnect(options: { reason: DisconnectReason }): Promise<DeviceView> {
    if (this.state === 'live') throw new AppError('DEVICE_BUSY', undefined, '实时字幕正在使用录音笔');
    if (options.reason === 'user') writeSetting(this.db, 'device_user_disconnected', '1');
    if (this.activity) {
      await this.cancel({ timeoutMs: this.activity.transport === 'wifi' ? HOTSPOT_CANCEL_WAIT_MS : BLE_CANCEL_WAIT_MS });
    }
    await this.activityDone.catch(() => undefined);
    this.disarmIdleTimer();
    const started = Date.now();
    await this.terminateWorker(true);
    this.log({ op: 'disconnect', origin: this.origin ?? 'user', ok: true, code: null, transport: null, bytes: null,
      durationMs: Date.now() - started, detail: `reason=${options.reason}` });
    this.setState('disconnected', options.reason);
    this.followUpSync = false;
    this.origin = null;
    this.listing = null;
    this.cleanable = null;
    return this.view();
  }

  // -- activity --------------------------------------------------------------
  private busyGuard(liveMessage: string): void {
    if (this.state === 'live') throw new AppError('DEVICE_BUSY', undefined, liveMessage);
    if (this.connecting) throw new AppError('DEVICE_BUSY', '录音笔正在连接，请稍候再试。', 'connect in progress');
    if (this.activity) {
      throw new AppError('DEVICE_BUSY', undefined, `录音笔正在${this.activity.kind === 'cleanup' ? '清理' : '同步'}录音`);
    }
  }

  sync(options: { ids?: number[]; origin: DeviceOrigin }): Promise<SyncOutcome> {
    this.busyGuard('实时字幕正在使用录音笔');
    // 用户在后台会话里点同步：会话归用户，同步完不再自动断开。
    if (options.origin === 'user') this.promoteToUser(false);
    if (options.origin === 'user') this.lastError = null;
    const jobId = randomUUID();
    const activity = newActivity(jobId, options.ids ? 'pull' : 'sync');
    this.activity = activity;
    this.abort = new AbortController();
    this.setState('busy', null);
    this.disarmIdleTimer();
    const runtime = this.runtimeFor(activity, options.origin, (ids) => autoTranscribeIfEnabled(this.app, ids));
    const run = runSync(runtime, { ids: options.ids }).catch((error: unknown) => {
      const appError = this.toAppError(error, 'pull');
      if (options.origin === 'user') this.lastError = appError.toView();
      this.log({ op: 'pull', origin: options.origin, ok: false, code: appError.code, transport: null, bytes: null,
        durationMs: Date.now() - new Date(activity.startedAt).getTime(), detail: appError.detail ?? '' });
      throw appError;
    });
    this.activityDone = run.then(() => undefined, () => undefined);
    return this.finishActivity(jobId, activity, options.origin, run);
  }

  cleanup(options: { origin: DeviceOrigin }): Promise<CleanupOutcome> {
    this.busyGuard('实时字幕正在使用录音笔');
    if (options.origin === 'user') this.lastError = null;
    const jobId = randomUUID();
    const activity = newActivity(jobId, 'cleanup');
    activity.phase = 'listing';
    this.activity = activity;
    this.abort = new AbortController();
    this.setState('busy', null);
    this.disarmIdleTimer();
    const runtime = this.runtimeFor(activity, options.origin, () => 0);
    const run = runCleanup(runtime).catch((error: unknown) => {
      const appError = this.toAppError(error, 'delete');
      if (options.origin === 'user') this.lastError = appError.toView();
      this.log({ op: 'delete', origin: options.origin, ok: false, code: appError.code, transport: null, bytes: null,
        durationMs: Date.now() - new Date(activity.startedAt).getTime(), detail: appError.detail ?? '' });
      throw appError;
    });
    this.activityDone = run.then(() => undefined, () => undefined);
    return this.finishActivity(jobId, activity, options.origin, run);
  }

  private runtimeFor(activity: DeviceActivity, origin: DeviceOrigin, afterImport: (ids: number[]) => number): SyncRuntime {
    const signal = (this.abort ?? new AbortController()).signal;
    return {
      db: this.db,
      origin,
      activity,
      gate: this.gate,
      platform: this.platform,
      isConnected: () => this.worker !== null && !this.worker.exited,
      ensureConnected: async () => {
        // 活动进行中连接：走共享的连接入口，连上后保持 busy，不计空闲。
        await this.sharedConnect({ origin });
        this.disarmIdleTimer();
        this.setState('busy', null);
      },
      request: <T>(cmd: WorkerCommand, args?: Record<string, unknown>, opts?: RequestOptions) => {
        const handle = this.worker;
        if (!handle) throw new AppError('DEVICE_DISCONNECTED');
        return handle.request<T>(cmd, args, opts);
      },
      refreshStatus: () => this.refreshStatus(),
      serial: () => this.serial,
      setListing: (files) => {
        this.listing = files;
        this.refreshCleanable();
      },
      incomingRoot: () => this.app.resources.path('audio', '_incoming', 'write'),
      libraryRoot: () => libraryRoot(this.db),
      ffmpeg: async () => (await resolveFfmpeg(this.db)) ?? 'ffmpeg',
      afterImport,
      transportSetting: () => this.transportSetting(),
      allowBackgroundWifi: () => this.allowBackgroundWifi(),
      wifiCapable: () => probeWifiCapable(undefined, this.platform, this.env),
      isCancelled: () => activity.cancelling,
      signal,
      cancelWorker: () => this.worker?.cancel(),
      killWorker: () => {
        if (this.worker && !this.worker.exited) this.worker.kill();
      },
      cancelGraceMs: () => (activity.transport === 'wifi' ? HOTSPOT_CANCEL_WAIT_MS : BLE_CANCEL_WAIT_MS),
      pullStallMs: this.pullStallMs,
      bleBps: () => this.measuredSpeeds().bleBps,
      log: (record) => this.log(record),
      measured: (transport, bps) => writeSetting(this.db, MEASURED_KEYS[transport], String(bps)),
    };
  }

  private finishActivity<T extends { done: number; failed: number; deferred: number; transport: Transport | null; fallback: AppErrorView | null; error: AppErrorView | null; cancelled: boolean }>(
    jobId: string,
    activity: DeviceActivity,
    origin: DeviceOrigin,
    run: Promise<T>,
  ): Promise<T> {
    let deferred = 0;
    return run
      .then((result) => {
        deferred = result.deferred;
        this.lastResult = {
          jobId,
          kind: activity.kind,
          origin,
          done: result.done,
          failed: result.failed,
          deferred: result.deferred,
          transport: result.transport,
          fallback: result.fallback,
          error: result.error,
          cancelled: result.cancelled,
          finishedAt: new Date().toISOString(),
        };
        return result;
      })
      .finally(() => {
        this.activity = null;
        this.abort = null;
        // 清单是同步开始时读的；挂接完成后重新计算可清理的录音。
        this.refreshCleanable();
        // 来源按结束时判断：后台同步途中被用户接管后，保持连接。
        const autoSession = this.origin === 'auto';
        const followUp = this.followUpSync;
        this.followUpSync = false;
        if (!this.worker) {
          if (this.state !== 'disconnected') this.setState('disconnected', 'lost');
        } else if (autoSession) {
          void this.disconnect({ reason: 'auto-done' }).catch(() => undefined);
        } else {
          this.setState('connected', null);
          this.armIdleTimer();
          if (followUp && deferred > 0) void this.sync({ origin: 'user' }).catch(() => undefined);
        }
      });
  }

  private refreshCleanable(): void {
    if (!this.listing || !this.serial) {
      this.cleanable = null;
      return;
    }
    const candidates = cleanupCandidates(this.db, this.serial, this.listing, libraryRoot(this.db));
    this.cleanable = { count: candidates.length, bytes: candidates.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0) };
  }

  /** 协作式取消；热点阶段给足恢复网络的时间，超时才强制结束 worker。 */
  async cancel(options: { timeoutMs?: number } = {}): Promise<DeviceView> {
    const activity = this.activity;
    if (!activity) return this.view();
    activity.cancelling = true;
    // 等网阶段 worker 还没开始传输：中止等待即可，不碰 worker。
    const waitingNetwork = activity.phase === 'waiting-network';
    this.abort?.abort();
    this.worker?.cancel();
    const timeout = options.timeoutMs ?? (activity.transport === 'wifi' ? HOTSPOT_CANCEL_WAIT_MS : BLE_CANCEL_WAIT_MS);
    const timedOut = await Promise.race([
      this.activityDone.then(() => false),
      new Promise<true>((resolve) => {
        const timer = setTimeout(() => resolve(true), timeout);
        timer.unref?.();
      }),
    ]);
    if (timedOut && !waitingNetwork && this.worker && !this.worker.exited) this.worker.kill();
    await this.activityDone.catch(() => undefined);
    return this.view();
  }

  // -- live caption ----------------------------------------------------------
  /** 实时字幕需要独占录音笔：先断开 worker，结束后按需恢复连接。 */
  async claimForLive(handle: LiveCaptureOptions): Promise<ChildProcessWithoutNullStreams> {
    if (this.state === 'live') throw new AppError('DEVICE_BUSY', '实时字幕已经在运行');
    if (this.activity || this.connecting) throw new AppError('DEVICE_BUSY', '录音笔正在同步录音，请等它结束后再开始实时字幕。');
    this.resumeAfterLive = this.state === 'connected' && this.origin === 'user';
    const resume = this.resumeAfterLive;
    this.disarmIdleTimer();
    // 同一时间只有一个进程占用录音笔：等 worker 完全退出再派生采集脚本。
    this.setState('live', 'live');
    await this.terminateWorker(true);
    this.origin = null;
    this.listing = null;
    this.log({ op: 'live', origin: 'user', ok: true, code: null, transport: null, bytes: null, durationMs: 0,
      detail: `claimed for live caption; resumeAfter=${resume}` });
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(handle.pythonCommand, ['-X', 'utf8', handle.scriptPath, '--scan-timeout', String(handle.scanTimeoutSec)], {
        windowsHide: true,
        env: handle.env,
      });
    } catch (error) {
      this.setState('disconnected', 'live');
      throw new AppError('RUNTIME_MISSING', undefined, `cannot start live capture: ${String(error)}`);
    }
    const release = async () => {
      this.liveHandle = null;
      this.setState('disconnected', 'live');
      // 只恢复会话，不触发同步：停止实时字幕不应让电脑切到录音笔热点。
      if (resume) await this.connect({ origin: 'user', autoSync: false }).catch(() => undefined);
    };
    this.liveHandle = { child, release };
    return child;
  }

  async releaseFromLive(): Promise<void> {
    const live = this.liveHandle;
    this.liveHandle = null;
    this.setState('disconnected', 'live');
    if (live) await live.release();
  }
}

function emptyStatus(): WorkerStatus {
  return { serial: '', model: '', firmware: null, batteryPct: null, freeSpacePct: null, recordingState: null, storageFormat: null };
}

export function createDeviceService(app: WorkbenchServer, options: DeviceServiceOptions): DeviceService {
  return new DeviceService(app, options);
}
