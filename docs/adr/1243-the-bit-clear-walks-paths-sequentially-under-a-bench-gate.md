---
subjects:
  - src/application/primitives/internal/clear-skip-worktree-from-present-files.ts
  - src/domain/sparse/missing-directory.ts
---
# 1243 — The bit clear walks paths sequentially under a bench gate

> **Superseded by [ADR-1247](1247-the-bit-clear-probes-presence-synchronously-under-a-floor-relative-gate.md)**
> for the walk and the gate: presence is probed synchronously where the adapter can, and the
> present-directories row is gated against one bare `lstat` per probed entry. The missing-directory
> cache and git's probe count are carried forward.

- **Status:** superseded by ADR-1247
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-H, R3) · **Supersedes/Refines:** applies ADR-226

## Context

git bounds the clear with a missing-directory cache: one `lstat` per skip-worktree entry outside a
known-missing directory, none when sparse is off or the index holds no skip-worktree entry.

## Options considered

1. **A sequential port of `path_found`, with a bench gate** (recommended).
2. The same answers, with the missing-directory resolution batched under bounded concurrency.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — no trade-off in results. A `status` bench
on a sparse fixture with many skip-worktree entries in present directories gates it: if the clear
costs more than 10% of `status` against main on the same fixture, option 2 replaces it.

## Consequences

### Positive

- The `lstat` count equals git's.
