---
subjects:
  - src/application/commands/rebase.ts
  - src/application/commands/internal/replay-sequence.ts
  - src/application/primitives/internal/scan-tracked-entries.ts
---
# 1018 — Continuing a stopped pick refreshes index stats as commit does

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** extends ADR-1008 to the routes of ADR-1011

## Context

ADR-1008 ports git's commit-time `refresh_cache` into `commit`. A pin (`pin-continue-refresh.zsh`, stable 3/3 with
timestamps masked) shows git's `cherry-pick --continue` and `rebase --continue` refresh the stat of a resolved entry
too: its index mtime moves to the file's. tsgit's continue routes do not refresh. Only `status` consumes
`compareAndRefresh`'s refreshed stats.

## Options considered

1. The continue routes of ADR-1011 reuse commit's tracked-entry scan and write trigger (recommended).
2. Those routes write `TREE` only, and the refresh becomes a follow-up.
3. Refresh on `rebase --continue` only.

## Decision

**Adopted-as-recommended (no user judgment)**: option 1. It applies the user-ratified ADR-1008 to the routes ADR-1011
already folds, through the same primitive.

## Consequences

- Interop rows for both continue routes check the refreshed entry stat as well as the `TREE` bytes and the kept `REUC`.
- Each continue pays one `lstat` per index entry, as git does.
