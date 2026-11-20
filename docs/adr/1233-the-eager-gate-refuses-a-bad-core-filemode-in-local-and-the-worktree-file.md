---
subjects:
  - src/application/primitives/internal/repo-state.ts
supersedes:
  - adr: "1186"
    scope: "the worktree-file gate leaving core.fileMode unchecked"
---
<!-- cspell:ignore filemode -->
# 1233 — The eager gate refuses a bad core.fileMode in local and the worktree file

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/core-filemode-false.md (D-C, R10) · **Supersedes/Refines:** supersedes ADR-1186 (the worktree-file gate leaving core.fileMode unchecked), applies DOCTRINE D-3

## Context

git parses `core.filemode` in `git_default_core_config`, so every command dies
(`fatal: bad boolean config value 'bogus' for 'core.filemode'`, exit 128) on a bad value in local
config (C5) or in an active `config.worktree` (C6). tsgit ignores both. This change starts reading
the key from both files (ADR-1229).

## Options considered

1. **Fold both: add `filemode` to `CORE_BOOLEAN_KEYS` and widen the worktree-file gate to it;
   breaking `!`** (recommended).
2. Gate the local value only and record C6 in the divergence ledger.
3. Record both in the divergence ledger.

## Decision

Option 1, ratified by the user. A bad `core.fileMode` in local config or in the active worktree
file throws `CONFIG_BAD_BOOLEAN_VALUE` from the eager gate, like `core.ignorecase`.

Superseded from ADR-1186: the worktree-file gate checking only the two sparse booleans, which left
`core.fileMode` unchecked.

Carried forward from ADR-1186: the worktree-file gate runs only when the extension is on, and every
other eager key in `config.worktree` (`core.ignorecase` among them) is still not checked there.

## Consequences

### Negative

- Every operational command throws on a `core.fileMode` value it used to ignore, as git does.
