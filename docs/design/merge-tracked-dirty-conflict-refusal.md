# Design — merge-command tracked-dirty conflict-path refusal (S13 gap)

> Brief: git refuses a merge when a **tracked** working file with local changes
> would be overwritten by conflict materialisation
> (`Your local changes to the following files would be overwritten by merge`);
> tsgit's `merge` pre-flights only the distinct-types **untracked** rename-target
> case on its conflict write path, while the apply consumers
> (`cherry-pick`/`revert`/`rebase`/`stash` via
> `applyMergeToWorktree.findWouldOverwrite`) already guard tracked-dirty paths.
> Add the tracked-dirty guard to `merge`'s conflict write path (conflict-wide,
> not distinct-types-specific) + pin refusal parity with interop.
>
> Status: draft → self-reviewed ×3 → accepted → revised against ADRs 342–345
>
> All four decisions are now **resolved** (ADRs 342/343/344/345). Decisions 1, 2, 4
> landed **as recommended**; **Decision 3 deviated** — the user chose to discriminate
> the refusal by class, and the accepted shape is **two class-keyed arrays**
> `WORKING_TREE_DIRTY { localChanges, untracked }`, not the `reason` enum the
> discriminate-option had named first. The sections below reflect the accepted
> contract; the original analysis is retained and annotated, not deleted.

## Problem

When a true merge **conflicts**, tsgit's `merge` command persists the conflict
state — markers in the working tree, stage 1/2/3 index entries, `MERGE_HEAD` /
`MERGE_MSG` / `ORIG_HEAD` — through `persistConflictState` →
`writeConflictingWorkingTree` (`merge.ts:430`/`528`). The only pre-flight refusal
on that path is `collectUntrackedRenameBlockers` (`merge.ts:513`): it `lstat`s the
distinct-types **rename targets** and refuses with `workingTreeDirty(blockers)`
if an **untracked** file squats one. There is **no conflict-wide tracked-dirty
guard**: a tracked working file with uncommitted local changes that the merge
would overwrite is silently clobbered.

git refuses. Confirmed empirically (real `git` 2.54.0, ort) and on the current
tsgit build:

```
# git:   refuses, exit 2, working tree + index + HEAD untouched, no MERGE_HEAD
error: Your local changes to the following files would be overwritten by merge:
	file.txt

# tsgit: returns { kind: 'conflict', conflicts: [{ path: 'file.txt', type: 'content' }], … }
#        file.txt overwritten with conflict markers, MERGE_HEAD written  ← DATA LOSS
```

This is a faithfulness divergence with data-loss consequences (the user's
uncommitted edit is destroyed), not a cosmetic gap.

The **clean** true-merge and fast-forward paths are **already guarded**:
`materialiseNonConflictTree` → `materializeTree` raises `CHECKOUT_OVERWRITE_DIRTY`,
which `asMergeDirtyError` (`merge.ts:213`) maps to `WORKING_TREE_DIRTY`. Existing
unit tests at `merge.test.ts:375` (clean-merge tracked-dirty) and `:417`
(clean-merge untracked-add) pin that branch. The gap is **strictly the conflict
branch**.

The **apply consumers** already implement the conflict-wide guard. In
`apply-merge-to-worktree.ts`, `changedPaths` (`:100`) collects every path the
merge would touch — clean outcomes that change ours (`outcomeChangesOurs`) plus
every conflict's `recordedPaths` — and `findWouldOverwrite` (`:116`) flags each
path that is **tracked-and-working-tree-modified** (via `compareWorkingTreeEntry`
/ `isWorkingTreeModified`) **or untracked-but-present** (the stash-add case),
returning `{ kind: 'would-overwrite', paths }` **before any write** (`:306`).
`cherry-pick` / `revert` / `rebase` / `stash` each map that to
`workingTreeDirty(res.paths)` (`cherry-pick.ts:327`/`394`, `revert.ts:167`/`385`,
`rebase.ts:254`, `stash.ts:441` via `stashApplyWouldOverwrite`).

`merge`'s conflict path needs the same guard; the design question is whether it
**reuses** the apply primitive's logic or grows its own, and on **which path
set**.

## Requirements

When this ships:

1. A `repo.merge.run` that would materialise a conflict overwriting a **tracked,
   locally-modified** working file refuses with
   `WORKING_TREE_DIRTY { localChanges, untracked }` carrying the offending path in
   `localChanges` (ADR-344) **before any disk write** — working tree, index, and
   HEAD untouched, no `MERGE_HEAD`/`MERGE_MSG`/`ORIG_HEAD` written, no `index.lock`
   leaked.
2. The guard is **conflict-wide**: it covers every path the conflicting merge
   would change — both conflict recorded paths (content, distinct-types renames,
   etc.) **and** clean outcomes that change ours — not only distinct-types
   targets.
3. The existing **untracked**-overwrite refusal (distinct-types rename target,
   S7) keeps refusing — now carrying the offending path in the `untracked` array
   of `WORKING_TREE_DIRTY { localChanges, untracked }` (ADR-344), through the
   unified pass.
4. A tracked-dirty path the merge does **not** touch (unchanged on both sides)
   does **not** refuse; the merge proceeds and the dirty file survives.
5. A tracked path whose merge resolves **cleanly** but **changes** ours, dirty in
   the worktree, **does** refuse (its path in `localChanges`) even though that
   path alone would not conflict.
6. Each class array is sorted **ascending** with the existing path comparator, and
   `localChanges` is the block reported before `untracked` (ADR-345). A path that
   is **both** classes resolves to `localChanges` only (ORD2) — never present in
   both arrays.
7. Refusal parity is pinned against real `git` in
   `test/integration/*-interop.test.ts`, reconstructing git's two prose blocks
   from the two structured arrays per ADR-249.
