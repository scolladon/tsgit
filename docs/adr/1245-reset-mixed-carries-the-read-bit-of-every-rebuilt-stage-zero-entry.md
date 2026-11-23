---
subjects:
  - src/application/commands/reset.ts
  - src/application/primitives/internal/reset-skip-worktree.ts
---
# 1245 — reset --mixed carries the read bit of every rebuilt stage-0 entry

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (R9) · docs/plan/skip-worktree-present-files.md (Pin 4, DC-1, DC-2) · **Supersedes/Refines:** refines ADR-1241, applies DOCTRINE D-2

## Context

ADR-1241 kept the read bit for an unchanged entry and left the changed- and new-entry shapes to
pins. git's `update_index_from_diff` (v2.56.0) rebuilds only the paths that differ from the target,
and sets the bit iff the stage-0 entry read had it, or, for a path with no stage-0 entry, iff the
path is outside the sparse patterns. Pinned: a changed present entry becomes `H`, a changed absent
`S` entry stays `S`, a stored `H` stays `H`, a new out-of-pattern path is `S`.

## Options considered

1. **git's whole rule, as an internal post-pass after `buildIndexFromTree`, so the public options
   and `stash apply --index` stay unchanged** (recommended).
2. Only the unchanged entry keeps its bit — leaves two pinned rows red.
3. Change `buildIndexFromTree`'s projection for every sparse caller — reaches `stash apply --index`,
   whose bit behaviour is not pinned here.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-2: the pinned rows fold whole.

## Consequences

### Positive

- `reset --mixed` matches git on every pinned bit shape without a public API change.
