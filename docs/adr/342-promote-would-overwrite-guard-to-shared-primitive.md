# ADR-342: Promote the would-overwrite guard to a shared primitive

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/merge-tracked-dirty-conflict-refusal.md](../design/merge-tracked-dirty-conflict-refusal.md)

## Context

The `merge` command's conflict write path silently overwrites a tracked,
locally-modified working file when materialising a conflict, where git refuses
(exit 2, working tree/index/HEAD untouched). The apply consumers
(`cherry-pick`/`revert`/`rebase`/`stash`) already carry the conflict-wide guard:
`changedPaths` (every path the merge would touch) + `findWouldOverwrite` (the
tracked-dirty / untracked-present predicate), both private consts in
`apply-merge-to-worktree.ts`. The question is how `merge` should acquire the same
guard.

## Options considered

1. **(chosen) Promote `changedPaths` + `findWouldOverwrite` to a shared primitive**
   *(design recommendation)* — both surfaces call one internal primitive. Pros: the
   two surfaces already compute the identical path set and run the identical dirty
   predicate; the only reason it is duplicated is birthplace. Clean DRY lift. Cons:
   touches the apply primitive (must stay behaviour-preserving for its existing
   suites).
2. **Duplicate the logic inline in `merge`** — copy the two functions into
   `merge.ts`. Pros: leaves the apply primitive untouched. Cons: re-introduces the
   exact drift this item exists to close; two copies of a faithfulness-critical
   guard.
3. **Call `applyMergeToWorktree` wholesale from `merge`** — Cons: infeasible —
   `merge` owns its own index lock / tree synthesis / `MERGE_MSG` ceremony and
   cannot delegate the whole write path.

## Decision

Extract the path-set builder (`changedPaths`) and the would-overwrite predicate
(`findWouldOverwrite`) into one shared internal primitive that both
`apply-merge-to-worktree.ts` and `merge.ts`'s conflict path call. The apply
primitive is refactored to call the promotion; its observable behaviour is
unchanged for the existing example/interop set.

## Consequences

### Positive

- One home for the conflict-wide would-overwrite guard — no divergence between the
  merge command and the apply consumers.
- `merge`'s conflict path gains the guard by calling the same code the consumers
  rely on, so the pinned behaviour transfers directly.

### Negative

- The refactor touches `apply-merge-to-worktree.ts`; its existing
  example/interop/stash suites must stay byte-identical to prove the lift is
  behaviour-preserving.

### Neutral

- No new public surface: the shared check is an internal primitive. `merge` must
  thread `ours.entries` out of its tree computation and read the current index
  before the lock to feed it — both mechanical (see the design).
