# Cross-OS audit

Baseline: main, 2026-10-29. Line references below refer to the pre-change files.

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
| live.ts:196,258-281 | EPIPE can crash server; stop writes did not close stdin | Handle pipe errors; EOF stop and bounded hard kill |
| sdk-script.ts:17; live-script.ts:64 | CoreBluetooth address is UUID, not MAC | Keep SDK device-reported MAC separate from transport identifier; pass transport object unchanged, no MAC filter |
| Device.tsx:298,422 | Windows-only example and unsupported claim Windows already deleted temp directory | Portable ~/ example and neutral explanation |
| routes/device.ts:98 | Repeated GET probes, no startup preflight, no decode/write/Host agent check | Cached preflight, explicit refresh, structured status and repair lifecycle |

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
