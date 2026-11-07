// ABOUTME: 实时字幕会话：编排采集脚本、ffmpeg 解码与 Host ASR 流式识别。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AppError, type AppErrorView } from '../contracts/errors';
import type { DeviceService } from './device/service';
import { classifyDeviceError } from './device/errors';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import type { LiveState } from '../contracts/app';
import { probePython, probeSdk, pythonRuntimeEnv, resolveFfmpeg } from './runtime-probe';
import { autoTranscribeIfEnabled, queueOrganization } from './jobs';
import { ensureMonthDir, libraryRoot } from './library';
import { fileSize, terminateChild } from './media';
import { nowIso, readSetting, row, run } from './sql';
import { liveScriptSource } from './live-script';
import { appendDetail, finishLiveAsr, pumpFrames } from './live-asr';
import { createPcmFramer, LIVE_DECODER_ARGS } from './live-audio';

const PCM_BYTES_PER_SECOND = 32_000;

interface Runtime {
  app: WorkbenchServer;
  status: 'starting' | 'listening' | 'error';
  message: string | null;
  detail?: string;
  error: AppErrorView | null;
  service: DeviceService | null;
  released: boolean;
  startedAt: number;
  endedAt: number | null;
  finals: string[];
  partial: string;
  pcmBytes: number;
  audioBytes: number;
  filePath: string;
  deviceName: string | null;
  python: ChildProcessWithoutNullStreams | null;
  ffmpeg: ChildProcessWithoutNullStreams | null;
  fileStream: WriteStream | null;
  streamId: string | null;
  seq: number;
  queue: Array<Buffer<ArrayBufferLike>>;
  pumping: Promise<void> | null;
  eventsDone: Promise<void> | null;
  restarts: number;
  stopping: boolean;
  exited: boolean;
}

interface SavedLive {
  recordingId: number;
  filePath: string;
  chars: number;
}

let current: Runtime | null = null;
let lastSaved: SavedLive | null = null;

/** 页面只显示 message；脚本与识别服务的原文合并进 detail。 */
function liveError(rt: Runtime): AppErrorView | null {
  if (!rt.error) return null;
  const detail = [rt.error.detail, rt.detail].filter(Boolean).join('\n');
  return detail ? { ...rt.error, detail } : rt.error;
}

function fail(rt: Runtime, error: AppError): void {
  rt.status = 'error';
  rt.message = error.message;
  rt.error = error.toView();
}

/** 采集结束后把录音笔交还设备服务（只交还一次）。 */
function releaseDevice(rt: Runtime): void {
  if (rt.released || !rt.service) return;
  rt.released = true;
  void rt.service.releaseFromLive().catch(() => undefined);
}

export function getLiveState(): LiveState {
  if (!current) {
    return {
      active: false,
      status: 'idle',
      message: null,
      startedAt: null,
      elapsedMs: 0,
      pcmBytes: 0,
      audioBytes: 0,
      finals: [],
      partial: '',
      deviceName: null,
      lastSaved,
      error: null,
    };
  }
  return {
    active: !current.exited,
    status: current.status,
    message: current.message,
    startedAt: new Date(current.startedAt).toISOString(),
    elapsedMs: (current.endedAt ?? Date.now()) - current.startedAt,
    pcmBytes: current.pcmBytes,
    audioBytes: current.audioBytes,
    finals: current.finals.slice(-40),
    partial: current.partial,
    deviceName: current.deviceName,
    lastSaved,
    error: liveError(current),
  };
}

async function ensureScript(dataDir: string): Promise<string> {
  const directory = path.join(dataDir, 'tools');
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, 'live_caption.py');
  await writeFile(target, liveScriptSource(), 'utf8');
  return target;
}

/** 数据目录由调用方传入（来自 audio 资源的父级）。 */
export async function resolveDataDirectory(app: WorkbenchServer): Promise<string> {
  const audioDir = await app.resources.path('audio', undefined, 'write');
  return path.dirname(audioDir);
}

