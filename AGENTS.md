# Repository rules

- Communicate in Chinese. Keep repository instructions in AGENTS.md only.
- Python development commands use `uv run`; Node package management uses `pnpm`.
- New remote repositories default to private. Do not change this repository's visibility.
- Never inspect or modify real Floatboat workbench data or stop existing Floatboat processes.
- Verification uses an isolated checkout-local data directory. Do not modify or copy `.claude/skills/verify-openminutes`.
- In PowerShell, check `Test-Path` before reading optional files (this checkout initially had no AGENTS.md).
- Run independent shell reads separately, not with semicolon command chains. Pass complex browser steps through a JSON file, not nested shell quoting.
- Do not persist `sys.executable` from `uv run --with ...`: it can point to an ephemeral environment removed at exit (observed ENOENT in SDK tests). Create a checkout-local environment with `uv venv`, install with `uv pip --python`, and run Python checks with `uv run --python <venv>`.
- Windows E2E cleanup can fail with EPERM while a browser profile is releasing file handles. Close owned browsers via CDP `Browser.close`, wait for exit, then retry the same nonce-scoped cleanup. Never kill by process name or delete a broader directory to bypass the lock.
- A GitHub HTTPS connection timeout is not a rejected commit. Retry the same ordinary push and verify the remote SHA; do not force-push, change credentials, or rewrite the remote to work around transient connectivity.
