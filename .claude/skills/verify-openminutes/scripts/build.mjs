#!/usr/bin/env node
// Builds dist/ with Floatboat's own workbench compiler (strict typecheck + esbuild server + vite UI),
// so the verified bundle is byte-for-byte what the Host would produce.
// Usage: node .claude/skills/verify-openminutes/scripts/build.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.OPENMINUTES_ROOT ?? resolve(import.meta.dirname, '../../../..'));
const toolchain = process.env.FLOATBOAT_TOOLCHAIN ?? 'C:/Program Files/Floatboat/resources/workbench-toolchain';
const compiler = join(toolchain, 'compiler.mjs');
if (!existsSync(compiler)) {
  console.error(`Floatboat compiler not found at ${compiler}. Set FLOATBOAT_TOOLCHAIN to the workbench-toolchain dir.`);
  process.exit(2);
}

const work = join(root, '.workbench', 'verify');
mkdirSync(work, { recursive: true });
const inputPath = join(work, 'compile-input.json');
const reportPath = join(work, 'compile-report.json');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
writeFileSync(inputPath, JSON.stringify({ sourceDirectory: root, reportPath, manifest }));

const run = spawnSync(process.execPath, [compiler, inputPath], { stdio: 'inherit' });
if (!existsSync(reportPath)) {
  console.error(`compiler exited ${run.status} without a report`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
for (const issue of report.diagnostics ?? []) {
  console.log(`${issue.severity ?? 'error'} ${issue.code ?? ''} ${issue.file ?? ''}${issue.line ? `:${issue.line}` : ''} ${issue.message ?? ''}`);
}
console.log(JSON.stringify({ passed: report.passed, typecheck: report.typecheck, compilation: report.compilation }));
process.exit(report.passed ? 0 : 1);
