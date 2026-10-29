#!/usr/bin/env node
// Drives the run's UI in a private headless Chrome/Edge over CDP (no npm deps), one session per call.
// Usage: node .claude/skills/verify-openminutes/scripts/browse.mjs <runId> <label> '<steps JSON array>'
//        node .claude/skills/verify-openminutes/scripts/browse.mjs <runId> <label> @steps.json
// Artifacts land in .workbench/verify-evidence/<runId>/<label>/ (steps.log, *.png, *.aria.txt, console.log).
//
// Steps (selectors: CSS, `aria=<aria-label>`, or `text=<exact visible text>`):
//   {"goto":"#/library"}                       navigate (relative to the run url) and wait for #root content
//   {"waitFor":"<sel>","timeout":10000}        wait until the element exists
//   {"waitText":"已归档"}                        wait until the page's visible text contains the string
//   {"waitNoText":"转录已排队"}                   wait until the string is gone from the visible text
//   {"click":"<sel>"}                          click the element's center with a real mouse event
//   {"fill":"<sel>","value":"..."}             replace an input/textarea value the way typing would
//   {"select":"<sel>","value":"..."}           choose a <select> option by value
//   {"press":"Enter"}                          key press on the focused element (Enter, Escape, Tab)
//   {"eval":"<js expression>"}                 log the (awaited, JSON-able) result
//   {"expectText":"..."} / {"expectNoText":"..."}   assert on visible text; failure exits 1
//   {"screenshot":"name.png"}                  full-page PNG
//   {"aria":"name.aria.txt"}                   accessibility tree (role "name" [value]) as text
//   {"sleep":500}
// window.confirm/alert dialogs are auto-accepted and their text is written to steps.log.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const [runId, label, stepsArg] = process.argv.slice(2);
if (!runId || !label || !stepsArg) {
  console.error("usage: browse.mjs <runId> <label> '<steps JSON>' | @file.json");
  process.exit(2);
}
const run = JSON.parse(readFileSync(join(root, '.workbench', 'verify', runId, 'run.json'), 'utf8'));
const steps = JSON.parse(stepsArg.startsWith('@') ? readFileSync(stepsArg.slice(1), 'utf8') : stepsArg);
const out = join(run.evidenceDir, label);
mkdirSync(out, { recursive: true });
const logLine = (line) => {
  console.log(line);
  appendFileSync(join(out, 'steps.log'), `${line}\n`);
};

