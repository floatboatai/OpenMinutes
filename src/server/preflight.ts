import { mkdtemp, mkdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkbenchServer } from '../../sdk/runtime.mjs';
import type { HostClient } from '../../sdk/host-contracts.mjs';
import type { DeviceEnv } from '../contracts/app';
import type { PreflightItem, PreflightReport } from '../contracts/preflight';
import { probeEnvironment, pythonRuntimeEnv } from './bridge';
import { libraryRoot } from './library';
import { resolveImportDir } from './ingest';
import { runCommand, verifyDecodable } from './media';

export function systemCheck(platform: string, arch: string): PreflightItem {
  const supported = ['win32', 'darwin', 'linux'].includes(platform) && ['x64', 'arm64'].includes(arch);
  return { id: 'system', label: '系统与架构', status: supported ? 'ok' : 'fail',
    reason: `${platform} / ${arch}`, autoRepair: false, action: supported ? '' : '请使用支持的 Windows、macOS 或 Linux x64/arm64 环境。' };
}

export function dependencyChecks(env: DeviceEnv): PreflightItem[] {
  return ([
    ['python', 'Python >=3.10', env.python],
    ['bleak', 'bleak', env.bleak],
    ['sdk', 'memotalk-sdk', env.sdk],
    ['ffmpeg', 'ffmpeg', env.ffmpeg],
  ] as const).map(([id, label, probe]) => ({
    id, label, status: probe.ok ? 'ok' : 'fail', reason: probe.detail, autoRepair: !probe.ok,
    action: probe.ok ? '' : id === 'ffmpeg'
      ? '安装用户级 ffmpeg，或在设置中填写已安装的 ffmpeg 绝对路径；系统级安装需先确认。'
      : '在本应用目录执行 uv venv --python 3.12 .venv，再执行 uv pip install --python .venv bleak memotalk-sdk（已有 .venv 不要覆盖）。用 uv run --no-project --python .venv python -c "import bleak, memotalk" 验证，再重新检测；自定义解释器需在设置中切换。',
  }));
}

const requiredOperations: Record<string, string[]> = {
  asr: ['start', 'sendFrame', 'stop', 'events'],
  llm: ['generateText'],
  agent: ['start', 'get'],
};

export function capabilityCheck(domain: string, entries: Array<{ operation: string; declared: boolean; status: string }>): PreflightItem {
  const available = new Set(entries.filter((entry) => entry.declared && entry.status === 'available')
    .map((entry) => entry.operation.startsWith(`${domain}.`) ? entry.operation.slice(domain.length + 1) : entry.operation));
  const missing = (requiredOperations[domain] ?? []).filter((operation) => !available.has(operation));
  return {
    id: `host-${domain}`, label: `Host ${domain}`, status: missing.length ? 'warn' : 'ok', autoRepair: false,
    reason: missing.length ? `${domain} 不可用：${missing.join(', ')}` : '能力已声明且可用；调用授权由 Host 检查',
    action: missing.length ? '在 Floatboat 中打开应用，授权对应能力并检查模型账户配置。' : '',
  };
}

export async function hostChecks(host: Pick<HostClient, 'capabilities'>): Promise<PreflightItem[]> {
  return Promise.all(['asr', 'llm', 'agent'].map(async (domain) => {
    try {
      return capabilityCheck(domain, (await host.capabilities.list({ domain })).capabilities);
    } catch (error) {
      return { ...capabilityCheck(domain, []), reason: `${domain} 不可用：${error instanceof Error ? error.message : String(error)}` };
    }
  }));
}

export async function writableDirectory(id: string, label: string, directory: string): Promise<PreflightItem> {
  const target = path.join(directory, `.openminutes-preflight-${randomUUID()}`);
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(target, '', { flag: 'wx' });
    await unlink(target);
    return { id, label, status: 'ok', reason: directory, autoRepair: false, action: '' };
  } catch (error) {
    return { id, label, status: 'fail', reason: `${directory}: ${error instanceof Error ? error.message : String(error)}`,
      autoRepair: true, action: '在应用设置中选择当前用户可写目录；不得删除录音、修改系统权限或移动已有数据。' };
  }
}

export function bluetoothPermission(value: string): Pick<PreflightItem, 'status' | 'reason'> {
  if (value === '3') return { status: 'ok', reason: 'CoreBluetooth 已授权；设备发现仍需实际连接验证（标识为 UUID）。' };
  if (value === '0') return { status: 'warn', reason: '蓝牙权限尚未请求。首次连接时需在 macOS 授权；本次未扫描设备。' };
  if (value === '1' || value === '2') return { status: 'fail', reason: 'macOS 蓝牙权限被限制或拒绝。' };
  return { status: 'warn', reason: '无法确认蓝牙授权，需在 macOS 真机首次连接时验证。' };
}

