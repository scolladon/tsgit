# Design — sequencer-sparse-cone-writes

> Brief: backlog 32.60. Under a sparse checkout, `cherry-pick`, `revert`, `rebase`,
> `rebase --rebase-merges` and `stash apply --index` write out-of-pattern paths that git leaves
> skip-worktree and unwritten. The entry places the defect in `applyMergeToWorktree`'s clean path,
> which calls `materializeTree` without the `sparse` matcher `materializeTree` already accepts. The
> re-pin (lesson 033) shows the conflict path diverges too, that ADR-076's "resolved-merged is
> always written" clause is contradicted by git 2.56.0 for `merge` as well, and that a naive
> clean-path fix would make two rows newly red: a case-variant path under `core.ignorecase=true`
> and a dirty out-of-pattern file that the forced apply would delete.
> Status: draft → self-reviewed ×3

## Context

### The corrected backlog statement

32.60 was filed against git 2.56.0 on 4a49607e. Re-pinned on main 48a7488e against git 2.56.0
(macOS, scrubbed `GIT_*`, signing off, `core.ignorecase` set explicitly to `false` and to `true`,
git side run twice per value, byte-identical):

- **The clean path diverges for every `applyMergeToWorktree` consumer.** That covers
  cherry-pick, revert, non-cone patterns, a rename leaving the cone, an add, `rebase`,
  `rebase --rebase-merges` (`merge -C`), `stash pop --index`, and a linked worktree whose sparse
  keys sit in `config.worktree`. The backlog inferred four of these from call sites. All four are
  now pinned.
- **The conflict path diverges too.** When an in-pattern path conflicts, an out-of-pattern clean
  path is written by tsgit. git leaves it skip-worktree and unwritten, both when its content is a
  committed blob (cf2) and when it was line-merged (cf3, cf3rb, scf3). For a line-merged path,
  git hashes the merged blob, stages it at stage 0 with skip-worktree, and does not write it.