function handleStderrLine(rt: Runtime, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  if (!trimmed.startsWith('{')) {
    // 非 JSON 的输出（traceback 等）只进技术详情，不直接显示给用户。
    appendDetail(rt, trimmed.slice(0, 500));
    return;
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const event = String(payload.event ?? '');
    if (event === 'found') rt.deviceName = String(payload.name ?? '') || null;
    if (event === 'streaming') {
      rt.status = 'listening';
      rt.message = null;
      rt.error = null;
    }
    if (event === 'error') {
      const kind = String(payload.kind ?? 'Error');
      fail(rt, classifyDeviceError(kind, String(payload.message ?? ''), { op: 'live', stderrTail: rt.detail }));
    }
  } catch {
    appendDetail(rt, trimmed.slice(0, 500));
  }
}

function runtimeMissing(detail: string): AppError {
  return new AppError('RUNTIME_MISSING', undefined, detail);
}

export async function startLive(app: WorkbenchServer, service: DeviceService): Promise<LiveState> {
  if (current && !current.exited) throw new AppError('LIVE_RUNNING', '实时字幕已经在运行');

  const db = app.database;
  const { command: pythonCommand, probe } = await probePython(readSetting(db, 'python_path'));
  if (!pythonCommand) throw runtimeMissing(probe.detail);
  const sdk = await probeSdk(pythonCommand);
  if (!sdk.ok) throw runtimeMissing(sdk.detail);
  const ffmpegPath = await resolveFfmpeg(db);
  if (!ffmpegPath) throw runtimeMissing('ffmpeg not found; set ffmpeg_path in 设置 › 诊断与高级');

  const dataDir = await resolveDataDirectory(app);
  const script = await ensureScript(dataDir);
  const env = await pythonRuntimeEnv(pythonCommand);

  lastSaved = null;
  const startedAt = Date.now();
  const monthDir = await ensureMonthDir(libraryRoot(db), new Date(startedAt).toISOString());
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const filePath = path.join(monthDir, `LIVE_${stamp}.mp3`);

  // 设备服务是录音笔的唯一所有者：由它断开 worker 并派生采集脚本；同步中会抛 DEVICE_BUSY。
  const python = await service.claimForLive({ pythonCommand, scriptPath: script, env, scanTimeoutSec: 12 });

  const session: Runtime = {
    app,
    status: 'starting',
    message: null,
    error: null,
    service,
    released: false,
    startedAt,
    endedAt: null,
    finals: [],
    partial: '',
    pcmBytes: 0,
    audioBytes: 0,
    filePath,
    deviceName: null,
    python,
    ffmpeg: null,
    fileStream: null,
    streamId: null,
    seq: 0,
    queue: [],
    pumping: null,
    eventsDone: null,
    restarts: 0,
    stopping: false,
    exited: false,
  };
  current = session;

  try {
    const ffmpeg = spawn(ffmpegPath, LIVE_DECODER_ARGS, { windowsHide: true });
    session.ffmpeg = ffmpeg;
    for (const child of [python, ffmpeg]) {
      child.stdin.on('error', (error) => {
        if (!session.stopping) {
          appendDetail(session, `stdin: ${error.message}`);
          fail(session, new AppError('DECODE_FAILED', undefined, error.message));
        }
      });
    }
    ffmpeg.on('error', (error) => {
      fail(session, new AppError('RUNTIME_MISSING', undefined, `ffmpeg: ${error.message}`));
      terminateChild(python);
    });
    session.fileStream = createWriteStream(filePath);

    python.stdout.on('data', (chunk: Buffer) => {
      session.audioBytes += chunk.length;
      session.fileStream?.write(chunk);
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.write(chunk);
    });

    let stderrBuffer = '';
    python.stderr.on('data', (chunk: Buffer) => {
      stderrBuffer += chunk.toString('utf8');
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop() ?? '';
      for (const line of lines) handleStderrLine(session, line);
    });

    ffmpeg.stdout.pipe(createPcmFramer()).on('data', (chunk: Buffer) => {
      session.queue.push(chunk);
      void pumpFrames(session);
    });

    python.on('close', (code) => {
      session.exited = true;
      session.endedAt = Date.now();
      if (!session.stopping && session.status !== 'error') {
        fail(session, new AppError('DEVICE_DISCONNECTED', undefined, `live capture exited (code ${code ?? '-'})\n${session.detail ?? ''}`));
      }
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
      // 用户主动停止时由 stopLive 在保存后交还；意外退出立即交还。
      if (!session.stopping) releaseDevice(session);
    });
    python.on('error', (error) => {
      session.exited = true;
      session.endedAt = Date.now();
      fail(session, new AppError('RUNTIME_MISSING', undefined, `cannot start live capture: ${error.message}`));
      releaseDevice(session);
    });

    return getLiveState();
  } catch (error) {
    session.exited = true;
    session.endedAt = Date.now();
    terminateChild(python);
    releaseDevice(session);
    current = null;
    throw error instanceof AppError ? error : new AppError('INTERNAL_ERROR', undefined, String(error));
  }
}