8. No regression to the clean/fast-forward dirty refusal or the apply consumers —
   both updated to the two-array shape and kept green.

## Faithfulness evidence (real `git` 2.54.0, ort)

Probed on throwaway repos under `mktemp -d` (`env -i`, isolated non-existent
`HOME`, `GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed, signing off,
`merge.conflictStyle=merge`). The working tree is **never** the probe site
(`.git/config` is shared across worktrees via the common dir). Merge is
`git merge --no-ff -m m theirs`. Index via `git ls-files -s`; refusal via
captured exit code + stderr; on-disk state via `lstat` + `MERGE_HEAD` presence.

| # | Scenario | git result |
|---|---|---|
| **S13** | base `a\nb\nc\n`; ours `a\nX\nc\n`; theirs `a\nY\nc\n` → content conflict on `file.txt`; `file.txt` dirty (`a\nDIRTY-LOCAL\nc\n`) before merge | **refusal, exit 2**: `error: Your local changes to the following files would be overwritten by merge:\n\tfile.txt\nPlease commit your changes or stash them before you merge.\nAborting`. Worktree `file.txt` = `DIRTY-LOCAL` (untouched), index stage-0 only, **no `MERGE_HEAD`** |
| M1 | three paths added in order `zebra`,`alpha`,`mango`, all conflict, all dirty | refusal, exit 2; paths listed **alphabetically sorted** (`alpha.txt`, `mango.txt`, `zebra.txt`) — sort order, **not** add/index order; index stage-0 |
| M2 | `f1` conflicts (both sides change); `f2` changed by **theirs only** (clean merge of `f2`), `f2` dirty | **refusal, exit 2** on `f2.txt` — a clean-but-changed path that is dirty refuses; no markers written, no `MERGE_HEAD` |
| M3 | `f1` conflicts + dirty; `f3` **untouched** by either side, dirty | **no refusal, exit 1** (conflict on `f1`); `MERGE_HEAD` written; `f3` dirty content survives — untouched paths are out of the guard |
| CL1 | `f1` conflicts (clean side unchanged in ours); `f2` theirs-only change, dirty; otherwise a conflicting merge | refusal, exit 2 on `f2.txt`; `f1` written **no** markers — the guard fires before any conflict materialisation even when a conflict exists elsewhere |
| TC1 | base file `p`; ours file `p` (modified); theirs symlink `p` → distinct-types conflict; `p` dirty | refusal, exit 2 on `p` — distinct-types conflict path is covered by the dirty guard at `conflict.path` |
| S7 | theirs **adds** `g`; untracked `g` squats it | refusal, exit 2: `error: The following untracked working tree files would be overwritten by merge:\n\tg\nPlease move or remove them before you merge.` (the **untracked** message — distinct prose, distinct suffix) |
| S7b | distinct-types: base file `p`, theirs symlink `p`, ours file `p` (regular side renamed to `p~HEAD`); untracked `p~HEAD` squat | refusal, exit 2, **untracked** message listing `p~HEAD` — matches the parent doc's S7 row, re-pinned here |
| ORD1 | tracked-dirty conflict path `f1` **and** untracked squat `g` (theirs-only add), non-overlapping | refusal, exit 2; git emits **both** blocks — **tracked-dirty (local changes) FIRST**, then untracked — in one stderr |
| ORD2 | tracked-dirty conflict path `f1` **and** distinct-types untracked rename-target squat `p~HEAD` | refusal, exit 2; **only** the **local-changes** block printed (`f1.txt`) — the tracked-dirty refusal short-circuits before the rename even probes its target |
| SP1 | conflict path `inside/f.txt` is **sparse-excluded** (cone sparse-checkout set to `outside/`); `inside/f.txt` absent from disk | **no refusal, exit 1**; git materialises the conflict to disk anyway (markers + stages 1/2/3), `MERGE_HEAD` written — a sparse-excluded path has no working file to be dirty, so the guard naturally never fires there |
| DG1 | untracked **dangling** symlink (`p~HEAD → /nonexistent/target`) squats a distinct-types rename target | **refusal, exit 2**, untracked message listing `p~HEAD` — git's untracked-presence probe is `lstat`-based (it sees the dangling link), **not** target-following. `realpath('p~HEAD')` fails (dangling) yet git still refuses |

Derived rules:

- **R1 — the gap is the merge command's conflict write path only.** The clean
  and fast-forward paths already refuse via `CHECKOUT_OVERWRITE_DIRTY` →
  `asMergeDirtyError` → `WORKING_TREE_DIRTY` (`merge.test.ts:375`/`:417`). S13
  reproduces only when the merge **conflicts**, routing through
  `persistConflictState`.

- **R2 — the dirty check is conflict-wide, over `changedPaths`.** git refuses on
  any path the merge would **change** that is locally modified: conflict recorded
  paths (content/distinct-types/etc., M1/TC1/CL1) **and** clean outcomes that
  change ours (M2/CL1 — `f2`'s theirs-only change). Untouched paths are exempt
  (M3). This is exactly the set `apply-merge-to-worktree.ts`'s `changedPaths`
  already computes (clean-changes-ours via `outcomeChangesOurs` + every
  conflict's `recordedPaths`).

- **R3 — tracked-dirty means working-tree-modified vs the current stage-0
  index.** A path is dirty when its working file differs from the index entry —
  `compareWorkingTreeEntry` ≠ `unchanged`/`absent` (the `isWorkingTreeModified`
  valve). This is the identical predicate `findWouldOverwrite` uses; `merge` has
  no equivalent today on the conflict path.

- **R4 — both refusal *conditions* exist, with distinct prose, same exit code.**
  Tracked-dirty → `Your local changes to the following files would be overwritten
  by merge:` + `Please commit your changes or stash them before you merge.`;
  untracked → `The following untracked working tree files would be overwritten by
  merge:` + `Please move or remove them before you merge.`. **Both are exit 2.**
  Per **Decision 3 (resolved, ADR-344)** the two conditions are **discriminated**
  into two class-keyed arrays on a single code:
  `WORKING_TREE_DIRTY { localChanges, untracked }`. A refusal is raised when
  either array is non-empty; a consumer reconstructs git's prose blocks straight
  from the two arrays without a re-stat. The single flat `{ paths }` shape the
  original draft proposed is **superseded** by this two-array shape across the
  whole merge family (the untracked refusal, the clean-path dirty refusal, and the
  apply consumers).

- **R5 — ordering: tracked-dirty (local changes) is reported before untracked.**
  When both classes are present git prints the local-changes block first (ORD1),
  and when they overlap on the same logical operation the local-changes refusal
  short-circuits the untracked probe (ORD2). Per **Decision 4 (resolved, ADR-345)**
  each class array is sorted ascending and `localChanges` is the first-reported
  block; an ORD2 path lands in `localChanges` only and never in `untracked`. The
  unified pass therefore runs tracked-dirty collection before untracked, and the
  ORD2 de-dup is "a path already in `localChanges` is excluded from `untracked`".

- **R8 — git's untracked-presence probe is `lstat`-based, not
  target-following.** A *dangling* untracked symlink squatting a rename target
  still refuses (DG1): `realpath` fails on the dangling link yet git refuses.
  This matched the (now-removed) `collectUntrackedRenameBlockers` (which used
  `ctx.fs.lstat`) and **diverged from** `findWouldOverwrite`'s untracked branch,
  which probed `ctx.fs.exists` — a `realpath`-following call on the node adapter
  (`node-file-system.ts:451`) that returns **false** for a dangling link. A naive
  fold leaving that probe as `ctx.fs.exists` would have **regressed the
  dangling-symlink case**. **Decision 2 (resolved, ADR-343) mandates switching the
  unified check's untracked-presence probe to `lstat`**, so DG1 is preserved on the
  merge path and **fixed** on the apply consumers (where it was an unpinned
  divergence).

- **R6 — sparse-excluded conflict paths are out of the guard by construction.**
  A sparse-excluded path has no working file (`compareWorkingTreeEntry` →
  `absent` → not modified), so the dirty guard never fires there (SP1). git
  materialises the excluded conflict to disk regardless; tsgit's
  `writeConflictToTree` already takes no matcher (`merge.ts:549`). No special
  handling needed — the guard's own predicate handles it. Pinned, not widened.

- **R7 — refusal is atomic and pre-write.** git leaves the working tree, index,
  and HEAD untouched and writes no `MERGE_HEAD` (S13, M1, M2, CL1, TC1). The
  guard must fire **before** `acquireIndexLock` writes anything (mirroring
  `collectUntrackedRenameBlockers`, which already runs first inside
  `writeConflictingWorkingTree`), and must not leak `index.lock`
  (`merge.test.ts:457` pins lock release for the clean-path refusal; the conflict
  path must hold the same invariant).

## Current state

- `src/application/commands/merge.ts`
  - `persistConflictState` (`:430`) — acquires the index lock, then calls
    `writeConflictingWorkingTree`; **no tracked-dirty pre-flight**.
  - `writeConflictingWorkingTree` (`:528`) — runs `collectUntrackedRenameBlockers`
    (untracked distinct-types targets only) → `throw workingTreeDirty(blockers)`,
    then writes outcomes + conflicts. Has `result.outcomes` + `result.conflicts`
    but **does not read the current index** here, and **does not build the
    `ours` flat map** the apply primitive uses for `outcomeChangesOurs`.
  - `asMergeDirtyError` (`:213`) — the clean/FF path's `CHECKOUT_OVERWRITE_DIRTY`
    → `WORKING_TREE_DIRTY` mapper. Unaffected.
  - `MergeConflictDescriptor` (`:92`) = `{ path, type }`; `MergeResult`'s conflict
    arm returns `conflicts.map((c) => ({ path: c.path, type: c.type }))` (`:461`).

- `src/application/primitives/apply-merge-to-worktree.ts`
  - `changedPaths` (`:100`) — clean-changes-ours + conflict `recordedPaths`;
    **private const**.
  - `findWouldOverwrite` (`:116`) — **today** tracked-dirty
    (`isWorkingTreeModified(compareWorkingTreeEntry)`, the `localChanges` class) +
    untracked-present (`byPath.get === undefined` then `ctx.fs.exists`, the
    `untracked` class); **private const**; takes `(ctx, paths: Set<FilePath>,
    currentIndex: GitIndex)`; **today returns** flat `ReadonlyArray<FilePath>`.
    Under ADRs 342/343/344 it is **promoted** and its return becomes
    `{ localChanges, untracked }` with the untracked branch probing `ctx.fs.lstat`.
    The `WorktreeMergeResult` `would-overwrite` arm (`:69`) likewise carries the two
    arrays instead of `paths`.
  - `outcomeChangesOurs` (`:72`) — clean-outcome-changes-ours predicate; private,
    carries documented equivalent-mutant justifications keyed off "a superset
    `changed` set is observationally identical".

- `src/application/primitives/compare-working-tree-entry.ts` —
  `compareWorkingTreeEntry` / `isWorkingTreeModified`, the dirtiness valve.
  Already a shared primitive; symlink-aware; reads the uncapped hash core.

- `src/domain/diff/index-diff.ts` — `recordedPaths` (`:189`, exported),
  `sortedRecordedPaths` (`:199`, exported). The path-set building blocks are
  already in domain.

- `src/domain/commands/error.ts` — **today** `WORKING_TREE_DIRTY { paths }`
  (`:8` union member, `:213` `workingTreeDirty()` factory), the unified merge-family
  would-overwrite code with no discriminator. **ADR-344 changes it to**
  `WORKING_TREE_DIRTY { localChanges: ReadonlyArray<FilePath>, untracked: ReadonlyArray<FilePath> }`.
  Its current consumers (all migrate to the two-array shape — see Consumers):
  `asMergeDirtyError` (`merge.ts:213`), the merge untracked-blockers refusal
  (`merge.ts:537`), `assertCleanWorkTree` (`clean-work-tree.ts:73` —
  `require_clean_work_tree` for cherry-pick/revert/rebase), and the
  cherry-pick/revert/rebase `would-overwrite` mappings
  (`cherry-pick.ts:327`/`:394`, `revert.ts:167`/`:385`, `rebase.ts:254`).

- `src/domain/commands/error.ts` — `CHECKOUT_OVERWRITE_DIRTY { paths }` (`:44`
  union, `:301` factory). This is the clean/FF path's error, **flat** `paths`.
  Its producer `applyChangeset` → `checkDirty` → `evaluateDirtyPath`
  (`apply-changeset.ts:82`) **does** classify each offending path by changeset
  entry kind — `update`/`delete` (was tracked, would be overwritten) via
  `isWorkingTreeDirty`, vs `add` (untracked clash) via `isUntrackedClash` — **but
  discards that classification by pushing both into one flat array**. So
  `asMergeDirtyError`, given only the flat `paths`, cannot today reconstruct which
  class each path is. See the clean-path mapping in *Error structured shape*.

- `src/domain/error.ts` (`:281`) — the `WORKING_TREE_DIRTY` structured-error
  renderer: `working tree has uncommitted changes: ${data.paths.length} files`.
  Reads `data.paths.length`; must move to `localChanges.length + untracked.length`.

- `src/application/commands/stash.ts` (`:441`) — reads `result.paths` from the
  `would-overwrite` arm and throws its **own** code `stashApplyWouldOverwrite`
  (`STASH_APPLY_WOULD_OVERWRITE { paths }`, `error.ts:184`/`:535`) — **not**
  `workingTreeDirty`. When the `would-overwrite` arm splits, stash's `result.paths`
  access breaks; see Consumers for the boundary resolution.

- `src/application/primitives/read-index.ts` — `readIndex(ctx)` returns the
  current `GitIndex` (used elsewhere in `merge.ts`).

## Proposed design

### Shape of the change

A conflict-wide would-overwrite pre-flight is added to the merge conflict path,
refusing with `workingTreeDirty({ localChanges, untracked })` before any write
(Decision 3 resolved, ADR-344). The path set is **`changedPaths`** (clean outcomes
that change ours + every conflict's `recordedPaths`) — the same set the apply
primitive uses. The dirty predicate is **`findWouldOverwrite`**, now returning the
two classes **separately**: a changed path that is tracked and working-tree-modified
(`compareWorkingTreeEntry` ≠ `unchanged`/`absent`, via `isWorkingTreeModified`) goes
to `localChanges`; a changed path **not** in the stage-0 index but present on disk
(the `byPath.get(path) === undefined` branch) goes to `untracked`. The untracked
branch's presence probe switches from `ctx.fs.exists` to `ctx.fs.lstat` (Decision 2
resolved, ADR-343) so a dangling-symlink squat still refuses (R8/DG1). The existing
untracked pre-flight `collectUntrackedRenameBlockers` is **removed** — its
distinct-types rename targets are in `changedPaths`'s `recordedPaths` and are now
flagged by the unified pass's `untracked` branch.

The shared check **promotes `changedPaths` + `findWouldOverwrite` to a shared
internal primitive** (Decision 1 resolved, ADR-342) that both
`apply-merge-to-worktree.ts` and `merge.ts` call. Both surfaces already compute the
*same* logical set and run the *same* dirty predicate; the only reason it was
duplicated is that `findWouldOverwrite` was born private to the apply primitive. The
promoted predicate returns a `{ localChanges: ReadonlyArray<FilePath>, untracked:
ReadonlyArray<FilePath> }` shape (each class array, before sorting); the sort is
applied at the refusal-construction boundary (ADR-345).

Inputs the shared check needs, and whether `merge` has them at the pre-flight
point:

| Input | apply has | merge has at pre-flight |
|---|---|---|
| `outcomes` | yes (`merged.outcomes`) | yes (`result.outcomes`) |
| `conflicts` | yes (`merged.conflicts`) | yes (`result.conflicts`) |
| `ours` flat map (for `outcomeChangesOurs`) | yes (`ours.entries` from `flattenTree`) | **not currently** — `computeMergeTreeResult` flattens `ourFlat` but discards it before `persistConflictState`. Recoverable by threading `ourFlat.entries` through `MergeTreeResult`'s conflict arm, or re-flattening ours' tree in the persist path |
| current stage-0 index | yes (`input.currentIndex`) | **not currently read on the conflict path** — add `readIndex(ctx)` before the guard (a pure read; the existing untracked guard already runs lock-free) |

So `merge` can feed the shared check by (a) threading `ours.entries` out of
`computeMergeTreeResult` (cheap — it is already flattened there) and (b) reading
the index before the lock. Both are mechanical.

### Guard placement and order (R5, R7)

Inside the merge conflict path, before any write and before
`acquireIndexLock`:

1. Read the current index (`readIndex`) — pure, lock-free.
2. Compute `changedPaths(outcomes, conflicts, ours)`.
3. Run the **single unified `findWouldOverwrite` pass** over that set, collecting
   tracked-dirty paths into `localChanges` and untracked-present paths into
   `untracked` (the `lstat` probe, ADR-343). A path that is both is recorded in
   `localChanges` only (ORD2 de-dup).
4. If either class is non-empty → sort each ascending (ADR-345) and
   `throw workingTreeDirty({ localChanges, untracked })`.

This **subsumes** `collectUntrackedRenameBlockers` (Decision 2 resolved,
ADR-343): the unified `findWouldOverwrite` flags untracked-but-present paths (the
`byPath.get(path) === undefined` branch), and the distinct-types rename targets are
in `recordedPaths`. The fold is faithful **only** because the unified check's
untracked-presence probe is switched to `ctx.fs.lstat` — matching
`collectUntrackedRenameBlockers`'s prior `lstat` semantics and git's `lstat`-based
probe, so a *dangling* untracked symlink squat still refuses (R8/DG1). The earlier
draft flagged that a naive fold leaving the probe as `ctx.fs.exists` would regress
DG1; ADR-343 mandates the `lstat` switch, closing that gap. `collectUntrackedRename
Blockers` is then removed.

### Error structured shape (R4, ADR-249, ADR-344) — RESOLVED, two class arrays

git emits two textually distinct refusals (local-changes vs untracked), both
exit 2. Per ADR-249 the library emits **structured data**, not the rendered string,
but the structured shape must let a consumer reconstruct what git printed.

**Decision 3 is resolved (ADR-344) and deviated from the draft recommendation.**
The draft recommended keeping the single `WORKING_TREE_DIRTY { paths }`; the user
chose to **discriminate by class**. The accepted shape is **two class-keyed
arrays** — *not* a `reason` enum:

```ts
WORKING_TREE_DIRTY {
  localChanges: ReadonlyArray<FilePath>;  // git's "Your local changes…" block — printed first
  untracked:    ReadonlyArray<FilePath>;  // git's "The following untracked…" block — printed second
}
```

A refusal is raised when **either** array is non-empty. The `reason` enum form was
**rejected** because a single per-error `reason` cannot represent **ORD1** — git
prints **both** a local-changes block **and** an untracked block in one refusal when
both classes are present non-overlapping — and choosing it would force a divergence
from git's dual-block output. Each array is sorted ascending (ADR-345);
`localChanges` is the block git prints first; an ORD2 path (both classes) resolves
to `localChanges` only.

#### Full ripple of the shape change (verified against the code, in-place)

- **`workingTreeDirty()` constructor — `domain/commands/error.ts:213`.** Today
  `(paths: ReadonlyArray<FilePath>) => …{ code: 'WORKING_TREE_DIRTY', paths }`.
  Becomes
  `({ localChanges, untracked }: { localChanges: ReadonlyArray<FilePath>; untracked: ReadonlyArray<FilePath> }) => …{ code, localChanges, untracked }`,
  and the `WORKING_TREE_DIRTY` union member (`error.ts:8`) carries both arrays.

- **Clean / FF mapper `asMergeDirtyError` — `merge.ts:213`.** It maps
  `CHECKOUT_OVERWRITE_DIRTY` → `WORKING_TREE_DIRTY`. **Re-pinned against the code
  and real git:**
  - `CHECKOUT_OVERWRITE_DIRTY { paths }` is **flat** — it does **not itself**
    distinguish the two classes in its payload.
  - But its producer **does** classify, transiently: the clean/FF path is
    `materialiseNonConflictTree` → `materializeTree` → `applyChangeset` →
    `checkDirty` → `evaluateDirtyPath` (`apply-changeset.ts:82`). `evaluateDirtyPath`
    flags an `update`/`delete` changeset entry via `isWorkingTreeDirty` (the
    **tracked-dirty / local-changes** class) and an `add` entry via
    `isUntrackedClash` (the **untracked** class) — then **flattens both into one
    `paths` array**, discarding which class each came from.
  - **Real git confirms this classification is the faithful one** (probed in a
    `mktemp -d` throwaway, env -i, isolated HOME, `GIT_CONFIG_NOSYSTEM=1`, GIT_*
    scrubbed, signing off, `merge.conflictStyle=merge`):
    - clean true-merge that would overwrite a **tracked-dirty** file (the
      `merge.test.ts:375` scenario) → git prints **`Your local changes to the
      following files would be overwritten by merge:`** → maps to `localChanges`.
    - clean true-merge whose **theirs-only add** clashes with an **untracked**
      working file (the `merge.test.ts:417` scenario) → git prints **`The following
      untracked working tree files would be overwritten by merge:`** → maps to
      `untracked`.
  - **Mapping rule.** Because the faithful class is exactly the one
    `evaluateDirtyPath` already computes but throws away, the clean-path mapping
    must **preserve** that distinction rather than re-stat. Concretely:
    `CHECKOUT_OVERWRITE_DIRTY`'s payload is enriched to carry the two classes
    (`{ localChanges, untracked }`, populated at `evaluateDirtyPath`'s branch
    boundary — `update`/`delete` → `localChanges`, `add` → `untracked`), and
    `asMergeDirtyError` becomes a straight class-to-class copy
    (`checkout.localChanges → merge.localChanges`, `checkout.untracked →
    merge.untracked`). This keeps `merge.test.ts:375` green (`f.txt` in
    `localChanges`) and `:417` green (`m.txt` in `untracked`) **and** is the only
    mapping that survives an ORD1-style clean refusal carrying both classes at
    once. (Alternative, if enriching `CHECKOUT_OVERWRITE_DIRTY` is judged out of
    24.9q's blast radius: `asMergeDirtyError` re-derives the class by stat-ing each
    flat path against the current index — tracked-and-on-disk-modified →
    `localChanges`, not-in-index-but-present → `untracked`. This re-does work the
    producer already did and is less faithful for the `delete`-of-a-tracked-path
    edge, so the enrich-the-error route is preferred. The plan phase picks the
    concrete form; either keeps `:375`/`:417` green.) Note `apply-changeset.ts:166`
    (`throw checkoutOverwriteDirty(dirty)`) is the **same** call that carries the
    clean/FF merge's classification — under the enrich route it throws the
    `{ localChanges, untracked }` that `checkDirty`/`evaluateDirtyPath` build.
    `CHECKOUT_OVERWRITE_DIRTY`'s **other** producers (`working-tree.ts:96`/`:99` —
    remove of a non-file/missing tracked path) populate `localChanges`, `untracked`
    empty; they are off the merge path and do not regress.

- **Apply consumers' `would-overwrite` → `workingTreeDirty(...)` mappings.** The
  promoted `findWouldOverwrite` and the `applyMergeToWorktree` `would-overwrite`
  arm change from `{ paths }` to `{ localChanges, untracked }`. The five
  `would-overwrite` call sites — `cherry-pick.ts:327`/`:394`, `revert.ts:167`/`:385`,
  `rebase.ts:254` — each become a class-keyed pass-through
  `throw workingTreeDirty({ localChanges: res.localChanges, untracked: res.untracked })`.
  Plus the `require_clean_work_tree` pre-flight `assertCleanWorkTree`
  (`clean-work-tree.ts:73`) — a **separate** `workingTreeDirty` call site that
  collects only **tracked** dirt (staged + unstaged + unmerged) — becomes
  `workingTreeDirty({ localChanges: [...dirty], untracked: [] })` (git's
  `require_clean_work_tree` prints the local-changes prose).

- **Stash boundary — `stash.ts:432`/`:441`.** Stash consumes the `would-overwrite`
  result via its **own** code `STASH_APPLY_WOULD_OVERWRITE { paths }` (single flat
  array), **not** `workingTreeDirty`. When the `would-overwrite` arm splits,
  `result.paths` no longer exists. Minimal faithful resolution (keeps stash's
  contract unchanged, in scope only as a non-breaking adaptation):
  `stashApplyWouldOverwrite([...result.localChanges, ...result.untracked])` —
  flatten the two classes at the stash boundary (git's `stash apply` overwrite
  refusal is a single local-changes block, so the merged order is acceptable; the
  existing stash tests use the same paths). Splitting `STASH_APPLY_WOULD_OVERWRITE`
  too is **out of scope** for 24.9q — that is stash's own contract.

- **Renderer — `domain/error.ts:281`, the `WORKING_TREE_DIRTY` case.** Today
  `working tree has uncommitted changes: ${data.paths.length} files`. Becomes
  `${data.localChanges.length + data.untracked.length} files` (the count is the sum
  of both classes; the message stays a count summary, not git's prose, per
  ADR-249).

### Sparse (R6)

No special handling. A sparse-excluded conflict path is `absent` on disk, so
`compareWorkingTreeEntry` returns `absent`, `isWorkingTreeModified` is false, and
the unified check skips it — matching git's "materialise the excluded conflict,
do not refuse" behaviour (SP1). The conflict is still written (tsgit's
`writeConflictToTree` already takes no matcher). Pinned by an interop row, not
widened.

### Consumers

`cherry-pick` / `revert` / `rebase` / `stash` keep their **refusal behaviour** for
the already-covered cases — they call `findWouldOverwrite` via
`applyMergeToWorktree`. The accepted ADRs ripple into them as follows:

- **ADR-342** — the apply primitive is refactored to call the promoted shared check;
  behaviour identical for the existing example/interop set.
- **ADR-343** — the untracked-presence probe changes `fs.exists`→`lstat`, which
  **fixes** the apply consumers' currently-uncovered dangling-symlink-squat edge to
  match git (DG1) — a faithfulness improvement, not a regression, re-verified by a
  new apply/stash dangling-symlink check (existing tests use regular files only).
- **ADR-344** — the `would-overwrite` arm now returns `{ localChanges, untracked }`,
  so the five `would-overwrite` call sites pass both classes through to
  `workingTreeDirty({ localChanges, untracked })`; `assertCleanWorkTree` moves to
  `{ localChanges: [...dirty], untracked: [] }`; and stash flattens both classes
  back into its own `STASH_APPLY_WOULD_OVERWRITE` single array at its boundary (its
  own contract is unchanged).

The structured `WORKING_TREE_DIRTY` shape change is observable on the merge family's
error contract (`merge`, `cherry-pick`, `revert`, `rebase`, the `clean`-family
`require_clean_work_tree`). No **new** public surface is added: the shared check is
an internal primitive, and `merge`'s `MergeResult` conflict arm is unchanged.

## Decision candidates

All four decisions are **resolved**. The analysis is retained below; the
**Resolution** column records the accepted option and its ADR.

| # | Choice | Alternatives (≤3) | Original recommendation | Resolution |
|---|---|---|---|---|
| 1 | Reuse vs extract the guard | (a) **Promote `changedPaths` + `findWouldOverwrite` to a shared primitive** both `merge` and `apply-merge-to-worktree` call; (b) duplicate the logic inline in `merge` (copy the two functions); (c) call `applyMergeToWorktree` from `merge`'s conflict path wholesale | **(a)** — the two surfaces compute the identical set and run the identical dirty predicate; the only reason it is private is birthplace. Promotion is a clean DRY lift. (c) is wrong — `merge` owns its own index/tree/MERGE_MSG ceremony and cannot delegate the whole write path; (b) re-introduces the divergence this item exists to close | **RESOLVED → (a), as recommended ([ADR-342](../adr/342-promote-would-overwrite-guard-to-shared-primitive.md)).** The apply primitive is refactored to call the promotion; its observable behaviour stays byte-identical for the existing suites |
| 2 | Fold `collectUntrackedRenameBlockers` into the unified check, or keep both | (a) **Fold into one ordered `findWouldOverwrite` pass, switching its untracked-presence probe from `fs.exists` to `lstat`** (so a dangling symlink squat still refuses, R8/DG1); (b) keep `collectUntrackedRenameBlockers` as-is and add the tracked-dirty guard as a separate pass before it; (c) fold but leave the probe as `fs.exists` | **(a)** — one ordered pass naturally reports local-changes before untracked (ORD1), de-dupes the overlap (ORD2), and removes duplicated logic, but only after the mandatory `lstat` switch. (c) **rejected** — regresses DG1. (b) safe fallback if the probe switch ripples unexpectedly | **RESOLVED → (a), as recommended ([ADR-343](../adr/343-fold-untracked-guard-lstat-presence-probe.md)).** One ordered pass; untracked probe switched to `lstat`; `collectUntrackedRenameBlockers` removed (its rename targets are in `recordedPaths`). The apply consumers' `fs.exists`→`lstat` switch is re-verified by a new dangling-symlink check |
| 3 | Error structured shape: discriminate the two refusal conditions or not | (a) **Keep single `WORKING_TREE_DIRTY { paths }`** (consumer reconstructs prose from context); (b) add `reason: 'local-changes' \| 'untracked'`; (c) split into two path arrays (`localChanges`, `untracked`) | **(a)** — ADR-249 binds data + exit, not prose; exit is 2 for both and `paths` carries the offenders, so a discriminator looked like an isolated untested split | **RESOLVED → DEVIATED. The user chose to discriminate; the accepted form is (c) two class-keyed arrays `{ localChanges, untracked }` ([ADR-344](../adr/344-discriminate-would-overwrite-refusal-by-class.md)).** Option (b)'s `reason` enum was **rejected** — a single per-error `reason` cannot represent **ORD1** (git prints both blocks in one refusal), forcing a divergence from git. The two-array shape is the only one faithful to ORD1. See *Error structured shape* for the full ripple |
| 4 | Path ordering / first-guard semantics | (a) **Sort ascending** (git lists ascending within a block) and report local-changes before untracked so a path that is both appears once as local-changes; (b) preserve discovery (`Set`) order; (c) match git's cross-block order within a flat array | **(a)** — git lists ascending within each block (M1) and reports local-changes first (ORD1/ORD2); `sortedRecordedPaths`/`comparePaths` already exist. (b) non-deterministic | **RESOLVED → (a), as recommended ([ADR-345](../adr/345-sort-would-overwrite-paths-local-changes-first.md)).** Each class array sorted ascending; `localChanges` reported before `untracked`; an ORD2 path lands in `localChanges` only. Sorting applied at the refusal-construction boundary; the internal `changedPaths` set stays order-agnostic |

## Test strategy

### Interop (faithfulness — the real gate)

New `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts`,
twin git-peer / tsgit harness per `merge-conflict-interop.test.ts`
(`makePeerPair`, scrubbed `runGit`/`tryRunGit`, peer pinned
`-c merge.conflictStyle=merge`). One slice per in-scope evidence row,
reconstructing git's two prose blocks from the structured
`WORKING_TREE_DIRTY { localChanges, untracked }` + the captured peer exit/stderr
(ADR-249) — local-changes paths from `localChanges`, untracked paths from
`untracked`, each rendered ascending, local-changes block first:

- **S13** — single tracked-dirty content-conflict path: both tools refuse; tsgit
  `localChanges` = `['file.txt']`, `untracked` = `[]`; worktree bytes, `lsStage`,
  and HEAD unchanged on both; **no `MERGE_HEAD`**.
- **M1** — two tracked-dirty conflict paths: both refuse; `localChanges` sorted
  `[alpha.txt, mango.txt, zebra.txt]` (sort order, not add order), `untracked` = `[]`.
- **M2 / CL1** — clean-but-changed path (theirs-only) that is dirty, during an
  otherwise-conflicting merge: refuses on the clean path in `localChanges`; **no
  conflict markers written**, no `MERGE_HEAD` — proves the guard covers
  clean-changes-ours and fires before materialisation.
- **M3** — dirty path untouched by the merge: **no refusal**; merge produces the
  conflict (`MERGE_HEAD` written), the dirty file survives.
- **TC1** — distinct-types conflict at a tracked-dirty path: refuses with
  `conflict.path` in `localChanges` (the dirty guard reaches distinct-types).
- **S7 / S7b** — untracked-add and distinct-types untracked rename-target squat:
  both refuse with the path in `untracked`, `localChanges` = `[]`; re-pins that the
  existing untracked refusal is unchanged after folding (ADR-343) — and that it now
  routes through the unified pass's `untracked` branch.
- **ORD1** — tracked-dirty conflict path **and** non-overlapping untracked squat:
  both tools refuse; assert tsgit's `localChanges` carries the tracked-dirty
  path(s) (sorted) **and** `untracked` carries the squat path(s) (sorted) — **both
  arrays populated** in one refusal — and that reconstructing git's stderr
  (local-changes block first, then untracked block) byte-matches the peer.
- **ORD2** — tracked-dirty conflict path **and** distinct-types untracked
  rename-target squat that overlap: both refuse; assert tsgit's `localChanges`
  carries the path and `untracked` = `[]` — **local-changes only** (the ORD2
  short-circuit; the overlapping path appears once, in `localChanges`).
- **DG1** — untracked **dangling** symlink squatting a distinct-types rename
  target: both refuse with the dangling-link path in `untracked` — pins the
  `lstat` probe (ADR-343), distinguishing it from the old `fs.exists` behaviour
  that would not have refused.
- **SP1** — sparse-excluded conflict path: no refusal, conflict materialised,
  `MERGE_HEAD` written (the guard's `absent` predicate exempts it).

### Unit

- `merge.test.ts` — conflict-path tracked-dirty refusal: refuses with
  `WORKING_TREE_DIRTY` carrying the dirty path in `localChanges`, HEAD + dirty
  bytes + index untouched, **no `MERGE_HEAD`** (the conflict-path twin of the
  existing `:375`/`:417` clean-path tests); index-lock release after a
  conflict-path refusal (the conflict-path twin of `:457`); guard-isolation tests
  — each condition (tracked-dirty alone → `localChanges` populated, `untracked`
  empty; untracked alone → vice-versa; both → both populated) triggers refusal
  independently (per the CLAUDE.md "guard clauses need isolated tests" rule), and a
  non-touched dirty path does not refuse (M3).
- The **existing clean-path tests update to the two-array shape and stay green:**
  `:375` (tracked-dirty clean true-merge) asserts `data.localChanges` contains
  `f.txt`; `:417` (untracked-add clean true-merge) asserts `data.untracked`
  contains `m.txt`. These pin the `asMergeDirtyError` /
  `CHECKOUT_OVERWRITE_DIRTY` class mapping re-pinned above. `asMergeDirtyError`'s
  direct unit test (`merge.test.ts:2627`) updates to assert the two-array result.
- `error.test.ts` — `workingTreeDirty` factory test (`:78`) updates to the
  `{ localChanges, untracked }` shape; `checkoutOverwriteDirty` factory test
  (`:545`) updates if `CHECKOUT_OVERWRITE_DIRTY` is enriched with the two classes;
  the `WORKING_TREE_DIRTY` renderer test asserts the summed count.
- The promoted shared primitive (ADR-342) gets its own
  `find-would-overwrite.test.ts` (or stays in the apply primitive's test) —
  tracked-dirty → `localChanges`, untracked-present → `untracked`,
  clean-changes-ours superset, per-class ascending sort, ORD2 de-dup
  (a both-classes path lands in `localChanges` only); the existing apply/stash
  interop proves the refactor is behaviour-preserving.
- **Apply/stash dangling-symlink check (ADR-343).** The `fs.exists`→`lstat` switch
  changes the apply consumers' untracked-present branch for dangling symlinks;
  existing apply/stash tests use regular files only. Add a unit/interop check (e.g.
  in the stash or cherry-pick apply suite) where an untracked **dangling** symlink
  squats a would-add path: the consumer now refuses (the `untracked` array carries
  the dangling path), matching git — proving the probe switch is a faithfulness
  fix, not a regression.

### Property lens (per CLAUDE.md)

Touch the four lenses against the changed code:

1. round-trip pair — none.
2. compositional matcher / aggregator — **`changedPaths` / `findWouldOverwrite`
   reduce arrays (outcomes + conflicts) to a two-class path-set verdict.** A
   candidate property: empty `changedPaths` ⇒ both classes empty (identity); adding
   a tracked-dirty changed path makes `localChanges` non-empty; adding an
   untracked-present changed path makes `untracked` non-empty; adding only
   untouched/clean-unchanged paths adds to neither; and a path counted in
   `localChanges` is never also in `untracked` (ORD2 de-dup invariant). Ships as a
   `*.properties.test.ts` sibling **iff** the promoted primitive (ADR-342) is
   exported for direct testing and the oracle is not a verbatim copy of the
   production loop; otherwise the example sweep above covers it. Recommended only if
   the export lands.
3. total function over a grammar — none (the guard can legitimately "throw" =
   refuse; that is the contract, not an exception over a safe subset).
4. idempotence / counting — none.

### Existing suites kept green

`merge-interop`, `merge-conflict-interop`, `merge-driver-interop`,
`distinct-types-with-base-interop` (S7 row), `cherry-pick`/`revert`/`rebase`/
`stash` interop — all must stay byte-identical on the **refusal-condition / which-
paths-refuse** axis (the apply consumers' behaviour is unchanged for regular-file
cases; the guard's home moves to the promoted primitive, ADR-342). Any assertion
that reads the structured `WORKING_TREE_DIRTY` payload (or stash's flattened
`STASH_APPLY_WOULD_OVERWRITE`) updates to the two-array shape (ADR-344).

## Out of scope

- **Display strings** — `Your local changes…` / `The following untracked…` and
  their suffixes are the consumer's job per ADR-249; the structured
  `WORKING_TREE_DIRTY { localChanges, untracked }` (each class sorted, local-changes
  first) + exit semantics suffice to reconstruct both blocks in the interop test.
- **Clean / fast-forward dirty refusal** — already shipped via
  `CHECKOUT_OVERWRITE_DIRTY` → `asMergeDirtyError`
  (`merge.test.ts:375`/`:417`); untouched here.
- **The apply consumers' refusal *conditions*** — already correct; the guard's
  code location moves to the promoted primitive (ADR-342) and the
  dangling-symlink edge is now faithful (ADR-343). Their **error shape** does
  change to the two-array `WORKING_TREE_DIRTY` (ADR-344) — in scope, covered above
  — but **which paths refuse** is otherwise unchanged for regular-file cases.
- **`MERGE_HAS_CONFLICTS` / resolvable-conflict reporting** — unrelated;
  refusal happens before any conflict is persisted.
- **`merge --no-overwrite-ignore` / `.gitignore`-aware untracked nuances** — git
  has subtler untracked-overwrite rules for ignored files; tsgit's untracked
  predicate is presence-based (now `lstat`, ADR-343) and matches the pinned rows;
  ignored vs tracked-vs-untracked edge nuances beyond S7/S7b/DG1 are deliberately
  unpinned and out of scope.
- **Recursive / inner merges** (`call_depth > 0`) — tsgit v1 has no recursive
  merge; nothing to mirror.
- **Detached-HEAD merge** — `merge` already refuses detached HEAD upstream
  (`unsupportedOperation`); the dirty guard never reaches it.
