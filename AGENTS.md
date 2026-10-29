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
