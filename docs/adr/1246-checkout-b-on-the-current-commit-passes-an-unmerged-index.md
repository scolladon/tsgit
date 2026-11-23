---
subjects:
  - src/application/commands/checkout.ts
---
# 1246 — checkout -b on the current commit passes an unmerged index

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/plan/skip-worktree-present-files.md (Pin 2) · **Supersedes/Refines:** refines ADR-1239, applies DOCTRINE D-5

## Context

git's `checkout -b <name>` with no start point skips `merge_working_tree`, so an unmerged index is
neither checked nor written: the command exits 0, HEAD moves and the conflict stages stay. With a
start point (`checkout -b y HEAD`) git refuses `you need to resolve your current index first`.
tsgit refuses both. ADR-1239 edits the same fast path.

## Options considered

1. **Fold: the fast path skips the unmerged-index refusal as git does** (recommended).
2. Record it in `docs/known-divergences.md`.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-5: a proven divergence in a
seam the change edits is folded.

## Consequences

### Positive

- `checkout({ createBranch: { name } })` succeeds over a conflicted index, as git does.
