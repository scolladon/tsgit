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
> Status: draft → self-reviewed ×3 → accepted

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
   locally-modified** working file refuses with `WORKING_TREE_DIRTY { paths }`
   **before any disk write** — working tree, index, and HEAD untouched, no
   `MERGE_HEAD`/`MERGE_MSG`/`ORIG_HEAD` written, no `index.lock` leaked.
2. The guard is **conflict-wide**: it covers every path the conflicting merge
   would change — both conflict recorded paths (content, distinct-types renames,
   etc.) **and** clean outcomes that change ours — not only distinct-types
   targets.
3. The existing **untracked**-overwrite refusal (distinct-types rename target,
   S7) keeps refusing with `WORKING_TREE_DIRTY { paths }`, unchanged.
4. A tracked-dirty path the merge does **not** touch (unchanged on both sides)
   does **not** refuse; the merge proceeds and the dirty file survives.
5. A tracked path whose merge resolves **cleanly** but **changes** ours, dirty in
   the worktree, **does** refuse even though that path alone would not conflict.
6. `paths` is sorted deterministically (git lists ascending).
7. Refusal parity is pinned against real `git` in
   `test/integration/*-interop.test.ts`, reconstructing git's prose from the
   structured fields per ADR-249.
8. No regression to the clean/fast-forward dirty refusal or the apply consumers.

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

- **R4 — both refusal *conditions* exist, with distinct prose, same exit code,
  same structured shape today.** Tracked-dirty → `Your local changes to the
  following files would be overwritten by merge:` + `Please commit your changes
  or stash them before you merge.`; untracked → `The following untracked working
  tree files would be overwritten by merge:` + `Please move or remove them before
  you merge.`. **Both are exit 2.** tsgit collapses both into
  `WORKING_TREE_DIRTY { paths }` already (the untracked refusal at `merge.ts:538`
  and the clean-path dirty refusal at `asMergeDirtyError` both use it). Whether
  the conflict-path tracked-dirty refusal needs a discriminator to let a consumer
  reconstruct the **two prose variants** is **Decision 3**.

- **R5 — ordering: tracked-dirty (local changes) is reported before untracked.**
  When both classes are present git prints the local-changes block first
  (ORD1), and when they overlap on the same logical operation the local-changes
  refusal short-circuits the untracked probe (ORD2). For tsgit's single-`paths`
  shape this matters only for **path ordering within the array** and **which
  guard runs first** — see Decision 4.

- **R8 — git's untracked-presence probe is `lstat`-based, not
  target-following.** A *dangling* untracked symlink squatting a rename target
  still refuses (DG1): `realpath` fails on the dangling link yet git refuses.
  This matches the existing `collectUntrackedRenameBlockers` (which uses
  `ctx.fs.lstat`) and **diverges from** `findWouldOverwrite`'s untracked branch,
  which probes `ctx.fs.exists` — a `realpath`-following call on the node adapter
  (`node-file-system.ts:451`) that returns **false** for a dangling link. Naive
  folding of the two guards (Decision 2(a) as written) would therefore **regress
  the dangling-symlink case**. Folding is only faithful if the unified check's
  untracked-presence probe is switched to `lstat` — see Decision 2.

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
  - `findWouldOverwrite` (`:116`) — tracked-dirty (`compareWorkingTreeEntry`) +
    untracked-present; **private const**; takes `(ctx, paths: Set<FilePath>,
    currentIndex: GitIndex)`; returns `ReadonlyArray<FilePath>`.
  - `outcomeChangesOurs` (`:72`) — clean-outcome-changes-ours predicate; private,
    carries documented equivalent-mutant justifications keyed off "a superset
    `changed` set is observationally identical".

- `src/application/primitives/compare-working-tree-entry.ts` —
  `compareWorkingTreeEntry` / `isWorkingTreeModified`, the dirtiness valve.
  Already a shared primitive; symlink-aware; reads the uncapped hash core.

- `src/domain/diff/index-diff.ts` — `recordedPaths` (`:189`, exported),
  `sortedRecordedPaths` (`:199`, exported). The path-set building blocks are
  already in domain.

- `src/domain/commands/error.ts` — `WORKING_TREE_DIRTY { paths }` (`:8`/`:214`),
  the unified merge-family would-overwrite code. No discriminator field.

- `src/application/primitives/read-index.ts` — `readIndex(ctx)` returns the
  current `GitIndex` (used elsewhere in `merge.ts`).

## Proposed design

### Shape of the change

