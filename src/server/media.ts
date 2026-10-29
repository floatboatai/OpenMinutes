// ABOUTME: ffmpeg 探测、时长解析与 16kHz 单声道 PCM16 解码，供转录流水线复用。

import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';

export interface CommandOutcome {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

export function terminateChild(child: ChildProcess): void {
  child.kill();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, 1000);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

/** 运行一个短命令并收集输出；超时后强制结束，绝不会无限等待。 */
export function runCommand(
  command: string,
  args: string[],
  timeoutMs = 15000,
  env?: NodeJS.ProcessEnv,
): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, ...(env ? { env } : {}) });
      child.stdin.end();
    } catch (error) {
      resolve({ ok: false, code: null, stdout: '', stderr: error instanceof Error ? error.message : '无法启动进程' });
      return;
    }
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (child) terminateChild(child);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n[超时] 命令超过 ${timeoutMs}ms 未完成` });
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 60000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 60000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

export interface ToolProbe {
  ok: boolean;
  detail: string;
  resolvedPath: string | null;
}

/** 在 PATH 中展开可执行文件候选，兼容 Windows 扩展名。 */
export { pathCandidates } from './tools';

const DURATION_PATTERN = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** 用 ffmpeg 的 stderr 头部信息解析时长，避免额外依赖 ffprobe。 */
export async function probeDurationSec(ffmpegPath: string, filePath: string): Promise<number | null> {
  const outcome = await runCommand(ffmpegPath, ['-hide_banner', '-i', filePath], 15000);
  const match = DURATION_PATTERN.exec(outcome.stderr);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

export async function fileSize(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return Number.isFinite(info.size) ? info.size : null;
  } catch {
    return null;
  }
}

export const PCM_SAMPLE_RATE = 16000;
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;
/** 每帧 2 秒 PCM，base64 后约 85KB，保持在单帧 128KiB 上限内。 */
export const PCM_FRAME_BYTES = PCM_BYTES_PER_SECOND * 2;

export interface DecodeFailure {
  kind: 'failure';
  message: string;
}

/**
 * 把任意音频解码成 16kHz 单声道 PCM16 小端，按固定帧长产出。
 * ffmpeg 失败时通过返回对象报告，而不是抛出难以定位的错误。
 */
export async function* decodePcmFrames(
  ffmpegPath: string,
  filePath: string,
): AsyncGenerator<Buffer, DecodeFailure | null, void> {
  const child = spawn(
    ffmpegPath,
    ['-v', 'error', '-i', filePath, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '16000', '-'],
    { windowsHide: true },
  );
  child.stdin.end();

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4000) stderr += chunk.toString('utf8');
  });

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  const queue: Array<Buffer<ArrayBufferLike>> = [];
  let finished = false;
  let failure: DecodeFailure | null = null;

  const stdout = child.stdout;
  stdout?.on('data', (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length >= PCM_FRAME_BYTES) {
      queue.push(pending.subarray(0, PCM_FRAME_BYTES));
      pending = pending.subarray(PCM_FRAME_BYTES);
    }
  });

  const done = new Promise<void>((resolve) => {
    child.on('error', (error) => {
      failure = { kind: 'failure', message: error.message };
      finished = true;
      resolve();
    });
    child.on('close', (code) => {
      if (code !== 0 && !failure) {
        failure = { kind: 'failure', message: stderr.trim() || `ffmpeg 退出码 ${code ?? 'unknown'}` };
      }
      finished = true;
      resolve();
    });
  });

  while (true) {
    if (queue.length > 0) {
      const frame = queue.shift();
      if (frame) yield frame;
      continue;
    }
    if (finished) break;
    await new Promise((resolve) => setTimeout(resolve, 12));
  }

  if (pending.length > 0 && !failure) yield pending;
  return failure;
}

/** 读取解码结果，验证音频确实能转成 PCM（导入时做一次轻量可用性检查）。 */
export async function verifyDecodable(ffmpegPath: string, filePath: string): Promise<{ ok: boolean; message: string }> {
  const outcome = await runCommand(
    ffmpegPath,
    ['-v', 'error', '-i', filePath, '-vn', '-f', 's16le', '-ac', '1', '-ar', '16000', '-t', '0.2', '-'],
    20000,
  );
  return outcome.ok ? { ok: true, message: '可解码' } : { ok: false, message: outcome.stderr.trim().slice(0, 300) };
}
