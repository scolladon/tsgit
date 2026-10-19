---
subjects:
  - src/application/commands/rebase.ts
  - src/application/commands/internal/replay-sequence.ts
---
# 1011 — Continuing a stopped pick writes the updated cache-tree

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** applies ADR-1007

## Context

Pins Q1 and Q2: after `cherry-pick` or `rebase` stops on a conflict and the user resolves it, `--continue` leaves a fully valid `TREE` and keeps `REUC` (`write_index_as_tree` then an index write). tsgit wrote nothing there.

## Options considered

1. Fold into this change (recommended).
2. File a follow-up.
3. Fold `rebase --continue` only.

## Decision

**Adopted-as-recommended (no user judgment)**: option 1. The routes share ADR-1007's primitive and invariant.

## Consequences

- Interop rows Q1 and Q2 pin the `TREE` bytes and the kept `REUC`.
