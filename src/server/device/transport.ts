// ABOUTME: 传输规划：按来源、批量大小与本机无线网卡决定走无线快传（热点 + FTP）还是蓝牙。

import type { DeviceOrigin, Transport, TransportSetting } from '../../contracts/device';
import { runCommand, type CommandOutcome } from '../media';

export type { TransportSetting } from '../../contracts/device';

/** 真机验收后按实测吞吐调整（见计划 §8.5）。 */
export const WIFI_MIN_BATCH_BYTES = 1_048_576;
export const BACKGROUND_BLE_LIMIT = { maxFiles: 3, budgetMs: 150_000 };
/** 还没有实测蓝牙吞吐时的保守估算（与拉取超时的 3 KB/s 一致）。 */
export const DEFAULT_BLE_BPS = 3_000;

const WIFI_PLATFORMS: ReadonlySet<string> = new Set(['win32', 'darwin', 'linux']);

export interface PlanInput {
  setting: TransportSetting;
  origin: DeviceOrigin;
  allowBackgroundWifi: boolean;
  files: Array<{ name: string; sizeBytes: number | null }>;
  wifiCapable: boolean;
  platform: NodeJS.Platform | string;
  /** 实测蓝牙吞吐（字节/秒）；后台同步按它估算是否超出单轮时长预算。 */
  bleBps?: number | null;
}

export interface TransferPlan {
  transport: Transport;
  include: string[];
  deferred: string[];
  reason: 'forced' | 'large-batch' | 'small-batch' | 'no-wifi-adapter' | 'unsupported-platform' | 'background-no-wifi';
}

type PlanFile = PlanInput['files'][number];

/**
 * 后台蓝牙单轮最多 maxFiles 个，且估算耗时不超过 budgetMs；大小未知的无法估算，留给下一次用户同步。
 * 超出预算的文件挪到 deferred，保持录音笔按时释放、会话按时自动断开。
 */
function limitBackground(files: PlanFile[], bleBps: number | null | undefined): { include: string[]; deferred: string[] } {
  const bps = bleBps && bleBps > 0 ? bleBps : DEFAULT_BLE_BPS;
  const include: string[] = [];
  const deferred: string[] = [];
  let spentMs = 0;
  for (const file of files) {
    const costMs = file.sizeBytes === null ? Number.POSITIVE_INFINITY : (file.sizeBytes / bps) * 1000;
    if (include.length < BACKGROUND_BLE_LIMIT.maxFiles && spentMs + costMs <= BACKGROUND_BLE_LIMIT.budgetMs) {
      include.push(file.name);
      spentMs += costMs;
    } else {
      deferred.push(file.name);
    }
  }
  return { include, deferred };
}

export function parseTransportSetting(value: string): TransportSetting {
  return value === 'wifi' || value === 'ble' ? value : 'auto';
}

export function planTransfer(input: PlanInput): TransferPlan {
  const names = input.files.map((file) => file.name);
  if (input.setting === 'ble') {
    if (input.origin === 'auto') return { transport: 'ble', ...limitBackground(input.files, input.bleBps), reason: 'forced' };
    return { transport: 'ble', include: names, deferred: [], reason: 'forced' };
  }

  const platformOk = WIFI_PLATFORMS.has(input.platform);
  const wifiOk = input.setting === 'wifi' || (platformOk && input.wifiCapable);

  if (input.origin === 'auto' && !input.allowBackgroundWifi) {
    const small = input.files.filter((file) => file.sizeBytes !== null && file.sizeBytes < WIFI_MIN_BATCH_BYTES);
    const smallNames = small.map((file) => file.name);
    const limited = limitBackground(small, input.bleBps);
    const deferred = [...names.filter((name) => !smallNames.includes(name)), ...limited.deferred];
    return { transport: 'ble', include: limited.include, deferred, reason: 'background-no-wifi' };
  }

  const background = input.origin === 'auto';
  if (!wifiOk) {
    const reason = platformOk ? 'no-wifi-adapter' : 'unsupported-platform';
    return background
      ? { transport: 'ble', ...limitBackground(input.files, input.bleBps), reason }
      : { transport: 'ble', include: names, deferred: [], reason };
  }
  if (input.setting === 'wifi') return { transport: 'wifi', include: names, deferred: [], reason: 'forced' };

  const unknownSize = input.files.some((file) => file.sizeBytes === null);
  const total = input.files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0);
  if (unknownSize || total >= WIFI_MIN_BATCH_BYTES) {
    return { transport: 'wifi', include: names, deferred: [], reason: 'large-batch' };
  }
  return background
    ? { transport: 'ble', ...limitBackground(input.files, input.bleBps), reason: 'small-batch' }
    : { transport: 'ble', include: names, deferred: [], reason: 'small-batch' };
}

export type ExecFn = (command: string, args: string[]) => Promise<CommandOutcome>;

const defaultExec: ExecFn = (command, args) => runCommand(command, args, 8000);

/** Windows 24H2 起 netsh 可能因定位权限拒绝输出，但这本身说明本机有无线网卡。 */
const LOCATION_HINT = /location|定位|位置/i;

export function parseWifiProbe(platform: string, outcome: CommandOutcome): boolean {
  const text = `${outcome.stdout}\n${outcome.stderr}`;
  if (platform === 'win32') {
    if (/no wireless interface|没有无线接口|wlansvc|is not running|未运行/i.test(text)) return false;
    if (LOCATION_HINT.test(text)) return true;
    if (!outcome.ok) return false;
    if (/(Interface name|接口名称|Driver|驱动程序)\s*:/i.test(text)) return true;
    // 非 UTF-8 代码页下字段名可能乱码；有多行 “字段 : 值” 的驱动块也算有网卡。
    return outcome.stdout.split(/\r?\n/).filter((line) => /^\s*\S.*\s:\s+\S/.test(line)).length >= 3;
  }
  if (platform === 'darwin') return outcome.ok && /Wi-?Fi|AirPort/i.test(outcome.stdout);
  if (platform === 'linux') return outcome.ok && /^wifi$/im.test(outcome.stdout);
  return false;
}

function probeCommand(platform: string): [string, string[]] | null {
  if (platform === 'win32') return ['netsh', ['wlan', 'show', 'drivers']];
  if (platform === 'darwin') return ['networksetup', ['-listallhardwareports']];
  if (platform === 'linux') return ['nmcli', ['-t', '-f', 'TYPE', 'dev']];
  return null;
}

const CACHE_MS = 10 * 60_000;
let cached: { platform: string; value: boolean; at: number } | null = null;

export function resetWifiProbeCache(): void {
  cached = null;
}

/** 缓存 10 分钟；假设备模式直接返回 true，保证测试走到无线快传分支。 */
export async function probeWifiCapable(
  exec: ExecFn = defaultExec,
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (env.OPENMINUTES_FAKE_DEVICE) return true;
  if (cached && cached.platform === platform && Date.now() - cached.at < CACHE_MS) return cached.value;
  const command = probeCommand(platform);
  const value = command ? parseWifiProbe(platform, await exec(command[0], command[1])) : false;
  cached = { platform, value, at: Date.now() };
  return value;
}

export function cachedWifiCapable(): boolean | null {
  return cached ? cached.value : null;
}
