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

Audio files live in the `audio` data resource directory. The database stores only relative filenames. Deleting a recording moves its audio file to `audio/_trash` instead of permanently deleting it.

## API overview

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/recordings` | List recordings with search, stage/category/tag filters, sorting, and pagination |
| `GET` | `/api/recordings/:id` | Details: metadata, transcript, AI analysis, and execution history |
| `PATCH` | `/api/recordings/:id` | Edit title, category, tags, and importance |
| `DELETE` | `/api/recordings/:id` | Delete a recording (move its file to `audio/_trash`) |
| `GET` | `/api/recordings/:id/audio` | Audio stream with HTTP Range support (206 and `content-range`; 416 for out-of-range requests) |
| `POST` | `/api/recordings/:id/export` | Export to a local directory |
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
