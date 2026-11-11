// ABOUTME: 设备 worker 客户端：写出脚本、派生 Python 进程、按 id 关联 JSON-lines 请求与响应、超时与终止。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../../contracts/errors';
import { terminateChild } from '../media';
import { pythonRuntimeEnv } from '../tools';
import { classifyDeviceError } from './errors';
import { FAKE_DEVICE_PRELUDE } from './fake-device';
import { DEVICE_WORKER_SCRIPT } from './worker-script';

export type WorkerCommand = 'connect' | 'status' | 'list' | 'pull' | 'delete' | 'disconnect';

export interface WorkerEvent {
  id?: number;
  event: string;
  data: Record<string, unknown>;
}

export interface RequestOptions {
  timeoutMs: number;
  onEvent?: (event: WorkerEvent) => void;
}

export interface WorkerHandle {
  request<T>(cmd: WorkerCommand, args?: Record<string, unknown>, options?: RequestOptions): Promise<T>;
  /** 协作式取消：worker 在安全点停下，热点会话照常恢复网络。 */
  cancel(): void;
  /** 关闭 stdin 让 worker 自行收尾，超时后强制结束。 */
  close(timeoutMs?: number): Promise<void>;
  kill(): void;
  onEvent(listener: (event: WorkerEvent) => void): void;
  onExit(listener: (code: number | null) => void): void;
  readonly exited: boolean;
  stderrTail(): string;
}

export interface SpawnWorkerOptions {
  python: string;
  stateDir: string;
  prefer: string | null;
  env?: NodeJS.ProcessEnv;
  netPlatform?: 'win32' | 'darwin' | 'linux';
}

export type SpawnWorker = (options: SpawnWorkerOptions) => Promise<WorkerHandle>;

interface Pending {
  cmd: WorkerCommand;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onEvent?: (event: WorkerEvent) => void;
  timer: NodeJS.Timeout;
}

/** 脚本写成文件再执行，避开 Windows 命令行长度与引号问题。 */
export async function writeWorkerFiles(stateDir: string, env: NodeJS.ProcessEnv = process.env): Promise<{ script: string; prelude: string | null }> {
  await mkdir(stateDir, { recursive: true });
  const script = path.join(stateDir, 'worker.py');
  await writeFile(script, DEVICE_WORKER_SCRIPT, 'utf8');
  if (!env.OPENMINUTES_FAKE_DEVICE) return { script, prelude: null };
  const prelude = path.join(stateDir, 'fake_device.py');
  await writeFile(prelude, FAKE_DEVICE_PRELUDE, 'utf8');
  return { script, prelude };
}

export function attachWorker(child: ChildProcessWithoutNullStreams): WorkerHandle {
  const pending = new Map<number, Pending>();
  const eventListeners: Array<(event: WorkerEvent) => void> = [];
  const exitListeners: Array<(code: number | null) => void> = [];
  let nextId = 1;
  let exited = false;
  let stderr = '';
  let stdoutBuffer = '';
  let fatal: { kind: string; message: string } | null = null;

  const failAll = (code: number | null) => {
    for (const [id, item] of pending) {
      clearTimeout(item.timer);
      pending.delete(id);
      item.reject(fatal
        ? classifyDeviceError(fatal.kind, fatal.message, { op: item.cmd, exitCode: code, stderrTail: stderr })
        : new AppError('DEVICE_DISCONNECTED', undefined, `worker exited (code ${code ?? '-'})\n${stderr.slice(-2000)}`));
    }
  };

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      stderr = `${stderr}${trimmed}\n`.slice(-8000);
      return;
    }
    const id = typeof message.id === 'number' ? message.id : undefined;
    const item = id !== undefined ? pending.get(id) : undefined;
    if (message.type === 'result' || message.type === 'error') {
      if (!item || id === undefined) return;
      clearTimeout(item.timer);
      pending.delete(id);
      if (message.type === 'result') item.resolve(message.data ?? null);
      else {
        const error = (message.error ?? {}) as { kind?: string; message?: string };
        item.reject(classifyDeviceError(error.kind ?? 'Error', error.message ?? '', { op: item.cmd, stderrTail: stderr }));
      }
      return;
    }
    if (message.type === 'event') {
      const event: WorkerEvent = {
        id,
        event: String(message.event ?? ''),
        data: (message.data ?? {}) as Record<string, unknown>,
      };
      if (event.event === 'fatal') fatal = event.data as { kind: string; message: string };
      item?.onEvent?.(event);
      for (const listener of eventListeners) listener(event);
      return;
    }
    if (message.type === 'log') {
      const event: WorkerEvent = { event: 'log', data: { level: message.level, message: message.message } };
      for (const listener of eventListeners) listener(event);
    }
  };

  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) handleLine(line);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-8000);
  });
  child.stdin.on('error', () => undefined);
  const onExit = (code: number | null) => {
    if (exited) return;
    exited = true;
    if (stdoutBuffer) handleLine(stdoutBuffer);
    failAll(code);
    for (const listener of exitListeners) listener(code);
  };
  child.on('close', onExit);
  child.on('error', (error) => {
    stderr = `${stderr}${error.message}\n`.slice(-8000);
    if (!fatal) fatal = { kind: 'ModuleNotFoundError', message: `cannot start Python: ${error.message}` };
    onExit(null);
  });

  const send = (payload: Record<string, unknown>) => {
    if (exited || child.stdin.destroyed) return false;
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return true;
  };

  return {
    request<T>(cmd: WorkerCommand, args: Record<string, unknown> = {}, options: RequestOptions = { timeoutMs: 60_000 }) {
      return new Promise<T>((resolve, reject) => {
        if (exited) {
          reject(new AppError('DEVICE_DISCONNECTED', undefined, `worker already exited\n${stderr.slice(-2000)}`));
          return;
        }
        const id = nextId++;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new AppError('DEVICE_TIMEOUT', undefined, `worker command ${cmd} exceeded ${options.timeoutMs}ms`));
        }, options.timeoutMs);
        pending.set(id, { cmd, resolve: resolve as (value: unknown) => void, reject, onEvent: options.onEvent, timer });
        send({ id, cmd, args });
      });
    },
    cancel() {
      send({ id: nextId++, cmd: 'cancel' });
    },
    async close(timeoutMs = 5000) {
      if (exited) return;
      const done = new Promise<void>((resolve) => exitListeners.push(() => resolve()));
      child.stdin.end();
      const timer = setTimeout(() => {
        if (!exited) terminateChild(child);
      }, timeoutMs);
      timer.unref?.();
      await done;
      clearTimeout(timer);
    },
    kill() {
      if (!exited) terminateChild(child);
    },
    onEvent(listener) {
      eventListeners.push(listener);
    },
    onExit(listener) {
      exitListeners.push(listener);
    },
    get exited() {
      return exited;
    },
    stderrTail() {
      return stderr.slice(-4000);
    },
  };
}

export const spawnDeviceWorker: SpawnWorker = async (options) => {
  const env = options.env ?? process.env;
  const { script, prelude } = await writeWorkerFiles(options.stateDir, env);
  const args = ['-X', 'utf8', '-u', script, '--state-dir', options.stateDir];
  if (options.prefer) args.push('--prefer', options.prefer);
  if (prelude) args.push('--fake-prelude', prelude);
  if (options.netPlatform) args.push('--net-platform', options.netPlatform);
  const runtimeEnv = await pythonRuntimeEnv(options.python, env);
  const child = spawn(options.python, args, { windowsHide: true, env: runtimeEnv });
  return attachWorker(child);
};
