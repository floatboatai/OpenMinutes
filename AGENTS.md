# Repository rules

- Use Chinese for user-facing communication.
- Use only AGENTS.md for repository instructions; do not create CLAUDE.md.
- Run Python through `uv run`; use `pnpm` for Node packages.
- New repositories are private unless explicitly requested otherwise.
- Do not edit `.claude/skills/verify-openminutes`; read it from
  `origin/redreamality/pstack` and run verification outside this branch.

## PowerShell pitfalls

- Check `Test-Path` before reading optional instruction files. This checkout
  originally had no root AGENTS.md; assuming it existed caused Get-Content to fail.
- Keep filesystem operations in PowerShell and use literal, resolved paths.
- Pass complex browser steps through a JSON file, not nested shell quoting.
- `git check-ignore` returns exit 1 when a path is not ignored; this is not a
  filesystem failure. Use `git ls-files` to check whether it is already tracked.
- On Windows, verification cleanup can hit EPERM immediately after stopping its
  server because file handles are still closing. Re-run the same nonce-scoped
  cleanup after the process exits; never kill unrelated processes or broaden
  the deletion target.
- PowerShell does not expand `sdk/*.mjs` for ripgrep. Search the directory with
  `rg -g '*.mjs' pattern sdk` instead of passing a wildcard path.
- The pinned verification skill's `text=` selector does not match `strong`.
  Use a specific button CSS selector when its label is rendered in `strong`.
- For verification readbacks separated by long browser sessions, request
  `Connection: close`; a stale Node fetch keep-alive socket produced ECONNRESET
  even though the isolated server's doctor and logs remained healthy.
