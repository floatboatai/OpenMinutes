// Supplemental Playwright checks against the isolated verify-openminutes run.
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';

const runId = process.argv[2];
const skill = process.env.OPENMINUTES_VERIFY_SKILL;
if (!runId || !skill) throw new Error('Provide runId and OPENMINUTES_VERIFY_SKILL');
const root = process.cwd();
const run = JSON.parse(readFileSync(join(root, '.workbench/verify', runId, 'run.json'), 'utf8'));
const doctor = spawnSync(process.execPath, [join(skill, 'doctor.mjs'), runId], {
  env: { ...process.env, OPENMINUTES_ROOT: root }, stdio: 'inherit', windowsHide: true,
});
assert.equal(doctor.status, 0);
const out = join(run.evidenceDir, 'responsive');
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const findings = [];
try {
  for (const [width, height, colorScheme] of [[1440, 1000, 'light'], [1024, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, timezoneId: 'Pacific/Port_Moresby' });
    const page = await context.newPage();
    const errors = [];
    const baselineWarnings = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      if (message.location().url === `${run.url}/favicon.ico`) baselineWarnings.push('Existing favicon.ico returns 404');
      else errors.push(message.text());
    });
    await page.goto(`${run.url}/#/calendar`);
    await page.getByLabel('日历截止日期').fill('2026-10-29');
    await page.getByRole('button', { name: /10:00 - 11:00 产品项目评审/ }).click();
    await expect(page.getByRole('heading', { name: '产品项目评审', exact: true })).toBeVisible();
    await expect(page.getByLabel('关联事件：REC20261029_101500.mp3')).toHaveValue('1');
    await page.getByRole('button', { name: '生成事件纪要', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('LLM 不可用');
    const overflow = await page.evaluate(() => ({
      viewport: innerWidth, document: document.documentElement.scrollWidth,
      controls: [...document.querySelectorAll('.calendar-page button, .calendar-page select, .calendar-page input:not([hidden])')]
        .filter((element) => element.getClientRects().length && element.scrollWidth > element.clientWidth + 2)
        .map((element) => element.textContent?.trim()),
    }));
    assert.ok(overflow.document <= overflow.viewport, `page overflows at ${width}: ${JSON.stringify(overflow)}`);
    assert.deepEqual(overflow.controls, [], `control text overflows at ${width}`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(out, `${width}-${colorScheme}.png`), fullPage: true });
    findings.push({ width, height, colorScheme, overflow, errors, baselineWarnings });
    await context.close();
  }
  const page = await browser.newPage({ timezoneId: 'Pacific/Port_Moresby' });
  await page.goto(`${run.url}/#/calendar`);
  await page.getByRole('button', { name: '新建事件', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建日历事件' });
  await dialog.getByLabel('事件标题').fill('手动归档验证');
  await dialog.getByLabel('开始时间').fill('2026-10-29T18:00');
  await dialog.getByLabel('结束时间').fill('2026-10-29T18:30');
  await dialog.getByLabel('地点').fill('书房');
  await dialog.getByLabel('参会人').fill('林然,陈明');
  await dialog.getByRole('button', { name: '创建事件', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '手动归档验证', exact: true })).toBeVisible();
  await expect(page.locator('.calendar-event-info')).toContainText('书房');
  const data = await fetch(`${run.url}/api/calendar/events?start=2026-10-29T00:00:00Z&end=2026-10-30T00:00:00Z`).then((response) => response.json());
  assert.equal(data.data.find((event) => event.summary === '手动归档验证')?.location, '书房');
  writeFileSync(join(out, 'manual-event.json'), JSON.stringify(data, null, 2));
  await page.screenshot({ path: join(out, 'manual-create.png'), fullPage: true });
  writeFileSync(join(out, 'checks.json'), JSON.stringify(findings, null, 2));
  copyFileSync(join(out, '390-light.png'), join(root, 'docs/calendar-evidence/09-mobile.png'));
  console.log(JSON.stringify({ passed: true, findings }));
} finally {
  await browser.close();
}
