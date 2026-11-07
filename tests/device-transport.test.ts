import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CommandOutcome } from '../src/server/media.ts';
import {
  BACKGROUND_BLE_LIMIT,
  DEFAULT_BLE_BPS,
  parseTransportSetting,
  parseWifiProbe,
  planTransfer,
  probeWifiCapable,
  resetWifiProbeCache,
  WIFI_MIN_BATCH_BYTES,
  type PlanInput,
} from '../src/server/device/transport.ts';

const MiB = 1_048_576;
const big = (name: string) => ({ name, sizeBytes: 2 * MiB });
const small = (name: string) => ({ name, sizeBytes: 100 * 1024 });

function plan(patch: Partial<PlanInput>) {
  return planTransfer({
    setting: 'auto', origin: 'user', allowBackgroundWifi: false, files: [], wifiCapable: true, platform: 'win32', ...patch,
  });
}

test('user sync picks Wi-Fi for large or unknown-size batches and BLE for small ones', () => {
  assert.equal(WIFI_MIN_BATCH_BYTES, MiB);
  for (const platform of ['win32', 'darwin', 'linux']) {
    assert.deepEqual(plan({ platform, files: [big('a.mp3')] }),
      { transport: 'wifi', include: ['a.mp3'], deferred: [], reason: 'large-batch' });
  }
  // Several small files whose total crosses the threshold still count as a large batch.
  const many = Array.from({ length: 11 }, (_, index) => small(`s${index}.mp3`));
  assert.equal(plan({ files: many }).transport, 'wifi');
  assert.equal(plan({ files: [{ name: 'x.mp3', sizeBytes: null }] }).reason, 'large-batch');
  assert.equal(plan({ files: [{ name: 'x.mp3', sizeBytes: MiB }] }).transport, 'wifi');
  assert.deepEqual(plan({ files: [{ name: 'x.mp3', sizeBytes: MiB - 1 }] }),
    { transport: 'ble', include: ['x.mp3'], deferred: [], reason: 'small-batch' });
});

test('missing adapter or unsupported platform falls back to BLE for every file', () => {
  assert.deepEqual(plan({ wifiCapable: false, files: [big('a.mp3')] }),
    { transport: 'ble', include: ['a.mp3'], deferred: [], reason: 'no-wifi-adapter' });
  assert.deepEqual(plan({ platform: 'freebsd', files: [big('a.mp3')] }),
    { transport: 'ble', include: ['a.mp3'], deferred: [], reason: 'unsupported-platform' });
});

test('forced settings override the size rule', () => {
  assert.deepEqual(plan({ setting: 'wifi', files: [small('a.mp3')] }),
    { transport: 'wifi', include: ['a.mp3'], deferred: [], reason: 'forced' });
  // Forced Wi-Fi does not need a detected adapter; the worker falls back on failure.
  assert.equal(plan({ setting: 'wifi', wifiCapable: false, files: [small('a.mp3')] }).transport, 'wifi');
  assert.deepEqual(plan({ setting: 'ble', files: [big('a.mp3'), big('b.mp3')] }),
    { transport: 'ble', include: ['a.mp3', 'b.mp3'], deferred: [], reason: 'forced' });
});

test('background sync never switches Wi-Fi unless allowed, and respects the BLE budget', () => {
  const files = [big('big1.mp3'), small('s1.mp3'), { name: 'unknown.mp3', sizeBytes: null }, small('s2.mp3'),
    small('s3.mp3'), small('s4.mp3'), big('big2.mp3')];
  const background = plan({ origin: 'auto', files });
  assert.equal(background.transport, 'ble');
  assert.equal(background.reason, 'background-no-wifi');
  assert.deepEqual(background.include, ['s1.mp3', 's2.mp3', 's3.mp3']);
  assert.equal(background.include.length, BACKGROUND_BLE_LIMIT.maxFiles);
  assert.deepEqual([...background.deferred].sort(), ['big1.mp3', 'big2.mp3', 's4.mp3', 'unknown.mp3']);

  const allowed = plan({ origin: 'auto', allowBackgroundWifi: true, files });
  assert.equal(allowed.transport, 'wifi');
  assert.equal(allowed.deferred.length, 0);

  // Allowed but small: BLE with the background budget applied.
  const smallOnly = plan({ origin: 'auto', allowBackgroundWifi: true, files: [small('a'), small('b'), small('c'), small('d')] });
  assert.deepEqual(smallOnly, { transport: 'ble', include: ['a', 'b', 'c'], deferred: ['d'], reason: 'small-batch' });

  // Forced BLE in the background is still budgeted (fast measured BLE: the file cap applies).
  const fast = 200_000;
  const forced = plan({ origin: 'auto', setting: 'ble', bleBps: fast, files: [big('a'), big('b'), big('c'), big('d')] });
  assert.deepEqual(forced, { transport: 'ble', include: ['a', 'b', 'c'], deferred: ['d'], reason: 'forced' });

  const noAdapter = plan({ origin: 'auto', allowBackgroundWifi: true, wifiCapable: false, bleBps: fast, files: [big('a'), big('b'), big('c'), big('d')] });
  assert.deepEqual(noAdapter, { transport: 'ble', include: ['a', 'b', 'c'], deferred: ['d'], reason: 'no-wifi-adapter' });
});

