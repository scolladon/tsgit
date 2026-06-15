# ADR-343: Fold the untracked overwrite guard into one ordered pass with an lstat presence probe

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/merge-tracked-dirty-conflict-refusal.md](../design/merge-tracked-dirty-conflict-refusal.md)

## Context

`merge`'s conflict path already runs an untracked-overwrite pre-flight
(`collectUntrackedRenameBlockers`) that `lstat`s distinct-types rename targets.
The promoted would-overwrite guard ([ADR-342](342-promote-would-overwrite-guard-to-shared-primitive.md))
also flags untracked-but-present paths — via its `byPath.get(path) === undefined`
branch — so the two overlap. The design pinned that real git, when both a
tracked-dirty path and an untracked squat are present, reports the **local-changes
block first** (ORD1), and short-circuits to local-changes when they collide on one
path (ORD2). It also pinned **DG1**: a *dangling* untracked symlink squatting a
rename target still refuses, because git's untracked-presence probe is `lstat`-based
(it sees the dangling link), not `realpath`-following. The promoted
`findWouldOverwrite` currently probes untracked presence with `ctx.fs.exists`, which
on the node adapter follows the link and returns `false` for a dangling symlink — so
a naive fold would **regress DG1**.

## Options considered

1. **(chosen) Fold into one ordered `findWouldOverwrite` pass, switching its
   untracked-presence probe from `fs.exists` to `lstat`** *(design recommendation)* —
   one pass reports local-changes before untracked (ORD1), de-dupes the overlap
   (ORD2), and removes the duplicated refusal logic. Pros: single faithful guard;
   also fixes the apply consumers' currently-uncovered dangling-squat edge to match
   git. Cons: changes the apply consumers' untracked probe semantics, which must be
   re-verified (their existing tests use regular files only).
2. **Keep `collectUntrackedRenameBlockers` as-is, add tracked-dirty as a separate
   prior pass** — Pros: no probe change, no ripple to apply consumers. Cons: keeps
   two untracked predicates with subtly different semantics; less DRY. Safe fallback
   if the probe switch unexpectedly ripples.
3. **Fold but leave the probe as `fs.exists`** — *rejected*: regresses DG1 (a
   dangling untracked symlink squat would stop refusing).

## Decision

Fold the untracked-overwrite check into the single promoted `findWouldOverwrite`
pass and switch its untracked-presence probe from `ctx.fs.exists` to `ctx.fs.lstat`
(presence-without-follow), matching `collectUntrackedRenameBlockers`'s existing
semantics and git's `lstat`-based probe. The pass runs once, tracked-dirty paths
collected before untracked, before any write and before the index lock.
`collectUntrackedRenameBlockers` is removed; its distinct-types rename targets are
covered because they are in `changedPaths`'s `recordedPaths`.

## Consequences

### Positive

- One ordered would-overwrite pass with git-faithful `lstat` presence semantics
  (DG1 preserved on merge; **fixed** on the apply consumers, where it was an
  unpinned divergence).
- The existing untracked refusal (S7/S7b) keeps refusing, now through the unified
  check; re-pinned by interop.

### Negative

- The `fs.exists`→`lstat` switch changes the apply consumers' untracked-present
  branch behaviour for dangling symlinks. This is a faithfulness improvement, not a
  regression, but requires a new apply/stash check (existing tests cover only
  regular-file squats).

### Neutral

- Ordering within the refusal is settled by
  [ADR-345](345-sort-would-overwrite-paths-local-changes-first.md); the structured
  shape that lets a consumer reconstruct git's two blocks is
  [ADR-344](344-discriminate-would-overwrite-refusal-by-class.md).
