import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { validateConnection, discoverHost, assertHostListener, probeHost } from './host.mjs';

const connection = { url: 'http://127.0.0.1:12345/context/app/secret' };
const inventory = { pids: [123], listeners: [{ port: 12345, address: '127.0.0.1', pid: 123 }] };

test('accepts local connection and copies only url', () => {
  assert.deepEqual(validateConnection({ ...connection, token: 'old-token', dataDirectory: 'real' }), connection);
});
test('rejects unsafe endpoints without disclosing them', () => {
  for (const url of ['https://127.0.0.1/a/b/c', 'http://localhost/a/b/c', 'http://user:secret@127.0.0.1/a/b/c',
    'http://127.0.0.1/a/b/c?token=secret', 'http://127.0.0.1/a/b/c#secret', 'invalid-secret']) {
    assert.throws(() => validateConnection({ url }), { message: 'HOST_ENDPOINT_INVALID' });
  }
});
test('requires live Floatboat ownership, not merely an open port', () => {
  assert.doesNotThrow(() => assertHostListener(connection, inventory));
  assert.throws(() => assertHostListener(connection, { pids: [], listeners: [] }), /FLOATBOAT_NOT_RUNNING/);
  assert.throws(() => assertHostListener(connection, { ...inventory, pids: [456] }), /HOST_LISTENER_NOT_OWNED/);
});
test('uses newest matching app config and fails closed on stale newest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'verify-host-test-'));
  try {
    const put = (name, appId, hostConnection, time) => {
      const path = join(directory, name);
      writeFileSync(path, JSON.stringify({ appId, hostConnection, dataDirectory: 'never-copy' }));
      utimesSync(path, time, time);
    };
    put('old.json', 'app', { url: 'http://127.0.0.1:1/a/b/c' }, 1);
    put('new.json', 'app', connection, 2);
    put('other.json', 'other', { url: 'http://127.0.0.1:2/a/b/c' }, 3);
    assert.deepEqual(discoverHost('app', directory, inventory), connection);
    assert.throws(() => discoverHost('absent', directory, inventory), /HOST_CONFIG_NOT_FOUND/);
    put('latest.json', 'app', { url: 'http://127.0.0.1:3/a/b/c' }, 4);
    assert.throws(() => discoverHost('app', directory, inventory), /HOST_LISTENER_NOT_OWNED/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test('probe issues exactly one metadata call and redacts server errors', async () => {
  const calls = [];
  let fail = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    calls.push({ method: req.method, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(fail ? { error: { message: connection.url } } : { data: { capabilities: [] } }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const local = { url: `http://127.0.0.1:${server.address().port}/a/b/c` };
    assert.deepEqual(await probeHost(local), { available: true, probe: 'capabilities.list' });
    assert.deepEqual(calls, [{ method: 'POST', body: { domain: 'capabilities', operation: 'list', input: {} } }]);
    fail = true;
    await assert.rejects(probeHost(local), /HOST_CAPABILITIES_PROBE_FAILED/);
  } finally {
    await new Promise((done) => server.close(done));
  }
});
