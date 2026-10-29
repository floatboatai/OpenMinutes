# Cross-OS audit

Baseline: main, 2026-10-29. Line references below refer to the pre-change files.
Server paths in the table are under `src/server/`; Device.tsx is under `src/ui/pages/`.

| Location | Impact / affected OS | Resolution |
| --- | --- | --- |
| bridge.ts:13-26 | Windows-only bundled executables; fails on macOS/Linux | Central platform-injected candidates, .app Contents/Resources, Homebrew, python3, project venv and uv managed discovery |
| bridge.ts:40-58 | User site must follow the selected interpreter, not a Python version or OS home convention | Existing site.getusersitepackages logic retained centrally, skip user injection for venv; UTF-8 enabled |
| bridge.ts:105 | First runnable Python could be Python 2 or incompatible Python 3 | Require Python >=3.10; inspect actual sys.executable |
| bridge.ts:119 | Only Windows backend imports checked | Check native bleak backend on all supported OSes |
| media.ts:68 | .cmd/.bat candidates cannot run without shell; GUI macOS PATH omits Homebrew | No shell wrappers; platform PATH separators and explicit Homebrew candidates |
| ingest.ts:288-302 | Lowercasing aliases distinct Linux and case-sensitive APFS directories; /private temp aliases missed | Filesystem identity for existing directories, case-sensitive POSIX lexical fallback and realpath nearest ancestor |
| ingest.ts:27 | Windows reserved names and trailing dot/space invalid; POSIX basename does not strip Windows separators | Portable filename sanitization |
| library.ts:17,59 | Backslash home notation on POSIX; prefix-only home abbreviation mistakes sibling folders | Platform-injected home expansion and segment-aware display |
| media.ts:22-36; bridge.ts:250-262 | Open stdin can hang; SIGTERM is not guaranteed to terminate on POSIX | Close unused stdin, bounded termination with SIGKILL escalation |
| media.ts:155-167 | Abandoned decode iterator leaves its child process alive on any OS | Terminate and await the decoder in generator finally |
| live.ts:196,258-281 | EPIPE can crash server; stop writes did not close stdin | Handle pipe errors; EOF stop and bounded hard kill |
| sdk-script.ts:17; live-script.ts:64 | CoreBluetooth address is UUID, not MAC | Keep SDK device-reported MAC separate from transport identifier; pass transport object unchanged, no MAC filter |
| Device.tsx:298,422 | Windows-only example and unsupported claim Windows already deleted temp directory | Portable ~/ example and neutral explanation |
| routes/device.ts:98 | Repeated GET probes, no startup preflight, no decode/write/Host agent check | Cached preflight, explicit refresh, structured status and repair lifecycle |
| tools.ts / repair actions (new) | Process cwd is not guaranteed to be the application directory; ephemeral uv --with interpreter disappears at exit | Derive application root from module location in source/build; use a persistent app-local venv |

## Checked without changing

- SDK and live scripts use asyncio and SDK transport discovery. No OS-specific microphone/ffmpeg device parameters: inputs are files or MP3 pipes, not avfoundation/dshow.
- Default ~/memo/memotalk directories use os.homedir and path.join.
- Text parsing accepts CRLF/LF; Python output now explicitly UTF-8.
- windowsHide is harmless outside Windows. No shell interpolation is needed.
- SDK files are vendored Host contracts and are not patched.

## Evidence and limits

Windows installation inspected read-only: resources/nodejs/node.exe,
python/python/python.exe, ffmpeg/bin/ffmpeg.exe, uv/uv.exe.
macOS bundle candidates are inferred, not verified shipping locations.
Native macOS checks remain necessary: signed .app layout on Intel/Apple Silicon,
CoreBluetooth permission attribution and NSBluetoothAlwaysUsageDescription,
first-use authorization, UUID discovery/connect, live stop/disconnect,
Homebrew/uv interpreters, case-sensitive APFS and /var vs /private aliases.
Linux BlueZ requires a running daemon and appropriate D-Bus permissions.

Preflight never scans/connects a BLE device. macOS checks authorization and
controller state without requesting permission; an undetermined state remains
a warning requiring user action. An agent cannot grant OS privacy permission.

## Verification on Windows