- **`merge` diverges on the line-merged row (mcf3).** ADR-076 rules that "in-memory-only
  (`resolved-merged`) content is always written even when excluded". git 2.56.0 does not write
  it. ADR-076's premise is also stale: both conflict paths already hash the merged bytes
  (`mergedBlobEntries`, and `merge.ts`'s `merged` argument to `buildConflictIndexEntries`, "already
  written as blobs"). So the working-tree write is not their sole persistence.
- **git re-applies the patterns to every index path, not only to changed ones.** An
  out-of-pattern file that is present and not skip-worktree is removed and marked `S` by a clean
  cherry-pick (pscp), a conflicted cherry-pick (pscf), a conflicted merge (mpscf) and a plain
  `stash apply` (stps). When that file is dirty, git keeps it, keeps `H`, warns `The following
  paths are not up to date and were left despite sparse patterns`, and exits 0 (dpscp, dpscf,
  dpsco). tsgit's `checkout` refuses this row today (dpsco, `CHECKOUT_OVERWRITE_DIRTY`).
- **Cone and non-cone matching are case-insensitive under `core.ignorecase=true`** (case, casenc,
  caseco). tsgit's matcher is case-sensitive everywhere. Today the sequencer rows "match" under
  `true` only because tsgit writes every path. `checkout` already diverges (caseco).
- **Already matching, and must stay so:** an out-of-pattern delete (del), a plain `stash apply`
  without `--index` (st, sta: git writes the path and clears its bit, through
  `unstage_changes_unless_new`), `merge` clean (mg) and its blob-backed conflict row (mcf2), an
  out-of-pattern path that itself conflicts (cf), a distinct-types conflict out of the patterns
  (dt), and a dirty file at a skip-worktree path under `stash apply` (stu: both refuse).

### git's rule (source, v2.56.0)

- `merge-ort.c` `checkout()` moves index and work tree from `ours` to the merge result with
  `unpack_trees` (`twoway_merge`, `update = 1`). Conflicted paths enter the result tree with their
  marker blobs. In `unpack-trees.c`, when `core.sparseCheckout` is on and `update` is set,
  "Sparse checkout loop #1" sets `CE_NEW_SKIP_WORKTREE` on every **existing** index entry from the
  patterns, and loop #2 does the same for `CE_ADDED` entries. `apply_sparse_checkout` then gives
  four cases:
  - was `S` and stays `S`: no write and no removal.
  - was not `S` and becomes `S`: `verify_uptodate_sparse`, then `CE_WT_REMOVE`. A dirty file is
    left with a warning.
  - was `S` and leaves `S`: `verify_absent_sparse`, then `CE_UPDATE`.
  - neither: the normal update.
- `merge-ort.c` `record_conflicted_index_entries` explicitly `checkout_entry`s a conflicted path
  whose stage-0 entry is skip-worktree, then replaces it with stages 1–3. So a conflict is
  always written (rows cf, dt).
- `builtin/stash.c` `do_apply_stash`: a clean merge without `--index` runs
  `unstage_changes_unless_new`. Its step 2 does this for every path the merge changed that the
  merged index marks skip-worktree: it moves an occupying file aside as `<name>.stash.XXXXXX`,
  `checkout_entry`s the merged version and clears the bit. Step 3 restores the pre-merge entry
  unless the path is new. With `--index` it runs `reset_tree(&index_tree, 0, 0)` instead (no
  update, so `unpack_trees` skips sparse). The merge's skip-worktree bits survive on entries the
  one-way merge keeps.
- `builtin/worktree.c` `add_worktree`: when the current worktree has sparse checkout on,
  `copy_sparse_checkout` copies `info/sparse-checkout` into the new worktree's admin directory.
  `copy_filtered_worktree_config` copies `config.worktree`. The checkout then runs sparse.

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/application/primitives/apply-merge-to-worktree.ts` | `applyMergeToWorktree(ctx, input: ApplyMergeInput): Promise<ApplyMergeResult>` | three-way merge onto work tree + index. Clean → `materializeTree(ctx, { targetTree: mergedTree, currentIndex, headTree: oursTree, force: true })`, **no `sparse`**. Conflict → `materialiseConflict` |
| same file | `materialiseConflict(ctx, merged, changed, currentIndex)` → `writeConflictWorktree`, `mergedBlobEntries`, `conflictResultTree` + `writeAutoMerge`, `buildUnmergedIndex(outcomes, conflicts, merged)`, `withConflictStopStats` | conflict path, sparse-blind: writes every changed outcome, stages stage-0 with `STAGE0_FLAGS` |
| same file | `writeConflictWorktree(ctx, outcomes, conflicts, changed)`, `writeChangedOutcome`, `survivingPathsOf`, `blobBackedEntries`, `keepsStagedChanges`, `unchangedCount` | the conflict-path writers. `survivingPathsOf` is shared with `merge.ts` |
| `src/application/primitives/internal/stat-conflict-index.ts` | `withConflictStopStats(ctx, entries, currentIndex, written)` | `lstat`s every path in `written`. An unwritten path in that set throws `FILE_NOT_FOUND` |
| `src/application/primitives/internal/merged-blob-entries.ts` | `mergedBlobEntries(ctx, outcomes)` | hashes each `resolved-merged` outcome into a blob → stage-0 entry |
| `src/application/primitives/internal/write-distinct-types-sides.ts` | `writeDistinctTypesSides(writer, conflict, scanner?)` | conflict-side writer. Unchanged: git writes conflicts regardless (dt) |
| `src/application/primitives/materialize-tree.ts` | `MaterializeTreeOpts.sparse`, `planMaterialize`, `sparseMovers`, `carryHeadAgreement`, `assembleIndexEntries`, `materializeTreeJudging` | the sparse seam. With `headTree` + `sparse` it is git's two-way sparse merge: excluded targets → `skipWorktreeEntry`, out-of-pattern index paths are movers. A dirty mover is refused when unforced (dpsco) and, by the `applyChangeset` contract ("Dirty-tree guard (unless `force`)"), not judged when forced |
| `src/application/primitives/apply-changeset.ts` | dirty-tree guard, `force` | see above |
| `src/application/primitives/read-sparse-checkout.ts` | `loadSparseMatcher(ctx)` → `readSparseConfig` + `readSparsePatternText` + `parseSparseCheckout` + `buildSparseMatcher(spec)` | layered config (local + `config.worktree`, `docs/design/sparse-checkout-worktree-config.md`). Pattern file from `ctx.layout.gitDir`, which is per-worktree. **No `core.ignorecase`** |
| `src/domain/sparse/parse-sparse-checkout.ts`, `cone.ts`, `non-cone.ts` | `buildSparseMatcher(spec)`, `coneMatcher(spec)`, `nonConeMatcher(rules)`, `compileSparseRule` → `compileGlob` (`src/domain/pathspec/compile-glob.ts`, `CompileGlobOptions { anchored, withDirSuffix? }`) | case-sensitive. No case-fold seam exists in `compile-glob.ts` |
| `src/domain/git-index/index-entry.ts` | `skipWorktreeEntry({ path, id, mode })` | zero-stat stage-0 entry with `skipWorktree: true` |
| `src/application/primitives/internal/synthetic-index-entry.ts` | `stage0Entry`, `zeroStat` | stage-0 builders used by the conflict path |
| `src/application/commands/merge.ts` | `writeConflictState`, `persistOctopusConflict` → `writeConflictingWorkingTree(…, matcher)`, `isExcluded`, `isMaterialised`, `survivingFor`, `outcomeWave`, `buildConflictIndexEntries(outcomes, conflicts, matcher, merged)` | ADR-076's rule: `isMaterialised` returns true for `resolved-merged`, and `merged` entries are staged without the bit |
| `src/application/commands/internal/replay-sequence.ts` | `replayMerge` → `applyMergeToWorktree` | cherry-pick, revert, rebase picks |
| `src/application/commands/internal/rebase-merges-steps.ts` | `mergeIntoLockedIndex` → `applyMergeToWorktree` | `rebase --rebase-merges` `merge -C` |
| `src/application/commands/stash.ts` | `mergeStash` → `applyMergeToWorktree`. `settleIndex`, `settleCleanIndex` (no `--index` → `unstageChangesUnlessNew`, `--index` → `reinstateIndex` → `buildIndexFromTree` with no `sparse`) | stash apply/pop and every autostash (`applyAutostash`, `applyMergeAutostash` apply without `--index`). `restoreSnapshot` applies with `--index` |
| `src/application/commands/internal/unstage-changes-unless-new.ts` | `unstageChangesUnlessNew(merged, before): UnstageOutcome` | step 3 of git's function. Restored entries get `STAGE0_FLAGS` (bit cleared). Added entries keep the merged flags |

### Constraining ADRs and doctrine

- ADR-226 (prime directive), ADR-249 (structured output: no new display field; the dirty-mover
  warning goes through `ctx.logger?.warn`, as `removeGitlinkDirectory` does).
- ADR-076 (merge conflict materialisation): its blob-backed and conflict clauses agree with git
  (mcf2, cf, dt). Its `resolved-merged` clause is contradicted by mcf3. See D-A.
- ADR-075 (the matcher is authoritative over donor skip-worktree bits). It applies to the conflict
  path's stage-0 entries.
- ADR-1170 (filing bar): every diverging row writes files git leaves out of the work tree, or
  loses or keeps user bytes git treats otherwise, on a well-formed repository. All are at or
  above the bar.
- DOCTRINE D-2: a shared-primitive half the change makes reachable is folded whole, with one
  interop pin per affected consumer. It governs D-C (dirty movers in `materializeTree`) and D-D
  (case folding in the matcher).
- DOCTRINE D-3 / ADR-1190 / ADR-1210: a returning call that now throws is breaking (`!`).
  ADR-1199: a removed refusal is `fix`. See "Breaking-change classification".
- Lessons 033 (re-pin before design), 038 (consumer table from the primitive), 042 (both
  `core.ignorecase` values, plus a case-variant row), 045 (ignorecase twin wrapper takes the
  Given slot).

## Pinned matrix (git 2.56.0, tsgit main 48a7488e, 2026-11-18)

Fixture: base commit `a/f=f1 a/g=g1 b/f=f1 top=t`. Cone = `/*\n!/*/\n/b/\n` with
`core.sparseCheckout`/`core.sparseCheckoutCone` true (local config) and `read-tree -mu HEAD`.
Non-cone = `/top\n/b/\n` with `core.sparseCheckoutCone false` (chosen to avoid 32.64). Columns
show `ls-files -t` tags (`H`, `S`, `M` = unmerged) with abbreviated oid where it matters, and the
files on disk. tsgit ran on a byte copy of git's pre-op repository. Each row is identical under
`core.ignorecase=false` and `=true`, except where a row says otherwise. Raw outputs and
re-runnable scripts live in the session scratchpad (not committed): `probe-git.sh`,
`probe-tsgit.mjs`, `probe2-*`, `probe3b-git.sh`, `probe3-tsgit.mjs`, `probe4-*`, `snap.sh`,
`rowdiff.sh`.

### Axis 1 — clean replay (the backlog's locus)

| # | Op | Shape | git | tsgit main | Verdict |
|---|---|---|---|---|---|
| cp | `cherry-pick other` | `other` changes `a/f` (out) + `b/f` (in) | `S a/f` unwritten | `H a/f` written | DIVERGE |
| rv | `revert HEAD` | same change reverted | `S a/f` unwritten | `H a/f` written | DIVERGE |
| nc | cherry-pick | non-cone `/top`,`/b/` | `S a/f` | `H a/f` written | DIVERGE |
| mv | cherry-pick | rename `a/g→b/g` (entering) + `b/f→a/h` (leaving) | `H b/g` written, `S a/h` unwritten | `H b/g`, `H a/h` written | DIVERGE (leaving) |
| add | cherry-pick | adds `a/n` (out) + `b/n` (in) | `S a/n` | `H a/n` written | DIVERGE |
| del | cherry-pick | deletes `a/f` | gone | gone | MATCH |
| rb | `rebase main` | topic changes `a/f`+`b/f` | `S a/f` | `H a/f` written | DIVERGE |
| rm | `rebase --rebase-merges main` | side changes `a/f`, merged into topic (`merge -C`) | `S a/f` | `H a/f` written | DIVERGE |
| wt | cherry-pick in a linked worktree | `sparse-checkout set b` there (`config.worktree`) | `S a/f` | `H a/f` written | DIVERGE |
| mg | `merge other` | true merge, clean | `S a/f` | `S a/f` | MATCH (merge's own path) |

### Axis 2 — conflict path

| # | Op | Shape | git | tsgit main | Verdict |
|---|---|---|---|---|---|
| cf | cherry-pick | `a/f` (out) itself conflicts | stages 1/2/3 `a/f`, markers written | same | MATCH |
| dt | cherry-pick | `a/f` (out) file→symlink vs edit (distinct types), `b/f` clean | `M a/f` (3), `M a/f~HEAD` (1,2), both written. `S a/g` | same | MATCH |
| cf2 | cherry-pick | `b/f` conflicts, `a/f` (out) take-theirs (blob-backed) | `S a/f` (theirs oid) unwritten | `H a/f` written | DIVERGE |
| cf3 | cherry-pick | `b/f` conflicts, `a/f` (out) line-merged cleanly | `S 1f29e7f a/f`: merged blob in the index, not written | `H 1f29e7f a/f` written | DIVERGE |
| cf3rb | `rebase main` | cf3 shape as a rebase pick | `S 1f29e7f a/f` unwritten | `H 1f29e7f a/f` written | DIVERGE |
| scf3 | `stash apply` | cf3 shape via a conflicted stash | `S 1f29e7f a/f` unwritten | `H a/f` written | DIVERGE |
| mcf2 | `merge other` | cf2 shape | `S a/f` | `S a/f` | MATCH (ADR-076 blob-backed clause) |
| mcf3 | `merge other` | cf3 shape | `S 1f29e7f a/f` unwritten | `H a/f` written | DIVERGE (ADR-076 resolved-merged clause) |

### Axis 3 — stash

| # | Op | Shape | git | tsgit main | Verdict |
|---|---|---|---|---|---|
| st | `stash apply` (no `--index`) | stash (made full) changes `a/f`+`b/f` | `H a/f` **written** (f2), `M a/f` unstaged | same | MATCH: must not regress |
| sta | `stash apply` (no `--index`) | stash adds `a/n` (staged, out) + edits `b/f` | `H a/n` written, `A  a/n`, ` M b/f` | same | MATCH: must not regress |
| stu | `stash apply` (no `--index`) | st shape + an untracked `junk` file at `a/f` (`S` path) | exit 128 `Your local changes … would be overwritten`, `H a/f` (git clears the bit of a present file on index read), `a/f`=junk | `STASH_APPLY_WOULD_OVERWRITE` | MATCH (refusal). git's `.stash.XXXXXX` relocation is unreachable with the default `sparse.expectFilesOutsideOfPatterns` |
| sp | `stash pop --index` | `a/f` staged+modified, `b/f` modified | `S a/f` (index f2) unwritten. `H b/f` (index f1, disk f2) | `H a/f` written | DIVERGE |

### Axis 4 — case folding (lesson 042)

Fixture `B/f`, `x/y`, `top`; `other` changes `B/f` and `x/y`; patterns name `/b/` (cone) or
`/top`,`/b/` (non-cone).

| # | Op | `core.ignorecase` | git | tsgit main | Verdict |
|---|---|---|---|---|---|
| case | cherry-pick, cone | false | `S B/f`, `S x/y` | both `H`, written | DIVERGE |
| case | cherry-pick, cone | true | `H B/f` written, `S x/y` | both `H`, written | DIVERGE (`x/y`). `B/f` matches only by accident |
| casenc | cherry-pick, non-cone | false | `S B/f`, `S x/y` | both `H`, written | DIVERGE |
| casenc | cherry-pick, non-cone | true | `H B/f` written, `S x/y` | both `H`, written | DIVERGE (`x/y`) |
| caseco | `checkout other`, cone | false | `S B/f`, `S x/y` | same | MATCH |
| caseco | `checkout other`, cone | true | `H B/f` written | `S B/f` unwritten | DIVERGE: shared matcher, on main |

### Axis 5 — present-despite-skipped files (patterns re-applied to every index path)

Shape: after `cone`, `update-index --no-skip-worktree a/g` + `checkout -- a/g` (so `a/g` is
`H` and on disk, outside the patterns). "dirty" = then `echo dirty > a/g`. A conflict variant adds
an in-cone `b/f` conflict.

| # | Op | git | tsgit main | Verdict |
|---|---|---|---|---|
| psco | `checkout other` | `a/g` removed, `S a/g` | same | MATCH (materializeTree movers) |
| pscp | cherry-pick, clean | `a/g` removed, `S a/g`. `S a/f` | `H a/g`, `H a/f`, both on disk | DIVERGE |
| pscf | cherry-pick, conflict | `a/g` removed, `S a/g`, `S a/f`, stages `b/f` | `H a/g`, `H a/f` on disk | DIVERGE |
| mpscf | `merge other`, conflict | `a/g` removed, `S a/g` | `H a/g` on disk (`S a/f` matches) | DIVERGE (merge.ts) |
| stps | `stash apply` (no `--index`) | `a/g` removed, `S a/g`. `H a/f` written | `H a/g` on disk | DIVERGE |
| dpsco | `checkout other`, dirty `a/g` | exit 0, warning `…not up to date and were left despite sparse patterns`, `H a/g` kept dirty, `S a/f` | `CHECKOUT_OVERWRITE_DIRTY` refusal, nothing written | DIVERGE: shared primitive, on main |
| dpscp | cherry-pick, clean, dirty `a/g` | exit 0, same warning, `H a/g` dirty kept, `S a/f` | `picked`, `H a/f` written, `a/g` kept | DIVERGE. A sparse-only fix makes this a **silent delete** of `a/g` (forced apply skips the dirty guard) |
| dpscf | cherry-pick, conflict, dirty `a/g` | exit 1, same warning, `H a/g` dirty kept, `S a/f`, stages `b/f` | `H a/f` written, `a/g` kept | DIVERGE |

### Axis 6 — the other `materializeTree` callers (lesson 038)

| # | Op | git | tsgit main | Verdict |
|---|---|---|---|---|
| wtaddlocal | `worktree add ../wt2 -b wt2 main` from a cone checkout (local config) | new worktree `S a/f`, `S a/g`, only `b/f`, `top` on disk. `worktrees/wt2/info/sparse-checkout` copied | `H` everywhere, all written. No `info/sparse-checkout` in the admin dir | DIVERGE: out of perimeter |
| wtaddset | same, after `sparse-checkout set b` (`config.worktree`) | same as above, plus `worktrees/wt2/config.worktree` copied | same as above, no `config.worktree` | DIVERGE: out of perimeter |
| piv | `pull origin main` into an unborn repo with cone patterns | `S a/f`, `S a/g`, only `b/f`, `top` on disk | not run: the node probe has no local transport. By code, `checkoutFromEmptyTree` passes `paths` and no `sparse`, and `MaterializeTreeOpts.sparse` is "honoured ONLY when `paths` is undefined", so every path is written `H` | DIVERGE (git pinned, tsgit by code): out of perimeter |

## Consumer table (lesson 038)

The primitive the fix changes is **the sparse verdict over a three-way merge result**. It has two
halves: `materializeTree`'s sparse mode (clean path) and the conflict-path writers. The table
lists the callers of `materializeTree`/`materializeTreeJudging`, `applyMergeToWorktree`, the
shared conflict helpers, and `loadSparseMatcher`.

| Caller | Reached from | Passes `sparse` today | Effect of the change | Pin | Status |
|---|---|---|---|---|---|
| `applyMergeToWorktree` clean → `materializeTree` | `replay-sequence.ts` `replayMerge` (cherry-pick, revert, rebase pick), `rebase-merges-steps.ts` `mergeIntoLockedIndex`, `stash.ts` `mergeStash` | no | **the fix** (R1) | cp rv nc mv add del rb rm wt pscp dpscp sp | folded |
| `applyMergeToWorktree` conflict → `materialiseConflict` | same | n/a | **the fix** (R2, R3) | cf cf2 cf3 cf3rb scf3 dt pscf dpscf | folded |
| `stash.ts` `settleCleanIndex` (no `--index`) | `stash apply`/`pop`, `applyAutostash` (rebase/pull autostash), `applyMergeAutostash` | n/a | git's step 2 (R4) | st sta stps stu | folded |
| `stash.ts` `reinstateIndex` → `buildIndexFromTree` | `stash apply --index`, `restoreSnapshot` | no | keeps donor bits (R5). `buildIndexFromTree` with no `sparse` already passes donor flags through | sp | folded, no code beyond R1 |
| `merge.ts` `writeConflictState` / `persistOctopusConflict` → `writeConflictingWorkingTree`, `buildConflictIndexEntries` | `merge` conflict, octopus conflict | yes (ADR-076) | D-A: `resolved-merged` excluded → unwritten, `S`. D-B: movers | mcf2 mcf3 mpscf | per D-A / D-B |
| `merge.ts` `attemptNonConflictTree` → `materializeTree` | `merge` clean / ff | yes | none, except via D-C (dirty movers) and D-D (case) | mg | unchanged |
| `checkout.ts` `materializeTreeJudging` (switch) | `checkout`/`switch` | yes (`loadSparseMatcher`) | D-C removes the dpsco refusal. D-D fixes caseco | psco dpsco caseco | per D-C / D-D |
| `checkout.ts` path restores (`paths` set) | `checkout -- <paths>`, `restore` | no; `paths` mode ignores it | none | — | unchanged |
| `reset.ts`, `internal/reset-worktree.ts` (rebase's reset onto upstream) | `reset --hard/--mixed/--merge/--keep`, rebase start | yes | D-C and D-D only | covered by D-C/D-D rows | per D-C / D-D |
| `pull.ts` fast-forward → `materializeTree` | `pull` ff | yes | D-C and D-D only | — | per D-C / D-D |
| `sparse-checkout.ts` `loadSparseMatcher` | `sparse-checkout reapply/set/add` | yes | D-D only | — | per D-D |
| `stash.ts` `resetAfterPush` → `materializeTreeJudging` | `stash push` reset | no | none. A forced one-way reset to HEAD: skip-worktree noops are "never judged". Not pinned. To prove: twin `stash push` with an out-of-pattern index-only change (`update-index --cacheinfo` on an `S` path), compare `ls-files -t` | not pinned | unchanged |
| `internal/pull-into-void.ts` `checkoutFromEmptyTree` | `pull` into an unborn HEAD | no (`paths` mode) | none | piv | **deferred**: IMPACT |
| `commands/worktree.ts` `materializeWorktree` | `worktree add` | no, and no pattern/config copy | none | wtaddlocal wtaddset | **deferred**: IMPACT |
| `materialize-worktree-from-head.ts` | submodule child init | no | none. The child is a fresh repository with no sparse keys, so `loadSparseMatcher` would return `undefined` | — | n/a |

## Requirements

Axes: **consumer** (cherry-pick, revert, rebase pick, `rebase --rebase-merges` `merge -C`, stash
apply without/with `--index`, `merge` per D-A/D-B) × **path class** (in-pattern, out-of-pattern
`S`, out-of-pattern present `H` clean, out-of-pattern present `H` dirty) × **outcome**
(unchanged, resolved-known, resolved-merged, resolved-deleted, added, renamed in/out, conflict,
distinct-types conflict) × **patterns** (cone, non-cone) × **`core.ignorecase`** (false, true) ×
**worktree** (main, linked with `config.worktree`).

- **R1 — clean path.** With sparse active, `applyMergeToWorktree`'s clean result equals git's
  two-way sparse checkout from `oursTree` to the merged tree:
  - An out-of-pattern result path is not written. Its `newIndexEntries` record has
    `skipWorktree: true` with the result's id and mode.
  - An in-pattern path is written as today.
  - An out-of-pattern deletion removes the entry.
  - An out-of-pattern path that is present, `H` and clean is removed from disk and becomes `S`
    (pscp).
  - A dirty one stays per R6.
  - `mergedTree`, `indexTree` and `AUTO_MERGE` are unchanged: skip-worktree changes no oid.
- **R2 — conflict path, blob-backed and deleted outcomes.** With sparse active, an
  out-of-pattern `unchanged`/`resolved-known` outcome the merge changed is not written. Its
  stage-0 entry carries `skipWorktree: true` (cf2). `resolved-deleted` is unchanged (no file).
  A conflicted path, a distinct-types side, and a gitlink survivor are always written. Their
  stages carry no bit (cf, dt). An unwritten path never reaches `withConflictStopStats`'s `lstat`
  set. An unwritten path does not keep a directory alive in `survivingPathsOf`.
- **R3 — conflict path, line-merged outcomes (D-A).** With sparse active, an out-of-pattern
  `resolved-merged` outcome is hashed (already done by `mergedBlobEntries`), staged at stage 0
  with `skipWorktree: true`, and not written (cf3, cf3rb, scf3; mcf3 if D-A = A).
  `AUTO_MERGE` still records the merged blob.
- **R4 — conflict path, movers (D-B).** With sparse active, a stage-0 index path that is
  out-of-pattern, not skip-worktree and not conflicted is removed from disk when clean, and its
  stage-0 entry becomes `S` (pscf; mpscf if D-B = A). That holds whether or not the merge changed
  it. git's `apply_sparse_checkout` sets `CE_WT_REMOVE` and clears `CE_UPDATE` for a
  "was not `S`, becomes `S`" entry. An untouched mover keeps its id and mode. A changed one takes
  the result's. A dirty untouched mover follows R6. A dirty changed one never gets here:
  `findWouldOverwrite` has already refused it.
- **R5 — stash apply without `--index` (git's step 2).** After a clean merge, every path whose
  merged entry differs from the pre-apply index (id/mode change or addition) and carries
  `skipWorktree: true` is written from the merged entry through the merge-result writer (smudge
  + EOL as a checkout). Its bit is then cleared, before `unstageChangesUnlessNew` (st, sta). A
  present-despite-skipped path the merge did not change stays removed and `S` (stps). The refusal
  of stu is unchanged. A conflicted stash apply keeps R2/R3 (scf3): git skips step 2 on conflict.
- **R6 — dirty out-of-pattern movers (D-C).** A present, out-of-pattern, non-`S` file that is not
  up to date is left on disk with its `H` entry unchanged. One warning lists the paths, through
  `ctx.logger?.warn` (git: `The following paths are not up to date and were left despite sparse
  patterns:`). The operation continues: exit 0 for a clean pick (dpscp), a conflict result for
  dpscf, success for `checkout` (dpsco). It is never deleted, forced or not.
- **R7 — `stash apply --index`.** The work-tree half follows R1. `reinstateIndex` keeps the merged
  entry's bit when the staged tree agrees with it (sp). No new code: `buildIndexFromTree` without
  `sparse` passes donor flags through.
- **R8 — case folding (D-D).** Under `core.ignorecase=true`, cone and non-cone patterns match
  case-insensitively over ASCII (git's `fspathncmp`/`WM_CASEFOLD`) for every consumer of
  `loadSparseMatcher`: `case`, `casenc`, `caseco` turn green. Under `false`, behaviour is
  byte-identical to today.
- **R9 — linked worktree.** The matcher is the worktree's own: `config.worktree` keys through
  `readSparseConfig`, the pattern file from the worktree's `gitDir` (wt). `loadSparseMatcher`
  already does both. No code.
- **R10 — sparse inactive.** With `core.sparseCheckout` off or absent, every consumer is
  byte-identical to today (no matcher, no extra config read beyond `readSparseConfig`).

### Every pinned row against its requirement

| Rows | Req | Walk |
|---|---|---|
| cp rv nc add rb rm wt | R1 | `loadSparseMatcher` → `materializeTree({ …, headTree: oursTree, sparse })` → `planMaterialize` puts `a/f`/`a/n` in `excluded` → `skipWorktreeEntry`. `indexForDiff` drops the old `S` entry, so nothing is written |
| mv | R1 | `b/g` in-pattern → add, written. `a/h` excluded → `S`. `b/f` deleted. `a/g` was `S` and is absent from the target → gone |
| del | R1 | `a/f` not in the target → no entry, no file. Unchanged |
| pscp | R1 | `sparseMovers` holds `a/g` (outside, not hidden) → not carried → `planMaterialize` excludes it → `skipWorktreeEntry`. Its file is removed by the mover removal that checkout already runs (psco proves the primitive) |
| dpscp dpsco | R6 | today: unforced → refusal (dpsco). Forced (the sequencer) → the dirty guard is skipped → delete. R6 changes the mover rule inside `materializeTree` so a dirty mover is carried `H` and warned about, forced or not |
| cf2 | R2 | `writeConflictWorktree` skips the excluded blob-backed write. `buildUnmergedIndex` → `skipWorktreeEntry`. The `written` set for `withConflictStopStats` excludes `a/f` |
| cf3 cf3rb scf3 | R3 | `mergedBlobEntries` hashes `1f29e7f`. The excluded merged entry → `skipWorktree: true`. No write |
| mcf3 mpscf | R3/R4 via D-A/D-B | `merge.ts` `isMaterialised` + `buildConflictIndexEntries` + the shared mover helper |
| cf dt | R2 | conflicts always written. `conflictsToIndexEntries` stages carry no bit. Unchanged |
| pscf dpscf | R4, R6 | the conflict path's new mover pass |
| st sta | R5 | the merge leaves `S a/f` (or `S a/n`) unwritten → step 2 writes it and clears the bit → `unstageChangesUnlessNew` restores `a/f` to the pre-apply id (bit cleared by its `zeroStat`) and keeps `a/n` |
| stps | R5 | step 2 does not touch `a/g` (unchanged by the merge). R1's mover removal stands |
| stu | — | `findWouldOverwrite` refuses before any write. Unchanged |
| sp | R1, R7 | the merge leaves `S a/f`. The staged tree has `a/f`=f2 = the merged id → donor kept with its bit |
| case casenc caseco | R8 | `loadSparseMatcher` reads `core.ignoreCase` and builds a folding matcher |
| mg mcf2 | — | unchanged |
| wtaddlocal wtaddset piv | — | out of perimeter (IMPACT) |

The walk found four gaps in the first draft. (1) Passing `sparse` alone turns dpscp from a wrong
write into a silent delete of user bytes: the clean path is forced, and a forced apply skips the
dirty guard. Hence R6 and D-C. (2) Under `core.ignorecase=true`, `B/f` matches today only because
everything is written. A sparse-only fix turns `case` red. Hence R8 and D-D. (3)
`withConflictStopStats` would `lstat` an unwritten path. Hence the narrowed `written` set in R2.
(4) The clean-path fix alone breaks st/sta (no step 2). Hence R5.

## Design

### 1. The matcher is loaded once per `applyMergeToWorktree` call (D-E = A shown)

```ts
export const applyMergeToWorktree = async (ctx, input) => {
  // … flatten, detect renames, merge, rejectUnsupported, findWouldOverwrite: unchanged …
  const sparse = await loadSparseMatcher(ctx); // pure read; the caller already holds the index lock
  if (merged.cleanMerge) {
    const mergedTree = await synthesiseMergedTree(ctx, merged.outcomes);
    const materialized = await materializeTree(ctx, {
      targetTree: mergedTree,
      currentIndex: input.currentIndex,
      headTree: input.oursTree,
      force: true,
      ...(sparse !== undefined ? { sparse } : {}),
    });
    // writeAutoMerge, keepsStagedChanges, indexTree: unchanged
  }
  return materialiseConflict(ctx, merged, changed, input.currentIndex, sparse);
};
```

- git loads the patterns per `unpack_trees` call (`populate_from_existing_patterns`), so per
  sequencer step. One load per call is faithful. It also picks up a pattern change between steps
  (an `exec sparse-checkout set` line in a rebase todo).
- `loadSparseMatcher` already honours `config.worktree` and the per-worktree pattern file
  (R9, row wt). No new reader.
- `keepsStagedChanges(ours, changed, newIndexEntries)` compares ids and modes only. A
  skip-worktree entry changes neither, so `indexTree` is unchanged (R1). Carried entries keep
  their flags through `carryHeadAgreement`.
- `ApplyMergeInput` does not change.

Context block: `src/application/primitives/apply-merge-to-worktree.ts`, `applyMergeToWorktree`
(clean branch) and `materialiseConflict` (new `sparse: SparseMatcher | undefined` parameter;
file-private, so not a boolean-parameter smell). Import `loadSparseMatcher` from
`./read-sparse-checkout.js` and `SparseMatcher` from `../../domain/sparse/index.js`. Unit suite:
`test/unit/application/primitives/apply-merge-to-worktree.test.ts`.

### 2. Conflict path: sparse-aware writers and index (R2, R3)

One predicate, shared with `merge.ts` (it moves out of `merge.ts`, where `isExcluded` is
file-private today):

```ts
// src/application/primitives/internal/sparse-verdict.ts
export const isExcluded = (sparse: SparseMatcher | undefined, path: FilePath): boolean =>
  sparse !== undefined && !sparse(path);

/** git writes a clean outcome only inside the patterns; a conflict is always written. */
export const isMaterialised = (outcome: ChangedOutcome, sparse: SparseMatcher | undefined): boolean =>
  !isExcluded(sparse, outcome.path);              // D-A = A: no resolved-merged exception
```

- **`writeConflictWorktree(ctx, outcomes, conflicts, changed, sparse)`.** The `touched` write
  loop skips `!isMaterialised(outcome, sparse)` for written outcomes. Deletions are unchanged.
  `survivingPathsOf` gets the filtered `touched`, as `merge.ts` `survivingFor` does. The conflict
  loop (`writeValidatedConflict` → `writeDistinctTypesSides` / `writeMarkedConflict`) is
  untouched. `createMergeResultWriter` still reads attributes from the whole result. git also
  reads attributes from the result index, excluded paths included.
- **`buildUnmergedIndex(outcomes, conflicts, merged, sparse)`.** Each stage-0 entry, whether from
  `blobBackedEntries` or `merged`, whose path `isExcluded` becomes
  `skipWorktreeEntry({ path, pathBytes?, id, mode })`. That is the domain builder; the escaped
  path must keep its `pathBytes`, so pass the `IndexEntry` spread, as `merge.ts` does with
  `indexPathOfEscaped`. Conflict stages are unchanged.
- **`withConflictStopStats(ctx, entries, currentIndex, written)`.** `written` becomes the
  materialised subset: `changed` minus excluded written outcomes. Its signature is unchanged; the
  caller narrows the set. Its `before` carry (same id/mode → the prior entry) must not overwrite a
  sparse verdict. `statOf` returns `entry` as is when `entry.flags.skipWorktree` differs from
  `before.flags.skipWorktree`. An unchanged `S` path keeps its prior entry (both `S`). Unit row:
  an excluded unchanged path whose prior entry is `H` (a mover, R4) ends `S`.
- `conflictResultTree`/`writeAutoMerge`: unchanged. `AUTO_MERGE` carries every path's blob,
  excluded or not, as git's result tree does.

Context block: `apply-merge-to-worktree.ts` — `writeConflictWorktree`, `writeChangedOutcome`,
`buildUnmergedIndex`, `blobBackedEntries`, `materialiseConflict`, `survivingPathsOf` (exported;
`merge.ts` imports it). `internal/stat-conflict-index.ts` — `withConflictStopStats`, `statOf`.
`src/domain/git-index/index-entry.ts` — `skipWorktreeEntry`. `merge.ts` — `isExcluded`,
`isMaterialised`, `survivingFor`, `outcomeWave`, `buildConflictIndexEntries` (D-A = A: the
`merged` entries get the same excluded → `skipWorktreeEntry` projection; `isMaterialised` drops
its `resolved-merged` arm). Existing unit suites:
`test/unit/application/primitives/apply-merge-to-worktree.test.ts`,
`test/unit/application/primitives/internal/stat-conflict-index.test.ts`, the `merge` suites under
`test/unit/application/commands/` (`merge-*.test.ts`; locate `buildConflictIndexEntries`' suite
with serena `find_referencing_symbols`).

### 3. Conflict-path movers (R4, D-B = A shown)

The clean path gets git's "re-apply the patterns to every index path" from `materializeTree`'s
`sparseMovers`. The conflict path does not use `materializeTree`. It gets a small pass over the
current index, run after the writes and before the index is built:

```ts
// src/application/primitives/internal/sparse-movers.ts
/** git's sparse loop #1 on a conflict stop: an out-of-pattern file the merge left alone leaves the work tree. */
export const retireSparseMovers = async (
  ctx: Context,
  scope: { readonly currentIndex: GitIndex; readonly conflicted: (key: IndexPathKey) => boolean },
  sparse: SparseMatcher,
): Promise<SparseRetirement /* { retired: ReadonlySet<IndexPathKey>; leftDirty: ReadonlyArray<FilePath> } */>
```

- Candidates: stage-0 entries with `!sparse(path)`, `!flags.skipWorktree` and not a conflict
  path. A changed one is included: §2 skips its write, so its old file would otherwise stay on
  disk behind an `S` entry with the new id. A changed candidate is clean by construction, since
  `findWouldOverwrite` refused any dirty changed path.
- A clean candidate (same `matchesCachedStat` / racy-content rule `materializeTree` uses to judge
  up-to-date; `src/application/primitives/internal/is-entry-stat-clean.ts`) is removed, its
  emptied directories are pruned (`pruneEmptiedDirectories`), and it is reported `retired`.
- A dirty candidate is reported `leftDirty`, gets one `ctx.logger?.warn`, and keeps its `H` entry
  (R6).
- `buildUnmergedIndex` marks `retired` paths `skipWorktree: true`. The clean outcomes already
  carry them as `unchanged` with the same id.
- `merge.ts`'s conflict writers call the same helper under D-B = A (mpscf).

### 4. Dirty movers inside `materializeTree` (R6, D-C = A shown)

Today a mover (out-of-pattern, non-`S` index path) enters the changeset as a delete. Unforced,
the dirty guard refuses it (dpsco). Forced, it is deleted. The change: in `carryHeadAgreement`'s
mover partition (`sparseMovers` → `partitionCarry`), a mover whose work file is not up to date is
carried as a kept `H` entry and leaves the mover set. Its path joins a `leftDirty` list, which
`materializeTreeJudging` warns about once. The rest of the mover machinery (`sparseCollisions`,
`stagedOutsideTarget`) sees it as kept, the same as an agreed path.

- This only applies when `headTree` is set (two-way), the only mode with movers.
- One stat (and a racy hash) per out-of-pattern non-`S` entry. In a sane sparse checkout that set
  is empty, so the cost is zero.
- `checkout`'s dpsco refusal disappears. ADR-1199 says a removed refusal is `fix`.

Context block: `materialize-tree.ts` — `sparseMovers`, `carryHeadAgreement`, `partitionCarry`,
`carrySplitOf`, `materializeTreeJudging`. `internal/is-entry-stat-clean.ts` —
`matchesCachedStat`, `RacyContentCheck`. Unit suite:
`test/unit/application/primitives/materialize-tree*.test.ts` (sparse describe blocks). Interop
twin: dpsco (checkout) and dpscp/dpscf (sequencer).

### 5. Stash apply without `--index`: git's step 2 (R5, D-F = A shown)

```ts
const settleCleanIndex = async (ctx, lock, newIndexEntries, { currentIndex, stagedTree }) => {
  if (stagedTree !== undefined) { /* reinstateIndex: unchanged (R7) */ }
  const checkedOut = await checkOutSkippedChanges(ctx, newIndexEntries, currentIndex.entries);
  const { entries, restagedPaths } = unstageChangesUnlessNew(checkedOut, currentIndex.entries);
  await lock.commit(entries, 'replace', { restagedPaths });
};
```

- `checkOutSkippedChanges(ctx, merged, before)` is a new internal next to
  `unstage-changes-unless-new.ts`. For each stage-0 merged entry with `skipWorktree: true` whose
  path is absent from `before` or differs in id/mode, it writes the blob through a
  `createWorkingTreeWriter` built like `createMergeResultWriter`: index-first attributes from the
  merged entries, `readEolSettings`, smudge limiter. It returns the entry with the bit cleared
  and the written file's stat (`withStatData`).
- git's `.stash.XXXXXX` relocation of an occupying file is unreachable. stu proves git clears
  the bit of a present file at index read and then refuses, and `findWouldOverwrite` refuses the
  same way. The helper carries no relocation branch (no dead code).
- Autostash (`applyAutostash`, `applyMergeAutostash`) reaches this through `applyStashCommit`
  without `--index`, as git's `apply_autostash` runs `stash apply`.

Context block: `src/application/commands/stash.ts` — `settleCleanIndex`, `settleIndex`,
`mergeStash`, `applyUnderLock`. `src/application/commands/internal/unstage-changes-unless-new.ts`
— `unstageChangesUnlessNew`, `UnstageOutcome`. Writer: `createMergeResultWriter` is exported from
`apply-merge-to-worktree.ts`. The step-2 helper needs a writer over index entries rather than
merge outcomes, so build it from `createWorkingTreeWriter`
(`src/application/primitives/internal/write-converted-entry.ts`) with
`attributeBlobLookup(entries)`. Unit suites: `test/unit/application/commands/stash.test.ts`,
`test/unit/application/commands/internal/unstage-changes-unless-new.test.ts`.

### 6. Case folding in the matcher (R8, D-D = A shown)

```ts
// src/domain/sparse/parse-sparse-checkout.ts
export interface SparseMatchOptions { readonly ignoreCase?: boolean }
export const buildSparseMatcher = (spec: SparseSpec, options: SparseMatchOptions = {}): SparseMatcher

// src/application/primitives/read-sparse-checkout.ts — loadSparseMatcher
const ignoreCase = (await readConfig(ctx)).core?.ignoreCase === true;
return buildSparseMatcher(parsed.spec, { ignoreCase });
```

- Cone: `coneMatcher` builds ASCII-lowercased copies of `parents`/`recursive` once and lowercases
  the walked `dir`. The hot path allocates one lowercased string per call, only when
  `ignoreCase`. Measure with the existing `materializeTree` bench before and after; a
  `toLowerCase` per path is the expected cost.
- Non-cone: `compileSparseRule` passes a new `CompileGlobOptions.caseFold?: boolean` to
  `compileGlob`. ASCII case-insensitive literal and class comparison is git's `WM_CASEFOLD`
  (`src/domain/pathspec/compile-glob.ts`, `matchTokens`). The option defaults off, so pathspec
  and ignore callers are unchanged.
- `ASCII` only: git's `tolower` is `sane_ctype`. A non-ASCII case pair stays distinct. Unit row.
- Every `loadSparseMatcher` consumer changes together (D-2). Interop pin per consumer: `checkout`
  (caseco), the sequencer (case, casenc), `reset --hard`, `merge`, `pull` ff (pin in planning; the
  rows reuse the caseco fixture).

### 7. Docs

- ADR-076: superseded in its `resolved-merged` clause (D-A = A) by a new ADR. ADR-073's note
  stays.
- `docs/design/sparse-reset-merge.md` §5.2 point 1 and §9 decision 3 get a superseded note
  pointing at the new ADR.
- `docs/known-divergences.md`: nothing removed (32.60 is a backlog item). New ledger lines only
  for what the decisions defer.
- `docs/BACKLOG.md` 32.60: tick, and record the corrected statement (lesson 033). It lists the
  pinned consumers, the conflict path and the ADR-076 supersession.

## Test plan

### Unit (memory adapter unless named)

- `apply-merge-to-worktree.test.ts`, one `describe` per class, each guard isolated:
  - clean: excluded change → `S`, no file. Excluded add → `S`. Rename leaving → `S`, entering →
    written. Excluded delete → gone. Sparse off → byte-identical to today (R10).
  - conflict: blob-backed excluded → `S`, no file, no `lstat` (kills the narrowed-`written`
    mutant). `resolved-merged` excluded → `S` with the merged oid, no file. Conflict on an
    excluded path → written, no bit. Distinct-types sides → written. Excluded `S` unchanged path
    keeps its prior entry. Mover clean → removed + `S`. Mover dirty → kept `H` + one warn with
    the path list (assert the logger call's data, not only that it was called).
  - matcher loaded per call: a pattern file changed between two calls changes the verdict.
- `stat-conflict-index.test.ts`: the skip-worktree verdict is not overwritten by the `before`
  carry (both directions).
- `sparse-verdict.test.ts`, `sparse-movers.test.ts`: each predicate arm on its own.
- `materialize-tree` sparse suite: dirty mover kept `H`, warned, forced and unforced (two rows).
  Clean mover removed (exists; extend if absent).
- `stash` suites: step 2 writes an excluded changed path and clears the bit (st), keeps a new
  excluded path staged and written (sta), leaves an unchanged mover removed (stps), skips on
  conflict (scf3). `--index` keeps the merged bit (sp).
- `merge` suites (D-A/D-B = A): `isMaterialised` without the `resolved-merged` arm;
  `buildConflictIndexEntries` marks an excluded merged entry `S`.
- `parse-sparse-checkout.test.ts`, `cone.test.ts`, `non-cone.test.ts`: `ignoreCase` true/false
  rows, `B/f` vs `/b/`, non-ASCII pair stays distinct. `compile-glob` `caseFold` rows (literal,
  class, `*`, `?`).
- `read-sparse-checkout.test.ts`: `core.ignorecase=true` reaches the matcher. Absent → false.

### Property tests (`.claude/workflow/property-testing.md`)

Only D-D touches a matcher. Lens 2 (compositional matcher) fits:
`src/domain/sparse/cone.properties.test.ts` and `non-cone.properties.test.ts` (new siblings,
shared `arbitraries.ts`). Properties, `numRuns` 100:

- with `ignoreCase`, the verdict is invariant under ASCII case flips of the path;
- with `ignoreCase: false` (or omitted), the verdict equals today's matcher (independently
  tested oracle: the existing example-tested matcher built without the option);
- a path that matches case-sensitively matches case-insensitively.

`compile-glob` gets the first and third properties for `caseFold`, added to the existing
`test/unit/domain/pathspec/compile-glob.properties.test.ts`. The R1–R7 writers are
orchestration: no property sibling (lens check: no round-trip, no rule reduction, no total
grammar, no counting invariant).

### Interop (`test/integration/*-interop.test.ts`)

One new suite, `test/integration/sequencer-sparse-cone-writes-interop.test.ts`. It reuses
`occupant-displacement-fixtures.js` (`commitOn`, `listing`, `COMMIT_ENV`) and the
`CONE_FILE`/seed pattern of `sparse-checkout-worktree-config-interop.test.ts`. Shape (lesson
045):

```ts
describe.each(['false', 'true'])('Given core.ignorecase=%s in both twins', (ignoreCase) => {
  describe('When cherry-pick replays a change outside the cone', () => {
    it('Then the path stays skip-worktree and unwritten, as git leaves it', …);
  });
  // revert, rebase, rebase --rebase-merges, the replay sequence (a two-commit cherry-pick range),
  // stash apply, stash apply --index, stash pop, non-cone, rename leaving, conflict cf2/cf3/cf3rb/scf3,
  // movers pscp/pscf/stps, dirty movers dpscp/dpscf/dpsco, linked worktree wt, case/casenc/caseco,
  // merge mcf3/mpscf (per D-A/D-B), and the must-not-regress rows del/st/sta/stu/cf/dt/mg/mcf2
});
```

Each row compares `ls-files -t -s`, the disk listing, and (st, sta) `status` reconstructed from
structured fields (ADR-249). The `case` rows assert both twins per value. The ignorecase=`true`
row on a case-sensitive filesystem is still meaningful: git reads the config, not the
filesystem. Skips go on `it.skipIf`, never `describe.skipIf(…).each(…)`. Run
`npm run check:test-pyramid` per part.

### Mutation

Narrowed buckets per module (`.claude/workflow/mutation.md`): `apply-merge-to-worktree.ts`,
`internal/sparse-verdict.ts`, `internal/sparse-movers.ts`, `internal/stat-conflict-index.ts`,
`materialize-tree.ts` (mover partition only), `stash.ts` step 2, `merge.ts` (touched functions),
`domain/sparse/*`, `compile-glob.ts`.

## Breaking-change classification

- No public signature changes in a breaking way. `buildSparseMatcher` gains an optional second
  parameter, and `CompileGlobOptions` an optional field. `api.json` moves (check at pre-push).
- State-only changes on returning calls (files not written, bits set) are `fix`, as every
  previous sparse-awareness change was.
- D-C = A removes a refusal (`checkout` dpsco) and adds none, so the change is `fix` (ADR-1199).
  With D-C = B or C, dpscp/dpscf change from "returns" to "throws `CHECKOUT_OVERWRITE_DIRTY`"
  (B), or the commit has to ship a known silent delete (C). B is `fix!` under D-3.
- D-D changes `checkout`/`reset`/`merge`/`pull` outcomes under `core.ignorecase=true`. That is a
  state change on returning calls: `fix`.

## Decision candidates

- **D-A — ADR-076's `resolved-merged` clause.** mcf3 (merge), cf3/cf3rb/scf3 (sequencer, stash)
  show git leaves an out-of-pattern line-merged path unwritten, with its merged blob at stage 0
  `S`. The clause's premise ("sole persistence") is false in today's code: both conflict paths
  hash the bytes.
  - A. Supersede the clause for `merge` and the sequencer/stash conflict path with a new ADR: one
    rule ("a clean outcome is written only inside the patterns; a conflict always is") in the
    shared `isMaterialised`.
  - B. Apply git's rule to the sequencer/stash conflict path only. Keep ADR-076 for `merge`, and
    record mcf3 in `docs/known-divergences.md`.
  - C. Keep ADR-076 and extend its clause to the sequencer: blob-backed paths are skipped,
    line-merged paths written. cf3/cf3rb/scf3/mcf3 stay red.
  - **Recommendation: A.** ADR-226 binds. The rows are pinned. The shared predicate removes the
    two-behaviour rule ADR-076 lists as a negative. The user's brief ("keep ADR-076's
    conflict-path handling") predates the mcf3 pin.
- **D-B — movers on a conflict stop (pscf, mpscf).** git removes an out-of-pattern clean `H` file
  the merge did not touch, and marks it `S`.
  - A. Fold for the sequencer/stash conflict path and `merge`'s conflict writers through one
    `retireSparseMovers` helper.
  - B. Sequencer/stash only. mpscf goes to the ledger.
  - C. Defer both. pscf/mpscf go to the ledger; the clean path still fixes pscp.
  - **Recommendation: A** (D-2: one shared rule, an interop pin per consumer).
- **D-C — dirty out-of-pattern movers in `materializeTree` (dpsco, dpscp, dpscf).** git keeps
  the dirty file `H`, warns and continues. tsgit `checkout` refuses. A sparse-only sequencer fix
  would delete the file, because the clean path is forced.
  - A. Fold into `materializeTree`'s mover partition: a dirty mover is carried `H` and warned
    about, forced or not. That fixes `checkout` too (`fix`, ADR-1199).
  - B. Leave `materializeTree` alone and pass `force: false` on the sequencer clean path for
    movers. dpscp/dpscf then refuse where git succeeds (`fix!`, D-3), and dpsco stays red.
  - C. Ship the sparse-only fix and ledger dpsco. This loses user bytes (dpscp): below no bar.
  - **Recommendation: A** (D-2; C is a data-loss regression).
- **D-D — `core.ignorecase` in the sparse matcher (case, casenc, caseco).**
  - A. Fold into `loadSparseMatcher` → `buildSparseMatcher(spec, { ignoreCase })` for every
    consumer, with an interop pin per consumer (checkout, sequencer, reset, merge, pull ff).
  - B. Fold for the sequencer's load site only. checkout/reset/merge/pull stay case-sensitive, so
    the two code paths disagree on one repository.
  - C. Defer. The `case` row under `true` becomes a regression of this change (today it matches
    by accident) and goes to the ledger with caseco.
  - **Recommendation: A** (D-2: the change makes the row reachable; B makes tsgit
    self-inconsistent).
- **D-E — where the matcher is loaded.**
  - A. Inside `applyMergeToWorktree`, once per call (per sequencer step).
  - B. Caller-supplied `ApplyMergeInput.sparse`, loaded once per sequence. This saves one config +
    pattern read per step, but misses a mid-rebase pattern change and changes four call sites.
  - C. Both (an optional input overrides the load).
  - **Recommendation: A** (git reloads per `unpack_trees`; no signature change; the read is small
    against a step's tree walks).
- **D-F — stash apply without `--index`.**
  - A. Apply sparse in the merge, then git's step 2 in `settleCleanIndex`
    (`checkOutSkippedChanges`).
  - B. Call the merge without sparse on the no-`--index` clean path. st/sta stay green, but stps
    stays red, and it needs a mode option on `applyMergeToWorktree`.
  - **Recommendation: A** (stps proves only A matches git's sequence).

## Out of scope

- `worktree add` does not copy `info/sparse-checkout`/`config.worktree` and does not check out
  sparse (wtaddlocal, wtaddset). Separate command, separate write surface: IMPACT.
- `pull` into an unborn HEAD ignores the patterns (piv; tsgit side by code): IMPACT.
- 32.64/32.77 non-cone matcher defects. The non-cone rows here use `/top`,`/b/` to stay clear of
  them.
- The reverse mover on a conflict stop: an in-pattern entry still carrying `S` (patterns widened
  without `reapply`) that the merge leaves alone. By `apply_sparse_checkout`, git writes it and
  clears the bit ("was `S`, leaves `S`"). The clean path already does this (`planMaterialize`
  strips `S` entries, so the path classifies `add`). The conflict path does not. Not pinned. To
  prove: in the pscf fixture, append `/a/` to the pattern file without `reapply`, then compare
  `ls-files -t` and the disk after the conflicting cherry-pick. If it diverges, it joins R4 in
  planning.
- Index stat bytes of a mover marked `S`. tsgit zeroes them (`skipWorktreeEntry`); git keeps the
  old stat. Not pinned. To prove: `git ls-files --debug a/g` after pscp in both twins.

## Self-review log

- Pass 1: found the forced-apply delete (dpscp) and the case row turning red. Added R6/D-C,
  R8/D-D and the pins dpsco/dpscp/dpscf/caseco/casenc.
- Pass 2: found `withConflictStopStats`' `lstat` on an unwritten path, and its `before` carry
  overwriting a sparse verdict. Added both to §2 and the unit plan. Found stash's step 2 missing
  from a clean-path-only fix. Added R5 and pinned sta/stps/stu.
- Pass 3: checked the consumer table against every `materializeTree(Judging)` /
  `applyMergeToWorktree` / `loadSparseMatcher` call site. Added `stash push` reset (unchanged,
  not pinned, proof recipe given) and the autostash routes. Checked that no requirement leans on
  an unpinned git behaviour. stu shows the relocation branch is unreachable, so it is excluded
  rather than assumed. Widened R4 to changed out-of-pattern `H` paths: the skipped write would
  otherwise leave a stale file behind an `S` entry. Recorded the unpinned reverse mover as a
  recipe, not a requirement.
