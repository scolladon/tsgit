---
subjects:
  - src/application/commands/checkout.ts
---
# 1239 — checkout -b on the current commit writes no index

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-D, R6) · **Supersedes/Refines:** applies DOCTRINE D-2

## Context

git's `switch_branches` skips `unpack_trees` and the index write when the new branch starts at
`HEAD` with nothing else to change (K6, W7, W8): a cleared bit stays `S` on disk. tsgit's
same-commit `checkout -b` rewrites the index, so after ADR-1236 it would persist `H`.

## Options considered

1. **No index write on git's fast path** (recommended); the no-op shapes are pinned first.
2. Write the raw bits on that path — a write git never does.
3. Ledger it.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-2: a divergence the change
newly reaches is folded. The guard covers exactly the shapes pinned as git no-ops.

## Consequences

### Positive

- The index file and its mtime are untouched where git leaves them.
