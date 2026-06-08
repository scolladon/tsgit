# Design — `merge` worktree + index materialisation

## Problem

`repo.merge` updates only the commit/ref for its **non-conflict** outcomes and
leaves the working tree + index frozen at `ours`. Canonical `git merge` checks
the merge result out to **both** the index and the working tree. This is a
faithfulness violation (prime directive), confirmed against real `git` for both
non-conflict paths:

- **Fast-forward** — `git merge --ff` advances the index + working tree to the
  new tip (a checkout). tsgit's FF branch (`mergeRun`) does a bare `updateRef`.
- **Clean true-merge** — `git merge --no-ff` writes the merged tree to the index
  + working tree. tsgit's `commitCleanMerge` commits the correct merged tree but
  writes neither.

### Oracle

Graph: base `f.txt`, ours `+a.txt`, theirs `+m.txt` (disjoint → clean). Real
`git merge --no-ff` and `git merge --ff` both leave `m.txt` in the **tree, the
index, and the working tree**. tsgit over the identical graph:

| outcome | merge-commit tree | index | working tree |
|---|---|---|---|
| clean true-merge | ✅ `f+a+m` | ❌ `f+a` | ❌ `m.txt` absent |
| fast-forward | — | ❌ `f` only | ❌ `m.txt` absent |

The merge *commit* is correct; the checkout-to-worktree+index step is missing.
The defect affects every clean merge whose result differs from `ours` — theirs-
only adds, theirs-side edits, theirs-side deletes, and combined content merges —
not only theirs-only adds.

### Root cause

`ADR-215` extracted the shared `applyMergeToWorktree` primitive (clean →
`materializeTree` onto worktree + index with a dirty guard; conflict → markers +
stage-1/2/3 entries) and **explicitly deferred migrating `merge.ts` onto it**:
"out of scope … risks merge's mutation-tested invariants … tracked for a later
cleanup." Every other 3-way consumer — cherry-pick, revert, rebase, stash —
already routes through it. `merge` is the lone holdout, and only its **conflict**
path materialises today (`persistConflictState` → `writeConflictingWorkingTree`
+ `buildConflictIndexEntries`, sparse-aware per `ADR-076`). No ADR diverges and
*justifies* a worktree-less merge, so this is an unfaithful gap to close, not an
intentional divergence.

## Scope

In scope — the two **non-conflict** outcomes:

1. clean true-merge (`commitCleanMerge`) → materialise the merged tree to
   worktree + index, then commit + move the ref;