export async function bluetoothCheck(platform: NodeJS.Platform, env: DeviceEnv): Promise<PreflightItem> {
  const item: PreflightItem = { id: 'bluetooth', label: '蓝牙', status: 'warn',
    reason: '未连接设备；蓝牙可用性尚未确认。', autoRepair: false,
    action: '启用蓝牙；macOS 在系统设置 > 隐私与安全性 > 蓝牙中授权实际发起请求的应用。不得通过修改 TCC 数据库绕过授权。' };
  if (!env.bleak.ok || !env.python.resolvedPath) return { ...item, reason: '请先修复 Python/bleak，再检查蓝牙。' };
  if (platform === 'darwin') {
    const result = await runCommand(env.python.resolvedPath,
      ['-c', 'from CoreBluetooth import CBManager;print(CBManager.authorization())'], 8000,
      await pythonRuntimeEnv(env.python.resolvedPath));
    const permission = bluetoothPermission(result.ok ? result.stdout.trim() : '');
    if (permission.status !== 'ok') return { ...item, ...permission };
    const hardware = await runCommand('/usr/sbin/system_profiler', ['SPBluetoothDataType', '-json'], 12000);
    const powered = hardware.ok && /"controller_state"\s*:\s*"attrib_on"/.test(hardware.stdout);
    return { ...item, status: powered ? 'ok' : 'warn', reason: `${permission.reason} ${powered ? '控制器已开启。' : '控制器状态未确认，请检查蓝牙开关。'}` };
  }
  if (platform === 'win32') {
    const result = await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '@(Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction Stop | Where-Object Status -eq OK).Count'], 12000);
    return { ...item, status: result.ok && Number(result.stdout.trim()) > 0 ? 'ok' : 'warn',
      reason: result.ok && Number(result.stdout.trim()) > 0 ? '已发现正常的蓝牙设备；未扫描或连接录音笔。' : '未确认可用蓝牙适配器，请检查蓝牙开关和驱动。' };
  }
  if (platform === 'linux') {
    const result = await runCommand('bluetoothctl', ['show'], 8000);
    return { ...item, status: result.ok && /Powered:\s*yes/.test(result.stdout) ? 'ok' : 'warn',
      reason: result.ok && /Powered:\s*yes/.test(result.stdout) ? 'BlueZ 控制器已开启；未扫描设备。' : '未确认 BlueZ 控制器，检查 bluetoothd、蓝牙开关和 D-Bus 权限。' };
  }
  return item;
}

export async function decodeCheck(ffmpeg: string | null): Promise<PreflightItem> {
  const base: PreflightItem = { id: 'decode', label: '音频解码', status: 'fail', reason: '缺少 ffmpeg', autoRepair: true,
    action: '安装支持 WAV/PCM 和 MP3 解码的 ffmpeg，并在设置中填写路径。' };
  if (!ffmpeg) return base;
  let directory: string | null = null;
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'openminutes-decode-'));
    const file = path.join(directory, 'probe.wav');
    const wav = Buffer.alloc(44 + 3200);
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(3200, 40);
    await writeFile(file, wav);
    const result = await verifyDecodable(ffmpeg, file);
    return { ...base, status: result.ok ? 'ok' : 'fail', reason: result.message, autoRepair: !result.ok, action: result.ok ? '' : base.action };
  } catch (error) {
    return { ...base, reason: `无法完成解码检查：${String(error)}`, autoRepair: false,
      action: '检查系统临时目录是否可写及磁盘剩余空间，然后重新检测。' };
  } finally {
    if (directory) {
      await unlink(path.join(directory, 'probe.wav')).catch(() => undefined);
      await rmdir(directory).catch(() => undefined);
    }
  }
}

export interface PreflightDependencies {
  environment: () => Promise<DeviceEnv>;
  directories: () => Promise<PreflightItem[]>;
  host: () => Promise<PreflightItem[]>;
  bluetooth: (env: DeviceEnv) => Promise<PreflightItem>;
  decode: (ffmpeg: string | null) => Promise<PreflightItem>;
}

export function createPreflight(platform: NodeJS.Platform, arch: string, dependencies: PreflightDependencies) {
  let cached: { report: PreflightReport; env: DeviceEnv } | null = null;
  let pending: Promise<{ report: PreflightReport; env: DeviceEnv }> | null = null;
  async function inspect() {
    const env = await dependencies.environment();
    const [directories, host, bluetooth, decode] = await Promise.all([
      dependencies.directories(), dependencies.host(), dependencies.bluetooth(env), dependencies.decode(env.ffmpeg.resolvedPath),
    ]);
    const report: PreflightReport = { checkedAt: new Date().toISOString(), platform, arch,
      items: [systemCheck(platform, arch), ...dependencyChecks(env), decode, bluetooth, ...directories, ...host] };
    cached = { env, report };
    return cached;
  }
  return {
    get(refresh = false) {
      if (pending) return pending;
      if (!refresh && cached) return Promise.resolve(cached);
      pending = inspect().finally(() => { pending = null; });
      return pending;
    },
  };
}

export function appPreflight(app: WorkbenchServer) {
  return createPreflight(process.platform, process.arch, {
    environment: () => probeEnvironment(app.database),
    directories: () => Promise.all([
      writableDirectory('import-dir', '导入目录', resolveImportDir(app.database).directory),
      writableDirectory('library-dir', '归档目录', libraryRoot(app.database)),
    ]),
    host: () => hostChecks(app.host),
    bluetooth: (env) => bluetoothCheck(process.platform, env),
    decode: decodeCheck,
  });
}
