// ABOUTME: 设备层测试夹具：带 audio 资源的隔离服务器，以及按 worker 协议应答的内存假 worker。

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkbenchServer, type WorkbenchServer } from '../../sdk/runtime.mjs';
import { AppError } from '../../src/contracts/errors.ts';
import { classifyDeviceError } from '../../src/server/device/errors.ts';
import type { WorkerStatus } from '../../src/server/device/sync.ts';
import type { RequestOptions, SpawnWorkerOptions, WorkerCommand, WorkerEvent, WorkerHandle } from '../../src/server/device/worker.ts';
import { writeSetting } from '../../src/server/sql.ts';

export const SERIAL = 'MT-TEST-0001';
export const MiB = 1_048_576;

// 每个测试都会新建一个服务器实例，它们各自注册进程信号监听。
process.setMaxListeners(Math.max(process.getMaxListeners(), 64));

export interface TestApp {
  app: WorkbenchServer;
  root: string;
  libraryDir: string;
  close(): Promise<void>;
}

export async function createTestApp(prefix: string): Promise<TestApp> {
  const root = await mkdtemp(path.join(os.tmpdir(), `openminutes-${prefix}-`));
  await cp(new URL('../../migrations/', import.meta.url), path.join(root, 'migrations'), { recursive: true });
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    appId: `${prefix}-test`, name: 'test', version: '1',
    server: fileURLToPath(import.meta.url), ui: '.', migrations: 'migrations',
    resources: [{ id: 'audio', kind: 'directory', role: 'data', location: 'data', path: 'audio', access: 'read-write', required: true }],
  }));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({
    appId: `${prefix}-test`, generation: '1', nonce: 'test', sourceDirectory: root, dataDirectory: path.join(root, 'data'),
  }));
  const app = await createWorkbenchServer(import.meta.url, { configPath });
  const libraryDir = path.join(root, 'library');
  await mkdir(libraryDir, { recursive: true });
  writeSetting(app.database, 'library_dir', libraryDir);
  // 不让挂接后的自动转录把任务排进全局队列。
  writeSetting(app.database, 'auto_transcribe', '0');
  // 不存在的 ffmpeg：时长探测直接返回 null，不会派生真实进程。
  writeSetting(app.database, 'ffmpeg_path', path.join(root, 'no-ffmpeg'));
  return {
    app,
    root,
    libraryDir,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface FakeFile {
  name: string;
  sizeBytes: number;
}

export interface FakeDeviceOptions {
  files?: FakeFile[];
  status?: Partial<WorkerStatus>;
  connectError?: { kind: string; message: string };
  /** connect 在这个 promise 完成前不返回，用来观察「正在连接」窗口。 */
  holdConnect?: Promise<void>;
  /** Wi-Fi 入网失败：发出 fallback 事件后改走蓝牙。 */
  wifiFails?: boolean;
  hotspotWasOn?: boolean;
  /** 这些文件落盘时多写 1 字节，模拟大小不一致。 */
  wrongSize?: string[];
  /** 这些文件报告一个任务目录之外的路径。 */
  outsidePath?: string[];
  /** 拉取在这个 promise 完成或收到取消前不返回。 */
  holdPull?: Promise<void>;
  deleteFails?: string[];
  /** worker 收到取消后不理会，用来验证超时后才强制结束。 */
  ignoreCancel?: boolean;
}

export interface FakeCall {
  cmd: WorkerCommand | 'cancel';
  args: Record<string, unknown>;
  offline?: boolean;
}

/** 一台内存里的录音笔；多次 spawn 共享同一份文件与调用记录。 */
export class FakeDevice {
  files: FakeFile[];
  status: WorkerStatus;
  options: FakeDeviceOptions;
  calls: FakeCall[] = [];
  spawns: SpawnWorkerOptions[] = [];
  workers: FakeWorker[] = [];
  isOffline: () => boolean = () => false;

  constructor(options: FakeDeviceOptions = {}) {
    this.options = options;
    this.files = (options.files ?? []).map((file) => ({ ...file }));
    this.status = {
      serial: SERIAL, model: 'MemoTalk S1', firmware: '206', batteryPct: 80, freeSpacePct: 90,
      recordingState: 'STOPPED', storageFormat: 'MP3', ...options.status,
    };
  }

  spawn = async (options: SpawnWorkerOptions): Promise<WorkerHandle> => {
    this.spawns.push(options);
    const worker = new FakeWorker(this);
    this.workers.push(worker);
    return worker;
  };

  commands(): string[] {
    return this.calls.map((call) => call.cmd);
  }

  last(cmd: FakeCall['cmd']): FakeCall | undefined {
    return [...this.calls].reverse().find((call) => call.cmd === cmd);
  }
}

export class FakeWorker implements WorkerHandle {
  private readonly device: FakeDevice;
  private cancelled = false;
  private cancelWaiters: Array<() => void> = [];
  private readonly exitListeners: Array<(code: number | null) => void> = [];
  private done = false;

  constructor(device: FakeDevice) {
    this.device = device;
  }

  get exited(): boolean {
    return this.done;
  }

  stderrTail(): string {
    return '';
  }

  onEvent(): void {
    /* 只有请求级事件 */
  }

  onExit(listener: (code: number | null) => void): void {
    this.exitListeners.push(listener);
  }

  /** 模拟录音笔休眠：进程自行退出。 */
  exit(code: number | null = 0): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.cancelWaiters.splice(0)) waiter();
    for (const listener of this.exitListeners) listener(code);
  }

  cancel(): void {
    this.device.calls.push({ cmd: 'cancel', args: {} });
    if (this.device.options.ignoreCancel) return;
    this.cancelled = true;
    for (const waiter of this.cancelWaiters.splice(0)) waiter();
  }

  async close(): Promise<void> {
    this.exit(0);
  }

  killed = false;

  kill(): void {
    this.killed = true;
    this.exit(null);
  }

  async request<T>(cmd: WorkerCommand, args: Record<string, unknown> = {}, options?: RequestOptions): Promise<T> {
    if (this.done) throw new AppError('DEVICE_DISCONNECTED', undefined, 'worker already exited');
    const device = this.device;
    device.calls.push({ cmd, args, offline: device.isOffline() });
    switch (cmd) {
      case 'connect': {
        if (device.options.holdConnect) await device.options.holdConnect;
        const failure = device.options.connectError;
        if (failure) throw classifyDeviceError(failure.kind, failure.message, { op: 'connect' });
        return { address: 'AA:BB:CC:DD:EE:FF', hotspotWasOn: Boolean(device.options.hotspotWasOn), timeSynced: true } as T;
      }
      case 'status':
        return { ...device.status } as T;
      case 'list':
        return {
          files: device.files.map((file) => ({ name: file.name, format: 'MP3', sizeBytes: file.sizeBytes, durationSec: 10, timestamp: null })),
        } as T;
      case 'pull':
        return (await this.pull(args, options?.onEvent)) as T;
      case 'delete': {
        const names = (args.names as string[]) ?? [];
        const fails = new Set(device.options.deleteFails ?? []);
        const files = names.map((name) => {
          if (fails.has(name)) return { name, ok: false, error: { kind: 'DeleteFailed', message: `${name} status=0x02` } };
          device.files = device.files.filter((file) => file.name !== name);
          return { name, ok: true };
        });
        return { files } as T;
      }
      case 'disconnect':
        return {} as T;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  }

  private async pull(args: Record<string, unknown>, onEvent?: (event: WorkerEvent) => void) {
    const device = this.device;
    const requested = args.files as Array<{ name: string; size: number | null }>;
    const outDir = String(args.outDir);
    let transport = args.transport as 'wifi' | 'ble';
    if (transport === 'wifi') {
      onEvent?.({ event: 'progress', data: { phase: 'preparing', transport: 'wifi', index: 0, count: requested.length } });
      if (device.options.wifiFails) {
        onEvent?.({ event: 'fallback', data: { from: 'wifi', to: 'ble', reason: 'WIFI_JOIN_FAILED', detail: 'netsh: The network is not available.' } });
        transport = 'ble';
      }
    }
    if (device.options.holdPull) {
      onEvent?.({ event: 'progress', data: { phase: 'transferring', transport, file: requested[0]?.name, index: 1, count: requested.length, bytes: 0, total: requested[0]?.size ?? null } });
      await Promise.race([device.options.holdPull, new Promise<void>((resolve) => this.cancelWaiters.push(resolve))]);
      if (this.done) throw new AppError('DEVICE_DISCONNECTED', undefined, 'worker killed during pull');
    }
    const files: Array<Record<string, unknown>> = [];
    let index = 0;
    for (const item of requested) {
      if (this.cancelled) break;
      index += 1;
      const entry = device.files.find((file) => file.name === item.name);
      if (!entry) {
        files.push({ name: item.name, ok: false, error: { kind: 'FileNotFoundOnDevice', message: item.name } });
        continue;
      }
      const size = entry.sizeBytes + ((device.options.wrongSize ?? []).includes(item.name) ? 1 : 0);
      const target = (device.options.outsidePath ?? []).includes(item.name)
        ? path.join(path.dirname(outDir), `stray-${item.name}`)
        : path.join(outDir, item.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.alloc(size, 7));
      onEvent?.({ event: 'progress', data: { phase: 'transferring', transport, file: item.name, index, count: requested.length, bytes: size, total: size } });
      files.push({ name: item.name, path: target, sizeBytes: size, transport, ok: true });
    }
    if (args.transport === 'wifi' && transport === 'wifi') {
      onEvent?.({ event: 'progress', data: { phase: 'restoring', transport: 'wifi' } });
    }
    return { files, cancelled: this.cancelled };
  }
}

/** 等到条件成立；默认 3 秒超时，避免测试挂死。 */
export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
