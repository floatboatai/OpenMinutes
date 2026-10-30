// Runs compiled UI against isolated data and an explicitly simulated Host. No BLE connection or agent executes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWorkbenchDatabase } from '../sdk/database.mjs';
import { checkMobile } from './mobile-preflight.mjs';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const scripts = process.env.OPENMINUTES_VERIFY_SCRIPTS;
assert.ok(scripts, 'Set OPENMINUTES_VERIFY_SCRIPTS to the existing verify-openminutes/scripts directory');
const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));

async function script(name, args) {
  const child = spawn(process.execPath, [path.join(scripts, name), ...args], {
    cwd: root, env: { ...process.env, OPENMINUTES_ROOT: root }, windowsHide: true, stdio: 'inherit',
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, name);
}

for (const simulated of [false, true]) {
  const runId = `preflight-${simulated ? 'fixture' : 'nohost'}-${Date.now()}`;
  const runDir = path.join(root, '.workbench', 'verify', runId);
  const evidenceDir = path.join(root, '.workbench', 'verify-evidence', runId);
  const dirs = { data: path.join(runDir, 'data'), inbox: path.join(runDir, 'inbox'),
    library: path.join(runDir, 'library'), browserProfile: path.join(runDir, 'browser-profile') };
  for (const directory of [dirs.data, dirs.library, dirs.browserProfile, evidenceDir]) await mkdir(directory, { recursive: true });
  // A file in place of inbox deterministically exercises a real, fixable preflight failure.
  await writeFile(dirs.inbox, 'E2E fixture. Never user data.');
  const db = await openWorkbenchDatabase({ appId: manifest.appId, dataDirectory: dirs.data, migrationsDirectory: path.join(root, 'migrations') });
  const values = {
    import_dir: dirs.inbox, library_dir: dirs.library,
    auto_connect: '0', auto_pull: '0', auto_transcribe: '0', auto_analyze: '0',
    ...(process.env.MEMOTALK_TEST_PYTHON ? { python_path: process.env.MEMOTALK_TEST_PYTHON } : {}),
  };
  for (const [key, value] of Object.entries(values)) {
    db.database.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  await db.close();
  const requests = [];
  let polls = 0;
  let recoveryMode = simulated ? 'running' : null;
  const host = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    requests.push(call);
    let data;
    if (call.domain === 'capabilities') {
      const operations = call.input.domain === 'agent' ? ['start', 'get', 'findByIdempotencyKey']
        : call.input.domain === 'asr' ? ['start', 'sendFrame', 'stop', 'events'] : ['generateText'];
      data = { capabilities: operations.map((operation) => ({ operation, declared: true, status: 'available' })) };
    } else if (call.domain === 'agent' && call.operation === 'start') {
      data = { runId: 'fixture-repair' };
    } else if (call.domain === 'agent' && call.operation === 'get') {
      if (recoveryMode === 'offline') {
        response.writeHead(503).end(JSON.stringify({ error: { code: 'FIXTURE_OFFLINE' } }));
        return;
      }
      polls++;
      data = { runId: 'fixture-repair', status: recoveryMode === 'running' || polls < 2 ? 'running' : 'completed',
        text: '模拟 Host：未执行安装或修改。', errorCode: null };
    } else {
      response.writeHead(400).end(JSON.stringify({ error: { code: 'UNEXPECTED_FIXTURE_CALL' } }));
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data }));
  });
  let child;
  let registered = false;
  try {
    let hostConnection;
    if (simulated) {
      await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
      hostConnection = { url: `http://127.0.0.1:${host.address().port}` };
    }
    const nonce = randomUUID();
    const configPath = path.join(runDir, 'workbench-config.json');
    await writeFile(configPath, JSON.stringify({
      appId: manifest.appId, generation: runId, nonce, sourceDirectory: root,
      dataDirectory: dirs.data, development: true, hostConnection,
    }));
    child = spawn(process.execPath, ['--enable-source-maps', path.join(root, manifest.server)], {
      cwd: root, env: { ...process.env, FLOATBOAT_WORKBENCH_CONFIG: configPath },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', (chunk) => { log += chunk; });
    child.stderr.on('data', (chunk) => { log += chunk; });
    const deadline = Date.now() + 30000;
    let url;
    while (!url && Date.now() < deadline) {
      const ready = log.split('\n').find((line) => line.startsWith('{"type":"ready"'));
      if (ready) url = JSON.parse(ready).url;
      else await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(url, log);
    await writeFile(path.join(runDir, 'run.json'), JSON.stringify({
      runId, url, pid: child.pid, nonce, root, runDir, evidenceDir, dirs, startedAt: new Date().toISOString(),
    }));
    registered = true;
    await script('doctor.mjs', [runId]);
    const initial = await fetch(`${url}/api/environment`).then((response) => response.json());
    assert.equal(initial.ok, true);
    assert.equal(initial.data.report.items.find((item) => item.id === 'import-dir').status, 'fail');
    assert.equal(requests.filter((call) => call.domain === 'agent').length, 0);
    const checkedAt = initial.data.report.checkedAt;
    const steps = [
      { goto: '#/device' }, { waitText: '本机环境', timeout: 60000 },
      { waitText: simulated ? 'Host agent' : 'agent 不可用', timeout: 60000 },
      { aria: 'before.aria.txt' }, { screenshot: 'before.png' },
      { click: 'text=重新检测' }, { waitText: '环境检测已刷新', timeout: 60000 },
      ...(simulated ? [
        { click: 'text=让 Floatboat 助手修复' },
        { waitText: '修复中', timeout: 60000 },
        { waitText: '模拟 Host：未执行安装或修改。', timeout: 60000 },
        { expectText: '模拟 Host：未执行安装或修改。' },
      ] : [{ expectText: 'agent 不可用' }]),
      { aria: 'after.aria.txt' }, { screenshot: 'after.png' },
    ];
    const stepsPath = path.join(runDir, 'steps.json');
    await writeFile(stepsPath, JSON.stringify(steps));
    await script('browse.mjs', [runId, 'device', `@${stepsPath}`]);
    await checkMobile({ runDir, evidenceDir, url });
    const after = await fetch(`${url}/api/environment`).then((response) => response.json());
    assert.notEqual(after.data.report.checkedAt, checkedAt);
    assert.equal(after.data.report.items.find((item) => item.id === 'import-dir').status, 'fail');
    if (simulated) {
      const starts = requests.filter((call) => call.domain === 'agent' && call.operation === 'start');
      assert.equal(starts.length, 1);
      assert.equal(path.resolve(starts[0].input.workingDirectory), path.resolve(root));
      assert.ok(starts[0].input.idempotencyKey);
      assert.equal(after.data.repair.status, 'running');
      // Stop only our child and reuse its isolated database. No actual Host is connected.
      const exited = new Promise((resolve) => child.once('close', resolve));
      child.kill();
      await exited;
      recoveryMode = 'offline';
      log = '';
      child = spawn(process.execPath, ['--enable-source-maps', path.join(root, manifest.server)], {
        cwd: root, env: { ...process.env, FLOATBOAT_WORKBENCH_CONFIG: configPath },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => { log += chunk; });
      child.stderr.on('data', (chunk) => { log += chunk; });
      url = undefined;
      const restartDeadline = Date.now() + 30000;
      while (!url && Date.now() < restartDeadline) {
        const ready = log.split('\n').find((line) => line.startsWith('{"type":"ready"'));
        if (ready) url = JSON.parse(ready).url;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(url, log);
      await writeFile(path.join(runDir, 'run.json'), JSON.stringify({
        runId, url, pid: child.pid, nonce, root, runDir, evidenceDir, dirs, startedAt: new Date().toISOString(),
      }));
      await script('doctor.mjs', [runId]);
      await writeFile(stepsPath, JSON.stringify([
        { goto: '#/device' }, { waitText: '修复结果未知，已禁止重复提交', timeout: 60000 },
        { eval: "(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.includes('让 Floatboat 助手修复')); if (!b?.disabled) throw new Error('repair must be disabled'); return true; })()" },
        { aria: 'unknown.aria.txt' }, { screenshot: 'unknown.png' },
      ]));
      await script('browse.mjs', [runId, 'restart-unknown', `@${stepsPath}`]);
      const blocked = await fetch(`${url}/api/environment/repair`, { method: 'POST' }).then((response) => response.json());
      assert.equal(blocked.data.status, 'unknown');
      assert.equal(blocked.data.idempotencyKey, starts[0].input.idempotencyKey);
      recoveryMode = 'running';
      await writeFile(stepsPath, JSON.stringify([
        { goto: '#/device' }, { waitText: '修复中', timeout: 60000 },
        { aria: 'running.aria.txt' }, { screenshot: 'running.png' },
      ]));
      await script('browse.mjs', [runId, 'restart-running', `@${stepsPath}`]);
      recoveryMode = 'completed';
      await writeFile(stepsPath, JSON.stringify([
        { goto: '#/device' }, { waitText: '已重新检测', timeout: 60000 },
        { aria: 'completed.aria.txt' }, { screenshot: 'completed.png' },
      ]));
      await script('browse.mjs', [runId, 'restart-completed', `@${stepsPath}`]);
      const recovered = await fetch(`${url}/api/environment`).then((response) => response.json());
      assert.equal(recovered.data.repair.status, 'completed');
      assert.equal(recovered.data.repair.idempotencyKey, starts[0].input.idempotencyKey);
      assert.equal(requests.filter((call) => call.domain === 'agent' && call.operation === 'start').length, 1);
      await writeFile(path.join(evidenceDir, 'recovered.json'), JSON.stringify(recovered, null, 2));
    } else {
      const denied = await fetch(`${url}/api/environment/repair`, { method: 'POST' }).then((response) => response.json());
      assert.equal(denied.ok, false);
      assert.match(denied.error, /agent 不可用/);
      await writeFile(path.join(evidenceDir, 'repair-denied.json'), JSON.stringify(denied, null, 2));
    }
    assert.equal((await readFile(path.join(evidenceDir, 'device', 'console.log'), 'utf8')).trim(), '');
    await writeFile(path.join(evidenceDir, 'environment.json'), JSON.stringify(after, null, 2));
    await writeFile(path.join(evidenceDir, 'host-fixture-requests.json'), JSON.stringify(requests, null, 2));
    await writeFile(path.join(evidenceDir, 'server.log'), log);
    console.log(`Verified ${runId}; evidence: ${evidenceDir}`);
  } finally {
    try {
      if (registered) {
        try {
          await script('cleanup.mjs', [runId]);
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          await script('cleanup.mjs', [runId]);
        }
      } else child?.kill();
    } finally {
      if (host.listening) await new Promise((resolve) => host.close(resolve));
    }
  }
}
