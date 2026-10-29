import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Never include connection contents or native command output in errors.
export function validateConnection(connection) {
  try {
    const url = new URL(connection.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || url.username || url.password || url.search || url.hash
      || url.pathname.split('/').filter(Boolean).length !== 3) throw new Error();
    return { url: url.href.replace(/\/$/, '') };
  } catch {
    throw new Error('HOST_ENDPOINT_INVALID');
  }
}

export function windowsHostInventory() {
  if (process.platform !== 'win32') throw new Error('HOST_DISCOVERY_REQUIRES_WINDOWS; use --no-host');
  const script = `
    $ErrorActionPreference = 'Stop'
    $pids = @(Get-Process -Name Floatboat -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Where-Object { $_.OwningProcess -in $pids } |
      ForEach-Object { @{ port = $_.LocalPort; address = $_.LocalAddress; pid = $_.OwningProcess } })
    @{ pids = $pids; listeners = $listeners } | ConvertTo-Json -Depth 4 -Compress
  `;
  try {
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch {
    throw new Error('HOST_PROCESS_INSPECTION_FAILED');
  }
}

export function assertHostListener(connection, inventory = windowsHostInventory()) {
  const endpoint = new URL(validateConnection(connection).url);
  if (!inventory.pids.length) throw new Error('FLOATBOAT_NOT_RUNNING; start Floatboat or use --no-host');
  const listener = inventory.listeners.find((item) =>
    item.port === Number(endpoint.port || 80)
    && ['127.0.0.1', '0.0.0.0', '::', '::ffff:127.0.0.1'].includes(item.address)
    && inventory.pids.includes(item.pid));
  if (!listener) throw new Error('HOST_LISTENER_NOT_OWNED_BY_FLOATBOAT; reopen this app in Floatboat or use --no-host');
}

export function discoverHost(appId, directory = join(process.env.APPDATA ?? '', 'floatboat', 'workbench', 'connections'),
  inventory = windowsHostInventory()) {
  if (!inventory.pids.length) throw new Error('FLOATBOAT_NOT_RUNNING; start Floatboat or use --no-host');
  let candidates;
  try {
    candidates = readdirSync(directory).filter((name) => name.endsWith('.json')).flatMap((name) => {
      const path = join(directory, name);
      try {
        const config = JSON.parse(readFileSync(path, 'utf8'));
        return config.appId === appId ? [{ connection: config.hostConnection, modified: statSync(path).mtimeMs }] : [];
      } catch {
        throw new Error('HOST_CONFIG_UNREADABLE');
      }
    });
  } catch {
    throw new Error('HOST_CONFIG_DISCOVERY_FAILED');
  }
  candidates.sort((a, b) => b.modified - a.modified);
  if (!candidates.length) throw new Error('HOST_CONFIG_NOT_FOUND; open this app in Floatboat or use --no-host');
  const connection = validateConnection(candidates[0].connection);
  assertHostListener(connection, inventory);
  return connection;
}

export async function probeHost(connection) {
  const endpoint = validateConnection(connection);
  try {
    const response = await fetch(`${endpoint.url}/v1/call`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ domain: 'capabilities', operation: 'list', input: {} }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    if (!response.ok || body.error || !body.data) throw new Error();
    return { available: true, probe: 'capabilities.list' };
  } catch {
    throw new Error('HOST_CAPABILITIES_PROBE_FAILED; reopen this app in Floatboat');
  }
}