function closeFileStream(stream: WriteStream | null): Promise<void> {
  return new Promise((resolve) => {
    if (!stream || stream.closed) {
      resolve();
      return;
    }
    stream.once('close', () => resolve());
    stream.end();
  });
}

export async function stopLive(app: WorkbenchServer): Promise<LiveState> {
  const session = current;
  if (!session) return getLiveState();

  session.stopping = true;
  try {
    if (session.python && !session.python.killed && !session.exited) {
      try {
        session.python.stdin.end('stop\n');
      } catch {
        /* stdin 可能已关闭 */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 4000);
        session.python?.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!session.exited) terminateChild(session.python);
    }

    if (session.ffmpeg) {
      if (!session.ffmpeg.stdin.destroyed) session.ffmpeg.stdin.end();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1500);
        session.ffmpeg?.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (session.ffmpeg.exitCode === null) terminateChild(session.ffmpeg);
    }

    const text = await finishLiveAsr(session);
    await closeFileStream(session.fileStream);

    if (session.audioBytes === 0 && !text) {
      session.message = session.message ?? '这次没有采集到音频（录音笔可能未唤醒或未在录音）';
    } else {
      lastSaved = await persistSession(app, session, text);
    }
  } finally {
    current = null;
    // 采集脚本已退出：把录音笔交还设备服务，之前是用户连接的会自动恢复连接。
    releaseDevice(session);
  }
  return getLiveState();
}

async function persistSession(app: WorkbenchServer, session: Runtime, text: string): Promise<SavedLive> {
  const db = app.database;
  const filename = path.basename(session.filePath);
  const size = (await fileSize(session.filePath)) ?? session.audioBytes;
  const durationSec = Math.max(1, Math.round(session.pcmBytes / PCM_BYTES_PER_SECOND));
  const existing = row(db, 'SELECT id FROM recordings WHERE dedupe_key = ?', [`live::${session.filePath}`]);
  const recordingId = existing
    ? Number(existing.id)
    : run(
        db,
        `INSERT INTO recordings (filename, dedupe_key, source, storage_path, size_bytes, duration_sec,
           recorded_at, status, transcript_text, created_at, updated_at)
         VALUES (?, ?, 'live_caption', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          filename,
          `live::${session.filePath}`,
          session.filePath,
          size,
          durationSec,
          new Date(session.startedAt).toISOString(),
          text ? 'transcribed' : 'ready',
          text || null,
          nowIso(),
          nowIso(),
        ],
      ).lastId;

  if (text) {
    run(
      db,
      `INSERT INTO transcripts (recording_id, engine, language, text, segments_json, char_count, audio_ms, created_at)
       VALUES (?, 'host-asr-live', NULL, ?, '[]', ?, ?, ?)`,
      [recordingId, text, text.length, Math.round(session.pcmBytes / 32), nowIso()],
    );
    if (readSetting(db, 'auto_analyze', '1') === '1') queueOrganization(app, recordingId);
  } else {
    autoTranscribeIfEnabled(app, [recordingId]);
  }

  return { recordingId, filePath: session.filePath, chars: text.length };
}