test('a background BLE round stays within the time budget, using the measured BLE speed', () => {
  assert.equal(BACKGROUND_BLE_LIMIT.budgetMs, 150_000);
  // Without a measurement the conservative 3 KB/s estimate applies: 2 MiB would take ~12 minutes.
  const unmeasured = plan({ origin: 'auto', setting: 'ble', files: [big('a'), small('b')] });
  assert.deepEqual(unmeasured, { transport: 'ble', include: ['b'], deferred: ['a'], reason: 'forced' });
  assert.equal(DEFAULT_BLE_BPS, 3_000);

  // 10 KB/s measured: 600 KB = 60 s each, so only two fit into 150 s.
  const kb600 = (name: string) => ({ name, sizeBytes: 600_000 });
  const measured = plan({ origin: 'auto', bleBps: 10_000, files: [kb600('a'), kb600('b'), kb600('c')] });
  assert.deepEqual(measured.include, ['a', 'b']);
  assert.deepEqual(measured.deferred, ['c']);

  // Unknown sizes cannot be bounded and wait for a user sync; user syncs are never budgeted.
  const unknown = plan({ origin: 'auto', setting: 'ble', bleBps: 200_000, files: [{ name: 'u', sizeBytes: null }, small('s')] });
  assert.deepEqual(unknown, { transport: 'ble', include: ['s'], deferred: ['u'], reason: 'forced' });
  assert.deepEqual(plan({ setting: 'ble', files: [big('a'), big('b')] }).deferred, []);
});

test('parseTransportSetting accepts only the three values', () => {
  assert.equal(parseTransportSetting('wifi'), 'wifi');
  assert.equal(parseTransportSetting('ble'), 'ble');
  assert.equal(parseTransportSetting('auto'), 'auto');
  assert.equal(parseTransportSetting('ftp'), 'auto');
});

const outcome = (stdout: string, ok = true, stderr = ''): CommandOutcome => ({ ok, code: ok ? 0 : 1, stdout, stderr });

test('Wi-Fi adapter probe parses each platform, including the Windows location prompt', () => {
  const drivers = 'Interface name: Wi-Fi\r\n\r\n    Driver                    : Intel(R) Wi-Fi 6 AX201\r\n    Vendor                    : Intel\r\n';
  assert.equal(parseWifiProbe('win32', outcome(drivers)), true);
  assert.equal(parseWifiProbe('win32', outcome('接口名称: WLAN\r\n    驱动程序 : Intel\r\n')), true);
  assert.equal(parseWifiProbe('win32', outcome('Network shell commands need location permission to access WLAN information.', false)), true);
  assert.equal(parseWifiProbe('win32', outcome('There is no wireless interface on the system.', false)), false);
  assert.equal(parseWifiProbe('win32', outcome('', false, 'The Wireless AutoConfig Service (wlansvc) is not running.')), false);
  assert.equal(parseWifiProbe('win32', outcome('', false)), false);
  assert.equal(parseWifiProbe('darwin', outcome('Hardware Port: Wi-Fi\nDevice: en0\n')), true);
  assert.equal(parseWifiProbe('darwin', outcome('Hardware Port: Ethernet\nDevice: en1\n')), false);
  assert.equal(parseWifiProbe('linux', outcome('ethernet\nwifi\nloopback\n')), true);
  assert.equal(parseWifiProbe('linux', outcome('ethernet\nloopback\n')), false);
  assert.equal(parseWifiProbe('linux', outcome('', false)), false);
  assert.equal(parseWifiProbe('aix', outcome('wifi')), false);
});

test('probeWifiCapable caches per platform and short-circuits in fake-device mode', async () => {
  resetWifiProbeCache();
  const calls: string[] = [];
  const exec = async (command: string, args: string[]) => {
    calls.push(`${command} ${args.join(' ')}`);
    return outcome('ethernet\nwifi\n');
  };
  assert.equal(await probeWifiCapable(exec, 'linux', {}), true);
  assert.equal(await probeWifiCapable(exec, 'linux', {}), true);
  assert.deepEqual(calls, ['nmcli -t -f TYPE dev']);

  assert.equal(await probeWifiCapable(async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    return outcome('Hardware Port: Ethernet');
  }, 'darwin', {}), false);
  assert.equal(calls.at(-1), 'networksetup -listallhardwareports');

  resetWifiProbeCache();
  assert.equal(await probeWifiCapable(async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    return outcome('There is no wireless interface on the system.', false);
  }, 'win32', {}), false);
  assert.equal(calls.at(-1), 'netsh wlan show drivers');

  resetWifiProbeCache();
  const before = calls.length;
  assert.equal(await probeWifiCapable(async () => {
    throw new Error('must not spawn in fake-device mode');
  }, 'win32', { OPENMINUTES_FAKE_DEVICE: 'ble' }), true);
  assert.equal(calls.length, before);
  resetWifiProbeCache();
});
