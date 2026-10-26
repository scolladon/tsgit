---
subjects:
  - src/application/primitives/internal/reset-worktree.ts
---
# 1089 — The merge rewind keeps `unmergedPaths` hidden

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC3) · **Supersedes/Refines:** refines ADR-226

## Context

The forced switch and `reset --hard` now reset an unmerged path to the target (UMn rows). The merge strategy rewind,
`hardResetWorktreeToCommit`, is git's `reset --hard HEAD` too. No row pins whether a conflicted index can reach it.

## Options considered

1. **Give it `unmergedPaths: 'reset'` too.** This is consistent with `reset.ts`.
2. **Leave it hidden until a row pins it.**

## Decision

**Adopted as recommended (no user judgment): option 2.** Every change needs a proof row, and none exists for this
path. To prove it: run `merge -s resolve -s ort` with a first strategy that conflicts and leaves `n` unmerged and
absent from HEAD, against git 2.55.

## Consequences

- The rewind gets the stale-only rule (ADR-1087) and nothing else.
