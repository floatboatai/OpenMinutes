// ABOUTME: 录音笔 SDK 桥接：探测 Python/bleak/ffmpeg/SDK，并以固定参数调用 SDK 命令行。

import { spawn } from 'node:child_process';
import type { DatabaseSync } from 'node:sqlite';
import type { BridgeRunResult, DeviceEnv, DeviceStatus, EnvProbe, ParsedDeviceFile } from '../contracts/app';
import { runCommand, terminateChild } from './media';
import { pythonCandidates, ffmpegCandidates, pythonRuntimeEnv as pythonEnvFor, uvPythonCandidates } from './tools';
export { pythonCandidates, ffmpegCandidates, userSiteDir, pythonRuntimeEnv } from './tools';
import { nowIso, readSetting } from './sql';
import { SDK_ACTION_SCRIPT } from './sdk-script';

export async function resolveFfmpeg(db: DatabaseSync): Promise<string | null> {
  for (const candidate of ffmpegCandidates(readSetting(db, 'ffmpeg_path'))) {
    const outcome = await runCommand(candidate, ['-hide_banner', '-version'], 8000);
    if (outcome.ok) return candidate;
  }
  return null;
}

function textField(stdout: string, key: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.includes(key)) continue;
    const index = Math.max(line.indexOf(':'), line.indexOf('：'));
    if (index < 0) continue;
    const value = line.slice(index + 1).trim();
    if (value) return value;
  }
  return null;
}

function firstNumber(value: string | null): number | null {
  if (!value) return null;
  const matched = /(\d+)/.exec(value);
  return matched ? Number(matched[1]) : null;
}

/** 解析 SDK `--action status` 输出的设备体检报告。 */
export function parseStatus(stdout: string): DeviceStatus | null {
  const serial = textField(stdout, '设备序列号');
  const battery = textField(stdout, '当前电量');
  const freeSpace = textField(stdout, '剩余存储空间');
  if (!serial && !battery && !freeSpace) return null;
  const firmwareRaw = textField(stdout, '固件版本号');
  const versionMatch = firmwareRaw ? /\(([^)]+)\)/.exec(firmwareRaw) : null;
  return {
    serial,
    mac: textField(stdout, '蓝牙 MAC'),
    firmware: versionMatch ? versionMatch[1] : firmwareRaw,
    batteryPct: firstNumber(battery),
    freeSpacePct: firstNumber(freeSpace),
    storageFormat: textField(stdout, '存储音频格式'),
    recordingState: textField(stdout, '当前录音状态'),
    hotspotSsid: textField(stdout, '热点 SSID'),
  };
}

export async function probePython(configured: string): Promise<{ probe: EnvProbe; command: string | null }> {
  const managed = await uvPythonCandidates();
  const candidates = [...new Set([...pythonCandidates(configured), ...managed].filter(Boolean))];
  for (const candidate of candidates) {
    const outcome = await runCommand(candidate, ['-c',
      'import sys;print(sys.executable);print("Python "+sys.version.split()[0]);sys.exit(0 if sys.version_info >= (3,10) else 1)',
    ], 8000);
    if (outcome.ok) {
      const [executable, version] = outcome.stdout.trim().split(/\r?\n/);
      if (!executable) continue;
      return { probe: { ok: true, detail: `${executable} · ${version}`, resolvedPath: executable }, command: executable };
    }
  }
  return { probe: { ok: false, detail: '未找到可用的 python 解释器', resolvedPath: null }, command: null };
}