A conflict-wide tracked-dirty pre-flight is added to the merge conflict path,
refusing with `workingTreeDirty(sortedPaths)` before any write. The path set is
**`changedPaths`** (clean outcomes that change ours + every conflict's
`recordedPaths`) — the same set the apply primitive uses. The dirty predicate is
the tracked-dirty half of **`findWouldOverwrite`** (`compareWorkingTreeEntry` ≠
`unchanged`/`absent`) over the current stage-0 index. Its relationship to the
**existing** untracked pre-flight (`collectUntrackedRenameBlockers`) — fold into
one ordered pass, or run as two passes tracked-dirty-first — is Decision 2; the
ordering in either case is tracked-dirty before untracked (R5).

The load-bearing question is **how much to lift** (Decision 1). The smallest
faithful change that also DRYs the duplicated guard is to **promote
`changedPaths` + `findWouldOverwrite` to a shared primitive** (e.g.
`find-would-overwrite.ts` under `primitives/internal/`, or extend an existing
merge primitive) that both `apply-merge-to-worktree.ts` and `merge.ts` call. Both
surfaces already compute the *same* logical set and run the *same* dirty
predicate; the only reason it is duplicated is that `findWouldOverwrite` was born
private to the apply primitive.

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
3. Find the would-overwrite paths over that set — tracked-dirty (always) and
   untracked-present (folded in under Decision 2(a), or via the retained
   `collectUntrackedRenameBlockers` under 2(b)).
4. If non-empty → `throw workingTreeDirty(sorted(dirtyPaths))`.

This **would subsume** `collectUntrackedRenameBlockers`: the unified
`findWouldOverwrite` flags untracked-but-present paths (the
`byPath.get(path) === undefined` branch), and the distinct-types rename targets
are in `recordedPaths`. Whether to **delete** `collectUntrackedRenameBlockers`
and route everything through the unified check, or keep it, is **Decision 2** —
and it is **not** a clean fold as-is. The two untracked-presence probes are
**not equivalent** (R8): `collectUntrackedRenameBlockers` uses `ctx.fs.lstat`
(does not follow the link, so a dangling symlink squat refuses, matching git
DG1), while `findWouldOverwrite`'s untracked branch uses `ctx.fs.exists` — a
`realpath`-following call that returns false for a dangling link and would **not**
refuse. Folding is only faithful if the unified check's untracked-presence probe
is changed to `lstat`. git's ORD1/ORD2 evidence (local-changes reported first;
overlap short-circuits to local-changes) still favours a single ordered pass
(tracked-dirty before untracked), but the probe semantics must be reconciled
first, and the precise untracked set re-pinned (S7/S7b/DG1/ORD1/ORD2).

### Error structured shape (R4, ADR-249)

git emits two textually distinct refusals (local-changes vs untracked), both
exit 2. Per ADR-249 the library emits **structured data**, not the rendered
string. The existing `WORKING_TREE_DIRTY { paths }` is already shared by the
untracked refusal (`merge.ts:538`) and the clean-path dirty refusal
(`asMergeDirtyError`). **Decision 3** is whether to:

- **(a)** keep the single `WORKING_TREE_DIRTY { paths }` — the consumer
  reconstructs which prose variant from context (it knows whether each path was
  tracked or untracked); or
- **(b)** add a discriminator (e.g. `reason: 'local-changes' | 'untracked'`, or
  split `paths` into two arrays) so a consumer can render git's two blocks
  without re-deriving tracked-ness.

The faithfulness invariant (ADR-226/249) binds the **data + exit semantics**, not
the prose. The exit code is the same (2) for both, and `paths` already carries the
offending paths. A consumer that wants git's exact two-block stderr (ORD1)
*could* re-derive tracked-ness by stat-ing each path against the index — but that
is work the library already did inside `findWouldOverwrite`. Recommendation below.

### Sparse (R6)

No special handling. A sparse-excluded conflict path is `absent` on disk, so
`compareWorkingTreeEntry` returns `absent`, `isWorkingTreeModified` is false, and
the unified check skips it — matching git's "materialise the excluded conflict,
do not refuse" behaviour (SP1). The conflict is still written (tsgit's
`writeConflictToTree` already takes no matcher). Pinned by an interop row, not
widened.

### Consumers

