# Design — stash-apply-dir-file-replacement

> Brief: backlog 32.22 — `stash apply` refuses a stash that replaced a directory with a file
> (`STASH_APPLY_WOULD_OVERWRITE`, "1 local change(s) would be overwritten") on a clean tree where git 2.55 applies it.
> Pin the dir↔file / dir↔symlink matrix for `stash apply`, `apply --index`, `pop`, `pop --index` against git 2.55,
> fix the refusal git-faithfully, and fold every in-perimeter gap the matrix proves on the same stash path.
> Status: draft → self-reviewed ×3

## Context

- The backlog's literal shape (tracked `d/x` replaced by file `d`, `git add -A`, `stash push`, `stash apply` on a
  clean tree) no longer refuses on main 23ff6c1e. The same probe, run through `git archive`-extracted `src/` of
  older commits, refuses with `STASH_APPLY_WOULD_OVERWRITE { paths: ['d'] }` at 7337e22e (where 32.22 was filed, #317) and
  4899565f (#330), and applies at fb6bc5b0 (#331, occupant displacement). #331 fixed the classification in the
  shared pre-flight; nothing pins it for stash: `MERGE_FAMILY_ROWS`
  (`test/integration/occupant-displacement-fixtures.ts:461-596`) has no clean-tree dir→file row, and
  `stash-apply-index-interop.test.ts:47-65` holds only the file→dir row. The directory-to-file branch of
  `unstageChangesUnlessNew` (`commands/internal/unstage-changes-unless-new.ts:42-47`, the `files.has(dir)` arm)
  is reached by that shape today (A.1 DFa × `apply`: tsgit's `ls-files -s` equals git's, `d/x` dropped), but no
  interop row proves it.
- The refusal survives in the work-tree-only variant stashed with `-u`: `d/x` deleted, untracked file `d`
  (A.1 DF × `-u`). git applies it; tsgit refuses `STASH_APPLY_WOULD_OVERWRITE { paths: ['d'] }`. Stack (probe
  with the error's stack): `domain/commands/error.ts:1396` ← `stash.ts:1075` (`refuseUntrackedOverwrites`) ←
  `stash.ts:1046` (`applyUnderLock`).
- `stash apply` today (`src/application/commands/stash.ts`):
  - `stashApply` (`:966-973`): `gateStash` → `assertNoPendingOperation` (`:971`) → `resolveStashEntry` →
    `applyStashCommit`.
  - `applyStashCommit` (`:1007-1025`) parses W, takes the index lock and runs `applyUnderLock` (`:1038-1067`):
    `readIndex` → `rejectUnmergedIndex` → `synthesizeTreeFromIndex` (C) → `refuseUntrackedOverwrites` (`:1069-1076`,
    when the stash has a U parent; `untrackedOverwrites` `:881-893` asks `pathIsOccupied` for every U path) →
    `mergeStash` (`:1079-1098`, throws `stashApplyWouldOverwrite([...localChanges, ...untracked])` at `:1096-1097`)
    → conflict: commit the unmerged entries, return `conflict` | clean: `reinstateIndex` (`--index`) or
    `unstageChangesUnlessNew` → `lock.commit` → `restoreUntracked` (`:912-931`) → `applied`.
  - `restoreUntracked` writes every U entry through `untrackedWriter` (`:896-910`) → `writeBlob`
    (`primitives/internal/write-converted-entry.ts:115-125`) → `writeWorkingTreeEntry`, which calls
    `unlinkSymlinkedLeadingComponent` (`primitives/internal/write-working-tree-file.ts:94`, `:340`): a checkout's
    displacement, so a leading symlink is replaced by a directory.
  - `stashPop` (`:1105-1116`) delegates to `stashApply` and drops only on `applied`. `applyAutostash`
    (`:979-994`) shares `applyStashCommit` (merge/rebase autostash; never has a U parent: `createAutostash`
    `:600-604` passes no `includeUntracked`).
- `stash push` after #332: `stashPush` (`:575-586`) opens with `refreshAndWriteIndex` (ADR-1092,
  `commands/internal/refresh-index.ts:35-46`), has no pending-operation gate (ADR-1095), runs `stashAndReset`
  (`:609-632`) and `finishStashReset` (ADR-1093/1094). `createStashCommits` (`:741-757`) writes the U commit only
  when an untracked path was found (`:750-753`). `resetAfterPush` (`:823-844`) resets, commits the index, THEN
  removes each stashed untracked path (`:841-843`, `removeWorkingTreeFile`
  `primitives/internal/write-working-tree-file.ts:350-354`).
- The shared 3-way apply `applyMergeToWorktree` (`primitives/apply-merge-to-worktree.ts:492-560`) always writes
  `AUTO_MERGE` on a clean merge (`:551`).
- Constraints: ADR-226 (faithful data and on-disk state), ADR-249 (structured data, no rendering), ADR-211 (stash
  v1 surface: `includeUntracked`, `keepIndex`, `restoreIndex`), ADR-212 (merge refusal is atomic, conflict is a
  result kind, pop keeps the stash on conflict), ADR-343 (`lstat` presence probe), ADR-1092 (push refresh), ADR-1095
  (push has no pending-operation gate). No ADR decides the pre-merge untracked check or the U-commit omission.
- Lessons: 017 (a refusal expectation is git's own, through the public command), 018 (a "writes nothing" pin
  drifts a clean entry's stat first — every row here drifts `keep`), 019 (name git's routine behind each
  up-to-date judge: the untracked restore is `checkout-index`, not `verify_uptodate`).

## Requirements

- R1 `stash apply` / `pop` (with and without `restoreIndex`) of a stash that replaced a tracked directory with a
  file, staged or not, nested or not, with or without `-u`, on a clean tree ends as git 2.55 leaves it: work tree,
  `ls-files -s`, `ls-files -v`, `refs/stash` and its reflog, `AUTO_MERGE` (A.1). The DFa rows are pinned in interop,
  so the directory-to-file branch of `unstageChangesUnlessNew` is reached from a public command.
- R2 The stash's untracked files are restored after the merge, whatever the merge's outcome: a clean merge, a
  conflict (`kind: 'conflict'`), or a merge refusal (`STASH_APPLY_WOULD_OVERWRITE`). Nothing about the untracked
  tree is judged before the merge (A.3 FU, UP rows).
- R3 The untracked restore follows git's `checkout-index --all` without `--force`, entry by entry in index order:
  - a path where `lstat` finds anything (file, directory, empty directory, symlink, dangling symlink) is not
    written and is reported; later entries are still restored;
  - a path whose leading component is not a directory (a regular file, a symlink to a file, to a directory, or
    dangling) stops the restore at that entry; the component is kept as it is, earlier entries stay written, later
    ones are not written; the blocking component is reported;
  - otherwise the entry is written (leading directories created).
  A tracked symlink is never replaced by a directory (A.3 link-m, linked-dir-m, dangling-m; A.1 LD × `-u`).
- R4 Any R3 report makes the command fail after the merge's index and work tree are written. `pop` then keeps the
  stash (A.1 LD × `-u` × `pop`). The data shape is DC1/DC2.
- R5 `stash apply` / `pop` open with git's `refresh_and_write_cache`, after the stash is resolved: stat-drifted,
  content-clean entries are refreshed and the index rewritten even when the apply then refuses (every A.1–A.3 row;
  A.2 refusals; A.5 U1). An unmerged index then refuses `MERGE_HAS_CONFLICTS`, the refreshed index left on disk.
  A missing stash refuses `STASH_NOT_FOUND` with the index untouched (A.1 DL rows: git keeps the inode).
- R6 When the stash's W tree equals its base tree, the apply runs no merge and writes no `AUTO_MERGE` (git's
  non-recursive `merge-ort` entry point prints "Already up to date." and returns), then runs the index step as for a clean merge (A.1 FD, LD
  plain rows).
- R7 `stash push --include-untracked` removes the stashed untracked paths before its reset, as git runs
  `clean --force --quiet -d :/` before `reset --hard` (A.4 trace). A dir↔file swap stashed with `-u` (DF, DFn, FD, LD)
  saves and resets without `DIRECTORY_NOT_EMPTY` / `NOT_A_DIRECTORY`, and then runs `finishStashReset`.
- R8 (DC4) `stash push --include-untracked` with local changes but no untracked file records git's U commit: the
  empty tree, no parent, subject `untracked files on <branch>: <short> <subject>`; W has three parents (A.4 E1, E2).
  Nothing to stash still saves nothing (A.4 E0).
- R9 (DC5) `stash apply` / `pop` run during a pending merge, cherry-pick, revert or rebase; the markers stay
  (A.5 P rows).
- R10 (DC3) A merge refusal keeps the git class of each path: local changes vs untracked (A.2 DFa × dirty-dx
  vs untr-du).
- R11 Every Appendix A row SAME today stays SAME (the DL/DLa push refusals, the DFa/FDa/LDa/LF/FL index outcomes);
  every DIFF row covered by R1–R10 becomes SAME.

## Design

### How the matrix was pinned

A throwaway harness outside the repository: one `mktemp -d` per row, isolated `HOME` with a global config
(`user.name`, `user.email`, `commit.gpgsign=false`, `merge.conflictStyle=merge`, `init.defaultBranch=main`),
`GIT_CONFIG_NOSYSTEM=1`, every other `GIT_*` scrubbed and asserted absent, `PATH` led by the git 2.55.0 build and
`git --version` asserted `git version 2.55.0`; every `cd` guarded by `[ -n "$G" ] && [ -d "$G/.git" ]`. Two
sibling repositories are seeded with the same plumbing-free history: `keep=k`, `d/x=x`, `n/s/y=y`, `f=f`, link
`l → keep`. The shape is planted in both; git pushes in the peer and tsgit (worktree `src/` at 23ff6c1e, loaded
through `jiti`, `createNodeContext({ workDir })`, `stashPush` / `stashApply` / `stashPop`) pushes in its twin, or
git pushes in both (the git-pushed runs, which isolate the apply from the push). W, I and U trees are compared
between the peers (equal on every row except A.4 E1). After the push both wait past the racy window, plant the
post-push state, then drift `keep` (`touch -t 202001010000 keep`, lesson 018) and record the index inode. git runs
the command (exit, stdout, stderr kept); tsgit runs the same through the command function (result kind or error
data). Compared: `ls-files -s`, `ls-files -v` tags, the recursive work-tree listing (type, link target, content),
`refs/stash` existence and reflog count, `.git` state files (`AUTO_MERGE`, …), `keep`'s cached mtime against
`lstat`, the index inode, `status --porcelain -uall`. Side probes, same isolation: the old-commit runs
(`git archive <rev> src`), the git `GIT_TRACE` of `stash push -u` and `stash apply`, the unmerged and pending-operation
apply, the U-commit shape, and merge / cherry-pick of a dir→file branch.

Shapes (tracked → stash work tree; `a` suffix = `git add -A` before the push): DF `d/x` → file `d`; DFn `n/s/y` →
file `n`; FD `f` → `f/y`; DL `d/x` → link `d → keep`; LD link `l` → `l/y`; LF link `l` → file `l`; FL `f` → link
`f → keep`; FU `f` edited + untracked `u`; UP `f` edited + untracked `a`, `m/z`, `u`, `z`. Push modes: plain,
`-u`, `--keep-index`. Post-push states: clean; dirty-dx (`d/x` edited); untr-du (untracked `d/u`); empty-de (empty
`d/e/`); ign-du (`d/u` ignored); rm-dx (`d/x` deleted); dirty-f; conflict-f (`f` committed `c` after the push);
untr-u (`u` recreated); file-m / link-m / linked-dir-m / dangling-m (`m` a file, a link to `keep`, to `d`, to
nowhere); emptydir-u. Commands: `stash apply`, `apply --index`, `pop`, `pop --index`.

### Parity summary

147 apply pairs. 22 SAME (the DL/DLa rows, where both pushes refuse beyond a symlink and both applies report no
stash). 76 differ only in `keep`'s refreshed stat (F5). 49 differ in outcome, work tree, index, `refs/stash` or
state files.

| # | Finding | Proof rows | Perimeter |
|---|---|---|---|
| F1 | The backlog's literal DFa shape refused before #331 and applies now; no interop row pins it | A.6 O1–O3; A.1 DFa × 4 commands | in (R1, regression guard) |
| F2 | DF / DFn × `-u`: tsgit refuses `STASH_APPLY_WOULD_OVERWRITE ['d']` before the merge; git merges (deletes `d/x`), then restores file `d` | A.1 DF, DFn × `-u`; A.2 DF-u × rm-dx | in (R2, R3) |
| F3 | git restores untracked files after a merge refusal and after a conflict; tsgit refuses before restoring, and returns `conflict` without restoring | A.3 FU × dirty-f, conflict-f | in (R2) |
| F4 | One untracked path in the way: git applies the merge, restores the others, exits 1; tsgit refuses before the merge | A.3 UP × untr-u, emptydir-u; A.2 DF-u × untr-du, empty-de, ign-du | in (R3, R4) |
| F5 | A leading symlink of an untracked path: git dies `cannot create directory at 'm'`, link kept; tsgit replaces the link with a directory, restores everything, and `pop` drops the stash | A.3 UP × link-m, linked-dir-m, dangling-m; A.1 LD × `-u` | in (R3, R4) |
| F6 | A leading regular file: git dies the same way, exit 1; tsgit throws the adapter's raw `NOT_A_DIRECTORY` with an absolute path | A.3 UP × file-m; A.1 FD × `-u` | in (R3, R4) |
| F7 | `stash apply` never refreshes nor rewrites the index; git does, also before every refusal | all rows (`keep` fresh in git, stale in tsgit; git inode changes on every row except no-stash) | in (R5) |
| F8 | W tree = base tree: git prints `Already up to date.` and writes no `AUTO_MERGE`; tsgit writes it | A.1 FD, LD × plain, `--keep-index` | in (R6) |
| F9 | `stash push -u` of a type-swapped path throws `DIRECTORY_NOT_EMPTY` (DF, DFn) or `NOT_A_DIRECTORY` (FD, LD) after saving the stash and resetting; git cleans untracked before its reset | A.4 S1–S4, trace | in (R7) |
| F10 | `stash push -u` with no untracked file writes a 2-parent W; git writes a 3-parent W with an empty-tree U | A.4 E1, E2 | DC4 |
| F11 | `stash apply` / `pop` refuse `OPERATION_IN_PROGRESS` while `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `REBASE_HEAD` stands; git applies and keeps the marker | A.5 P1–P5 | DC5 |
| F12 | `STASH_APPLY_WOULD_OVERWRITE { paths }` merges git's two refusal classes into one list | A.2 DFa × dirty-dx vs untr-du | DC3 |
| — | Merge and cherry-pick of a dir→file branch (clean, untracked `d/u`, dirty `d/x`) match git on main | A.6 M1–M6 | not a gap |

### Root causes (main 23ff6c1e)

- RC1 (F2, F4) — `applyUnderLock` (`stash.ts:1046`) runs `refuseUntrackedOverwrites` (`:1069-1076`) before the
  merge, on the pre-merge work tree, and turns any occupied U path into a whole-apply refusal. git
  merges first and restores the untracked tree afterwards: its merge output precedes the restore's errors on every
  A.2/A.3 row, and the A.4 trace shows the restore as `read-tree <u_tree>` then `checkout-index --all` against a
  temporary index. Directory `d` exists before the merge deletes `d/x`.
- RC2 (F3) — the untracked restore sits on the clean branch only (`:1065`); `mergeStash` throws (`:1096`) and the
  conflict branch returns (`:1048-1054`) before it.
- RC3 (F5, F6) — `restoreUntracked` writes through the checkout writer, whose `unlinkSymlinkedLeadingComponent`
  (`write-working-tree-file.ts:94`, `:340`) displaces a leading symlink, and lets a leading file surface the adapter's
  `NOT_A_DIRECTORY`. git's `checkout-index` without `--force` dies on such a component with
  `fatal: cannot create directory at '<component>': File exists` and leaves it in place (A.3 file-m, link-m,
  linked-dir-m, dangling-m).
- RC4 (F7) — `stashApply` (`:966-973`) has no opening refresh; ADR-1092 added it to `stashPush` only.
- RC5 (F8) — `mergeStash` calls `applyMergeToWorktree` unconditionally; that primitive writes `AUTO_MERGE` on every
  clean merge (`apply-merge-to-worktree.ts:551`). git's stash goes through the non-recursive `merge-ort` entry point, which returns
  early when base equals theirs.
- RC6 (F9) — `resetAfterPush` (`stash.ts:823-844`) removes the untracked paths after the reset (`:841-843`); by then
  the reset has re-created `d/` (DF) or the file `f` (FD), so `rmIfExists('d')` / `rmIfExists('f/y')` fails.
- RC7 (F10) — `createStashCommits` (`:750-753`) skips the U commit when no untracked path was found.
- RC8 (F11) — `assertNoPendingOperation` (`:971`), present since #98, no ADR (ADR-1095 removed its push twin).
- RC9 (F12) — `mergeStash` (`:1096-1097`) concatenates `localChanges` and `untracked`.

### Fix design

Parts P1–P7, in dependency order. Each part's context block is the minimal reading list.

**P1 — interop guard for the backlog shape (F1, R1)** — no source change. Adds the DFa row to
`stash-apply-index-interop.test.ts` `ROWS` (`'a directory replaced by a file'`: `rm -r d`, `put d`, `add -A`), so
the existing three assertions (staged entries, zero-stat paths, `write-tree` succeeds) cover the
directory-to-file arm of `unstageChangesUnlessNew`. Lesson 005 evidence, same fixture on main through tsgit:
`ls-files -s` equal to git's (A.1 DFa), no zero-stat path in either index, `write-tree` succeeds in both. It is
committed first and stays green through every later part.
Context block: `test/integration/stash-apply-index-interop.test.ts:27-115`; `commands/internal/unstage-changes-unless-new.ts:41-47`, `:121-137`.

**P2 — `stash apply` opens with git's refresh (F7, RC4, R5)** — in `stashApply`:

```ts
export const stashApply = async (ctx, input = {}) => {
  const workDir = await gateStash(ctx, 'stash apply');
  const stash = await resolveStashEntry(ctx, input.index ?? 0);  // STASH_NOT_FOUND leaves the index alone (DL rows)
  await refreshAndWriteIndex(ctx);                               // git's refresh_and_write_cache; refuses unmerged
  return applyStashCommit(ctx, workDir, stash, input);
};
```

- Reuses ADR-1092's `refreshAndWriteIndex` as-is: refresh, unconditional write, then `MERGE_HAS_CONFLICTS` for an
  unmerged index (A.5 U1: git stdout `f: needs merge`, stderr `error: could not write index`, index rewritten, `keep`
  fresh).
- `applyUnderLock`'s own `rejectUnmergedIndex` stays: `applyAutostash` enters `applyStashCommit` without
  `stashApply`. The order "resolve, then refresh" is git's (with no stash, git exits 1 and keeps the index inode and
  the bystander's stale stat: A.1 DL rows).
- With DC5 = (a) the `assertNoPendingOperation` line goes (P7); with (b) it stays after the refresh, so a conflicted
  merge refuses `MERGE_HAS_CONFLICTS` as git does (A.5 U1) instead of `OPERATION_IN_PROGRESS`.
- Context block: `stash.ts:563-586`, `:966-973`; `commands/internal/refresh-index.ts:31-46`;
  `test/unit/application/commands/stash-unmerged-index.test.ts`.

**P3 — the merge outcome no longer short-circuits the untracked restore (F2, F3, RC1, RC2, R2)** —
`applyUnderLock` becomes "merge, settle the index, restore untracked, then report":

```ts
const applyUnderLock = async (ctx, lock, app: StashApplication): Promise<StashApplyResult> => {
  const currentIndex = await readIndex(ctx);
  rejectUnmergedIndex(currentIndex.entries);
  const cTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
  const merged = await mergeStash(ctx, { bTree, cTree, wTree: parsed.wTree, currentIndex });   // no throw
  const settled = await settleIndex(ctx, lock, merged, { ...app, cTree, currentIndex });     // conflict | clean | refused
  const restore = app.uTree === undefined ? NOTHING_RESTORED : await restoreUntracked(ctx, app.uTree);
  return reportApply(settled, restore, app.w);       // throws or returns, per DC1/DC2
};
```

- `mergeStash` returns `ApplyMergeResult` (the `would-overwrite` kind included) instead of throwing.
  `settleIndex` holds today's two branches unchanged: conflict → `lock.commit(result.indexEntries, 'replace')`;
  clean → `reinstateIndex` or `unstageChangesUnlessNew` + `lock.commit(..., { restagedPaths })`; would-overwrite →
  nothing (the lock is released without a commit; P2's refresh is already on disk).
- `refuseUntrackedOverwrites` and `untrackedOverwrites` (`:881-893`, `:1069-1076`) are deleted, and
  `pathIsOccupied`'s import goes with them if P4 does not reuse it.
- `reportApply`: a would-overwrite merge throws `STASH_APPLY_WOULD_OVERWRITE` (DC3 shape); a conflict returns
  `kind: 'conflict'`; a clean merge with a failed restore throws the DC1 error; else `applied`. What a failed
  restore adds to a refusal or a conflict is DC2.
- ADR-212 stays true for the tracked merge (its refusal still writes no tracked path). The stash's untracked files
  are restored after it, as git does.
- Pop: `stashPop` drops only on `applied`, so every failure keeps the stash (A.1 LD-u × `pop`, A.3 rows).
- `applyAutostash` gets the same flow; it never carries a U parent, so only the merge half applies to it.
- Context block: `stash.ts:934-964` (`hasStagedChanges`, `reinstateIndex`), `:1007-1098`;
  `primitives/apply-merge-to-worktree.ts:106-124` (`ApplyMergeResult`); ADR-212.

**P4 — git's `checkout-index` restore (F4, F5, F6, RC3, R3, R4)** — `restoreUntracked` returns what it could not
restore instead of throwing or displacing:

```ts
/** What `checkout-index --all` (no --force) left unwritten. */
interface UntrackedRestore {
  readonly existing: ReadonlyArray<FilePath>;   // "<p> already exists, no checkout", in index order
  readonly blockedAt?: FilePath;                // "cannot create directory at '<dir>'": the restore stopped here
}

type RestoreVerdict =
  | { readonly kind: 'free' }
  | { readonly kind: 'exists' }
  | { readonly kind: 'blocked'; readonly at: FilePath };
```

- Per entry, in the U tree's flattened order (equal to index order for full paths): the whole-tree name gate first
  (unchanged, `:913-921`); then the verdict: the first leading component that `lstat` finds and that is not a
  directory (file, any symlink) → `blocked` (stop the loop, keep what was written); else `lstat` of the path itself
  finds anything → `exists` (record, continue); else write it.
- The write must not displace: a verdict of `free` guarantees no leading symlink or file remains on the path, so
  `unlinkSymlinkedLeadingComponent` finds nothing to unlink. A leading directory created by an earlier entry is a
  real directory. The writer, the attribute provider and the EOL handling (`untrackedWriter` `:896-910`) are unchanged.
- An escaped (lossy) name keeps today's rule: never on disk, so it reads as absent and `writeBlob` skips it
  (`write-converted-entry.ts:116`); the unit row at `stash.test.ts:1207` stays green.
- Leading-component probe: the leading-path scanner (`createLeadingPathScanner`,
  `primitives/internal/symlinked-leading-path.ts:64`) answers the symlink half (`hasSymlinkedLeadingPath`) with its
  per-directory memo. A leading regular file is not a symlink, and `pathIsOccupied` reads `NOT_A_DIRECTORY` as absent
  (`path-occupied.ts` `isAbsence`), so the file half needs its own walk: one `lstat` per distinct unseen prefix,
  memoised for the restore. Candidate to reuse before writing a new walk: `classifyBeneathObstruction`
  (`primitives/internal/occupant-clash.ts`). The implementer checks its rule against A.3 file-m / link-m / linked-dir-m /
  dangling-m and does not bend it (lesson 019: this is `checkout-index`'s rule, not `verify_uptodate`'s).
- `blockedAt` is the component git names (`m`), not the entry (`m/z`).
- Context block: `stash.ts:896-931`; `primitives/internal/symlinked-leading-path.ts:23-64`, `:190-252`;
  `primitives/internal/path-occupied.ts`; `primitives/internal/write-converted-entry.ts:105-144`;
  `primitives/internal/write-working-tree-file.ts:88-135`, `:308-354`; `primitives/internal/occupant-clash.ts`
  (`classifyBeneathObstruction`); unit rows `stash.test.ts:1040-1101`, `:1105-1400`.

**P5 — no merge when W equals its base (F8, RC5, R6)** — in `mergeStash`, before `applyMergeToWorktree`:

```ts
// git's non-recursive merge-ort entry: "Already up to date." when the merge base is theirs; no AUTO_MERGE.
if (trees.wTree === trees.bTree) return unchangedMerge(trees.currentIndex);
```

`unchangedMerge` builds the clean result the index step needs: `newIndexEntries` = the current index's entries, no
write. Then `unstageChangesUnlessNew(current, current)` restores nothing, and `reinstateIndex` still runs under
`--index` when `hasStagedChanges` says so: git's early return reports a clean merge, so its index step
follows. Not probed with a staged I ≠ B under W = B; the index step is left exactly as today for that case. The shared
primitive is not touched: whether cherry-pick, revert or rebase write `AUTO_MERGE` for a pick whose tree equals its
parent's was not probed, and stays as it is. The `ApplyMergeResult.clean` variant carries `mergedTree`/`indexTree`; the
stash only reads `result.newIndexEntries`, so `unchangedMerge` returns a narrower stash-local type, never a fake
`MaterializeTreeResult`.
Context block: `stash.ts:1079-1098`; `primitives/apply-merge-to-worktree.ts:106-124`, `:530-560`;
`primitives/materialize-tree.ts` (`MaterializeTreeResult`).

**P6 — `stash push -u` (F9, F10, RC6, RC7, R7, R8)**:

- `resetAfterPush` removes `untracked.paths` before `materializeTreeJudging` (git: `clean` before `reset --hard`).
  The removal happens under the same lock and touches only work-tree files; the reset's displacement then sees no
  untracked occupant. The `Stryker disable` comment on `:840` moves with the block, with its equivalence argument
  unchanged.
- DC4 = (a): `createStashCommits` writes the U commit whenever `opts.includeUntracked === true`, with the empty
  tree when nothing was found; `hasLocalChanges` is unchanged, so `-u` on a clean tree still returns
  `no-local-changes` (A.4 E0). The writer's subject and parentless shape are the existing ones (`writer.untracked`).
- Context block: `stash.ts:512-531` (`findLocalChanges`, `hasLocalChanges`), `:609-632`, `:736-757`, `:786-844`;
  `primitives/internal/write-working-tree-file.ts:350-354`; unit rows `stash.test.ts:661-760`.

**P7 — error data and the pending-operation gate (DC1, DC2, DC3, DC5; F11, F12)**:

- DC1 = (a): `stashUntrackedNotRestored(existing, blockedAt?)` in `domain/commands/error.ts` beside
  `stashApplyWouldOverwrite` (`:1385-1396`), a union member at `:451`, a message case in `domain/error.ts:739`
  (wording only, e.g. `could not restore untracked files from stash`).
- DC3 = (a): `STASH_APPLY_WOULD_OVERWRITE` gains `localChanges` and `untracked` beside `paths` (kept, the
  concatenation it is today, so no caller breaks).
- DC2 = (a): the refusal error and the `conflict` result carry an optional `untrackedNotRestored: UntrackedRestore`
  when P4 reports something.
- DC5 = (a): `assertNoPendingOperation` and its import go from `stashApply`. Before removing it, the implementer pins
  one real resolved cherry-pick and one stopped rebase (`rebase-merge/` present) against git 2.55, as ADR-1095
  required for push; a disagreement stops the part.
- Context block: `domain/commands/error.ts:440-460`, `:1380-1397`; `domain/error.ts:700-745`; `reports/api.json`
  (`StashApplyResult`, `StashPopResult`, the error-data union); `stash.ts:80-90` (imports), `:966-973`.

### Performance

| operation | today | after |
|---|---|---|
| `stash apply` / `pop` | one lock: read, merge, write | + one refresh scan (N `lstat`, a hash per stat-dirty entry) and one index write before the apply lock (P2; git pays the same) |
| `-u` apply | `pathIsOccupied` per U path before the merge, then one write per path | one verdict per U path (`lstat` of the path, plus one per unseen leading prefix), then the write; no pre-scan |
| apply with W = base | full 3-way merge, `AUTO_MERGE` write | none (P5) |
| `stash push -u` | reset, then removals | removals, then reset (same work) |

No new pass on the hot paths of merge, cherry-pick or rebase: P5 is stash-local and P3/P4 touch `stash.ts` only.
Bench: `npm run bench:ab` on `test/bench/stash.bench.ts` (apply pays P2's scan). Add one scenario only if the
existing apply row moves by more than its noise band.

### Adapter impact

None expected. The verdict uses `lstat` (no follow) through `ctx.fs`. The memory adapter's `lstat` reports a
symlink as a symlink and a path under a file as `NOT_A_DIRECTORY` (the codes `path-occupied.ts` already reads).
P4's unit rows run on the memory adapter and the interop rows on node, so the leading-file and leading-symlink
verdicts are pinned on both.

### Size-cap impact

P1 0 B; P2 ~30–50 B gzip (one call, one import); P3 ~60–120 B (restructure; the deleted pre-check pays back ~60 B);
P4 ~150–250 B (verdict, prefix memo, report); P5 ~40–70 B; P6 ~10–30 B; P7 ~120–180 B (constructor, union member,
message case, optional fields; the removed gate gives back ~20 B). Net about +400–600 B on the full library and the
browser entry, beyond the <100 B headroom. Caps are re-measured from a clean build (`rm -rf dist .wireit`) and raised
in the same change. `reports/api.json` changes only under DC1/DC2/DC3 = (a).

### Out of perimeter

- Hunch, not proven: `applyAutostash` (merge/rebase `--autostash`) reaches the apply without P2's refresh; git's
  `apply_autostash` runs `stash apply`, which would refresh. To prove: drift a clean bystander's stat between a
  `rebase --autostash` stop and its finish in both tools, compare `ls-files --debug`.
- `--index` conflicts in the index-side merge ("Index was not unstashed"): unchanged (ADR-211), rendered by
  the caller.

## Decision candidates

Settled by matching git, so not candidates: the untracked restore after the merge in every outcome (R2), the
`checkout-index` verdicts (R3), the refresh and its order (R5, ADR-1092's step reused), the W = base early return
(R6), the push's clean-before-reset order (R7), `pop` keeping the stash on any failure (ADR-212).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC1 | Error when a clean merge applied but an untracked path was not restored (F4–F6) | (a) new code `STASH_UNTRACKED_NOT_RESTORED { existing, blockedAt? }` (b) reuse `STASH_APPLY_WOULD_OVERWRITE { paths }`, thrown after the merge (c) `kind: 'applied'` result with an `untrackedNotRestored` field, no throw | (a) | git exits 1 after writing the merge (A.3 UP untr-u): a refusal code that means "nothing was written" (ADR-212) would mislead a caller under (b); (c) makes `pop` drop a stash git keeps. `blockedAt` vs `existing` lets a caller rebuild both git messages (ADR-249). Against (a): a new error code, an additive `api.json` change. |
| DC2 | What a merge refusal or a conflict reports when the untracked restore also failed (A.3 FU dirty-f-untr-u, conflict-f-untr-u) | (a) optional `untrackedNotRestored` on the refusal's data and on the `conflict` result (b) report the merge outcome only; the untracked failure is visible on disk only (c) the untracked error wins, the merge outcome is dropped | (a) | git prints both and exits 1; (a) keeps both in structured data. (b) loses data a caller needs to rebuild git's stderr; (c) hides conflicts the caller must resolve. Against (a): one optional field on a public result type. |
| DC3 | F12: `STASH_APPLY_WOULD_OVERWRITE` loses git's local-changes vs untracked split | (a) add `localChanges` and `untracked` beside `paths` (b) leave as is, IMPACT line | (a) | Same refusal path P3 restructures. git prints two different messages (A.2 DFa dirty-dx vs untr-du), and `findWouldOverwrite` already returns both lists. Against (a): additive `api.json` change; `paths` becomes redundant. |
| DC4 | F10: `stash push -u` with no untracked file writes git's empty-tree U commit | (a) fold into P6 (b) keep out, IMPACT line with A.4 E1/E2 | (a) | Proven on the same function the probes exercised, so the fold rule applies; the change is one condition. Against (a): a push behaviour, not an apply one; W gains a third parent for `-u` users, which a consumer reading parents sees. |
| DC5 | F11: drop `stash apply` / `pop`'s pending-operation gate | (a) drop it (git applies and keeps every marker) (b) keep it after P2's refresh, IMPACT line with A.5 | (a) | Proven on the function P2 edits; ADR-1095 removed the push twin for the same reason. The implementer first pins a real resolved cherry-pick and a stopped rebase (lesson 017). Against (a): removes a refusal shipped since #98, and a caller relying on it loses a guard. |

## Test strategy

Interop, git 2.55 (the suites assert the version as the #331/#332 suites do). Every row drifts `keep`'s stat after
the push (`touchedAt`) and compares, besides the outcome: `listing`, `indexState` (stage listing), `ls-files -v`,
`staleEntries` (lesson 018), `AUTO_MERGE` presence, `refs/stash` reflog count. Racy entries are avoided with
`settleIndex` after the build, not with sleeps (lesson 012).

- `test/integration/stash-apply-index-interop.test.ts` (P1): the DFa row in `ROWS`.
- New `test/integration/stash-apply-type-change-interop.test.ts` (`@proves surface: stash`,
  `interopSurface: stash`): `describe.each` over A.1's shapes × push mode {plain, `-u`, `--keep-index`} × command
  {`apply`, `apply --index`, `pop`, `pop --index`}, the stash pushed by each tool on its own twin (W/I/U trees asserted
  equal, P6); the A.2 post-push states for DFa and DF-u; the A.3 untracked restore rows (FU, UP × untr-u,
  emptydir-u, file-m, link-m, linked-dir-m, dangling-m, file-m-untr-u, conflict-f, dirty-f, conflict-f-untr-u). Refusal
  rows assert git's exit 1 and reconstruct its stderr from the error data: `<p> already exists, no checkout` per
  `existing`, `fatal: cannot create directory at '<blockedAt>': File exists`, then
  `error: could not restore untracked files from stash`; the merge refusal header by class (DC3). Row shape
  `{ shape, push, post, command, git: Outcome }`, with `Outcome` extended by `untrackedNotRestored`. Fixtures:
  `interop-helpers.ts` (`makePeerPair`, `initBothRepos`, `git`, `tryRunGitWithExit`, `lsStage`),
  `occupant-displacement-fixtures.ts` (`listing`, `indexState`, `staleEntries`, `settleIndex`, `touchedAt`,
  `fileAt`, `directoryHolding`, `emptyDirectoryAt`, `danglingLinkAt`, `linkAt`, `ignoring`).
- `test/integration/stash-interop.test.ts`: the dangling-symlink pop row (`:203-231`) gets the new code under DC1
  and keeps "stash kept on both"; the P7 pending rows (A.5 P1–P5 plus the real cherry-pick / stopped-rebase pins);
  the unmerged apply with a drifted bystander (A.5 U1: git `f: needs merge` + `error: could not write index`, both
  indexes rewritten, `keep` fresh in both).
- `test/integration/stash-push-reset-interop.test.ts`: A.4 S1–S4 (`-u` type swaps: saved, no throw, HEAD reflog
  `reset: moving to HEAD` written by `finishStashReset`) and E0–E2 (U commit shape: parent count, empty tree, subject).

Unit (memory adapter, Given/When/Then split, AAA, `sut`):

- `test/unit/application/commands/stash.test.ts`:
  - restore: one row per verdict: `exists` for a file, a directory, an empty directory, a dangling link (later
    entries still written, data `existing` in index order); `blocked` for a leading file, a link to a file, a link to
    a directory, a dangling link (earlier entries written, later not, the link kept, `blockedAt` = the component);
    a leading directory created by an earlier entry is not blocked;
  - order: the merge applies before the restore (DF-u: `d/x` deleted, file `d` restored); a merge refusal restores
    the untracked files and then throws (data asserted, DC3 fields); a conflict restores them and returns
    `conflict` (DC2 field when the restore failed);
  - P5: W = base writes no `AUTO_MERGE`, leaves the index entries, still reinstates under `restoreIndex`;
  - P2: `stashApply` refreshes a touched clean entry and rewrites the index on success and on a refusal;
    `STASH_NOT_FOUND` writes nothing;
  - P6: `-u` push of a dir→file and a file→dir swap saves, resets and removes; `-u` with tracked changes only
    writes a 3-parent W whose U tree is empty; `-u` with nothing writes nothing;
  - P7: apply under each marker applies and keeps the marker (DC5); the `it.each` at `:1040-1101` moves its
    untracked-present row to the DC1 code.
- `test/unit/application/commands/stash-unmerged-index.test.ts`: the apply refusal leaves the refreshed index (index
  bytes changed, bystander stat refreshed) and is `MERGE_HAS_CONFLICTS` even with `MERGE_HEAD` present.
- `test/unit/application/commands/internal/unstage-changes-unless-new.test.ts`: unchanged (both D/F arms already
  have rows; P1 adds the interop reach).
- `test/unit/domain/commands/error.test.ts`: the new constructor's data and the extended
  `STASH_APPLY_WOULD_OVERWRITE` data; `test/unit/domain/exhaustiveness.ts` gains the new code (DC1 = (a)).

Lesson 017: every refusal expectation above is git's, reproduced through the public command in Appendix A (A.2,
A.3, A.5). Lesson 015: P2, P3 and P5 change a step every `stash apply`, `pop` and autostash re-apply runs. The part
gate runs every interop file that reaches `applyStashCommit`: `grep -lE "stash\.(apply|pop)|stashApply|stashPop|autostash" test/integration`
(the `stash-*`, `merge-autostash`, `rebase-autostash`, `pull-rebase`, `merge-options`, `merge-abort` suites) and
reports the count. P6 also runs every `stash push` interop file.

Mutation: `stash.ts` (`stashApply`, `applyUnderLock`, the new `settleIndex` / `reportApply`, `restoreUntracked` and
its verdict, `mergeStash`, `resetAfterPush`, `createStashCommits`), the new error constructor and message case;
narrowed Stryker buckets per prefix (`.claude/workflow/mutation.md`).

## Out of scope

- The autostash refresh hunch (above): unproven.
- `stash push -- <pathspec>`, `stash -p`, `--index` reinstatement of a conflicted index side: not exposed (ADR-211).
- git's rendered output (`Already up to date.`, the status block `stash apply` prints, `Index was not unstashed.`):
  rendering, rebuilt by the caller (ADR-249).
- `git clean -d`'s removal of untracked empty directories during `push -u`: tsgit's `-u` stashes files only, and
  no row here probes an untracked empty directory at push time.

## Appendix A — pinned matrix (git 2.55.0 vs tsgit 23ff6c1e)

"keep stale" = tsgit leaves the drifted bystander's cached stat stale where git refreshed it (F7); it holds on every
row below where git found a stash, and is omitted from the delta column. `apply` and `pop` agree with each other on
every row except where noted; `--index` variants agree with their plain twin unless noted.

### A.1 — clean tree after the push (both tools' pushes; git-pushed reruns give the same apply results)

| shape | push | git (apply / pop, ± `--index`) | tsgit delta |
|---|---|---|---|
| DF `d/x` → file `d`, unstaged | plain | exit 0; plain push lost the untracked `d`; tree without `d`, ` D d/x` | — |
| DF | `-u` | exit 0; `d` restored as a file, ` D d/x`, `?? d`, `AUTO_MERGE` | push throws `DIRECTORY_NOT_EMPTY` after saving (F9); apply refuses `STASH_APPLY_WOULD_OVERWRITE ['d']`, tree keeps `d/x`, no `AUTO_MERGE` (F2) |
| DF | `--keep-index` | exit 0, as plain | — |
| DFa staged | plain, `-u`, `--keep-index` | exit 0; index `d` only (`A  d`, `D  d/x`); `--index` same; plain apply prints `error: 'd/x' appears as both a file and as a directory` on stderr and still exits 0 | — (F1: refused before #331) |
| DFn `n/s/y` → file `n` | plain / `--keep-index` | exit 0, as DF | — |
| DFn | `-u` | exit 0, as DF-u | push `DIRECTORY_NOT_EMPTY`; apply (of tsgit's saved stash) refuses `['n']` |
| DFna | all | exit 0, as DFa | — |
| FD `f` → `f/y`, unstaged | plain, `--keep-index` | W = base: stdout `Already up to date.`, no `AUTO_MERGE` | writes `AUTO_MERGE` (F8) |
| FD | `-u` | W = base; `Already up to date.`, then stderr `fatal: cannot create directory at 'f': File exists` / `error: could not restore untracked files from stash`, exit 1; `pop` keeps the stash | push throws `NOT_A_DIRECTORY` after saving (F9); apply throws raw `NOT_A_DIRECTORY` with an absolute path, writes `AUTO_MERGE` (F6, F8) |
| FDa | all | exit 0; plain apply prints `error: 'f' appears as both a file and as a directory` | — |
| DL `d/x` → link `d` (± staged) | all | push exit 1 `error: 'd/x' is beyond a symbolic link`; apply exit 1 `No stash entries found.`, index untouched | SAME (`PATHSPEC_BEYOND_SYMLINK`, `STASH_NOT_FOUND`) |
| LD link `l` → `l/y`, unstaged | plain, `--keep-index` | W = base, `Already up to date.` | writes `AUTO_MERGE` (F8) |
| LD | `-u` | exit 1, `fatal: cannot create directory at 'l': File exists`, link `l` kept; `pop` keeps the stash | push throws `NOT_A_DIRECTORY` after saving; apply replaces link `l` with directory `l/y` (` D l`, `?? l/y`), `applied`, `pop` drops (F5) |
| LDa | all | exit 0; plain apply prints `error: 'l' appears as both a file and as a directory` | — |
| LF, LFa, FL, FLa | all | exit 0 | — (U tree differs on `-u`: A.4 E) |

### A.2 — non-clean targets (pushed by git in both)

| shape × post | git | tsgit |
|---|---|---|
| DFa × dirty-dx | exit 1, `error: Your local changes to the following files would be overwritten by merge:` / `\td/x` / `Please commit your changes or stash them before you merge.` / `Aborting` (`--index` adds `Index was not unstashed.`); index rewritten (refresh) | `STASH_APPLY_WOULD_OVERWRITE ['d/x']`, index inode kept |
| DFa × untr-du | exit 1, `error: Updating the following directories would lose untracked files in them:` / `\td` / blank / `Aborting` | `STASH_APPLY_WOULD_OVERWRITE ['d']` (class lost, F12) |
| DFa × empty-de, ign-du, rm-dx | exit 0, `d` a file | same |
| DF-u × dirty-dx | exit 1, the local-changes block, then `d already exists, no checkout` / `error: could not restore untracked files from stash` | `STASH_APPLY_WOULD_OVERWRITE ['d']` |
| DF-u × untr-du | exit 1; merge applied (` D d/x`, `d/u` kept, `AUTO_MERGE`), then `d already exists, no checkout` / `error: could not restore untracked files from stash` | refuses before the merge; `d/x` still there (F4) |
| DF-u × empty-de, ign-du | exit 1, as untr-du (`d/e/` resp. `d/u` keeps `d`) | as untr-du |
| DF-u × rm-dx | exit 0; empty `d` removed, file `d` restored, `?? d` | refuses `['d']` (F2) |

### A.3 — untracked restore semantics (pushed by git in both)

| row | setup → `stash apply` | git | tsgit |
|---|---|---|---|
| FU dirty-f | edit `f` + untracked `u`, `-u`; `f` edited again | exit 1, local-changes block for `f`; `u` restored anyway | refuses `['f']`, `u` not restored (F3) |
| FU conflict-f | `f=c` committed after the push | exit 1, `UU f` markers, `u` restored, `AUTO_MERGE` | `conflict`, `u` not restored (F3) |
| FU untr-u | `u` recreated | exit 1; merge applied (` M f`, `AUTO_MERGE`), `u already exists, no checkout`, `error: could not restore untracked files from stash` | refuses `['u']` before the merge (F4) |
| FU conflict-f-untr-u | both | exit 1; conflict written, then `u already exists, no checkout` | refuses `['u']` before the merge |
| FU dirty-f-untr-u | both | exit 1; local-changes block, then `u already exists, no checkout` | refuses `['u']` |
| UP untr-u | untracked `a`, `m/z`, `u`, `z`; `u` recreated | exit 1; `a`, `m/z`, `z` restored, `u` kept as is | refuses `['u']`, nothing restored |
| UP emptydir-u | `u/` an empty directory | exit 1, `u already exists, no checkout`; others restored | refuses `['u']` |
| UP file-m | `m` a file | exit 1, `fatal: cannot create directory at 'm': File exists`; `a` restored, `m/z`, `u`, `z` not | raw `NOT_A_DIRECTORY` after writing `a` (F6) |
| UP link-m / linked-dir-m / dangling-m | `m` → `keep` / → `d` / → nowhere | exit 1, same fatal, link kept; only `a` restored | link replaced by directory `m/`, all four restored, `applied`; `pop` drops (F5) |
| UP file-m-untr-u | both | exit 1, the fatal only (stops before `u`); `a` restored | refuses `['u']` before the merge |

### A.4 — `stash push -u` (git 2.55.0 vs tsgit 23ff6c1e)

| row | setup → command | git | tsgit |
|---|---|---|---|
| trace | DF + edit `f` → `GIT_TRACE=1 stash push -q -u` | children in order: two `update-index` (temporary index), `clean --force --quiet -d :/`, `reset --hard -q --no-recurse-submodules` | — |
| trace | → `GIT_TRACE=1 stash apply -q` | children: `read-tree <u_tree>`, `checkout-index --all` (temporary index), after the in-process merge | — |
| S1 / S2 | DF / DFn → `stash push -u` | exit 0, tree back at HEAD | stash saved, then `DIRECTORY_NOT_EMPTY` from `removeWorkingTreeFile` (`stash.ts:842`); tree and stash trees equal to git's; the throw leaves `stashPush` before `finishStashReset` (`:581-583`, by code), so no HEAD reflog entry and no ORIG_HEAD |
| S3 / S4 | FD / LD → `stash push -u` | exit 0 | saved, then `NOT_A_DIRECTORY` (`f/y`, `l/y`) |
| E0 | clean tree → `stash push -u` | exit 0, `No local changes to save`, no `refs/stash` | same |
| E1 | edit `f` → `stash push -q -u` | W parents: base, I, U; U tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, U has no parent, subject `untracked files on main: <short> base` | W parents: base, I (F10) |
| E2 | staged edit → `stash push -q -u` | as E1 | as E1 tsgit |

### A.5 — refresh, unmerged index, pending operations

| row | setup → `stash apply` | git | tsgit |
|---|---|---|---|
| U1 | conflicted `merge side` on `f`, `keep` drifted | exit 1, stdout `f: needs merge`, stderr `error: could not write index`; index rewritten, `keep` fresh, stages kept | `OPERATION_IN_PROGRESS { operation: 'merge' }`, index inode kept, `keep` stale |
| P1 | resolved real merge (`f` added), stash edits `keep` | exit 0, `keep=e`, `MERGE_HEAD`, `MERGE_MODE`, `MERGE_MSG` kept | `OPERATION_IN_PROGRESS { operation: 'merge' }` |
| P2–P5 | planted `MERGE_HEAD` / `CHERRY_PICK_HEAD` / `REVERT_HEAD` / `REBASE_HEAD` (= HEAD) | exit 0, applied, marker kept | `OPERATION_IN_PROGRESS { operation: merge / cherry-pick / revert / rebase }` |

### A.6 — controls

| row | probe | result |
|---|---|---|
| O1 / O2 / O3 | DFa × plain × `apply`, tsgit `src/` from 7337e22e / 4899565f / fb6bc5b0 | `STASH_APPLY_WOULD_OVERWRITE ['d']` / same / `applied` |
| M1–M3 | `merge --no-ff side` where `side` replaced `d/x` with file `d`: clean / untracked `d/u` / dirty `d/x` | git exit 0 / 2 lose-untracked `d` / 2 local changes `d/x`; tsgit `merge` / `WORKING_TREE_DIRTY { untracked: ['d'] }` / `{ localChanges: ['d/x'] }`; trees equal |
| M4–M6 | `cherry-pick side`, same three | git exit 0 / 128 / 128; tsgit `picked` / same two refusals; trees equal |