export async function probeBleak(pythonCommand: string | null): Promise<EnvProbe> {
  if (!pythonCommand) return { ok: false, detail: '需要先有可用的 Python 才能检查 bleak', resolvedPath: null };
  const env = await pythonEnvFor(pythonCommand);
  const outcome = await runCommand(
    pythonCommand,
    ['-c', [
      'import bleak, importlib.metadata as m, sys',
      'if sys.platform == "win32":',
      '    from bleak.backends.winrt.client import BleakClientWinRT',
      '    from bleak.backends.winrt.scanner import BleakScannerWinRT',
      'elif sys.platform == "darwin":',
      '    from bleak.backends.corebluetooth.client import BleakClientCoreBluetooth',
      '    from bleak.backends.corebluetooth.scanner import BleakScannerCoreBluetooth',
      'elif sys.platform.startswith("linux"):',
      '    from bleak.backends.bluezdbus.client import BleakClientBlueZDBus',
      '    from bleak.backends.bluezdbus.scanner import BleakScannerBlueZDBus',
      'print("bleak " + m.version("bleak"))',
    ].join('\n')],
    25000,
    env,
  );
  if (outcome.ok) {
    const version = outcome.stdout.trim().replace(/^bleak\s+/, '') || 'unknown';
    return { ok: true, detail: `bleak ${version} 可导入`, resolvedPath: pythonCommand };
  }
  const hint = outcome.stderr.split('\n').filter(Boolean).pop() ?? 'import bleak 失败';
  return { ok: false, detail: hint.slice(0, 300), resolvedPath: null };
}

export async function probeSdk(pythonCommand: string | null): Promise<EnvProbe> {
  if (!pythonCommand) return { ok: false, detail: '需要先有可用的 Python 才能检查 memotalk-sdk', resolvedPath: null };
  const outcome = await runCommand(
    pythonCommand,
    ['-c', 'from memotalk import MemoTalkClient; from importlib.metadata import version; print("memotalk-sdk " + version("memotalk-sdk"))'],
    25000,
    await pythonEnvFor(pythonCommand),
  );
  return outcome.ok
    ? { ok: true, detail: `${outcome.stdout.trim()} 可导入`, resolvedPath: pythonCommand }
    : { ok: false, detail: `当前 Python 无法导入 memotalk-sdk：${outcome.stderr.trim().slice(-300)}`, resolvedPath: null };
}

export async function probeEnvironment(db: DatabaseSync): Promise<DeviceEnv> {
  const { probe: python, command } = await probePython(readSetting(db, 'python_path'));
  const bleak = await probeBleak(command);
  const sdk = await probeSdk(command);
  const ffmpegPath = await resolveFfmpeg(db);
  const ffmpeg: EnvProbe = ffmpegPath
    ? { ok: true, detail: ffmpegPath, resolvedPath: ffmpegPath }
    : { ok: false, detail: '未找到 ffmpeg，可在设置中填写绝对路径', resolvedPath: null };
  return { python, ffmpeg, bleak, sdk, checkedAt: nowIso() };
}

export type SdkAction = 'status' | 'list' | 'download';

let sdkBusy = false;

/** 是否有 SDK 调用在进行中；自动重连据此避让。 */
export function isSdkBusy(): boolean {
  return sdkBusy;
}

export interface SdkRunOptions {
  file?: string;
  outDir?: string;
}

export interface BridgeOutcome {
  result: BridgeRunResult;
  serial: string | null;
}

/** SDK 命令行走的是打印式输出，失败原因通常写在 [X] / [!] 开头的行里。 */
function sdkFailureHint(stdout: string): string | null {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.startsWith('[X]') || item.startsWith('[!]'));
  return line ? line.replace(/^\[[Xx!]\]\s*/, '') : null;
}

function parseFileLines(stdout: string): ParsedDeviceFile[] {
  const files: ParsedDeviceFile[] = [];
  const line = /^\s*\d+\.\s+(.+?)\s*\|\s*格式=([^\s|]+)\s*\|\s*大小=([\d,]+)\s*B\s*\|\s*时长=(\d+)s\s*\|\s*时间戳=(\d+)\s*$/gm;
  for (const match of stdout.matchAll(line)) {
    const [, name, format, size, duration, timestamp] = match;
    files.push({
      name: name.trim(),
      format,
      sizeBytes: Number(size.replace(/,/g, '')) || null,
      durationSec: Number(duration) || null,
      timestamp: Number(timestamp) || null,
    });
  }
  return files;
}

