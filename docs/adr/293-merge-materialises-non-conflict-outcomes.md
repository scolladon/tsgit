# ADR-293: `merge` materialises its non-conflict outcomes to the working tree + index

## Status

Accepted (at `79a9d6e3`)

## Context

`repo.merge` updates only the commit/ref for its **non-conflict** outcomes and
leaves the working tree + index frozen at `ours`. Canonical `git merge` checks
the result out to **both** the index and the working tree. Confirmed against real
`git` for both non-conflict paths: a **fast-forward** advances the index +
working tree to the new tip (a checkout), and a **clean true-merge** writes the
merged tree to the index + working tree. tsgit's FF branch does a bare
`updateRef`; its `commitCleanMerge` commits the correct merged tree but writes
neither. No ADR diverges and *justifies* a worktree-less merge — so this is an
unfaithful gap under the prime directive ([ADR-226](226-git-faithfulness-prime-directive.md)),
not an intentional divergence.

[ADR-215](215-apply-merge-to-worktree-primitive.md) extracted the shared
`applyMergeToWorktree` primitive and **explicitly deferred** migrating `merge.ts`
onto it ("out of scope … risks merge's mutation-tested invariants … tracked for a
later cleanup"). Every other 3-way consumer — cherry-pick, revert, rebase, stash —
already routes through it; `merge`'s **conflict** path is the only one that
materialises today, and it is sparse-aware ([ADR-076](076-merge-conflict-materialization.md)).

Two load-bearing choices follow.

## Decision

### 1 — Targeted materialisation; the conflict path is untouched

Add a working-tree + index materialisation step to **only** the two non-conflict
branches, reusing the `materializeTree` primitive, and keep `merge`'s own merge
engine (`computeMergeTreeResult`) and conflict machinery byte-identical:

- **clean true-merge** (`commitCleanMerge`) — under the index lock: read the
  current index, `materializeTree({ targetTree: mergedTree, currentIndex, force:
  false })`, commit the returned index entries, then create the merge commit and
  move the ref. The merged tree is already synthesised by
  `computeMergeTreeResult`, so no second 3-way merge runs.
- **fast-forward** (`mergeRun`'s FF branch) — the same, with `targetTree =
  theirsTree` and an `updateRef` instead of a new commit.

A **full migration** of `merge` onto `applyMergeToWorktree` was rejected: it would
route the *conflict* path through the primitive too, which (a) regresses ADR-076's
sparse-aware conflict materialisation (the primitive's conflict writer takes no
matcher), (b) double-writes the conflict working tree, and (c) disturbs merge's
mutation-tested conflict invariants — the precise risk ADR-215 flagged. The
targeted fix touches only the currently-inert non-conflict branches.

### 2 — Dirty-worktree refusal surfaces `workingTreeDirty`

`materializeTree(force: false)` refuses — without mutating any state — when a
tracked file the merge would overwrite has drifted from the index, or an
untracked file clashes with a path the merge adds (git's "Your local changes /
untracked working tree files would be overwritten by merge. Aborting."). The
refusal is surfaced as the merge-family `workingTreeDirty` code — the same code
cherry-pick / revert / rebase / stash raise for their would-overwrite guard — by
remapping the `checkoutOverwriteDirty` that `materializeTree` raises internally,
so the whole 3-way merge family speaks one would-overwrite code. `force: true`
was rejected: it would silently clobber a dirty working file (data loss,
unfaithful).

## Consequences

### Positive

- `merge`'s non-conflict outcomes are git-faithful: index + working tree + tree
  all reflect the merge, pinned byte-for-byte by a twin-git `merge-interop` suite.
- The conflict path — including ADR-076 sparse-awareness and its mutation
  invariants — is untouched, so the blast radius is the two previously-empty
  non-conflict branches.
- The 3-way merge family surfaces one consistent `workingTreeDirty` would-
  overwrite code.
- Realises ADR-215's deferred cleanup for the non-conflict paths and supersedes
  its "later cleanup" note (the conflict-path migration remains intentionally
  undone to preserve ADR-076).

### Negative

- A small amount of materialisation logic is duplicated between `merge`'s two
  non-conflict branches and `applyMergeToWorktree`'s clean branch (both call
  `materializeTree`); accepted to avoid the conflict-path regression a shared
  path would cause.
- The dirty refusal needs a `catch`/remap of `checkoutOverwriteDirty` →
  `workingTreeDirty` rather than the code falling out directly.

### Neutral

- The pre-merge **index-vs-HEAD** cleanliness guard (git's "Entry not uptodate.
  Cannot merge.") is a separate, pre-existing gap `merge` already lacks; the
  `force: false` guard checks working-tree drift against the index, not index
  drift against HEAD. Not addressed here.
- Existing clean-merge unit tests assert only the merge-commit tree on a clean
  working tree, so they stay green and gain incidental worktree/index coverage.