const browserPath = [
  process.env.VERIFY_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((candidate) => candidate && existsSync(candidate));
if (!browserPath) throw new Error('no Chrome/Edge found; set VERIFY_BROWSER');

const profile = run.dirs.browserProfile;
const portFile = join(profile, 'DevToolsActivePort');
writeFileSync(portFile, '');
const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--window-size=1400,900',
    '--no-first-run',
    '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

let exitCode = 0;
let socket;
try {
  const port = await until(() => readFileSync(portFile, 'utf8').split('\n')[0].trim() || null, 15_000, 'DevToolsActivePort');
  const targets = await until(async () => {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    return list.find((target) => target.type === 'page') ?? null;
  }, 10_000, 'page target');
  socket = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((done, fail) => {
    socket.onopen = done;
    socket.onerror = fail;
  });
  const cdp = connect(socket);
  const consoleLines = [];
  cdp.on('Runtime.consoleAPICalled', (event) => {
    if (event.type === 'error' || event.type === 'warning') {
      consoleLines.push(`[${event.type}] ${event.args.map((arg) => arg.value ?? arg.description ?? '').join(' ')}`);
    }
  });
  cdp.on('Runtime.exceptionThrown', (event) => {
    consoleLines.push(`[exception] ${event.exceptionDetails.exception?.description ?? event.exceptionDetails.text}`);
  });
  // window.confirm/alert would block headless Chrome forever; accept them and keep the text as evidence.
  cdp.on('Page.javascriptDialogOpening', (event) => {
    logLine(`  dialog ${event.type}: ${event.message} -> accepted`);
    void cdp.send('Page.handleJavaScriptDialog', { accept: true });
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Accessibility.enable');
  logLine(`# run ${runId} ${run.url} label=${label} browser=${browserPath}`);

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  };
  const find = (selector) => `(() => {
    const sel = ${JSON.stringify(selector)};
    const visible = (el) => el.getClientRects().length > 0;
    if (sel.startsWith('aria=')) return [...document.querySelectorAll('[aria-label]')].find((el) => el.getAttribute('aria-label') === sel.slice(5) && visible(el)) ?? null;
    if (sel.startsWith('text=')) {
      const want = sel.slice(5);
      const all = [...document.querySelectorAll('button, a, [role], label, option, td, th, li, span, div, h1, h2, h3, p')];
      return all.find((el) => visible(el) && el.innerText?.trim() === want && ![...el.children].some((child) => child.innerText?.trim() === want)) ?? null;
    }
    return document.querySelector(sel);
  })()`;
  const visibleText = () => evaluate('document.body.innerText');

  for (const step of steps) {
    const name = JSON.stringify(step);
    if (step.goto !== undefined) {
      await cdp.send('Page.navigate', { url: new URL(step.goto, `${run.url}/`).href });
      await until(() => evaluate("document.readyState === 'complete' && document.querySelector('#root')?.children.length > 0"), 15_000, 'page render');
    } else if (step.waitFor) {
      await until(() => evaluate(`!!${find(step.waitFor)}`), step.timeout ?? 10_000, step.waitFor);
    } else if (step.waitText) {
      await until(async () => (await visibleText()).includes(step.waitText), step.timeout ?? 10_000, `text ${step.waitText}`);
    } else if (step.waitNoText) {
      await until(async () => !(await visibleText()).includes(step.waitNoText), step.timeout ?? 10_000, `text gone ${step.waitNoText}`);
    } else if (step.click) {
      const box = await until(
        () => evaluate(`(() => { const el = ${find(step.click)}; if (!el) return null; el.scrollIntoView({block: 'center'}); const r = el.getBoundingClientRect(); return {x: r.x + r.width / 2, y: r.y + r.height / 2}; })()`),
        step.timeout ?? 10_000,
        step.click,
      );
      for (const type of ['mousePressed', 'mouseReleased']) {
        await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
      }
    } else if (step.fill) {
      await until(() => evaluate(`!!${find(step.fill)}`), step.timeout ?? 10_000, step.fill);
      await evaluate(`(() => { const el = ${find(step.fill)}; el.focus(); el.select?.(); })()`);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await cdp.send('Input.insertText', { text: String(step.value) });
    } else if (step.select) {
      await until(() => evaluate(`!!${find(step.select)}`), step.timeout ?? 10_000, step.select);
      await evaluate(`(() => { const el = ${find(step.select)}; const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(el, ${JSON.stringify(String(step.value))}); el.dispatchEvent(new Event('change', {bubbles: true})); })()`);
    } else if (step.press) {
      const keys = { Enter: [13, '\r'], Escape: [27, ''], Tab: [9, ''] };
      const [code, text] = keys[step.press] ?? [0, ''];
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.press, code: step.press, windowsVirtualKeyCode: code, text });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.press, code: step.press, windowsVirtualKeyCode: code });
    } else if (step.eval) {
      logLine(`  = ${JSON.stringify(await evaluate(step.eval))}`);
    } else if (step.expectText !== undefined) {
      if (!(await visibleText()).includes(step.expectText)) throw new Error(`expected visible text: ${step.expectText}`);
    } else if (step.expectNoText !== undefined) {
      if ((await visibleText()).includes(step.expectNoText)) throw new Error(`unexpected visible text: ${step.expectNoText}`);
    } else if (step.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      writeFileSync(join(out, step.screenshot), Buffer.from(shot.data, 'base64'));
    } else if (step.aria) {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree');
      writeFileSync(join(out, step.aria), renderAx(nodes));
    } else if (step.sleep) {
      await new Promise((done) => setTimeout(done, step.sleep));
    } else {
      throw new Error(`unknown step ${name}`);
    }
    logLine(`ok ${name}`);
  }
  writeFileSync(join(out, 'console.log'), consoleLines.join('\n'));
  logLine(`# done; console errors/warnings: ${consoleLines.length}`);
} catch (error) {
  exitCode = 1;
  logLine(`FAIL ${error.message}`);
} finally {
  socket?.close();
  browser.kill();
}
process.exit(exitCode);

function connect(ws) {
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id !== undefined) {
      const entry = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) entry?.fail(new Error(`${data.error.message} ${data.error.data ?? ''}`));
      else entry?.done(data.result);
    } else {
      listeners.get(data.method)?.(data.params);
    }
  };
  return {
    send: (method, params = {}) =>
      new Promise((done, fail) => {
        const id = ++nextId;
        pending.set(id, { done, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    on: (method, handler) => listeners.set(method, handler),
  };
}

async function until(probe, timeout, what) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((done) => setTimeout(done, 150));
  }
  throw new Error(`timed out waiting for ${what}${lastError ? ` (${lastError.message})` : ''}`);
}

function renderAx(nodes) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const lines = [];
  const skip = new Set(['generic', 'none', 'InlineTextBox', 'LineBreak']);
  const walk = (node, depth) => {
    const role = node.role?.value;
    const name = node.name?.value ?? '';
    const value = node.value?.value;
    const shown = !node.ignored && role && !skip.has(role) && !(role === 'StaticText' && !name.trim());
    if (shown) lines.push(`${'  '.repeat(depth)}${role}${name ? ` "${name}"` : ''}${value !== undefined && value !== '' ? ` [${value}]` : ''}`);
    for (const childId of node.childIds ?? []) {
      const child = byId.get(childId);
      if (child) walk(child, shown ? depth + 1 : depth);
    }
  };
  walk(nodes[0], 0);
  return `${lines.join('\n')}\n`;
}
