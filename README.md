English | [简体中文](README.zh-CN.md)

# OpenMinutes

> Turn MemoTalk S1 voice-recorder MP3s into searchable, categorized text you can review.

`OpenMinutes` (formerly `memotalk-workbench`) is a complete open-source [Floatboat](https://floatboat.ai) Workbench app, used with the [`memotalk-sdk`](https://github.com/floatboatai/memotalk-sdk) hardware client.

---

## Why OpenMinutes?

Recordings accumulate every day, but finding a particular conversation or listening back to everything becomes difficult.

This workbench connects import, transcription, classification, and search in one workflow. Each recording has a clear stage label: awaiting download, awaiting transcription, transcribing, awaiting classification, classifying, archived, or failed. Batch operations use the current filters.

## Features

| Capability | Description |
| --- | --- |
| Three import methods | Scan a directory, register a device file manifest, or download directly over BLE (requires local Python, `bleak`, and a physical device) |
| Streaming transcription | Decode audio to 16 kHz mono PCM16 with `ffmpeg`, stream it through Host ASR, and store the full text and timestamped segments |
| AI classification | Use the Host LLM to generate structured titles, summaries, categories, tags, key points, action items, and importance levels, with manual editing |
| Search and review | Search transcript text, titles, and summaries; filter by category, tag, or stage; sort by time; and process recordings in batches |
| Recording details and playback | Play audio with HTTP Range support, seek to sentence timestamps, and review separate transcript, AI analysis, and execution-history sections |
| Category management | Create, rename inline, recolor, and delete categories |
| Device setup | Check the environment (Python, `bleak`, SDK, and `ffmpeg`), configure paths, browse the SDK command reference, and register recordings manually |

## Getting started

The app runs in the **Floatboat desktop Workbench runtime**. It is a workbench package loaded by the Host, not a standalone Node service.

- The Host prepares dependencies, runs strict TypeScript checks, compiles the server, and bundles the UI. Generated files go in `dist/` and are not committed.
- The Host applies SQLite migrations when opening the workbench. Add new files to `migrations/`; do not rewrite existing migrations.
- ASR and LLM calls use Host capabilities. This repository neither contains nor requires model API keys.

```bash
pnpm install          # Install UI dependencies, type definitions, and test tooling
```

Then use Floatboat's `check_workbench_project` to run type checks and build the app, and `workbench_runtime open` to apply the update. These are Host operations, not package scripts.

### Runtime dependencies

| Dependency | Purpose | Behavior when missing |
| --- | --- | --- |
| `ffmpeg` | Audio probing and decoding | Transcription is unavailable, and the UI reports it |
| `python` + `bleak` + `memotalk-sdk` | Download device recordings over BLE | The device page reports "not ready"; directory import remains available |

Tool discovery tries configured paths, Floatboat's bundled tools, `PATH`, and command names in that order, so it does not rely solely on the process `PATH`.

Check the device page for the Python interpreter in use, then install the SDK into that same environment:

```bash
uv pip install --python "/path/to/python" "memotalk-sdk>=0.1.0"
"/path/to/python" -m memotalk.cli --version
```

On Windows, use the absolute path to `python.exe`. In PowerShell, prefix the quoted interpreter path with `&` when running the version check. If you use a virtual environment, select its Python interpreter in settings.
The SDK installs `bleak` automatically; you do not need to clone its source or configure an SDK directory.
The app uses `from memotalk import MemoTalkClient` for device APIs and live audio streaming.
Upgrading removes the old `sdk_dir` setting while preserving other path, recognition, and automation settings.

### SDK regression tests

`pnpm test` runs the server tests. SDK integration tests use the package's simulated device and do not connect to a physical recorder.
Set the `MEMOTALK_TEST_PYTHON` environment variable to the path of a Python interpreter with `memotalk-sdk` installed before running them.
Without this variable, SDK integration tests are skipped; settings API and migration tests still run.

## Project structure

```text
src/
  contracts/       Shared DTOs (app.ts) and untrusted-input validation (input.ts)
  server/          Node server: assembly, routing, and domain logic
    routes/        HTTP routes grouped by domain
    http.ts        Shared { ok, data | error } envelope and error-code mapping
    sql.ts         Thin node:sqlite wrapper, settings, and job records
    ingest.ts      Directory scanning, manifest registration, deduplication, naming conflicts
    media.ts       ffmpeg probing, duration parsing, and PCM16 framing
    transcribe.ts  Host ASR sessions: parameter fallback, streaming, resumption, error classification
    organize.ts    Host LLM structured classification and text fallback
    pipeline.ts    Transcription/classification state machines and retries
    bridge.ts      memotalk-sdk Python API bridge (fixed arguments, no concatenated commands)
  ui/              React UI: overview / library / details / device / categories / live / settings
migrations/        Append-only SQLite migrations
sdk/               @floatboat/workbench-sdk contracts and types (provided by the Host)
tests/             Server tests
```

Related documentation (in Chinese): [requirements](REQUIREMENTS.md), [engineering conventions](ENGINEERING.md), and [design](DESIGN.md).

## Data model

`devices`, `recordings`, `transcripts`, `analyses`, `categories`, `tags`, `recording_tags`, `job_runs`, `sdk_commands`, and `settings`.

### Storage and directories

- `import_dir` is the scan source and the default audio export destination, defaulting to `~/memo/memotalk/inbox`. Scans create a missing directory, read only its immediate files, and copy supported audio (`.mp3`, `.wav`, `.m4a`, `.aac`, `.ogg`, `.flac`, `.amr`, `.opus`) into the library without removing the originals.
- `library_dir` defaults to `~/memo/memotalk/raw`. Imports and BLE downloads are copied into `<library_dir>/<yyyy-MM>/`, using the recording month inferred from the filename or a fallback date. Live recordings also go into monthly folders. Use an absolute path or `~/...` for these directory settings; changing the library setting does not relocate existing files.
- New `recordings.storage_path` values store the full destination path (absolute with the default or an absolute library directory). Historical relative filenames resolve against the Host's `audio` data resource. BLE downloads first use the Host's `audio/_incoming` staging directory, not `import_dir`.
- Deletion attempts to move audio to `<library_dir>/_trash/<milliseconds>-<basename>` using the **current** library setting, then deletes the recording and its transcript, analysis, tag links, and job history. If the move fails, database deletion still proceeds; `audioMovedToTrash` is then `null`. There is no restore API.
- Export copies the audio under its original `filename` into `import_dir`, or into the request body's optional `directory`. It creates missing destination directories and can overwrite a same-named file. The detail page uses the default destination. There is no separate export-directory setting.

When resolving `import_dir`, an empty value falls back to the default; a path inside the system temporary directory is replaced with the default and written back to settings. An explicit `directory` in a scan request is used and saved directly, without that temporary-directory fallback.

## API overview

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/recordings` | List recordings with search, stage/category/tag filters, sorting, and pagination |
| `GET` | `/api/recordings/:id` | Details: metadata, transcript, AI analysis, and execution history |
| `PATCH` | `/api/recordings/:id` | Edit title, category, tags, and importance |
| `DELETE` | `/api/recordings/:id` | Delete a recording; attempt to move audio to `<library_dir>/_trash/<milliseconds>-<basename>` |
| `GET` | `/api/recordings/:id/audio` | Audio stream with HTTP Range support (206 and `content-range`; 416 for out-of-range requests) |
| `POST` | `/api/recordings/:id/export` | Copy audio to `import_dir` by default; optional body field `directory` overrides it |
| `POST` | `/api/recordings/:id/transcribe` | Transcribe one recording |
| `POST` | `/api/recordings/:id/organize` | AI classification for one recording |
| `POST` | `/api/recordings/batch/transcribe`, `/api/recordings/batch/organize` | Batch transcription and classification |
| `GET` | `/api/ingest/directory` | Read import directory information |
| `POST` | `/api/ingest/directory/ensure` | Create the import directory |
| `POST` | `/api/ingest/scan` | Scan the import directory |
| `POST` | `/api/ingest/manifest` | Register device manifest entries |
| `GET` | `/api/device`, `/api/device/summary`, `/api/device/capabilities` | Device records, overview, and SDK command reference |
| `POST` | `/api/device/check`, `/api/device/list`, `/api/device/download`, `/api/device/status` | Environment check, file listing, BLE download, and status |
| `GET` | `/api/live` | Live caption status |
| `POST` | `/api/live/start`, `/api/live/stop` | Start or stop live captions |
| `GET`, `POST` | `/api/categories` | List or create categories |
| `PATCH`, `DELETE` | `/api/categories/:id` | Update or delete a category |
| `GET`, `PATCH` | `/api/settings` | Paths, transcription/classification toggles, hotwords, and language |

JSON responses use the `{ ok: true, data }` / `{ ok: false, error: { code, message } }` envelope. The audio endpoint returns an audio stream on success.

## Design principles

- Report failures honestly. If BLE is not ready, audio cannot play, or upstream ASR fails, the UI reports the problem and offers a next action.
- Communicate status with both text and color, never color alone. Animations respect `prefers-reduced-motion`.
- Prioritize lists. Each recording occupies one row, content is at most 1220 px wide, and table numbers use `tabular-nums` for alignment.
- Support accessibility. Icon-only buttons have `aria-label` and `title`; segmented controls use `aria-pressed`.

See [DESIGN.md](DESIGN.md) for more design decisions.

## Related repositories

- [`floatboatai/memotalk-sdk`](https://github.com/floatboatai/memotalk-sdk): Python BLE client and CLI for the MemoTalk S1

## License

[MIT](LICENSE) © Floatboat and MemoTalk
