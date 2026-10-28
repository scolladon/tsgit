# Design — stash-apply-dir-file-replacement

> Brief: backlog 32.22 — `stash apply` refuses a stash that replaced a directory with a file
> (`STASH_APPLY_WOULD_OVERWRITE`, "1 local change(s) would be overwritten") on a clean tree where git 2.55 applies it.
> Pin the dir↔file / dir↔symlink matrix for `stash apply`, `apply --index`, `pop`, `pop --index` against git 2.55,
> fix the refusal git-faithfully, and fold every in-perimeter gap the matrix proves on the same stash path.
> Status: draft → self-reviewed ×3 → revised against ADRs 1101–1102 → self-reviewed ×3

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
- Revision (HEAD 0589e7c5, P1–P8 shipped on the branch): the review proved two more gaps on the same functions,
  folded by ADR-1101 (`--index` index-side conflict) and ADR-1102 (`push -u` empty directories). Today
  `applyUnderLock` (`stash.ts:1120-1134`) merges W first and judges the index side last, inside
  `settleCleanIndex` (`:1162-1177`) → `reinstateIndex` (`:1014-1037`), whose `if (merged.kind !== 'clean') return;`
  (`:1030`) skips the reinstatement silently. On the push side `listUntracked` (`:543-555`) keeps the walker's
  files only, and the walker (`primitives/walk-working-tree.ts:179`) never yields a directory except a nested
  repository under `isNestedRepository`, so `cleanStashedUntracked` (`:837-851`) never learns of an empty one.
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
- R12 (ADR-1101) `stash apply` / `pop` with `restoreIndex`, when the stashed index tree differs from both its base
  and the current index (git's `has_index`), judge the index side before the work-tree merge, as git's
  `do_apply_stash` runs `diff-tree --binary <w>^2^..<w>^2 | apply --cached` before `merge-ort`'s non-recursive entry point. A
  side that does not apply refuses `STASH_INDEX_CONFLICT { paths }` (index order). Nothing is written beyond the
  opening refresh (R5): no work-tree change, no `AUTO_MERGE`, no untracked file restored, `refs/stash` kept, `pop`
  drops nothing (A.7 H2, delete, add-add rows). A side that
  applies is reinstated as today, from the tree the judge produced, without a second index-side merge (A.7 non-overlap,
  offset-mid). `iTree` equal to `bTree` or `cTree` runs no judge (A.7 i-is-b, i-is-c). The shapes where git's patch
  judge and a three-way merge disagree (A.7 adjacent, same-change, non-overlap × `--keep-index`, add-same, offset-top) follow DC6;
  the current-index-differs-from-HEAD shapes (A.7 staged-non-overlap, staged-other, w-is-b-staged) follow DC7.
- R13 (ADR-1102) `stash push --include-untracked` removes what git's `clean --force --quiet -d :/` removes before
  its reset: the stashed untracked files, every untracked directory with no file under it (`readdir` empty, or
  holding only such directories), and every parent those removals leave empty, deepest first. Kept: a tracked
  directory (any ancestor of an index path), a directory still holding an ignored file or an ignored directory,
  an ignored directory and everything under it, a path the index tracks (an unpopulated gitlink's empty
  directory), and the work-tree root. Empty directories never enter the U tree and never count as a local change
  (A.8 only-empty: `No local changes to save`, directory kept). `status` is unchanged (A.8: `status --porcelain
  -uall` equal before every push, never listing an empty directory). Same with `--keep-index` (A.8, every row).

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
| F13 | `--index` with an index side that does not apply: git refuses `conflicts in index. Try without --index.` before any write and keeps the stash; tsgit merges W, skips the reinstatement silently, returns `applied` (or the W merge's `conflict`), and `pop` drops the stash on `applied` | A.7 H2, delete, add-add | in (R12, ADR-1101) |
| F14 | git's patch judge (`apply --cached`: exact context, no three-way fallback, a creation needs an absent path) refuses where tsgit's three-way index-side merge is clean | A.7 adjacent, same-change, non-overlap × `--keep-index`, add-same, offset-top | DC6 |
| F15 | `--index` with a current index that differs from HEAD: git's `reset_head` leaves the index at HEAD, then `merge-ort`'s non-recursive entry point's `unclean()` refuses "local changes would be overwritten" for every path where HEAD and C differ; tsgit applies | A.7 staged-non-overlap, staged-other; i-is-b-staged (no `has_index`: both apply) | DC7 |
| F16 | `stash push -u` leaves untracked directories holding no file, which git's `clean -d` removes | A.8 empty-dir, nest, file-and-empty, reviewer, tracked-parent, tracked-sibling, mixed, two-empty, change-only, type-empty × `--keep-index` | in (R13, ADR-1102) |

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

Revision root causes (HEAD 0589e7c5):

- RC10 (F13) — the index side is judged after the work-tree merge (`settleCleanIndex` `stash.ts:1162-1177`, only
  on a clean W merge) and its conflict is swallowed (`reinstateIndex` `:1030`). git judges it first: in
  `do_apply_stash`, after `refresh_and_write_cache` and `write_index_as_tree(c_tree)`, the `has_index` branch runs
  `diff_tree_binary` + `apply_cached` and returns `error: conflicts in index. Try without --index.` before
  `merge-ort`'s non-recursive entry point and before `restore_untracked` (A.7 H2 × `-u`: `u` not restored).
- RC11 (F14) — tsgit's judge is `mergeTreesToTree` (a three-way merge); git's is `apply --cached` of the B→I
  patch (3 lines of context, exact context match, offsets allowed, a hunk at line 1 anchored at the file start, a
  creation refused when the path is in the index, a deletion needing the whole preimage).
- RC12 (F15) — after `apply_cached`, git's `reset_head` (`reset --quiet --refresh`) resets the index to HEAD, and
  `merge-ort`'s non-recursive entry point's `unclean()` compares that index with `c_tree`: any path where HEAD ≠ C refuses. tsgit
  never resets to HEAD.
- RC13 (F16) — `listUntracked` (`stash.ts:543-555`) sees files only; `walkWorkingTree` descends into an empty
  directory and yields nothing, so `cleanStashedUntracked` prunes only the parents of the removed files
  (`pruneEmptiedDirectories(…, untracked.paths, …)`).

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

Revision parts (ADRs 1101–1102), on top of P1–P8 as shipped at 0589e7c5. P9 and P10 are independent of each other.
P11 exists only if DC6 = (a), P12 only if DC7 = (a); both build on P9. Line numbers below are HEAD 0589e7c5's.

**P9 — the index side is judged before the work-tree merge (F13, RC10, R12, ADR-1101)** — git's order in
`do_apply_stash`: refresh → `c_tree` → `has_index` judge (`apply_cached`, refusal returns here) → merge →
reinstatement (`reset_tree(index_tree)`) → `restore_untracked`. The judge moves into `applyUnderLock`, after
`rejectUnmergedIndex` and `cTree`, before `mergeStash`; its clean tree rides to the reinstatement, so the index-side
merge runs once:

```ts
/** git's `has_index` branch: the stashed index as a tree on top of the current one, judged before any write. */
const judgeIndexSide = async (ctx: Context, app: StashApplication, cTree: ObjectId): Promise<ObjectId | undefined> => {
  if (app.input.restoreIndex !== true) return undefined;
  const iTree = await commitTreeOf(ctx, app.parsed.indexParent);
  if (!hasStagedChanges({ bTree: app.bTree, cTree, iTree })) return undefined;
  const merged = await mergeTreesToTree(ctx, { baseTree: app.bTree, oursTree: cTree, theirsTree: iTree, labels: STASH_LABELS });
  if (merged.kind !== 'clean') throw stashIndexConflict(conflictedPathsOf(merged.conflicts));
  return merged.mergedTree;
};

// applyUnderLock
const cTree = await synthesizeTreeFromIndex(ctx, currentIndex.entries);
const stagedTree = await judgeIndexSide(ctx, app, cTree);        // throws before any write; the lock is released unused
const merged = await mergeStash(ctx, { bTree, cTree, wTree: parsed.wTree, currentIndex });
const settled = await settleIndex(ctx, lock, merged, { ...app, cTree, currentIndex, stagedTree });
```

- Inside the lock, not before it: `cTree` comes from the index read under the lock, exactly as git builds `c_tree`
  after its refresh. A throw inside `applyStashCommit`'s `try` releases the lock without a commit; the refresh (P2)
  is already on disk, matching git's rewritten index on every A.7 refusal row.
- `SettleInputs` gains `stagedTree: ObjectId | undefined`. `settleCleanIndex` reinstates when it is defined, else runs
  `unstageChangesUnlessNew` as today; it no longer reads `parsed.indexParent` (the judge did). `reinstateIndex`
  loses its merge and its silent `return`: `buildIndexFromTree({ targetTree: stagedTree, currentIndex: writtenIndex })`
  → `lock.commit(entries, 'replace')`. The conflict and would-overwrite branches of `settleIndex` are unchanged
  (git's "Index was not unstashed." is rendering).
- `conflictedPathsOf`: each conflict's `path` through `viewOfEscaped` (`domain/git-index/index-path-key.ts:42`, as
  `toConflictList` does), de-duplicated, sorted with `comparePaths` (`domain/diff/path-compare.ts`), so `paths` is in
  index order whatever order `mergeEscapedTrees` reports.
- `pop`: `stashPop` reaches `stashDrop` only after `stashApply` returns, so the throw keeps the stash. `applyAutostash`
  passes `{}`: no judge.
- `mergeTreesToTree` (`primitives/apply-merge-to-worktree.ts:602-632`): its only caller now refuses on `conflict`, so
  the `Stryker disable` on `if (!merged.cleanMerge)` (`:629-630`) goes (the refusal test kills both mutants) and its doc
  comment says the caller refuses instead of "leaves the index untouched".
- Error (surface gates, `.claude/workflow/surface-gates.md`): union member `{ code: 'STASH_INDEX_CONFLICT'; paths:
  ReadonlyArray<FilePath> }` after `STASH_UNTRACKED_NOT_RESTORED` (`domain/commands/error.ts:458-464`); constructor
  `stashIndexConflict(paths)` beside `stashUntrackedNotRestored` (`:1432-1440`), one line added to the comment block
  at `:1410-1415`; message case in `domain/error.ts:741` (wording only, e.g. `` `cannot apply stash: conflicts in
  index (${data.paths.length} path(s)); try without restoreIndex` ``); `test/unit/domain/exhaustiveness.ts:239`;
  `reports/api.json` regenerated with `npm run docs:json` in the same part (prepush gate).
- ADR-211's carve-out now reads as ADR-1101 states; the doc comment on `reinstateIndex` and `hasStagedChanges` keep
  git's names.
- Context block: `stash.ts:1003-1037` (`hasStagedChanges`, `reinstateIndex` — current signature
  `reinstateIndex(ctx, lock, { bTree, cTree, iTree, writtenIndex })`), `:1081-1177` (`applyStashCommit`,
  `StashApplication`, `applyUnderLock`, `SettledApply`, `SettleInputs`, `settleIndex`, `settleCleanIndex`),
  `:1231-1242` (`stashPop`); `primitives/apply-merge-to-worktree.ts:592-632` (`MergeTreesResult`,
  `mergeTreesToTree`); `domain/merge/merge-types.ts:17-40` (`MergeConflict.path` is an escaped `FilePath`);
  `commands/internal/replay-sequence.ts:114-117` (`toConflictList`, the `viewOfEscaped` precedent);
  `domain/commands/error.ts:446-464`, `:598-615`, `:1408-1440`; `domain/error.ts:734-746`;
  `test/unit/domain/exhaustiveness.ts:237-239`; `test/unit/domain/commands/error.test.ts:200-266`; unit
  `stash.test.ts:1092-1180` (the `restoreIndex` rows that must stay green), `refusalDataOf` (`:134`), `setupRepo`
  (`:87`), `commitFile` (`:66`), `write` (`:60`); interop `stash-apply-index-interop.test.ts` (`seed` `:41`, `put` `:36`,
  the `git` helper, `zeroStatPaths` `:80`).

**P10 — `stash push -u` removes the untracked directories git's `clean -d` removes (F16, RC13, R13, ADR-1102)**:

- The walker reports an entered directory whose `readdir` is empty. "Entered" already means: not ignored
  (`ignore(path, true)` is asked first), not an embedded repository, below the root. In `walkWorkingTree`'s loop
  (`walk-working-tree.ts:194-208`), a `push` step whose `frame.entries.length === 0` calls the report hook when the
  caller asked for it (DC8 decides where that hook lives; the public `walkWorkingTree` output is unchanged under
  every DC8 option). The report is not counted against `maxEntries` (an empty directory is never a tree entry).
  Literal emptiness is enough: a directory holding only empty directories is reported through its leaves and
  removed by the climb; one holding an ignored file or an ignored directory is not empty (A.8 ignored-file, ignored-deep, ignored-inner,
  mixed).
- `listUntracked` (`stash.ts:543-555`) returns `{ files, emptyDirectories }`; an empty directory whose path the
  index tracks is dropped by the same `tracked.has(keyOfPath(path))` filter the files use (A.8 gitlink-dir: an
  unpopulated gitlink's directory stays, as in git). `LocalChanges` (`:496-503`) gains
  `untrackedEmptyDirectories: ReadonlyArray<FilePath>`; `hasLocalChanges` (`:538-541`) and `createStashCommits` are
  unchanged (A.8 only-empty; U trees equal on every A.8 row).
- `ResetInputs` (`:796-802`) gains `emptyDirectories`; `stashAndReset` (`:619-650`) passes
  `found.untrackedEmptyDirectories`. `cleanStashedUntracked` (`:837-851`) removes the files, then prunes from the
  files' parents and from the empty directories themselves in one deepest-first pass:

```ts
for (const path of untracked.paths) await removeWorkingTreeFile(ctx, path);
await pruneDirectoriesFrom(
  ctx,
  workDir,
  [...untracked.paths.map(parentDirectory), ...emptyDirectories],   // git's clean -d: files, then empty dirs, bottom-up
  survivingDirectoriesOf(currentIndex.entries.map((entry) => entry.path)),
);
```

- `prune-emptied-directories.ts`: new export `pruneDirectoriesFrom(ctx, workdir, startDirectories, surviving)`
  schedules each start directory itself; `pruneEmptiedDirectories` becomes `pruneDirectoriesFrom` over the removed
  paths' parents, so its callers (`rm.ts:192`, `apply-changeset.ts:571`, `apply-merge-to-worktree.ts:233`, stash)
  keep their behaviour and its unit suite stays green. `parentDirectory` is exported for the stash or the mapping
  stays inside the module (implementer's call, no behaviour difference).
- A tracked ancestor is in `surviving` and ends the climb (A.8 tracked-parent, tracked-sibling); a directory a race
  filled refuses `rmdir` and stays, as git's `rmdir` would.
- `status` (`status.ts:485`), `add` (`add.ts:1303`, `:1742`) and `fs-workdir-enumerator.ts:63` do not ask for the
  report; their output is unchanged.
- The `Stryker disable` on `resetAfterPush`'s `if (opts.includeUntracked === true)` (`:860-861`) keeps its argument:
  without `-u`, `listUntracked` is not called and both lists are empty.
- Context block: `stash.ts:484-555` (`UntrackedProjection`, `UntrackedFile`, `LocalChanges`, `findLocalChanges`,
  `hasLocalChanges`, `listUntracked`), `:619-650` (`stashAndReset`), `:796-802` (`ResetInputs`), `:837-878`
  (`cleanStashedUntracked`, `resetAfterPush`); `primitives/walk-working-tree.ts` (`WalkConfig` `:17-28`,
  `enterSubdirectory` `:67-86`, `stepEntry` `:99-120`, `walkWorkingTree` `:179-209`); `primitives/types.ts:253-290`
  (`WalkWorkingTreeEntry`, `WalkWorkingTreeOptions`, the `isNestedRepository` precedent);
  `primitives/internal/prune-emptied-directories.ts` (whole file, 93 lines); `primitives/index.ts:120` and
  `repository.ts:1087` (the public exposure DC8 weighs); unit `walk-working-tree.test.ts` (the `describe` tree from
  `:46`), `prune-emptied-directories.test.ts`, `stash.test.ts` P6 rows (`-u` push), `stash-clean-order.test.ts`;
  interop `stash-push-reset-interop.test.ts:582-760` (`SWAP_SEED`, `SWAPS`, `arrange`, `expectSameIndexOutcome`,
  `treeAt`, the emptied-directory row `:717-745`); fixtures `emptyDirectoryAt`, `fileWith`, `ignoring`, `listing`
  (lists directories with a trailing `/`, so an empty one shows) in `occupant-displacement-fixtures.ts`.

**P11 — git's patch judge (F14, RC11; only if DC6 = (a))** — `judgeIndexSide` keeps its signature and swaps
`mergeTreesToTree` for git's `apply --cached` rule over the B→I diff: per changed path, the hunks `diff-tree`
writes (Myers, 3 lines of context; plumbing reads no `diff.algorithm` / `diff.context`) applied to C's blob with
`apply.c`'s matching: exact context lines, an offset search outwards from the hunk's position, a hunk starting at
line 1 anchored at the file start, a hunk with no trailing context anchored at the end, hunks in order with the
running offset; a creation refuses when C holds the path (A.7 add-add, add-same: `already exists in index`); a
deletion and a binary or mode-only change need C's entry to equal B's. Failing paths are collected (git checks the
whole list before refusing). The result tree is C with the patched blobs, git's `index_tree`. A domain module
(`domain/diff/apply-hunks.ts` or a sibling of `patch-serializer.ts`) over `computeHunks`; a `*.properties.test.ts`
sibling (a hunk set applies to its own preimage and yields the postimage; offsets shift nothing else).
Context block: `domain/diff/patch-serializer.ts` (`computeHunks`, `OutputHunk`, `BodyLine`), `domain/diff/line-diff.ts`,
`domain/diff/xdiff/*`, `.claude/workflow/property-testing.md`.

**P12 — git's `reset_head` before the work-tree merge (F15, RC12; only if DC7 = (a))** — when the judge returns a
tree and C ≠ HEAD's tree, git leaves the index at HEAD (stat refreshed) and refuses with the local-changes class
listing every path where HEAD and C differ, then restores the untracked tree as after any merge refusal (A.7
staged-non-overlap × `-u`: `u` restored; the work tree is not touched, so a staged new file reads `?? h` afterwards, A.7
staged-other). In `applyUnderLock`, after the judge returned a tree: read HEAD's tree (`resolveHeadCommit` +
`commitTreeOf`, `stash.ts:169-185`; the stash base `bTree` is not HEAD once HEAD moved); if it differs from `cTree`,
commit a mixed reset (git's `reset --quiet --refresh`: `buildIndexFromTree({ targetTree: headTree, currentIndex })`,
which keeps the stat of an entry whose id and mode agree; the work tree is not written) and settle a
`would-overwrite` with `localChanges` = the paths where HEAD and C differ (`pathsDifferingBetween`,
`stash.ts:805-825`, mapped to `FilePath` and sorted), `untracked: []`. git's `unclean()` runs before its W = B early
return (A.7 w-is-b-staged: refusal, no `Already up to date.`), so P5's early return sits after this check. Context
block: `stash.ts:169-198`, `:805-825`, `:1014-1037`, `:1120-1160`; `primitives/build-index-from-tree.ts`
(`buildIndexFromTree`, as `reinstateIndex` calls it).

### Performance

| operation | today | after |
|---|---|---|
| `stash apply` / `pop` | one lock: read, merge, write | + one refresh scan (N `lstat`, a hash per stat-dirty entry) and one index write before the apply lock (P2; git pays the same) |
| `-u` apply | `pathIsOccupied` per U path before the merge, then one write per path | one verdict per U path (`lstat` of the path, plus one per unseen leading prefix), then the write; no pre-scan |
| apply with W = base | full 3-way merge, `AUTO_MERGE` write | none (P5) |
| `stash push -u` | reset, then removals | removals, then reset (same work) |
| `apply --index` with a staged state (P9) | W merge, then the index-side merge (clean only) | the index-side merge before the W merge, run once; a refusal skips the W merge and the restore |
| `apply` without `restoreIndex` (P9) | `commitTreeOf(indexParent)` read on every clean apply | not read (the judge returns before it) |
| `stash push -u` (P10) | the walk's files; prune from their parents | + one array push per empty directory the walk already `readdir`s; one `rmdir` per reported directory and per emptied parent (git's `clean -d` pays the same) |
| `status`, `add`, enumerator walks (P10) | — | unchanged: the report hook is unset, one `undefined` check per entered directory |
| P11 (DC6 = (a)) | three-way merge per changed path | Myers hunks per changed path + a context scan per hunk; same order of cost, `apply --index` only |
| P12 (DC7 = (a)) | — | one HEAD tree read per `apply --index` that reinstates |

No new pass on the hot paths of merge, cherry-pick or rebase: P5 is stash-local and P3/P4 touch `stash.ts` only.
P9–P12 touch `stash.ts`, the walker's per-directory step (one branch) and the prune module (one indirection).
Bench: `npm run bench:ab` on `test/bench/stash.bench.ts` (apply pays P2's scan). Add one scenario only if the
existing apply row moves by more than its noise band.

### Adapter impact

None expected. The verdict uses `lstat` (no follow) through `ctx.fs`. The memory adapter's `lstat` reports a
symlink as a symlink and a path under a file as `NOT_A_DIRECTORY` (the codes `path-occupied.ts` already reads).
P4's unit rows run on the memory adapter and the interop rows on node, so the leading-file and leading-symlink
verdicts are pinned on both. P10 needs `readdir` of an empty directory to return `[]` and an empty directory to be
removable: the memory adapter keeps explicit directories (`memory-file-system.ts:272`, `mkdir`), and the prune
module already handles an adapter without `rmdir` (`removeIfEmptyDirectory`).

### Size-cap impact

P1 0 B; P2 ~30–50 B gzip (one call, one import); P3 ~60–120 B (restructure; the deleted pre-check pays back ~60 B);
P4 ~150–250 B (verdict, prefix memo, report); P5 ~40–70 B; P6 ~10–30 B; P7 ~120–180 B (constructor, union member,
message case, optional fields; the removed gate gives back ~20 B). Net about +400–600 B on the full library and the
browser entry, beyond the <100 B headroom. Caps are re-measured from a clean build (`rm -rf dist .wireit`) and raised
in the same change. `reports/api.json` changes only under DC1/DC2/DC3 = (a).

| part | estimated gzip | what |
|---|---|---|
| P9 | +90–150 B | `judgeIndexSide`, `conflictedPathsOf`, constructor, union member, message case; `reinstateIndex` loses its merge (−30 B) |
| P10 | +60–110 B | walker report branch + config field, `listUntracked` split, threading, `pruneDirectoriesFrom` |
| P11 (DC6 = (a)) | +1.2–2.0 kB | fragment matcher, offset search, anchoring, creation/deletion/binary rules, result tree |
| P12 (DC7 = (a)) | +60–100 B | HEAD tree read, mixed reset, refusal |

The session raises the caps once, after review, from a clean build (`rm -rf dist .wireit`). `reports/api.json`
changes in P9 (new code) and in P10 only under DC8 = (a).

### Out of perimeter

- Hunch, not proven: `applyAutostash` (merge/rebase `--autostash`) reaches the apply without P2's refresh; git's
  `apply_autostash` runs `stash apply`, which would refresh. To prove: drift a clean bystander's stat between a
  `rebase --autostash` stop and its finish in both tools, compare `ls-files --debug`.

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

Revision (ADRs 1101–1102). Settled by ADR-1101 or by matching git, so not candidates: the code name and its single
`paths` field (ADR-1101); where the judge runs (under the lock, after `cTree`, before the W merge: git's
`do_apply_stash` order, A.7 H2 writes nothing); a refused index side restores no untracked file (A.7 H2 × `-u`); the
clean tree carried to the reinstatement (one merge, same result as today's second merge); the removal set, order and
kept directories of P10 (ADR-1102, A.8); the tracked-path filter on empty directories (A.8 gitlink-dir); empty directories
never counting as a local change (A.8 only-empty).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC6 | F14: what decides "the index side applies" — ADR-1101 asks the design to record the shapes where git's patch judge and a three-way merge disagree; it does not ratify a divergence | (a) P11: port git's `apply --cached` rule (B→I hunks, exact context, offsets, anchoring, creation/deletion/binary rules) (b) keep `mergeTreesToTree` and write an ADR recording A.7 adjacent, same-change, non-overlap × `--keep-index`, add-same and offset-top as accepted divergence (tsgit reinstates, git refuses) (c) the three-way merge plus "refuse when C's entry for a staged path differs from B's" | (a) | ADR-226: faithful refusal conditions unless an ADR diverges. The divergence is not a corner: `stash push --keep-index`, commit the kept index, then `stash pop --index` (git-stash's "Testing partial commits" example, popped with `--index`) is refused by git (A.7 non-overlap × `--keep-index`) while (b) pops and drops. (c) is wrong both ways: it refuses A.7 non-overlap and offset-mid, which git applies. Against (a): +1.2–2.0 kB gzip and a new domain module with its own property suite; the result tree becomes git's `index_tree` (C patched), not a merge. |
| DC7 | F15: `--index` that reinstates on a current index differing from HEAD — git resets the index to HEAD, then refuses "local changes would be overwritten" for every path where HEAD and C differ (A.7 staged-non-overlap, staged-other, w-is-b-staged); the user's staging is left unstaged, the work tree untouched | (a) P12: replicate (mixed reset to HEAD, `STASH_APPLY_WOULD_OVERWRITE { localChanges }`, untracked restored, stash kept) (b) out of this change: IMPACT line with the A.7 rows, backlog only on the user's word (c) refuse as git does but keep the current index (ADR recording the divergence on the index state) | (a) | Same function and same `--index` step P9 rewrites, so the fold rule applies; ADR-226 binds refusal conditions and on-disk index state, and every file's content survives in the work tree (only the staging is lost, as in git). Against (a): tsgit reproduces a git behaviour that discards a user's staging; not covered by ADR-1101, so it needs the user's word either way. (c) protects the staging at the price of a recorded divergence. |
| DC8 | Where the walker's empty-directory report lives (ADR-1102: "exposes … to callers that ask for them") | (a) public: a new `WalkWorkingTreeOptions` field (e.g. `onEmptyDirectory?: (directory: FilePath) => void`), additive `api.json`, reachable through `repo.walkWorkingTree` (b) internal: the same hook on a non-barrelled entry point in `walk-working-tree.ts` that `walkWorkingTree` wraps with the hook unset; public surface unchanged (c) a second, stash-local walk listing empty directories | (b) | The stash is the only caller; YAGNI keeps the public surface to what a consumer needs, and the hook adds no per-entry cost to `status`. (a) follows the `isNestedRepository` precedent but publishes an option no consumer asked for; it can be promoted later without a break. (c) duplicates the walker's ignore, `.git`, embedded-repository and depth rules and pays a second full-tree `readdir`. Against (b): one more internal export of the walker module. |

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

### Revision tests (P9–P12)

Interop, git 2.55, same isolation and comparisons as above; every row drifts `keep` after the push and records the
index inode before the command (lesson 018: A.7 refusals rewrite the index in both tools, through the refresh).

- P9 — `test/integration/stash-apply-index-interop.test.ts`, a new `describe` "stash apply index-side judge interop"
  over `INDEX_SIDE_ROWS` (`{ shape, push, command, git: 'refuses' | 'applies' }`). Seed: `keep=k`, `f` = ten lines
  `l1`…`l10`, `g=g0` (the file's own `seed`/`put` style, then `settleIndex`). Each tool pushes on its own twin; W/I/U
  trees asserted equal. Rows, exactly the A.7 combinations: H2 × push {plain, `-u` with untracked `u`,
  `--keep-index`} × {`apply --index`, `pop --index`}, delete and add-add × plain × both commands, delete × `-u`,
  add-add × {`-u`, `--keep-index`} × `apply --index` → refuses (delete × `--keep-index` is no row: the kept index
  already holds the deletion, so I = C); non-overlap × {plain, `-u`} × both commands, offset-mid × plain × both
  commands and × `-u` × `apply --index`, i-is-b and i-is-c × {plain × both commands, `-u`, `--keep-index` ×
  `apply --index`}, w-is-b, and H2 × plain `stash apply` → applies. A refusal row asserts: git exit 1 and stderr ending
  `error: conflicts in index. Try without --index.`; tsgit `STASH_INDEX_CONFLICT` with `paths` = the paths of git's
  `error: <p>: patch does not apply` / `error: <p>: already exists in index` lines; `listing`, `indexState`,
  `staleEntries` equal; no `AUTO_MERGE` in either; `refs/stash` count 1 in both; index rewritten in both; `u` absent
  in both on `-u`. An applies row asserts the same comparisons plus `status --porcelain -uall` equal. The DC6 and DC7
  rows (adjacent, same-change, non-overlap × `--keep-index`, add-same, offset-top; staged-non-overlap, staged-other, w-is-b-staged) join the
  table with git's outcome once P11 / P12 land; under DC6 = (b) or DC7 = (b)/(c) they are pinned as the recorded
  divergence (tsgit's outcome asserted, git's beside it in the row), never left out.
- P10 — `test/integration/stash-push-reset-interop.test.ts`, inside "stash push include-untracked interop", a
  `describe.each` over `EMPTY_DIRECTORY_SHAPES` × push {`-u`, `-u --keep-index` with `keep` staged}: the A.8 rows
  (empty-dir, nest, file-and-empty, reviewer, tracked-parent as `d/b` under `SWAP_SEED`'s tracked `d/x`, tracked-sibling, ignored-file, ignored-dir,
  under-ignored, link-to-dir, ignored-deep, ignored-inner, mixed, two-empty, change-only, type-empty, gitlink-dir) built with `emptyDirectoryAt`,
  `fileWith`, `linkAt`, `gitlink`, and an `info/exclude` holding `*.cache`, `build/`, `out/` (`ignoring` writes one
  pattern; the row writes the three). Asserts: `status --porcelain -uall` equal before the push; `listing` equal
  after (it shows empty directories); trees of `stash@{0}`, `^2`, `^3` equal; `expectSameIndexOutcome()`.
  only-empty sits beside the clean-tree row (`:747`): both `no-local-changes`, `emptydir/` kept, no `refs/stash`.

Unit (memory adapter, Given/When/Then split, AAA, `sut`, data asserted through `refusalDataOf`):

- `stash.test.ts`, P9: H2 shape → `STASH_INDEX_CONFLICT { paths: ['f'] }`, `g` unchanged, no `AUTO_MERGE`, the index
  holds the committed `f`; `pop` with `restoreIndex` → same data, `stashList` still one entry; with `-u` → `u` not
  restored; delete (the W merge would conflict too) → the index-side code wins; two conflicting paths → `paths` in index
  order; the H2 shape without `restoreIndex` → applies (guards the `restoreIndex !== true` return); i-is-c and i-is-b
  under `restoreIndex` → no refusal (each `hasStagedChanges` arm alone); a clean index side → the existing
  reinstatement rows (`:1092-1180`) stay green. `test/unit/domain/commands/error.test.ts`: `stashIndexConflict` data
  and message; `exhaustiveness.ts` gains the case.
- `walk-working-tree.test.ts` (or the internal entry point's suite under DC8 = (b)), P10: an empty directory is
  reported, not yielded; an ignored empty directory is not reported; an empty directory inside an embedded
  repository is not reported; a directory holding only an empty directory reports the leaf only; an empty work tree
  reports nothing (the root is never reported); the report does not count against `maxEntries`; without the hook the
  output equals today's.
- `prune-emptied-directories.test.ts`, P10: `pruneDirectoriesFrom` removes a start directory itself, climbs, stops
  at a surviving one, keeps a non-empty one; the `pruneEmptiedDirectories` rows stay unchanged.
- `stash.test.ts`, P10: a `-u` push removes an empty directory, a nested empty chain, `d/e/` beside `d/u`; keeps a
  directory holding an ignored file, an ignored directory, a tracked path's empty directory; `-u` with only an empty
  directory → `no-local-changes`, directory kept; a push without `-u` keeps every empty directory.
- P11 (DC6 = (a)): the fragment matcher's example suite (exact context, offset, start/end anchoring, creation,
  deletion, binary, mode) and a `*.properties.test.ts` sibling (`.claude/workflow/property-testing.md`). P12
  (DC7 = (a)): the staged-other shape → `STASH_APPLY_WOULD_OVERWRITE { localChanges: ['h'], untracked: [] }`, the index
  at HEAD with `h` unstaged, the work tree unchanged, untracked files restored.

Lesson 017: every refusal above is git's own (A.7 H2, delete, add-add; A.7 STAGED* for P12), reached through
`repo.stash.apply` / `pop`. Lesson 015: P9 changes a step of every `apply --index` / `pop --index`; its gate runs the
`applyStashCommit` interop family listed above and reports the count. P10 changes every `stash push -u` and touches
the walker and the prune module shared by `status`, `add`, `rm`, checkout and merge: its gate runs every `stash push`
interop file plus every interop file that reaches `walkWorkingTree` or `pruneEmptiedDirectories` (`status`, `add`,
`rm`, `checkout`, `merge`, `cherry-pick` suites; count reported). Lesson 018: every A.7 / A.8 row drifts `keep` and
compares the index inode and `staleEntries`.

Mutation (narrowed buckets per prefix): P9 — `judgeIndexSide`, `conflictedPathsOf`, `settleCleanIndex`,
`reinstateIndex`, `mergeTreesToTree`'s conflict line (no longer disabled), `stashIndexConflict` and its message case;
P10 — the walker's report branch, `listUntracked`, `cleanStashedUntracked`, `pruneDirectoriesFrom`; P11 / P12 — their
new modules and branches.

## Out of scope

- The autostash refresh hunch (above): unproven.
- `stash push -- <pathspec>`, `stash -p`, `--index` reinstatement of a conflicted index side: not exposed (ADR-211).
- git's rendered output (`Already up to date.`, the status block `stash apply` prints, `Index was not unstashed.`):
  rendering, rebuilt by the caller (ADR-249).

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

### How the revision matrices were pinned (A.7, A.8)

The A.1–A.6 harness, with tsgit taken from the committed tree, not the worktree (another agent edits `src/`):
`git archive 0589e7c5 src` extracted into the throwaway, loaded through `jiti` (`createNodeContext({ workDir })`,
`stashPush` / `stashApply` / `stashPop`). git asserted `git version 2.55.0`, `GIT_*` scrubbed and asserted absent,
isolated `HOME`, every repository guarded before use. Each tool pushes on its own twin; W, I and U trees compared
(equal on every A.7 and A.8 row). A.7: after the push, a sleep past the racy window, the post-push state planted
in both, `keep` drifted (`touch -t 202001010000 keep`), the index inode recorded, then the command. Compared: exit
and stderr / result kind or error data, `ls-files -s`, `ls-files -v` tags, the recursive listing, `refs/stash`
reflog count, `.git` state files, `keep`'s cached mtime against `lstat`, the index inode, `status --porcelain
-uall`. A.8: `status --porcelain -uall` compared before the push, then the listing, `ls-files -s` and the three
stash trees after it.

### A.7 — `apply --index` / `pop --index`: the index-side judge (git 2.55.0 vs tsgit 0589e7c5)

Seed: `keep=k`, `f` = ten lines `l1`…`l10`, `g=g0`, one commit. "Staged" is the stash's I; "current" is the index
after the post-push step. Every row: both indexes rewritten (the opening refresh), `keep` fresh in both; on every
git refusal `refs/stash` is kept, no `AUTO_MERGE`, the work tree and index equal to their post-push state.

| row | staged (I) and work tree at push → post-push | git 2.55.0 | tsgit 0589e7c5 |
|---|---|---|---|
| H2 | `f=I` staged, work `f=W`, `g=g1` → `f=W` committed | exit 1, `error: patch failed: f:1` / `error: f: patch does not apply` / `error: conflicts in index. Try without --index.`; `g=g0`, status clean | `applied`; `g=g1` (` M g`), `AUTO_MERGE`; `pop` drops the stash (F13) |
| H2 × `-u` (untracked `u`) | same + `u` | as H2; `u` not restored | `applied`, `u` restored, `pop` drops |
| H2 × `--keep-index` | same | as H2 | as H2 tsgit |
| H2, plain `stash apply` (no `--index`) | same | exit 0, ` M g` (no judge) | SAME |
| delete | `git rm f`, `g=g1` → `l9` edited in `f`, committed | exit 1, `f: patch does not apply`, `conflicts in index`; nothing written | `conflict [{ f, modify-delete }]`, `UD f`, `g=g1` staged, `AUTO_MERGE` (the W merge conflicts) |
| delete × `-u` | same + `u` | as delete | as delete tsgit |
| add-add | new `n=N` staged, `g=g1` → `n=M` committed | exit 1, `error: n: already exists in index` / `conflicts in index` | `conflict [{ n, add-add }]`, markers in `n`, `AUTO_MERGE` |
| add-add × `-u`, × `--keep-index` | same | as add-add | as add-add tsgit |
| non-overlap | `l2`→`L2` staged, `g=g1` → `l9`→`L9` committed | exit 0; index `f` = `L2`+`L9` (`M  f`), ` M g`, `AUTO_MERGE` | SAME |
| non-overlap × `-u` | same + `u` | exit 0, `u` restored | SAME |
| offset-mid | `l6`→`L6` staged, `g=g1` → two lines inserted above `l1`, committed | exit 0; hunk found at offset +2; `M  f`, ` M g` | SAME |
| offset-mid × `-u` | same + `u` | exit 0 | SAME |
| i-is-c (I = C, no judge) | `l2`→`L2` staged, `g=g1` → `L2` committed | exit 0, ` M g` | SAME (× plain, `-u`, `--keep-index`) |
| i-is-b (I = B, no judge) | `l2`→`L2` unstaged, `g=g1` → new `h` committed | exit 0, ` M f`, ` M g` | SAME (× plain, `-u`, `--keep-index`) |
| w-is-b (W = B, I ≠ B) | `l2`→`L2` staged, work `f` back to base → new `h` committed | exit 0 | SAME |
| adjacent (F14) | `l4`→`L4` staged, `g=g1` → `l6`→`L6` committed (inside the hunk's trailing context) | exit 1, `f: patch does not apply`, `conflicts in index`; nothing written | `applied`; index `f` = `L4`+`L6` (`M  f`), `g=g1`, `AUTO_MERGE`; `pop` drops (× `-u`, × both commands) |
| same-change (F14) | `l2`→`L2` staged, `g=g1` → `L2` and new `h` committed (C ≠ I through `h`) | exit 1, `f: patch does not apply`, `conflicts in index` | `applied` (× `-u`, `--keep-index`, both commands) |
| non-overlap × `--keep-index` (F14) | the kept index holds `L2`; post-push commits it with `L9` | exit 1, `f: patch does not apply`, `conflicts in index` | `applied`; `pop` drops |
| add-same (F14) | new `n=N` staged, `g=g1` → `n=N` and new `h` committed | exit 1, `n: already exists in index`, `conflicts in index` | `applied` (the add/add of equal blobs merges clean) |
| offset-top (F14) | `l2`→`L2` staged (hunk at line 1), `g=g1` → two lines inserted above `l1`, committed | exit 1, `f: patch does not apply` (a hunk at line 1 is anchored at the file start) | `applied`; `f` = inserted lines + `L2` (× `-u`, `--keep-index`) |
| staged-non-overlap (F15) | as non-overlap → `l9`→`L9` staged, not committed (C ≠ HEAD) | exit 1, `error: Your local changes to the following files would be overwritten by merge:` / `  f` / `Index was not unstashed.`; index reset to HEAD (`f` = base, ` M f`), work `f` keeps `L9` only, `g=g0`; × `-u`: `u` restored | `applied`; `M  f` (`L2`+`L9`), ` M g`, `AUTO_MERGE`; `pop` drops |
| staged-other (F15) | as non-overlap → new `h` staged, not committed | exit 1, local-changes block listing `h`, `Index was not unstashed.`; index at HEAD, `?? h`, `f` and `g` untouched | `applied`; `A  h`, `M  f`, ` M g` |
| w-is-b-staged (F15) | as w-is-b → new `h` staged, not committed | exit 1, local-changes block listing `h`, `Index was not unstashed.` (no `Already up to date.`: the index check precedes the W = B return) | `applied` |
| i-is-b-staged (bound of F15) | as i-is-b → new `h` staged, not committed | exit 0 (no `has_index`, no `reset_head`) | SAME |

Where the two judges agree (H2, delete, add-add refuse; non-overlap, offset-mid apply) P9 alone makes tsgit match git. Where
they disagree, git refuses and a three-way merge is clean: a change in C inside the hunk's 3-line context (adjacent), C
already holding the staged change (same-change, non-overlap × `--keep-index`), C having added the same file (add-same), C
shifting a hunk anchored at line 1 (offset-top). No probed shape has git applying where the three-way merge conflicts.

### A.8 — `stash push -u` and untracked directories holding no file (git 2.55.0 vs tsgit 0589e7c5)

Seed: `keep=k`, `a/t=t`, `.gitignore` = `*.cache`, `build/`, `out/`, one commit. Each row also edits `keep` and adds
an untracked `top` unless noted; × `--keep-index` stages `keep` first. Every row: `status --porcelain -uall` equal
in both before the push and never listing an empty directory; W, I, U trees equal; `ls-files -s` equal after.
Listings below omit `.gitignore`, `a/t`, `keep`.

| row | planted before the push | git 2.55.0 after `push -u` (and × `--keep-index`) | tsgit 0589e7c5 |
|---|---|---|---|
| empty-dir | `emptydir/` | gone | `emptydir/` kept (F16) |
| nest | `nest/inner/` | gone | `nest/`, `nest/inner/` kept |
| file-and-empty | `d/u`, `d/e/` | `d/` gone | `d/`, `d/e/` kept |
| reviewer | `emptydir/`, `nest/inner/`, `d/u` | all gone | `emptydir/`, `nest/inner/` kept (`d/` pruned) |
| two-empty | `nest/i1/`, `nest/i2/i3/` | gone | all kept |
| tracked-parent | `a/b/` (`a` tracked) | `a/b/` gone, `a/` kept | `a/b/` kept |
| tracked-sibling | `a/z`, `a/e/` | `a/z`, `a/e/` gone, `a/` kept | `a/e/` kept |
| mixed | `nest/inner/`, `nest/build/` (ignored) | `nest/inner/` gone; `nest/`, `nest/build/` kept | `nest/inner/` kept |
| change-only (no untracked file) | `emptydir/`, `keep` edited only | gone (git's `clean -d` runs on every `-u` save; U = empty tree) | kept |
| type-empty | tracked `keep` replaced by empty `keep/` (no `top`) | `-u`: file `keep` back (SAME); × `--keep-index` (deletion staged): no `keep` at all | `-u`: SAME; × `--keep-index`: `keep/` kept |
| ignored-file | `m/.cache` (ignored), `m/z` | `m/z` gone, `m/`, `m/.cache` kept | SAME |
| ignored-dir | `build/` (ignored, empty) | kept | SAME |
| under-ignored | `out/e/` (under an ignored directory) | kept | SAME |
| ignored-deep | `x/y/.cache` (ignored) only | `x/`, `x/y/`, `x/y/.cache` kept | SAME |
| ignored-inner | `p/build/` (ignored, empty) | `p/`, `p/build/` kept | SAME |
| link-to-dir | `alias → a` (untracked link to a directory) | stashed in U, removed | SAME |
| gitlink-dir | gitlink `sub` committed, `sub/` empty (unpopulated) | `sub/` kept | SAME |
| only-empty (nothing else changed) | `emptydir/` only | exit 0, `No local changes to save`, `emptydir/` kept, no `refs/stash` | SAME (`no-local-changes`) |