2. fast-forward (`mergeRun`'s FF branch) → materialise the new tip's tree to
   worktree + index, then move the ref.

Out of scope — the **conflict** path stays exactly as-is. It already materialises
correctly, is **sparse-aware** (`ADR-076`), persists `MERGE_HEAD` / `ORIG_HEAD` /
`MERGE_MSG`, and carries the mutation-tested invariants `ADR-215` warned about.
`up-to-date` and `fastForward: 'only'`-refusal outcomes are unaffected.

## Approach

Keep `merge`'s single merge engine (`computeMergeTreeResult`) for clean-vs-
conflict detection and its conflict machinery untouched. Add a worktree + index
materialisation step to the two non-conflict branches, following the established
cherry-pick pattern (`applyOnePick`): acquire the index lock, read the current
index, materialise the target tree, commit the resulting index entries, then
create the commit (clean) / move the ref (FF), all under the lock.

```
commitCleanMerge(…, mergedTree):
  lock = acquireIndexLock(ctx)
  try:
    currentIndex = readIndex(ctx)
    materialised = materializeTree(ctx, { targetTree: mergedTree, currentIndex, force: false })
    lock.commit(materialised.newIndexEntries)
    id = createCommit(ctx, commitData)
    updateRef(ctx, branch, id, { expected: ourId, reflogMessage })
    return { kind: 'merge', … }
  finally:
    lock.release()
```

The FF branch mirrors it with `targetTree = theirsTree` and an `updateRef`
instead of a new commit (FF creates no commit).

`materializeTree(force: false)` diffs the target tree against the current index
and writes only the changed paths (`m.txt` add; theirs-side edits as updates;
theirs-side deletes as removals), returning post-write stat-carrying index
entries for the lock to commit — identical to the clean branch of
`applyMergeToWorktree`. The merged tree is already synthesised by
`computeMergeTreeResult`, so no second 3-way merge is run.

### Dirty-worktree guard

`materializeTree(force: false)` calls `checkDirty` before writing: a to-be-
overwritten tracked file whose working content drifted from the index, or an
untracked file clashing with a path the merge adds, makes the merge **refuse
without mutating any state** — matching git's "Your local changes / untracked
working tree files would be overwritten by merge. Aborting." In the normal merge
flow the working tree matches `ours` (clean), so nothing is dirty and the merge
proceeds. Using `force: false` (not `force: true`) is mandatory: `force: true`
would silently clobber a dirty working file (data loss, unfaithful).

## Key decisions (for ADR)

**D1 — Fix strategy: targeted materialisation vs full `applyMergeToWorktree`
migration.** Recommend **targeted** `materializeTree` in the two non-conflict
branches. A full migration of `merge` onto `applyMergeToWorktree` would route the
*conflict* path through it too, which (a) regresses `ADR-076` sparse-aware
conflict materialisation (the primitive's conflict writer takes no matcher), (b)
double-writes the conflict working tree, and (c) disturbs merge's mutation-tested
conflict invariants — the precise risk `ADR-215` flagged when it deferred the
migration. The targeted fix touches only the currently-empty non-conflict
branches (lowest blast radius) and leaves the conflict path byte-identical.

**D2 — Dirty-worktree refusal error code.** The refusal is git-faithful either
way (no state mutation); the question is which structured code the library
surfaces. Options: (a) accept `checkoutOverwriteDirty` — what
`materializeTree(force: false)` already raises, zero extra code; (b) a thin pre-
check that throws the merge-family `workingTreeDirty` (the code cherry-pick /
revert / rebase / stash surface for their would-overwrite guard via
`applyMergeToWorktree`'s `would-overwrite` result), at the cost of a small dirty
pre-scan. Recommend **(b)** for cross-command consistency within the 3-way merge
family.

## Faithfulness pinning

New `test/integration/merge-interop.test.ts` (twin git peer / tsgit ours over a
real tmpdir + the Node fs adapter, `interop-helpers`), asserting **index +
working tree + tree** parity after:

- a fast-forward merge (theirs-only add reaches index + worktree);
- a clean true-merge — theirs-only add, theirs-side edit, and a combined content
  merge (`writeTreeOf` index→tree equality, `lsStage` entry equality, on-disk
  file bytes, and merge-commit tree equality);
- a **dirty-worktree co-refusal**: a local edit to a path the merge would
  overwrite makes **both** git and tsgit refuse, leaving HEAD + index + worktree
  unchanged (`tryRunGit` for the peer side).

## Test plan

Unit (`merge.test.ts`, GWT/AAA, `sut`, 100% coverage + 0 killable mutants):

- clean true-merge materialises a theirs-only add into worktree + index (the
  reproduction);
- clean true-merge applies a theirs-side edit / delete to worktree + index;
- fast-forward materialises the new tip into worktree + index;
- dirty-worktree path → refusal with the chosen error code, HEAD/index/worktree
  unchanged (separate tests for the tracked-drift and untracked-clash guards);
- regression: the conflict path's worktree + index output is unchanged.

## Risks

- **Merge's mutation invariants** — mitigated: the conflict path is untouched;
  only the previously-inert non-conflict branches gain logic.
- **Index-lock ordering** — the lock wraps read → materialise → commit-index →
  create-commit/move-ref → release, mirroring `applyOnePick`; object writes
  (merged blobs/tree) happen before the lock and need no serialisation.
- **Existing clean-merge unit tests** — they assert only the merge-commit tree
  and use a clean working tree, so they stay green; some gain incidental
  worktree/index coverage.

## Non-goals

- Migrating the conflict path onto `applyMergeToWorktree` (would regress
  `ADR-076`); tracked separately if ever desired.
- Reproducing git's human-readable "would be overwritten by merge" prose — the
  library emits structured codes, not rendered stdout (`ADR-249`).
- The pre-merge **index-vs-HEAD** cleanliness guard (git refuses a merge when the
  index carries staged changes on an affected path) — a separate, pre-existing gap
  that `merge` already lacks; the `force: false` guard here checks working-tree
  drift against the index, not index drift against HEAD. Not a regression; tracked
  separately if desired.
