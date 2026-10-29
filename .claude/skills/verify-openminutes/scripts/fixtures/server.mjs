// Test-only server. It never loads the app, Host, BLE, or user data.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const config = JSON.parse(readFileSync(process.env.FLOATBOAT_WORKBENCH_CONFIG, 'utf8'));
const root = config.sourceDirectory;
const { mode } = JSON.parse(readFileSync(join(root, 'fixture-mode.json'), 'utf8'));
writeFileSync(join(root, 'child.pid'), String(process.pid));
const db = new DatabaseSync(join(config.dataDirectory, 'data.sqlite'), { readOnly: true });
writeFileSync(join(root, 'initial-settings.json'), JSON.stringify(db.prepare('SELECT key, value FROM settings').all()));
db.close();
const server = createServer((req, res) => {
  appendFileSync(join(root, 'requests.log'), `${req.method} ${req.url}\n`);
  if (req.url === '/__workbench/health') {
    if (mode === 'health-hang') return;
    res.writeHead(mode !== 'wrong-nonce' && req.headers.authorization === `Bearer ${config.nonce}` ? 200 : 401);
    res.end(JSON.stringify({
      pid: mode === 'wrong-pid' ? process.pid + 1 : process.pid,
      generation: mode === 'wrong-generation' ? 'other' : config.generation,
    }));
  } else {
    if (mode === 'fetch-rejection') { req.socket.destroy(); return; }
    if (mode === 'patch-hang') return;
    if (mode === 'write-failure') mkdirSync(join(dirname(config.dataDirectory), 'run.json'));
    res.writeHead(mode === 'http-error' ? 500 : 200);
    res.end(mode === 'bad-json' ? '{' : JSON.stringify({ ok: mode !== 'patch-failure' }));
  }
});
server.listen(0, '127.0.0.1', () => {
  if (mode === 'timeout') return;
  if (mode === 'bad-ready') { console.log('{"type":"ready",bad}'); return; }
  console.log(JSON.stringify({ type: 'ready', url: `http://127.0.0.1:${server.address().port}` }));
});