function parseSerial(stdout: string): string | null {
  const patterns = [/SN[:\s=]+([A-Za-z0-9-]{4,32})/i, /序列号[:\s=]+([A-Za-z0-9-]{4,32})/];
  for (const pattern of patterns) {
    const matched = pattern.exec(stdout);
    if (matched?.[1]) return matched[1];
  }
  return null;
}

/** 按固定参数运行 SDK 命令行；不接受用户拼接的任意命令。 */
export async function runSdkAction(
  db: DatabaseSync,
  action: SdkAction,
  options: SdkRunOptions = {},
  timeoutMs = 90000,
): Promise<BridgeOutcome> {
  const env = await probeEnvironment(db);
  const pythonCommand = env.python.resolvedPath;
  const commandLabel = `MemoTalkClient: ${action}${action === 'download' ? ` (${options.file ?? ''} -> ${options.outDir ?? ''})` : ''}`;

  if (!pythonCommand || !env.sdk.ok || !env.bleak.ok) {
    const message = !pythonCommand
      ? '缺少可用的 Python 解释器，无法调用 SDK。'
      : `当前 Python 的 memotalk-sdk 或 bleak 依赖不可用。请执行：uv pip install --python "${pythonCommand}" memotalk-sdk`;
    return {
      result: {
        ok: false,
        action,
        command: commandLabel,
        exitCode: null,
        stdout: '',
        stderr: '',
        parsedFiles: [],
        parsedStatus: null,
        message,
      },
      serial: null,
    };
  }

  const pythonEnv = await pythonEnvFor(pythonCommand);
  const callArgs =
    action === 'download'
      ? ['-X', 'utf8', '-c', SDK_ACTION_SCRIPT, '--action', action, '--file', options.file ?? '', '--out-dir', options.outDir ?? '']
      : ['-X', 'utf8', '-c', SDK_ACTION_SCRIPT, '--action', action];

  sdkBusy = true;
  const outcome = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(pythonCommand, callArgs, {
      windowsHide: true,
      ...(pythonEnv ? { env: pythonEnv } : {}),
    });
    child.stdin.end();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild(child);
      resolve({ code: null, stdout, stderr: `${stderr}\n[超时] SDK 调用超过 ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 400000) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 400000) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}` });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  }).finally(() => {
    sdkBusy = false;
  });

  const parsedFiles = parseFileLines(outcome.stdout);
  const parsedStatus = parseStatus(outcome.stdout);
  const crashed = /ModuleNotFoundError|Traceback/.test(`${outcome.stdout}${outcome.stderr}`);
  const ok = outcome.code === 0 && !crashed;
  const hint = sdkFailureHint(`${outcome.stdout}\n${outcome.stderr}`);
  const message = crashed
    ? 'SDK 运行失败，请检查 Python 依赖（bleak）与设备连接状态。'
    : ok
      ? action === 'status'
        ? `已连接设备${parsedStatus?.serial ? `：${parsedStatus.serial}` : ''}`
        : action === 'download'
        ? 'SDK 下载流程已结束，请查看下方输出确认结果。'
        : parsedFiles.length > 0
          ? `已读取 ${parsedFiles.length} 条设备文件记录。`
          : 'SDK 调用完成，但设备没有返回录音文件。'
      : hint ?? `SDK 调用未成功（退出码 ${outcome.code ?? '未知'}）。`;

  return {
    result: {
      ok,
      action,
      command: commandLabel,
      exitCode: outcome.code,
      stdout: outcome.stdout.slice(-20000),
      stderr: outcome.stderr.slice(-8000),
      parsedFiles,
      parsedStatus,
      message,
    },
    serial: parsedStatus?.serial ?? parseSerial(outcome.stdout) ?? readSetting(db, 'device_serial') ?? null,
  };
}
