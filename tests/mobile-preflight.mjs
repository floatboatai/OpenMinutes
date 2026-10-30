import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function checkMobile(run) {
  const executable = [process.env.VERIFY_BROWSER, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/chromium']
    .find((candidate) => candidate && existsSync(candidate));
  assert.ok(executable, 'Chrome/Edge required');
  const profile = path.join(run.runDir, 'mobile-profile');
  await mkdir(profile);
  const browser = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 100 && !port; attempt++) {
      try { port = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0].trim(); } catch {}
      if (!port) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(port);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    socket = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const pending = new Map();
    const errors = [];
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `${run.url}/#/device` });
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      const value = await send('Runtime.evaluate', { expression: '!!document.querySelector("[data-preflight-id=system]")', returnByValue: true });
      ready = value.result.value === true;
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.ok(ready, 'mobile preflight rendered');
    const measured = await send('Runtime.evaluate', { returnByValue: true, expression: `({
      viewport: innerWidth,
      width: document.documentElement.scrollWidth,
      rows: [...document.querySelectorAll('.environment-panel .env__row')].map(row => ({
        id: row.dataset.preflightId,
        width: row.getBoundingClientRect().width,
        overflow: row.scrollWidth > row.clientWidth,
        text: row.innerText
      }))
    })` });
    assert.equal(measured.result.value.viewport, 390);
    assert.ok(measured.result.value.width <= 390, JSON.stringify(measured.result.value));
    assert.ok(measured.result.value.rows.every((row) => !row.overflow));
    assert.deepEqual(errors, []);
    await writeFile(path.join(run.evidenceDir, 'mobile-layout.json'), JSON.stringify(measured.result.value, null, 2));
    const metrics = await send('Page.getLayoutMetrics');
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 390, height: Math.min(metrics.cssContentSize.height, 4500), scale: 1 } });
    await writeFile(path.join(run.evidenceDir, 'mobile.png'), Buffer.from(screenshot.data, 'base64'));
  } finally {
    const closed = new Promise((resolve) => browser.exitCode !== null || browser.signalCode !== null ? resolve() : browser.once('close', resolve));
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: 999999, method: 'Browser.close' }));
    } else {
      browser.kill();
    }
    const timer = setTimeout(() => browser.kill(), 5000);
    timer.unref();
    await closed;
    clearTimeout(timer);
    socket?.close();
  }
}