`cherry-pick` / `revert` / `rebase` / `stash` keep their behaviour for the
already-covered cases — they call `findWouldOverwrite` via `applyMergeToWorktree`.
Two caveats: under **Decision 1(a)** the apply primitive is refactored to call
the promoted shared check (behaviour identical for the existing example/interop
set); under **Decision 2(a)** the untracked-presence probe changes
`fs.exists`→`lstat`, which **fixes** the apply consumers' currently-uncovered
dangling-symlink-squat edge to match git (DG1) — a faithfulness improvement, not
a regression, but it must be re-verified with a new apply/stash check since
existing tests use regular files only. No new public surface: the shared check is
an internal primitive; `merge`'s `MergeResult` and the
`WORKING_TREE_DIRTY` code are the only externally observable shapes, both
pre-existing (subject to Decision 3).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Reuse vs extract the guard | (a) **Promote `changedPaths` + `findWouldOverwrite` to a shared primitive** both `merge` and `apply-merge-to-worktree` call; (b) duplicate the logic inline in `merge` (copy the two functions); (c) call `applyMergeToWorktree` from `merge`'s conflict path wholesale | **(a)** | The two surfaces compute the identical set and run the identical dirty predicate; the only reason it is private is birthplace. Promotion is a clean lift (DRY) without over-engineering. (c) is wrong — `merge` builds its own index/tree/MERGE_MSG ceremony and cannot delegate the whole write path; (b) re-introduces the divergence this item exists to close |
| 2 | Fold `collectUntrackedRenameBlockers` into the unified check, or keep both | (a) **Fold into one ordered `findWouldOverwrite` pass, switching its untracked-presence probe from `fs.exists` to `lstat`** (so a dangling symlink squat still refuses, R8/DG1); (b) keep `collectUntrackedRenameBlockers` as-is and add the tracked-dirty guard as a separate pass before it (two predicates, no probe change); (c) fold but leave the probe as `fs.exists` | **(a)** | One ordered pass naturally reports local-changes before untracked (ORD1) and de-dupes the overlap (ORD2), and removes duplicated refusal logic — **but only after** reconciling the probe (R8): the `lstat` switch is mandatory for faithfulness. The apply consumers (`findWouldOverwrite`'s current callers) must be re-verified after the `fs.exists`→`lstat` switch — their existing interop covers untracked-add but not a dangling squat, so add a check. (c) is **rejected** — it regresses DG1. (b) is the safe fallback if the probe switch proves to ripple into the apply consumers unexpectedly, at the cost of keeping two untracked predicates |
| 3 | Error structured shape: discriminate the two refusal conditions or not | (a) **Keep single `WORKING_TREE_DIRTY { paths }`** (consumer reconstructs prose from context); (b) add `reason: 'local-changes' \| 'untracked'`; (c) split into two path arrays (`localChanges`, `untracked`) | **(a)** | ADR-249 binds data + exit semantics, not prose; exit is 2 for both, `paths` carries the offenders, and the code is *already* shared by both conditions across the merge family today — adding a discriminator now would be an isolated, untested split (and would force a parallel change in the apply consumers' `would-overwrite` mapping for symmetry). If a consumer needs git's exact two-block stderr it can re-derive tracked-ness; but this is a user decision because it changes the error contract |
| 4 | Path ordering / first-guard semantics within the single `paths` array | (a) **Sort `paths` ascending** (git lists ascending within a block) and run tracked-dirty before untracked so a path that is both is reported once as local-changes; (b) preserve discovery order; (c) match git's two-block order (all local-changes paths, then all untracked) within the flat array | **(a)** | git lists ascending within each block (M1) and reports local-changes first (ORD1/ORD2). With a single flat `paths` array and Decision 3(a), a plain ascending sort is the faithful, deterministic, mutation-stable choice; `sortedRecordedPaths` / `comparePaths` already exist. (c) only matters if Decision 3 splits the arrays; (b) is non-deterministic across Set iteration |

## Test strategy

### Interop (faithfulness — the real gate)

New `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts`,
twin git-peer / tsgit harness per `merge-conflict-interop.test.ts`
(`makePeerPair`, scrubbed `runGit`/`tryRunGit`, peer pinned
`-c merge.conflictStyle=merge`). One slice per in-scope evidence row,
reconstructing git's prose from the structured `WORKING_TREE_DIRTY { paths }` +
the captured peer exit/stderr (ADR-249):

- **S13** — single tracked-dirty content-conflict path: both tools refuse; tsgit
  `WORKING_TREE_DIRTY` lists `file.txt`; worktree bytes, `lsStage`, and HEAD
  unchanged on both; **no `MERGE_HEAD`**.
- **M1** — two tracked-dirty conflict paths: both refuse; `paths` sorted
  `[f1.txt, f2.txt]`.
- **M2 / CL1** — clean-but-changed path (theirs-only) that is dirty, during an
  otherwise-conflicting merge: refuses on the clean path; **no conflict markers
  written**, no `MERGE_HEAD` — proves the guard covers clean-changes-ours and
  fires before materialisation.
- **M3** — dirty path untouched by the merge: **no refusal**; merge produces the
  conflict (`MERGE_HEAD` written), the dirty file survives.
- **TC1** — distinct-types conflict at a tracked-dirty path: refuses on
  `conflict.path` (the dirty guard reaches distinct-types).
- **S7 / S7b** — untracked-add and distinct-types untracked rename-target squat:
  both refuse, untracked message; re-pins the existing refusal is unchanged after
  folding (Decision 2).
- **ORD1 / ORD2** — tracked-dirty + untracked together: git's two-block (ORD1)
  and short-circuit (ORD2) ordering; assert tsgit's `paths` contains the
  local-changes path(s) first / only (per Decision 4).
- **SP1** — sparse-excluded conflict path: no refusal, conflict materialised,
  `MERGE_HEAD` written (the guard's `absent` predicate exempts it).

### Unit

- `merge.test.ts` — conflict-path tracked-dirty refusal: refuses with
  `WORKING_TREE_DIRTY` carrying the dirty path, HEAD + dirty bytes + index
  untouched, **no `MERGE_HEAD`** (the conflict-path twin of the existing
  `:375`/`:417` clean-path tests); index-lock release after a conflict-path
  refusal (the conflict-path twin of `:457`); guard-isolation tests — each
  condition (tracked-dirty alone, untracked alone, both) triggers refusal
  independently (per the CLAUDE.md "guard clauses need isolated tests" rule),
  and a non-touched dirty path does not refuse (M3).
- The promoted shared primitive (Decision 1(a)) gets its own
  `find-would-overwrite.test.ts` (or stays in the apply primitive's test) —
  tracked-dirty, untracked-present, clean-changes-ours superset, sorting; the
  existing apply/stash interop proves the refactor is behaviour-preserving.

### Property lens (per CLAUDE.md)

Touch the four lenses against the changed code:

1. round-trip pair — none.
2. compositional matcher / aggregator — **`changedPaths` / `findWouldOverwrite`
   reduce arrays (outcomes + conflicts) to a path-set verdict.** A candidate
   property: empty `changedPaths` ⇒ empty refusal (identity); adding a
   tracked-dirty changed path makes the refusal non-empty; adding only
   untouched/clean-unchanged paths never adds to the refusal. Ships as a
   `*.properties.test.ts` sibling **iff** the promoted primitive is exported for
   direct testing and the oracle is not a verbatim copy of the production loop;
   otherwise the example sweep above covers it. Recommended only if the export
   lands.
3. total function over a grammar — none (the guard can legitimately "throw" =
   refuse; that is the contract, not an exception over a safe subset).
4. idempotence / counting — none.

### Existing suites kept green

`merge-interop`, `merge-conflict-interop`, `merge-driver-interop`,
`distinct-types-with-base-interop` (S7 row), `cherry-pick`/`revert`/`rebase`/
`stash` interop — all must stay byte-identical (the apply consumers' behaviour is
unchanged; only the guard's home moves under Decision 1(a)).

## Out of scope

- **Display strings** — `Your local changes…` / `The following untracked…` and
  their suffixes are the consumer's job per ADR-249; the structured
  `WORKING_TREE_DIRTY { paths }` + exit semantics suffice to reconstruct them in
  the interop test.
- **Clean / fast-forward dirty refusal** — already shipped via
  `CHECKOUT_OVERWRITE_DIRTY` → `asMergeDirtyError`
  (`merge.test.ts:375`/`:417`); untouched here.
- **The apply consumers' refusal behaviour** — already correct; only the guard's
  code location changes if Decision 1(a) is taken. No behavioural change.
- **`MERGE_HAS_CONFLICTS` / resolvable-conflict reporting** — unrelated;
  refusal happens before any conflict is persisted.
- **`merge --no-overwrite-ignore` / `.gitignore`-aware untracked nuances** — git
  has subtler untracked-overwrite rules for ignored files; tsgit's untracked
  predicate is presence-based (`fs.exists`) and matches the pinned rows; ignored
  vs tracked-vs-untracked edge nuances beyond S7/S7b are deliberately unpinned
  and out of scope.
- **Recursive / inner merges** (`call_depth > 0`) — tsgit v1 has no recursive
  merge; nothing to mirror.
- **Detached-HEAD merge** — `merge` already refuses detached HEAD upstream
  (`unsupportedOperation`); the dirty guard never reaches it.