- `pnpm test`: 48 passed, 0 failed, 0 skipped, including the installed SDK fake-device suite.
- Pure platform scenarios run under Node's test runner for win32/darwin/linux. They cover bundle roots, Homebrew, PATH separators, python3, venv, uv executable discovery, home expansion, path boundaries and case policy.
- Filesystem tests exercise real directory identity and a junction/symlink ancestor; no assumptions about macOS APFS case sensitivity.
- Preflight tests cover unsupported systems, macOS permission states, missing imports, unavailable/undeclared Host operations, writable/blocked directories, cache and refresh deduplication.
- Repair tests use the actual SDK HTTP client against a local fixture, verifying workingDirectory, idempotencyKey, prompt boundaries, progress, terminal failure/cancellation/interruption, fresh inspection, and ambiguous-submit duplicate suppression.
- Floatboat compiler: strict typecheck and compilation passed. Only the existing large-module warning for Device.tsx remains.
- Browser E2E uses the pstack worktree's `doctor.mjs`, `browse.mjs`, and `cleanup.mjs` without copying or modifying that skill. Seeded SQLite settings isolate all directories before startup; auto-connect/pull/transcribe/analyze are off.
- No-Host run: visible preflight failures, explicit `agent 不可用`, disabled repair button, repair API rejection.
- Simulated-Host run: real button click sends exactly one SDK request; progress/result rendered; completion reruns checks and retains unresolved failure. The fixture does not execute an agent or change dependencies.
- Desktop 1400px and mobile 390px screenshots inspected. Mobile DOM measurements show no document or preflight-row overflow. Browser console errors/warnings: 0.
- No real Host agent execution, paid ASR/LLM call, BLE scan/connection, or macOS hardware run was performed.

Reproduce with an existing Python environment:

```powershell
uv venv --python 3.12 .workbench/test-python
uv pip install --python .workbench/test-python bleak memotalk-sdk
$env:MEMOTALK_TEST_PYTHON = Join-Path (Get-Location) '.workbench/test-python/Scripts/python.exe'
pnpm test
pnpm exec node --import tsx --test tests/platform.test.ts tests/preflight.test.ts
$env:OPENMINUTES_ROOT = (Get-Location).Path
$env:OPENMINUTES_VERIFY_SCRIPTS = 'C:/Users/unknown/orca/workspaces/openminutes/pstack-review-fix/.claude/skills/verify-openminutes/scripts'
node "$env:OPENMINUTES_VERIFY_SCRIPTS/build.mjs"
node tests/e2e-preflight.mjs
```

Evidence is retained under `.workbench/verify-evidence/preflight-*/`, including
before/after screenshots, ARIA, mobile layout measurements, API results and
simulated Host request payloads. Scratch instances are stopped and removed.

## Authorization and operational limits

The manifest adds `agent`; updating/reopening the app may require the user to
authorize that capability in Floatboat. Capability enumeration is read-only,
and actual call authorization is checked by Host. Only a user button click
starts a repair task, which may consume the configured agent model's quota.
No startup agent task is sent. Prompt restrictions do not replace Host
authorization/sandbox controls. System-level changes require separate user
confirmation; privacy permissions cannot be automated.

Preflight reports are process-local caches. Repair intent, idempotency key,
run ID and state are now persisted in SQLite, keyed by working directory
(`0005_environment_repair.sql`). The intent commits before `agent.start`.
Restarting only queries the saved task, using its run ID or original key;
it never starts or resubmits a repair automatically. A missing result or
failed query stays `unknown`, blocks new submissions and retains its key.
The UI distinguishes recovery from unknown results and displays both IDs.
Only a confirmed terminal Host result allows a later explicit new repair.
Corrupt journals fail closed. A crash before submission can leave an intent
whose execution cannot be proven: this intentionally remains blocked until
the Host can return a result, rather than risking duplicate mutations.

Tasks submitted by older versions before this journal existed cannot be
reconstructed retroactively. Check Floatboat for any such task before the
first repair after upgrading. No real Host/OS permission boundary has changed.

## PR #9 review fixes

- All Python text probe boundaries now use one `pythonTextEnv` helper, overriding
  inherited `PYTHONUTF8=0` and `PYTHONIOENCODING=gbk` before the first executable
  or user-site query, not merely before later SDK calls.
- A real Python regression first reproduces corrupted Chinese output through
  `runCommand`, then verifies a Chinese-named venv executable and Chinese
  `PYTHONUSERBASE` resolve exactly under the same legacy environment.
- `pnpm test`: 80 passed, 0 failed, 0 skipped using the existing isolated SDK
  interpreter. Recovery covers four crash boundaries crossed with running,
  completed/failed/cancelled/interrupted, query errors and missing results.
  Additional tests prove intent commits before submission, a lost response
  retains its original key, persistence failure cannot submit, and corrupt
  journal data does not create a fresh task.
- Floatboat typecheck/build passed, retaining only the existing Device.tsx
  large-module warning.
- Isolated browser verification uses the external `pstack-review-fix` scripts
  without modifying or copying them. It never enables real Host mode.
  The simulated task stays running while its workbench child process is
  stopped and restarted against the same database. Query failure locks the
  button and API; restoring queries recovers the original task, then its
  terminal state triggers preflight. Exactly one `agent.start` occurs across
  the restart. Desktop/mobile rendering and no-Host rejection are also checked.
