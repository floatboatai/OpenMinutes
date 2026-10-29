// ABOUTME: 实时字幕会话：编排采集脚本、ffmpeg 解码与 Host ASR 流式识别。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import type { LiveState } from '../contracts/app';
import { probePython, probeSdk, pythonRuntimeEnv, resolveFfmpeg } from './bridge';
import { autoTranscribeIfEnabled, queueOrganization } from './jobs';
import { ensureMonthDir, libraryRoot } from './library';
import { fileSize } from './media';
import { nowIso, readSetting, row, run } from './sql';
import { liveScriptSource } from './live-script';
import { pumpFrames } from './live-asr';
import { createPcmFramer, LIVE_DECODER_ARGS } from './live-audio';

const PCM_BYTES_PER_SECOND = 32_000;

interface Runtime {
  app: WorkbenchServer;
  status: 'starting' | 'listening' | 'error';
  message: string | null;
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
  pumping: boolean;
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

export class LiveError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LiveError';
    this.code = code;
  }
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
    rt.message = rt.message ?? trimmed.slice(0, 200);
    return;
  }
  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const event = String(payload.event ?? '');
    if (event === 'found') rt.deviceName = String(payload.name ?? '') || null;
    if (event === 'connected' || event === 'streaming') {
      rt.status = 'listening';
      rt.message = null;
    }
    if (event === 'error') {
      rt.status = 'error';
      rt.message = String(payload.message ?? '采集脚本报错');
    }
    if (event === 'streaming') rt.status = 'listening';
  } catch {
    /* 非法 JSON 行忽略 */
  }
}

export async function startLive(app: WorkbenchServer): Promise<LiveState> {
  if (current && !current.exited) throw new LiveError('ALREADY_RUNNING', '实时字幕已经在运行');

  const db = app.database;
  const { command: pythonCommand } = await probePython(readSetting(db, 'python_path'));
  if (!pythonCommand) throw new LiveError('NO_PYTHON', '未找到 Python 解释器，无法启动采集脚本');
  const sdk = await probeSdk(pythonCommand);
  if (!sdk.ok) throw new LiveError('NO_SDK', sdk.detail);
  const ffmpegPath = await resolveFfmpeg(db);
  if (!ffmpegPath) throw new LiveError('NO_FFMPEG', '未找到 ffmpeg，无法解码音频流');

  const dataDir = await resolveDataDirectory(app);
  const script = await ensureScript(dataDir);

  lastSaved = null;
  const startedAt = Date.now();
  const monthDir = await ensureMonthDir(libraryRoot(db), new Date(startedAt).toISOString());
  const stamp = new Date(startedAt).toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
  const filePath = path.join(monthDir, `LIVE_${stamp}.mp3`);

  const session: Runtime = {
    app,
    status: 'starting',
    message: null,
    startedAt,
    endedAt: null,
    finals: [],
    partial: '',
    pcmBytes: 0,
    audioBytes: 0,
    filePath,
    deviceName: null,
    python: null,
    ffmpeg: null,
    fileStream: null,
    streamId: null,
    seq: 0,
    queue: [],
    pumping: false,
    restarts: 0,
    stopping: false,
    exited: false,
  };
  current = session;

  try {
    const env = await pythonRuntimeEnv(pythonCommand);
    const python = spawn(pythonCommand, ['-X', 'utf8', script, '--scan-timeout', '12'], {
      windowsHide: true,
      ...(env ? { env } : {}),
    });
    const ffmpeg = spawn(
      ffmpegPath,
      LIVE_DECODER_ARGS,
      { windowsHide: true },
    );
    session.python = python;
    session.ffmpeg = ffmpeg;
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
        session.status = 'error';
        session.message = session.message ?? `采集脚本退出（退出码 ${code ?? '未知'}）`;
      }
      if (!ffmpeg.stdin.destroyed) ffmpeg.stdin.end();
    });
    python.on('error', (error) => {
      session.exited = true;
      session.endedAt = Date.now();
      session.status = 'error';
      session.message = `采集脚本启动失败：${error.message}`;
    });

    return getLiveState();
  } catch (error) {
    session.exited = true;
    session.endedAt = Date.now();
    session.status = 'error';
    session.message = error instanceof Error ? error.message : '启动失败';
    current = null;
    throw error instanceof LiveError ? error : new LiveError('START_FAILED', session.message ?? '启动失败');
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
    if (session.python && !session.python.killed) {
      try {
        session.python.stdin.write('stop\n');
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
      if (!session.exited) session.python.kill();
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
      if (session.ffmpeg.exitCode === null) session.ffmpeg.kill();
    }

    await pumpFrames(session);
    await closeFileStream(session.fileStream);

    let text = session.finals.join('\n').trim();
    if (session.streamId) {
      try {
        const final = await app.host.asr.stop({ streamId: session.streamId });
        const tail = (final.text ?? '').trim();
        if (!text && tail) text = tail;
      } catch {
        /* 识别收尾失败不阻断落库 */
      }
    }

    if (session.audioBytes === 0 && !text) {
      session.message = session.message ?? '这次没有采集到音频（设备可能未唤醒或未进入录音）';
    } else {
      lastSaved = await persistSession(app, session, text);
    }
  } finally {
    current = null;
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
