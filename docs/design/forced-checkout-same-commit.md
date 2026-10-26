# Design — forced-checkout-same-commit

> Brief: backlog 32.27 — `checkout -f HEAD` with a populated index leaves a symlinked parent `a` in place where git
> 2.55 replaces the link with a directory (tracked `a/payload`). Root cause known (ADR-1080): the forced switch never
> reaches the apply because every unchanged path classifies `noop`. Fix the classification as git's one-way reset
> does, reuse the displacement shipped in #331, and fold every in-perimeter caller of the same classification, plus
> the refusal, reflog and stat-refresh gaps the matrix proved on the same call sites (ADRs 1087–1091).
> Status: draft → self-reviewed ×3 → revised against ADRs 1087–1091 → self-reviewed ×2

## Context

- The forced switch: `switchBranch` (`src/application/commands/checkout.ts:248-322`) calls `materializeTree`
  (`:285-294`) with `force: true`, no `forceRewriteAll`, no `headTree` (`headTreeOption` `:236-246` returns `{}` when
  forced), no `unmergedPaths`. It commits `newIndexEntries` unconditionally (`:299`). Then `moveHead` (`:311`) always
  writes HEAD and a `checkout: moving from <x> to <arg>` reflog entry, `removeBranchState` (`:312`), `post-checkout`
  (`:315`). The unforced switch refuses an unmerged index first (`rejectUnmergedIndex`, `:284`).
- `materializeTree` (`src/application/primitives/materialize-tree.ts:475-528`): `computeChangeset` (`:488`, pure,
  `compute-changeset.ts:64-100` — `noop` iff index `id`+`mode` equal the target's), optional `projectUnmergedPaths`
  (`:489-491`), then `forceRewriteAll === true ? upgradeNoopsToUpdates(...)` (`:493-494`, `:290-299`: EVERY `noop`
  becomes `update`). `splitWaves` drops `noop` entries before the apply. `mergeNewIndexEntries` (`:218-235`) takes a
  written entry (post-write `lstat`, `STAGE0_FLAGS`, via `indexEntryFromStat`
  `internal/index-entry-from-stat.ts:38-58`) over the donor entry; a `noop` keeps the donor entry, stat included.
- `forceRewriteAll: true` callers (ADR-023 introduced it for `reset --hard`):

| caller | git counterpart |
|---|---|
| `reset.ts:179-191` | `reset --hard <rev>` |
| `checkout.ts:456-477` (`materializePathRestoreFromIndex`) | `checkout -- <p>` |
| `checkout.ts:479-507` (`materializePathRestoreLocked`) | `checkout <rev> -- <p>` |
| `stash.ts:803-824` (`resetAfterPush`) | `stash push`'s `reset --hard` |
| `commands/internal/reset-worktree.ts:55` (`hardResetWorktreeToCommit`, from `merge.ts:887`) | merge strategy rewind, `reset --hard HEAD` |
| `commands/internal/reset-worktree.ts:72-80` (`attemptProtectedResetWorktreeToCommit`) | `rebase --abort` / `--skip`, rebase-merges `reset` |

- `materializeTree`, `MaterializeTreeOpts` and `forceRewriteAll` are public (`src/application/primitives/index.ts:64-65`,
  `reports/api.json` `MaterializeTreeOpts.forceRewriteAll`). ADR-1087 keeps the name and redefines it.
- Stat judgement already in the tree, git's `ie_match_stat` as `verify_uptodate` uses it:
  `matchesCachedStat` (`internal/occupant-clash.ts:156-166`, private): mode (`deriveWorkingMode`) + `matchesContentStat`
  (`internal/is-entry-stat-clean.ts:76-82`: mtime, ctime, uid, gid, ino, size; `dev` excluded), then for a racy entry
  (`isRacy` `:26-30`) a content compare with checkin attributes (`compareFile`). It ignores `assumeValid`.
  `lstatBeyondLink` (`occupant-clash.ts:142-151`) maps `NOT_A_DIRECTORY` to unreachable. Status's
  `isEntryStatClean` (`is-entry-stat-clean.ts:83-91`) honours `assumeValid` and `compareAndRefresh`
  (`compare-working-tree-entry.ts:332-349`) hashes a stat-dirty file; neither is git's one-way-reset rule (see T and AU
  rows). `compareAndRefresh` IS git's `refresh_index` rule (assume-valid, skip-worktree, gitlink, intent-to-add never
  refreshed; `shouldRefresh` `:295-301`), which P5 and P7 need.
- git's `refresh_and_write_cache`, house pattern: `commands/internal/write-index-cache-tree.ts:76-87` (lock → `readIndex`
  → `rejectUnmergedIndex` → `scanTrackedEntries` (`internal/scan-tracked-entries.ts:104-112`) → `withRefreshedStat`
  (`internal/index-lock.ts:302-310`) → `lock.commit(entries, 'update', { verified: verifiedBy(scan) })`).
- Unmerged refusals: `rejectUnmergedIndex` (`commands/internal/unmerged-index.ts:6-12`) throws
  `mergeHasConflicts(count, paths)` (`domain/commands/error.ts:709-721`, `MERGE_HAS_CONFLICTS { count, paths,
  truncated? }`), used by the unforced switch, `commit` and `stash apply` for git's "you need to resolve your current
  index first", "needs merge" and "could not write index" refusals (pinned in `branch-state-removal-interop.test.ts:310`,
  `stash-apply-index-interop.test.ts:247`, `commit-cache-tree-interop.test.ts:386`).
- The `reset` ref tail (`reset.ts:88-100`): `recordOrigHead` (`:104-108`, ORIG_HEAD ← HEAD), `updateRef(ctx, 'HEAD',
  id, { reflogMessage: resetMovingTo(rev) })` (attached: logs HEAD only, `reset: moving to HEAD`; detached no-move:
  no entry — A.3 R rows), `removeBranchState(ctx, 'silent')`.
- `stashPush` (`stash.ts:570-577`): `gateStash`, `assertNoPendingOperation` (`:575`), `stashAndReset` (`:589-617`,
  shared with `createAutostash` `:580-584`): lock, `findLocalChanges`, stash commits, `record` (stash ref),
  `resetAfterPush` (`:803-824`). No reflog, no ORIG_HEAD, no hook.
- Path restore (`checkout.ts:356-401`): `restoreUnderIndexLock` takes the lock, reads the index, builds the universe,
  `refuseUnmatched` (`:394`), then materialises; no unmerged check.
- Bounded fan-out: `boundedMapFor(ctx, 'ioBound')` (`internal/concurrency.ts`), used by `scan-tracked-entries.ts`.
- `GitIndex.indexMtime` (`domain/git-index/index-entry.ts:95`) is filled by `readIndex`; every caller above reads the
  index under its lock just before `materializeTree`.
- Constraints: ADR-226 (byte-faithful work tree, index, reflog, refusals), ADR-249 (structured data), ADR-023 (the
  `forceRewriteAll` contract, refined by ADR-1087), ADR-1075 (displacement before the write wave, reused as-is),
  ADR-1080 (this fix kept separate), ADR-1087 (keep the name, stale-only rule, ships as `fix`), ADR-1088 (judge home),
  ADR-1089 (merge rewind keeps `unmergedPaths` hidden), ADR-1090 (unforced refresh folded), ADR-1091 (F10–F12 folded).

## Requirements

- R1 A forced switch (`checkout -f <HEAD | @ | branch | oid | other commit>`) rewrites every stage-0 entry whose
  target `id`+`mode` equal the index's and whose work-tree path is not up to date, and leaves every up-to-date one
  untouched (no write, donor stat kept). Every occupant shape of Appendix A ends as git 2.55 leaves it.
- R2 "Up to date" is git's `ie_match_stat` with `CE_MATCH_IGNORE_VALID | CE_MATCH_IGNORE_SKIP_WORKTREE` on an
  `lstat` of the whole path (leading symlinks followed): absent (`ENOENT`) or unreachable (`ENOTDIR`) is stale; a
  mode/type change is stale; any of mtime, ctime, uid, gid, ino, size differing is stale (a `touch` alone is stale);
  all equal and not racy is up to date; all equal and racy is decided by content (the racy branch is the one #331
  pinned for `verify_uptodate`, design `forced-checkout-displace-occupant.md` "As shipped"; this matrix avoids racy
  entries). `assumeValid` is ignored. A skip-worktree entry is never judged and never rewritten. A gitlink is up to
  date iff a directory stands at its path.
- R3 A rewritten up-to-date-by-id entry keeps the prior entry's `assumeValid` flag (git keeps `h`).
- R4 Every `forceRewriteAll` caller (table above) follows R1–R3 instead of rewriting every path: `reset --hard`,
  path restore, `stash push`, rebase abort/skip, the merge rewind. Clean files are not rewritten. The option keeps
  its name (ADR-1087); its TSDoc states the stale-only rule.
- R5 A forced switch and `reset --hard` reset an unmerged path to the target: a conflicted path absent from the target
  is removed from the work tree and the index (UMn rows). The merge rewind keeps `unmergedPaths` hidden (ADR-1089).
- R6 `checkout HEAD` / `checkout @` (forced or not, attached or detached, no `--detach`, no `-b`) moves no ref and
  writes no reflog entry; HEAD stays attached to its branch. Branch state (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
  `MERGE_MSG`, `MERGE_MODE`) is still removed and `post-checkout` still fires. `HEAD~0`, `--detach HEAD`, `-b x HEAD`
  keep today's (already faithful) behaviour.
- R7 (ADR-1090) An unforced switch that succeeds writes the index with every stage-0 entry git's `refresh_index`
  refreshes: not assume-unchanged, not skip-worktree, not a gitlink, stat drifted, content equal — kept and untouched
  entries alike (A.4 `all`, `same`). A content-dirty, assume-unchanged or skip-worktree entry stays stale. A refused
  switch writes nothing (A.4 `refuse`).
- R8 (ADR-1091, F10) A path restore from the index (`checkout -- <pathspec>`) whose pathspec matches an unmerged
  path refuses with `MERGE_HAS_CONFLICTS { count, paths }` naming every matched unmerged path once, in index order;
  index, work tree and hooks untouched (no `post-checkout`). An unmatched pathspec refuses first
  (`PATHSPEC_NO_MATCH`). A pathspec that matches no unmerged path proceeds. A restore from a tree (`checkout <rev> --
  <pathspec>`) never refuses for an unmerged path (A.3 F10e, F10f, F10l).
- R9 (ADR-1091, F12) `stash push` (any of `includeUntracked`, `keepIndex`) on an index holding an unmerged entry
  refuses with `MERGE_HAS_CONFLICTS { count, paths }` before writing any object, ref, reflog or index; work tree
  untouched. The refusal precedes the pending-operation gate, so a conflicted merge refuses as git does (A.3 M1).
- R10 (ADR-1091, F11) A `stash push` that saves a stash then writes, after its reset, git's `reset --hard` ref tail:
  HEAD reflog `reset: moving to HEAD` (old = new = HEAD) when HEAD is attached, no entry when detached, the branch's
  own reflog untouched (A.3 F11a–F11e). Further tail effects hang on DC6.
- R11 (DC5 dependent) `stash push` opens with git's index refresh: stat-dirty, content-clean entries are refreshed
  and written, even when nothing is stashed (A.2 T × `stash push`).
- R12 Every Appendix A row SAME today stays SAME; every DIFF row covered by R1–R11 becomes SAME. Rows hanging on an
  unratified DC stay as they are until ratified.

## Design

### How the matrix was pinned

A throwaway harness outside the repository (`mktemp -d` per row, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every
`GIT_*` scrubbed, `commit.gpgsign=false`, fixed author/committer dates, `git --version` asserted `2.55.0`) builds the
same history with git plumbing in two sibling repositories: `main` = `keep` + the shape's tracked entries, `t` = child
of `main` adding `other` (so every shape path is unchanged between `main` and `t`). After `reset --hard main` both
repositories wait 1.1 s and `reset --hard` again so no entry is racy. The shape is planted in both, then git runs the
command in one and tsgit (worktree `src/` at fb6bc5b0, loaded through `jiti`, `openRepository({ cwd })`) the
equivalent in the other. Compared: recursive work-tree listing (type, link target, content, exec bit),
`git ls-files -s`, `git ls-files -v` (flags), stale index entries (`ls-files --debug` `ino`/`size`/mtime-second vs
`lstat`), rewritten paths (a path present before whose inode or mtime changed), HEAD's symref, HEAD reflog count and
top subject, and the `.git` state files. Git-only probes: a populated submodule at a different commit (GLp) and a
`rebase --abort` with a clean and a touched bystander (RB).

Shapes (`keep` tracked bystander everywhere): C clean; E content edit; T `touch` only (mtime +5 s); M `chmod +x`;
Dw tracked file deleted; AU assume-unchanged + edit; SW skip-worktree + edit; S3a dangling symlink `a` for tracked
`a/payload`; S3g `a` → copy of the directory (new inodes); S3i `a` → the moved directory (same inodes); S1 file `d`
for tracked `d/x`; S2 directory `f/` holding untracked `f/u` for tracked `f`; S2e empty directory `f/`; S3b dangling
link `f`; LF link `f` → tracked `g` (same content); S3f regular file `l` for tracked link `l`; S3c directory `l/`
with untracked `l/u` for tracked link `l`; S3d file `d` for tracked link `d/l`; LR link `l` retargeted; GL gitlink with
empty directory; GLf file `s` for gitlink `s`; ST staged edit; SA staged new file; SD `git rm f`; SDk
`git rm --cached f`; U untracked `u`; UM `f` unmerged (stages 1–3, work file edited); UMn `n` unmerged (stages 2–3)
and absent from HEAD.

Commands: set 1 — `checkout -f HEAD`, `checkout -f main`, `checkout -f <main oid>`, `checkout -f t`, detached
`checkout -f HEAD`, `reset --hard HEAD`; set 2 — `checkout HEAD`, `checkout main`, `checkout -- f keep`,
`checkout HEAD -- f keep`, `stash push`; set 3 (C only) — `checkout @`, `checkout -f @`, `checkout HEAD~0`,
`checkout --detach HEAD`, `checkout -f --detach HEAD`, `checkout -b nb HEAD`, detached `checkout HEAD`; set 4 —
`checkout -f HEAD` / `-f main` with `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `MERGE_MSG`, `MERGE_MODE`, `ORIG_HEAD` planted;
set 5 (T only) — unforced `checkout t`, `checkout --detach main`.

Revision probes (A.3, A.4), same isolation, a three-file history `f`, `g`, `keep` (plus `a`, `s` for A.4) and a
`post-checkout` hook appending its arguments to a log outside the repository (`core.hooksPath`): the F10 path-restore
refusal matrix, the F11 `stash push` ref tail (attached, detached, `-u`, `--keep-index`, both, second push,
`core.logAllRefUpdates=false`), the F12 refusal (stages 1–3, stages 2–3, `-u`, `--keep-index`, a real conflicted merge),
the pending markers under `stash push`, and the unforced switch refresh set. Each records exit code, stdout, stderr,
`ls-files -s`, the work tree, HEAD and branch reflogs, `refs/stash` and its reflog, the hook log, the index file hash
and the object count before and after. tsgit's side runs the same scenario through `openRepository`
(`checkout({ paths })`, `checkout({ paths, source: 'HEAD' })`, `stash.push({ includeUntracked?, keepIndex? })`,
`reset({ mode: 'hard', rev: 'HEAD' })`, `checkout({ rev })`). tsgit's `stash.push` exposes no pathspec and
path restore exposes no `-f` / `--ours` / `--theirs` / `--merge`, so those git variants are not probed.

### Parity summary

319 pairs. Set 1: 168 pairs, 30 SAME. Of the 140 forced-switch pairs, 90 differ in work tree, flags, stale index or
rewritten set; every `-f HEAD` / detached `-f HEAD` pair (56) differs in HEAD attachment or reflog. `ls-files -s`
never differs in set 1. Set 2: 140 pairs, 63 SAME. Sets 3–5: 11 pairs, 5 SAME. Revision probes: A.3 and A.4.

Findings, each with the rows that prove it (Appendix A):

| # | Finding | Proof rows | Perimeter |
|---|---|---|---|
| F1 | Forced switch rewrites nothing; git rewrites every stale entry and displaces the occupant | E, T, M, Dw, AU, S3a, S3g, S1, S2, S2e, S3b, LF, S3f, S3c, S3d, LR, GLf × 5 spellings | in (32.27) |
| F2 | git leaves an up-to-date entry alone even beyond a symlinked leading directory | S3i (both tools keep the link); GL, SW, C; GLp (git only) | regression guard |
| F3 | `reset --hard`, path restore, `stash push` rewrite every file; git only stale ones | C, T, Dw, SA, U … (`rewritten` column); RB (`rebase --abort`) | in (R4, ADR-1087) |
| F4 | `reset --hard` drops the assume-unchanged flag; path restore too | AU × `reset --hard`, `checkout -- f`, `checkout HEAD -- f` | in (R3) |
| F5 | `reset --hard` rewrites a skip-worktree entry and drops its flag | SW × `reset --hard` | in (R2) |
| F6 | `reset --hard` replaces a link git keeps (stat through it matches) | S3i × `reset --hard` | in (R2) |
| F7 | Forced switch and `reset --hard` keep the work file of an unmerged path absent from the target | UMn × set 1 | in (R5) |
| F8 | `checkout HEAD` / `@` detaches and logs; git stays and logs nothing | every `-f HEAD`, `checkout HEAD`, `@` row | in (R6) |
| F9 | Unforced switch leaves a touched entry's stat stale; git refreshes every refreshable entry | T × `checkout HEAD`, `checkout main`, `checkout t`, `--detach main`; A.4 | in (R7, ADR-1090) |
| F10 | `checkout -- f` on an unmerged `f`: git exits 1 `error: path 'f' is unmerged`, nothing written; tsgit succeeds, drops every stage of `f` (no stage-0 entry left: `D  f` + `?? f`), restores the other paths, fires `post-checkout` | A.3 F10a–F10k vs T10a–T10k | in (R8, ADR-1091) |
| F11 | `stash push` writes no HEAD `reset: moving to HEAD` reflog entry | A.3 F11a–F11d vs T11a, T11c | in (R10, ADR-1091) |
| F12 | `stash push` on an unmerged index: git exits 1 (stdout `f: needs merge`, stderr `error: could not write index`), nothing written; tsgit stashes and resets | A.3 F12a–F12e vs T12a, T12d; M1 vs TM1 | in (R9, ADR-1091) |
| F13 | `stash push` does not refresh the index first; git refreshes it (even with nothing to stash) | A.2 T × `stash push` | DC5 |
| F14 | `stash push --keep-index` fires no `post-checkout`; git fires `<head> <head> 0` | A.3 F11c, F11d vs T11c | DC7 |
| F15 | `stash push` refuses `OPERATION_IN_PROGRESS` while `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or `REBASE_HEAD` stands; git stashes, resets and clears branch state | A.3 M2, K rows vs TM1 | DC8 | F15: drop `stash push`'s pending-operation gate (`stash.ts:575`) | (a) drop it: git stashes, resets and clears `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` (keeps `REBASE_HEAD`) (b) keep it, warn-and-ask with M2 and the K rows | (a) | Proven (M2 is a real resolved merge; K rows), same function, so the fold rule applies; P8's `removeBranchState` already gives the clearing. Before folding, the implementer pins one real resolved cherry-pick and one real stopped rebase (`rebase-merge/` present) against git 2.55 (lesson 017). Against (a): it removes a refusal shipped since #98 and widens `stash push` to every pending operation; P7 already makes the common case (a conflicted merge) faithful. |
| F16 | `stash push` writes no ORIG_HEAD; git's reset writes ORIG_HEAD = HEAD (attached and detached) | A.3 O1, O4 vs O2 | DC6 |

### Root causes (main fb6bc5b0)

- RC1 (F1) — `checkout.ts:285-294` passes no rewrite option; `materialize-tree.ts:493-494` leaves every `noop`, and
  `splitWaves` drops it.
- RC2 (F3, F5, F6) — `upgradeNoopsToUpdates` (`materialize-tree.ts:290-299`) upgrades every `noop` without asking the
  work tree; ADR-023 assumed git's `reset --hard` rewrites every path. git's `oneway_merge` (and `checkout_entry` for
  path restore) skips an entry whose stat is up to date and never touches a skip-worktree entry.
- RC3 (F4) — the written entry for an upgraded `noop` is `indexEntryFromStat(...)` with `STAGE0_FLAGS`; git copies the
  old entry (`copy_cache_entry`) and keeps `CE_VALID`.
- RC4 (F7) — the forced switch and `reset.ts` leave `unmergedPaths` at `hidden`, so `computeChangeset` never sees the
  conflicted `n` and the target-only `newIndexEntries` drop it without a delete.
- RC5 (F8) — `resolveSwitch` (`checkout.ts:169-177`) resolves `HEAD`/`@` to an object with `onBranch: undefined`, so
  `switchBranch` detaches (`:263`) and `moveHead` (`:311`) logs. git treats a bare `HEAD` name as "stay".
- RC6 (F9) — `switchBranch` (`checkout.ts:282-299`) hands `materializeTree` the index as read; nothing refreshes it,
  so every `noop` keeps its stale donor stat into the commit at `:299`. git refreshes every refreshable entry
  before the two-way merge and writes the index only on success (A.4).
- RC7 (F10) — `restoreUnderIndexLock` (`checkout.ts:383-401`) goes from `refuseUnmatched` (`:394`) straight to
  `materializePathRestoreFromIndex`; the index-synthesised target tree holds no entry for an unmerged path, so the
  restore drops its stages without writing a stage-0 entry.
- RC8 (F11, F16) — `stashPush` (`stash.ts:570-577`) ends after `stashAndReset`; the ref tail git's `reset --hard`
  child writes (`reset.ts:95-99` in tsgit's own reset) is never run.
- RC9 (F12, F13) — `stashPush` has no opening refresh; `findLocalChanges` (`stash.ts:508-521`) classifies an
  unmerged index as changes, and `resetAfterPush` resets it.
- RC10 (F14) — `resetAfterPush` (`stash.ts:803-824`) never fires `post-checkout`. RC11 (F15) — the pending-operation
  gate `assertNoPendingOperation` (`stash.ts:575`), present since the stash command landed (#98), with no ADR.

### Fix design

Parts P1–P8. Each part's context block is the minimal reading list an implementer needs.

**P1 — the stale-entry pass (RC1, RC2)** — new internal module
`src/application/primitives/internal/stale-entries.ts`, consumed by `materializeTree` in place of
`upgradeNoopsToUpdates` when `forceRewriteAll === true` (ADR-1087: same option, git's stale-only rule):

```ts
/** git's oneway_merge: a `noop` whose work-tree path is not up to date becomes an `update`. */
export const upgradeStaleNoops = async (
  ctx: Context,
  changeset: Changeset,
  index: GitIndex,          // plan.indexForDiff: stage-0 entries carry the cached stat
  workdir: string,
): Promise<Changeset>;      // re-tallied with tallyStats, as upgradeNoopsToUpdates does today

// one verdict per noop, fanned out through boundedMapFor(ctx, 'ioBound')
const isUpToDate = async (ctx, entry: IndexEntry, workdir, indexMtime): Promise<boolean> => {
  if (entry.flags.skipWorktree || isLossy(entry)) return true;   // never judged (R2); lossy: unaddressable
  const absPath = joinPath(workdir, entry.path);
  const stat = await lstatBeyondLink(ctx, absPath);
  if (stat === undefined || stat === UNREACHABLE) return false;  // ENOENT / ENOTDIR
  if (entry.mode === FILE_MODE.GITLINK) return stat.isDirectory;
  return matchesCachedStat(ctx, { entry, indexMtime }, absPath, stat);
};
```

- ADR-1088: `matchesCachedStat` and `lstatBeyondLink` move out of `occupant-clash.ts` into
  `internal/is-entry-stat-clean.ts`, exported; `occupant-clash.ts` imports them back: one `ie_match_stat`, two
  consumers. The racy branch builds its checkin attribute provider lazily, once per pass (today it builds one per call).
- The upgraded entry keeps `previousId`/`previousMode` = the index's, so the apply's displacement (ADR-1075) runs
  unchanged: S1, S3c, S3d need P1 of #331, the rest are plain writes.
- `materializeTree` order: `computeChangeset` → `projectUnmergedPaths` (when `reset`) → stale pass (when
  `forceRewriteAll`) → apply. The stale pass only touches `noop` entries, all stage-0, so it never meets a conflict stage.
- Sparse: `plan.indexForDiff` already lacks skip-worktree entries under a matcher; without a matcher, a manually set
  skip-worktree entry stays `noop` (R2).
- `MaterializeTreeResult.written` now counts rewrites only (ADR-1087). `reset.ts:200`'s
  `written > 0 || deleted > 0 || matcher !== undefined` guard stays correct: every index change the reset makes is an
  `add`/`update`/`delete`; an all-up-to-date tree leaves the index as it was. The comment at `checkout.ts:498-503`
  ("`written` is always `pathSet.size`") becomes false and is reworded; the commit there is already unconditional.
- Context block: `materialize-tree.ts:14-28` (stat-source contract), `:84-95` (option + TSDoc), `:209-235`, `:290-299`,
  `:475-528`; `internal/occupant-clash.ts:142-166`; `internal/is-entry-stat-clean.ts:20-91`;
  `internal/concurrency.ts` (`boundedMapFor`); `compare-working-tree-entry.ts` `compareFile` (racy branch);
  `internal/read-gitattributes.ts` `buildCheckinAttributeProvider`; tests
  `test/unit/application/primitives/internal/occupant-clash.test.ts`, `materialize-tree.test.ts`.

**P2 — flag carry (RC3)** — `mergeNewIndexEntries` / `pickEntry` (`materialize-tree.ts:209-235`): when the written
entry replaces an old stage-0 entry with the same `id` and `mode`, the result keeps the old entry's `assumeValid`
flag. Only flags git copies for an identical entry: `assumeValid` is the one pinned (AU rows); skip-worktree entries
never reach a write (P1). An `update` whose id changed keeps today's fresh flags (not probed, unchanged).
Context block: `materialize-tree.ts:209-235`; `domain/git-index/index-entry.ts` (`IndexEntryFlags`, `STAGE0_FLAGS`);
`internal/index-entry-from-stat.ts:38-58`.

**P3 — callers (RC1, RC2, RC4)** — ADR-1087: no rename, no `api.json` change, ships as `fix`.

| caller | today | after |
|---|---|---|
| `checkout.ts:285` forced switch | `force` | `force`, `forceRewriteAll: true`, `unmergedPaths: 'reset'` (forced only; the unforced path already refuses an unmerged index, `rejectUnmergedIndex` `:284`) |
| `reset.ts:179` | `force`, `forceRewriteAll` | unchanged option, + `unmergedPaths: 'reset'` |
| `checkout.ts:472`, `:495` path restore | `forceRewriteAll` | unchanged (new meaning) |
| `stash.ts:815` | `forceRewriteAll` | unchanged (new meaning) |
| `commands/internal/reset-worktree.ts:55` merge rewind | `forceRewriteAll` | unchanged (new meaning); `unmergedPaths` stays hidden (ADR-1089) |
| `commands/internal/reset-worktree.ts:72-80` protected reset | `forceRewriteAll`, `unmergedPaths: 'reset'` | unchanged |

The unforced switch does not get the option: git's two-way merge keeps an entry HEAD, the index and the target agree
on without writing it (T, E, S3a × unforced rows rewrite nothing).

Rewritten to state git's rule: the `forceRewriteAll` TSDoc (`materialize-tree.ts:84-95`, "every entry whose
work-tree stat is not up to date"), the stat-source contract (`:14-28`, its "`reset --hard` therefore MUST set
`forceRewriteAll: true` so every noop" line), `reset-worktree.ts`'s module doc (`:1-4`) and `ResetMode` pick
(`:27-29`), the comments at `reset.ts:183-186`, `checkout.ts:466-471`, `:490-494`, `:498-503`. ADR-023's "every path
is written" consequence is refined by ADR-1087.
Context block: the five call sites above; `commands/internal/reset-worktree.ts:1-80`; ADR-1087, ADR-1089.

**P4 — a bare `HEAD` stays (RC5)** — in `switchBranch`:

```ts
// git's update_refs_for_switch: a bare HEAD name moves nothing ("Nothing to do").
const staysOnHead = (opts: CheckoutSwitchOptions): boolean =>
  HEAD_SPELLINGS.has(opts.rev) && opts.detach !== true && opts.createBranch === undefined;
```

`HEAD_SPELLINGS = new Set(['HEAD', '@'])` (named constant). When it holds: skip `moveHead`; the result reports
`branch` = the current branch (`priorHead.kind === 'symbolic'` and under `refs/heads/`) or `undefined`, `detached`
accordingly; `removeBranchState` and `post-checkout` (old = new oid) still run (set 4). The work-tree half is the
same forced/unforced materialisation as any switch. The unforced `checkout HEAD` gains the same stay (F8 rows).
Context block: `checkout.ts:110-246` (types, `resolveSwitch`, `moveHead`, `headTreeOption`), `:248-322`;
`test/unit/application/commands/checkout.test.ts`.

**P5 — unforced refresh (RC6, ADR-1090)** — the unforced switch refreshes the index it hands `materializeTree`, so
kept and untouched entries leave with fresh stats and a refused switch writes nothing, as git does (A.4):

```ts
// in switchBranch, under the index lock, after rejectUnmergedIndex (unforced only)
const read = await readIndex(ctx);
if (opts.force !== true) rejectUnmergedIndex(read.entries);
const { currentIndex, verified } =
  opts.force === true ? { currentIndex: read, verified: undefined } : await refreshedIndex(ctx, read);
// ... materializeTree({ currentIndex, ... }) unchanged ...
await lock.commit(materializeResult.newIndexEntries, 'replace', verified ? { verified } : {});
```

- `refreshedIndex(ctx, index)` (new, `commands/internal/refresh-index.ts`, shared with P7):
  `scanTrackedEntries(ctx, index, index.entries, QUIET_SCAN)` then `{ currentIndex: { ...index, entries:
  withRefreshedStat(index, scan.refreshed) }, verified: verifiedBy(scan) }`. `QUIET_SCAN` moves from
  `write-index-cache-tree.ts:21` to this module and is imported back.
- Which entries (A.4): every stage-0 entry `compareAndRefresh` refreshes — stat drifted, content equal, not
  assume-unchanged, not skip-worktree, not a gitlink, not intent-to-add. Kept-by-the-merge and untouched entries are
  the same set: a `noop` keeps its donor, now refreshed. Entries the switch writes carry their post-write `lstat`
  (unchanged). A content-dirty entry is not refreshed (stays stale, A.2 E row).
- Racy entries: `scanTrackedEntries` decides a racy stat-equal entry by content, and `lock.commit`'s
  `smudgeRacilyClean` (`internal/index-lock.ts:438`) smudges what is still racy against the new index mtime, the rule
  every tsgit index write already applies; `verified` spares it the re-read. No new racy rule.
- Commit: the existing unconditional `lock.commit(..., 'replace')` (`checkout.ts:299`) carries the refreshed stats;
  no second write. Any refusal inside `materializeTree` (`CHECKOUT_OVERWRITE_DIRTY`, …) releases the lock without a
  commit, so the refresh is dropped with it (A.4 `refuse`: git and tsgit both leave `f` stale).
- The forced switch does not refresh: its stale pass (P1) rewrites every stat-dirty entry, as git's one-way merge does.
- Context block: `checkout.ts:270-303`; `commands/internal/write-index-cache-tree.ts:20-48`;
  `internal/scan-tracked-entries.ts:95-118`; `internal/index-lock.ts:60-66` (`CommitOptions.verified`), `:302-310`,
  `:430-445`; `compare-working-tree-entry.ts:295-349`.

**P6 — path restore refuses an unmerged match (RC7, ADR-1091, F10)** — in `restoreUnderIndexLock`, after
`refuseUnmatched(unmatched)` (`checkout.ts:394`) and only when `source === undefined`:

```ts
// git's checkout_paths: a matched unmerged entry refuses the whole restore before anything is written.
if (source === undefined) rejectUnmergedIndex(currentIndex.entries.filter((e) => pathSet.has(escapedPathOf(e))));
```

- Reuses `rejectUnmergedIndex` → `MERGE_HAS_CONFLICTS { count, paths }`: one path per unmerged path (stages collapse
  through its `Set`), index order (A.3 F10d: `f` then `g`). ADR-249: no `path '<p>' is unmerged` text.
- Order pinned: `PATHSPEC_NO_MATCH` first (F10k), then the unmerged refusal (F10a–d, F10g, F10i). The lock is
  released without a commit (git's index hash unchanged, F10a), and `pathRestore` never reaches `post-checkout`
  (`checkout.ts:369`) because the throw leaves before it.
- A tree source needs no guard: git's `checkout <rev> -- <p>` resolves the stages from the tree (F10e, F10f) or
  leaves an unmerged path the tree lacks alone (F10l: `checkout HEAD -- .` keeps `n`'s stages 2–3), and tsgit already
  does both (T10e, T10l).
- `pathSet` holds escaped paths (`escapedPathOf`), so the filter keys on `escapedPathOf(entry)`, as the universe does.
- Context block: `checkout.ts:356-401`, `:519-…` (`enumerateSourcePaths`); `commands/internal/unmerged-index.ts`;
  `domain/commands/error.ts:700-721`; `domain/git-index/index-path-key.ts` (`escapedPathOf`).

**P7 — `stash push` opens with git's refresh (RC9, ADR-1091 F12; F13 per DC5)** — `stashPush` gains a locked
opening pass before the pending-operation gate:

```ts
export const stashPush = async (ctx, opts = {}) => {
  const workDir = await gateStash(ctx, 'stash');
  await refreshAndWriteIndex(ctx);           // git's refresh_and_write_cache: refuses an unmerged index
  await assertNoPendingOperation(ctx);       // removed if DC8 folds
  const saved = await stashAndReset(ctx, workDir, opts, (w) => pushStashRef(ctx, w.stash, w.message));
  if (saved.kind === 'saved') await finishStashReset(ctx, opts);   // P8
  return saved;
};
```

- `refreshAndWriteIndex(ctx)` (`commands/internal/refresh-index.ts`): `acquireIndexLock` → `readIndex` →
  `rejectUnmergedIndex` (F12: `MERGE_HAS_CONFLICTS`, git's stdout `<p>: needs merge` and stderr
  `error: could not write index` are rendering) → `refreshedIndex` (P5) → `lock.commit(entries, 'update',
  { verified })` when `scan.refreshed.length > 0`, else release. Under DC5 = (b) the pass stops after the refusal.
- Placement before `assertNoPendingOperation` makes a real conflicted merge refuse `MERGE_HAS_CONFLICTS` as git does
  (A.3 M1 vs TM1: tsgit says `OPERATION_IN_PROGRESS` today), whatever DC8 decides.
- `createAutostash` (`stash.ts:580-584`) shares `stashAndReset` but not `stashPush`: unchanged (git's autostash is
  `create_autostash`, not probed).
- Every object, ref and reflog write comes after the pass, so a refusal leaves the object count, `refs/stash` and
  its reflog as they were (A.3 F12a: 8 objects before and after).
- Context block: `stash.ts:563-617`, `:803-824`; `commands/internal/write-index-cache-tree.ts:20-87`;
  `commands/internal/unmerged-index.ts`; `test/unit/application/commands/stash-unmerged-index.test.ts`.

**P8 — `stash push`'s reset ref tail (RC8, ADR-1091 F11; F16 per DC6; F14 per DC7)** — extract `reset.ts:95-99`
into `commands/internal/reset-refs.ts`:

```ts
/** git's reset_refs + remove_branch_state after `reset --hard <rev>`. */
export const recordHardReset = async (ctx: Context, id: ObjectId, rev: string): Promise<void> => {
  await recordOrigHead(ctx);                                              // moved from reset.ts:104-108
  await updateRef(ctx, 'HEAD' as RefName, id, { reflogMessage: resetMovingTo(rev) });
  await removeBranchState(ctx, 'silent');
};
```

- `reset` calls it unchanged (its interop rows pin attached HEAD-only logging and detached no-move silence, A.3 R1/R2,
  T11i). `stashPush` calls it with HEAD's oid and `'HEAD'` once the stash is saved (`finishStashReset`). Under
  DC6 = (b) (F11 only) the stash tail is the `updateRef` line alone.
- `removeBranchState` clears `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` only once DC8 lets a marker reach the
  push (A.3 M2, K rows); with the gate kept, a push never sees those markers.
- DC7 = (a): when `opts.keepIndex === true`, `finishStashReset` then runs
  `runInformationalHook(ctx, 'post-checkout', { args: [head, head, FILE_FLAG] })` (git fires it after the
  reset with the file flag; A.3 F11c, F11d). `FILE_FLAG` moves from `checkout.ts:108` to a shared constant.
- Order matches git: stash ref and its reflog (`record`) → reset (`resetAfterPush`) → HEAD reflog / ORIG_HEAD →
  keep-index hook.
- Context block: `reset.ts:69-108`; `abort-merge.ts:56-63` (same tail by hand); `stash.ts:570-617`;
  `primitives/update-ref.ts`; `commands/internal/branch-state.ts`; `commands/internal/merge-state.ts`
  (`writeOrigHead`, `clearOrigHead`); `domain/reflog/reflog-messages.ts:38-39`; `primitives/run-hook.ts`.

### Performance

| operation, clean N-file tree | today | after |
|---|---|---|
| `checkout -f <same or other commit>` | 0 I/O for unchanged paths (unfaithful) | N `lstat`, 0 writes (git: N `lstat`) |
| `reset --hard`, `stash push`'s reset, rebase abort/skip, merge rewind | N blob reads + inflates + writes + `lstat` | N `lstat`, writes only for stale paths |
| `checkout [<rev>] -- <pathspec>` | one write per matched path | one `lstat` per matched path, writes only for stale; P6 adds one in-memory filter |
| unforced switch | `lstat` for changed paths only | + N `lstat` and one hash per stat-dirty entry (P5; git pays the same `refresh_cache`), + the attribute provider build once |
| `stash push` | one classification scan | + one refresh scan (N `lstat`, hash per stat-dirty) and an index write when something refreshed (P7); + one ref update (P8) |

`lstat` fans out through `boundedMapFor(ctx, 'ioBound')`. The racy branch hashes only racy, stat-matching entries
(none on a tree older than its index). No new syscall on clone (`add`-only changesets have no `noop`). P7's second
scan is a deliberate cost: folding it into `findLocalChanges`'s `compareAndRefresh` (`stash.ts:323`) would save N
`lstat` but must write the refresh even when nothing is stashed, which that path does not reach under the stash lock
order; measured before any merge of the two passes.

Bench plan, `npm run bench:ab` against main:
- `test/bench/checkout.bench.ts`: the forced alternation (pays P1's `lstat` pass on shared paths), the unforced
  alternation `'When checkout() alternates tip and root without force'` (pays P5), plus three new scenarios:
  `checkout({ rev: 'HEAD', force: true })`, `checkout({ rev: <current branch> })` unforced on the clean fixture (P5
  alone: N `lstat`, no hash, no write wave — the ADR-1090 row), and `reset({ mode: 'hard', rev: 'HEAD' })` (expected:
  drops by the cost of N writes).
- `test/bench/stash.bench.ts`: the existing push scenario (pays P1's narrowing and P7's scan).

### Adapter impact

None expected. On node, `lstat` follows leading symlinks (POSIX), which S3i pins. The memory adapter's
`lstatIfReachable` / `lstat` resolve through `walk(path, 'no-follow')` (`memory-file-system.ts:206-230`); a
`stale-entries` unit row with a leading link to the moved directory pins that it follows intermediate links. If it
does not, that row is the proof of an adapter defect, fixed in the same part.

### Size-cap impact

P1 ~250–400 B gzip (new module, lazy provider, bounded map), P2 ~40–80 B, P4 ~60–100 B, P5 ~80–150 B (reuses
`scanTrackedEntries`), P6 ~30–50 B, P7 ~80–120 B, P8 ~40–80 B (an extraction plus a call). Headroom is under 100 B, so
caps are re-measured from a clean build (`rm -rf dist .wireit`) and raised in the same change. `api.json` is
unchanged (ADR-1087); no public type or option moves.

### Out of perimeter

- Hunch, not proven: tsgit never reads `core.filemode` when judging stat (`deriveWorkingMode` compares the exec bit
  unconditionally), so with `core.filemode=false` a `chmod +x` would read stale where git's `ce_match_stat_basic`
  ignores it. To prove: rerun the M row with `core.filemode=false` on both sides.
- `createAutostash` (rebase/merge autostash) shares `stashAndReset` but not `stashPush`; P7/P8 leave it as is. To
  prove a gap: rerun F11/F12/O1 through `rebase --autostash` against git 2.55.

## Decision candidates

Settled:

| # | Choice | Settled by |
|---|---|---|
| DC1 | `forceRewriteAll` keeps its name, means git's stale-only rule; no `api.json` change; ships as `fix` | ADR-1087 (user-ratified) |
| DC2 | The shared `ie_match_stat` judge lives in `internal/is-entry-stat-clean.ts` | ADR-1088 |
| DC3 | The merge rewind keeps `unmergedPaths` hidden | ADR-1089 |
| DC4 | Fold F9: the unforced switch refreshes the index (P5) | ADR-1090 |
| — | Fold F10, F11, F12 (P6, P7's refusal, P8's reflog) | ADR-1091 |

Also settled by matching git, so not candidates: the up-to-date rule (R2), the skip-worktree exemption (SW), the flag
carry (AU), the bare-`HEAD` stay and its spellings (sets 3, 4), the UMn reset for the forced switch and `reset --hard`
(F7), folding R4 into every `forceRewriteAll` caller (F3–F6), the refresh set of P5 (A.4), the refusal codes
(`MERGE_HAS_CONFLICTS` is the house code for every unmerged-index refusal, and the refusal order is pinned).

New, raised by the ADR-1090/1091 folds — settled: DC5 → ADR-1092, DC6 → ADR-1093, DC7 → ADR-1094, DC8 → ADR-1095 (each option (a); DC8 conditional on the real cherry-pick and stopped-rebase pins):

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC5 | F13: does P7 implement git's whole opening `refresh_and_write_cache` (refusal + stat refresh + write) or only the unmerged refusal? | (a) whole step (b) refusal only | (a) | F12's refusal IS that step's failure mode; (b) keeps the T × `stash push` row stale, and on a touched-plus-edited tree the stale-only reset (P1) would rewrite the touched file git refreshed first. Against (a): one extra N-`lstat` scan and an index write per push. |
| DC6 | F16: does P8 run git's whole `reset --hard` ref tail (ORIG_HEAD, HEAD reflog, branch-state removal) or only the reflog line ADR-1091 names? | (a) whole tail via the extracted `recordHardReset` (b) reflog only | (a) | git writes ORIG_HEAD = HEAD on every push (O1, O4); same child `reset`, same three lines tsgit's `reset` already runs. (b) leaves a proven ORIG_HEAD gap on the call site P8 edits. Against (a): ORIG_HEAD is not named in ADR-1091. |
| DC7 | F14: `stash push --keep-index` fires `post-checkout <head> <head> 0` | (a) fold into P8 (b) keep out, warn-and-ask with F11c/T11c | (a) | Same function (`stashPush` tail), proven both sides, one call. Against (a): a hook is a new side effect for a caller that never saw one from `stash.push`. |
| DC8 | F15: drop `stash push`'s pending-operation gate (`stash.ts:575`) | (a) drop it: git stashes, resets and clears `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` (keeps `REBASE_HEAD`) (b) keep it, warn-and-ask with M2 and the K rows | (a) | Proven (M2 is a real resolved merge; K rows), same function, so the fold rule applies; P8's `removeBranchState` already gives the clearing. Before folding, the implementer pins one real resolved cherry-pick and one real stopped rebase (`rebase-merge/` present) against git 2.55 (lesson 017). Against (a): it removes a refusal shipped since #98 and widens `stash push` to every pending operation; P7 already makes the common case (a conflicted merge) faithful. |

## Test strategy

Interop, against git 2.55 (`PATH` must resolve `git` to 2.55.0; the suite asserts the version as the #331 suites do).
Each row compares the work-tree listing (with exec bit), `ls-files -s`, `ls-files -v`, the rewritten set and, for
switch rows, HEAD's symref and HEAD reflog (count and top subject). Racy entries are avoided without sleeping
(lesson 012): after building, back-date every work file's mtime with `utimesSync(now - 10 s)` and run
`git update-index --refresh` in both peers, so every entry is older than the index.

- New `test/integration/checkout-forced-same-commit-interop.test.ts` (`@proves surface: repo.checkout`,
  `interopSurface: checkout`): `describe.each` over A.1 shapes × `{ -f HEAD, -f main, -f <oid>, -f t, detached -f HEAD }`.
  Row shape `{ shape, command, expected: 'git' }`. It also holds set 3 (bare `HEAD` / `@` spellings), set 4 (branch
  state removed) and set 5 plus A.4 (unforced refresh: `all`, `refuse`, `same`; stale set compared through
  `ls-files --debug` vs `lstat`, flags through `ls-files -v`). Fixtures come from `occupant-displacement-fixtures.ts`
  (`buildHistory`, `replacing`, `fileAt`, `danglingLinkAt`, `directoryHolding`, `movedBehindLink`,
  `copiedBehindLink`, `assumingUnchanged`, `listing`, `indexState`), extended with `touchedAt`, `chmodAt`,
  `skipWorktree`, `unmergedAt` (stages 1–3) / `unmergedAbsentAt` (stages 2–3), a `staleEntries(dir)` reader and a
  `rewrittenPaths(before, after)` inode/mtime diff.
- Same file, path restore: C, T, AU, S2, ST rows × `checkout -- f keep`, `checkout HEAD -- f keep`; and the F10 rows
  of A.3 (F10a `-- f`, F10b `-- f keep`, F10c `-- .`, F10d two unmerged, F10g stages 2–3, F10h `-- keep` proceeds,
  F10i glob + `f`, F10k unmatched first, F10e/F10f/F10l tree source). Refusal rows assert git exit 1 and stderr
  `error: path '<p>' is unmerged\n` per path (reconstructed from `paths`), tsgit
  `{ code: 'MERGE_HAS_CONFLICTS', count, paths }`, index file bytes unchanged in both, work tree unchanged, hook log
  empty in both.
- `test/integration/reset-interop.test.ts`: `reset --hard HEAD` × A.1 shapes, with the AU, SW, S3i, UMn rows and the
  clean-tree "nothing rewritten" row; R1/R2 (HEAD log `reset: moving to HEAD`, branch log untouched, ORIG_HEAD) and
  T11i (detached: no entry) guard the extracted `recordHardReset`.
- `test/integration/checkout-leading-symlink-interop.test.ts`: the existing `checkout -f HEAD` row
  (`:173-200`) gains a populated-index variant (the literal 32.27 shape).
- `test/integration/stash-interop.test.ts`: C, T, E rows asserting `keep` is not rewritten; T row asserting the stat
  refresh with "no local changes" (DC5); F11a–F11e (HEAD reflog top `reset: moving to HEAD` attached, none detached,
  branch reflog untouched, a second push adds a second entry); O1/O4 ORIG_HEAD (DC6); F11c/F11d hook log
  `post-checkout <head> <head> 0` (DC7); F12a–F12e + M1 refusals (git exit 1, stdout `<p>: needs merge\n`, stderr
  `error: could not write index\n`; tsgit `MERGE_HAS_CONFLICTS { count, paths }`; `refs/stash` absent, object count,
  index bytes, work tree and reflogs unchanged in both); M2 and K rows if DC8 folds.
- `test/integration/rebase-reset-interop.test.ts`: RB (clean bystander kept, touched one rewritten on `--abort`).

Lesson 015: P1, P3, P5, P7 and P8 change a step every forced checkout, unforced switch, `reset --hard`, path
restore, `stash push` and rebase abort/skip runs. The part gate runs every interop file that drives those commands
(`grep -lE "\.checkout\(|reset\(\{|stash\.push|stashPush|\.abort\(|\.skip\(" test/integration` → 36+ files today)
and reports the count.

Unit (memory adapter, Given/When/Then split, AAA, `sut`):

- `test/unit/application/primitives/internal/stale-entries.test.ts`: one row per verdict branch (skip-worktree,
  lossy, `ENOENT`, `ENOTDIR`, gitlink with and without a directory, mode change, each of mtime / ctime / uid / gid /
  ino / size alone, racy with equal and with different content, `assumeValid` ignored), and the provider built once
  for two racy entries.
- `test/unit/application/primitives/internal/occupant-clash.test.ts` stays green on the moved judge (no new rows).
- `test/unit/application/primitives/materialize-tree.test.ts`: `forceRewriteAll` upgrades only stale `noop`s; the
  flag carry on a rewritten AU entry; `written` counts rewrites only; a stale pass after `projectUnmergedPaths`.
- `test/unit/application/commands/internal/refresh-index.test.ts`: `refreshedIndex` refreshes a touched clean entry
  and keeps a dirty, an assume-unchanged and a skip-worktree one; `refreshAndWriteIndex` refuses an unmerged index
  (data asserted, index bytes unchanged), writes only when something refreshed.
- `test/unit/application/commands/checkout.test.ts`: `staysOnHead`, one row per guard (`HEAD`, `@`, `detach`,
  `createBranch`, other rev); result `branch`/`detached` on attached and detached HEAD; an unforced switch commits a
  refreshed stat, a forced one does not scan; a refused unforced switch leaves the index bytes; path restore refuses
  a matched unmerged path (stages 1–3 and 2–3, two paths in index order), proceeds when the spec misses it, refuses
  unmatched first, fires no hook on refusal, never refuses with a tree source.
- `test/unit/application/commands/stash-unmerged-index.test.ts`: `stashPush` refuses an unmerged index before any
  object or ref write (with `includeUntracked`, `keepIndex`), and before the pending-operation gate.
- `test/unit/application/commands/stash.test.ts`: HEAD reflog entry on attached push, none on detached; ORIG_HEAD
  (DC6); keep-index hook (DC7); `createAutostash` writes none of them.
- `test/unit/application/commands/reset.test.ts`, `internal/reset-worktree.test.ts`: the option and `unmergedPaths`
  reach `materializeTree`; `recordHardReset` keeps `reset`'s ref tail.

Lesson 017: a kill test whose expectation keeps an occupant, refuses or crashes is first reproduced through the
public command against git 2.55. S3i (link kept), SW (edited file kept), F10 and F12 (refusals), A.4 `refuse` are
git's outcomes and are pinned in Appendix A.

Mutation: `stale-entries.ts`, the moved judge, `materialize-tree.ts`, `refresh-index.ts`, `reset-refs.ts`, the
`checkout.ts` switch and path-restore regions, `stashPush`; narrowed Stryker buckets per prefix.

## Out of scope

- The `core.filemode` hunch and `createAutostash` (above).
- The two-way (unforced) merge's own classification of changed paths: unchanged and already covered by #331.
- `update`s whose id changes: their flags stay fresh as today (no row probes `CE_VALID` across a content change).
- git options tsgit's API does not expose: path restore `-f` / `--ours` / `--theirs` / `--merge`, `stash push --
  <pathspec>`, `--staged`, `--patch`.
- Not probed, behaviour unchanged: a forced checkout on an unborn HEAD, intent-to-add entries, `core.filemode=false`,
  `core.logAllRefUpdates=false` beyond an existing HEAD log (git still appends, F11h; tsgit's reflog writer is shared
  with `reset`).

## Appendix A — pinned matrix (git 2.55.0 vs tsgit fb6bc5b0)

### A.1 — forced switch and `reset --hard HEAD`

"rewrote" = a path present before whose inode or mtime changed. Bystanders `keep` and `other` are omitted from the
tree column. git's work tree, index (`ls-files -s`) and rewritten set are identical across the five forced spellings
(`-f HEAD`, `-f main`, `-f <oid>`, `-f t`, detached `-f HEAD`); so are tsgit's. `ls-files -s` is equal between the
tools on every row. Stale index entries after `-f main` (the probe's `ino`/size/mtime check): git only SW (the
edited skip-worktree file it never touches); tsgit E, T, Dw, AU, SW, S3a, S3g, S1, S3b, LF, S3f, S3d, LR, GLf.

| shape | git work tree (all `-f`) | git rewrote | tsgit work tree | tsgit rewrote | `reset --hard` rewrote: git / tsgit | `reset --hard` tree/flags delta |
|---|---|---|---|---|---|---|
| C clean | `f=v1` | — | `f=v1` | — | — / f keep | — |
| E content edit | `f=v1` | f | `f=edited` | — | f / f keep | — |
| T touch only | `f=v1` | f | `f=v1` | — | f / f keep | — |
| M mode only | `f=v1` | f | `f=v1` (+x) | — | f / f keep | — |
| Dw deleted | `f=v1` | (recreated) | (absent) | — | — / keep | — |
| AU assume-unchanged edit | `f=v1`, flag `h` | f | `f=edited` | — | f / f keep | flags: git `h f` ts `H f` |
| SW skip-worktree edit | `f=edited`, flag `S` | — | `f=edited` | — | — / f keep | tree: git `f=edited` ts `f=v1`; flags: git `S f` ts `H f` |
| S3a dangling link parent | `a/ a/payload=v1` | a | `a@->nowhere` | — | a / a keep | — |
| S3g link parent to copy | `a/ a/payload=v1 held/…` | a a/payload | `a@->held held/…` | — | a a/payload / a a/payload keep | — |
| S3i link parent to moved dir | `a@->held held/payload=v1` | — | same | — | — / a a/payload keep | tree: git keeps `a@->held`, ts `a/ a/payload=v1` |
| S1 file where dir | `d/ d/x=v1` | d | `d=occupant` | — | d / d keep | — |
| S2 populated dir where file | `f=v1` | f | `f/ f/u=untracked` | — | f / f keep | — |
| S2e empty dir where file | `f=v1` | f | `f/` | — | f / f keep | — |
| S3b dangling link where file | `f=v1` | f | `f@->nowhere` | — | f / f keep | — |
| LF link to same content where file | `f=v1 g=v1` | f | `f@->g g=v1` | — | f / f g keep | — |
| S3f file where link | `l@->t-v1` | l | `l=t-v1` | — | l / keep l | — |
| S3c populated dir where link | `l@->t-v1` | l | `l/ l/u=untracked` | — | l / keep l | — |
| S3d file where dir of link | `d/ d/l@->t-v1` | d | `d=occupant` | — | d / d keep | — |
| LR link retargeted | `l@->t-v1` | l | `l@->elsewhere` | — | l / keep l | — |
| GL gitlink, empty dir | `s/` | — | `s/` | — | — / keep | — |
| GLf file where gitlink | `s/` | s | `s=occupant` | — | s / keep s | — |
| ST staged edit | `f=v1` | f | `f=v1` | f | f / f keep | — |
| SA staged new file | `f=v1` (n removed) | — | same | — | — / f keep | — |
| SD staged delete | `f=v1` | — | same | — | — / keep | — |
| SDk `rm --cached` | `f=v1` | f | same | f | f / f keep | — |
| U untracked | `f=v1 u=untracked` | — | same | — | — / f keep | — |
| UM unmerged f | `f=v1` | f | same | f | f / f keep | — |
| UMn unmerged n, absent from HEAD | `f=v1` (n removed) | — | `f=v1 n=conflicted` | — | — / f keep | tree: git removes `n`, ts keeps it |

GLp (git only): gitlink `s` at C1 with the submodule checked out at C2 → `checkout -f HEAD` exit 0, submodule HEAD
stays C2, index `160000 C1 s`, `status` ` M s`. RB (git only): `rebase --abort` after a conflict stop keeps a clean
bystander's inode and rewrites a touched one.

HEAD and reflog, every shape (exit 0 everywhere in set 1):

| command | git HEAD after | git reflog | tsgit HEAD after | tsgit reflog |
|---|---|---|---|---|
| `checkout -f HEAD` (on `main`) | `refs/heads/main` | no entry | detached | `checkout: moving from main to HEAD` |
| detached `checkout -f HEAD` | detached | no entry | detached | `checkout: moving from <oid> to HEAD` |
| `checkout -f main` (on `main`) | `refs/heads/main` | `checkout: moving from main to main` | same | same |
| `checkout -f <oid>` | detached | `checkout: moving from main to <oid>` | same | same |
| `checkout -f t` | `refs/heads/t` | `checkout: moving from main to t` | same | same |

### A.2 — sets 2–5

| row | git 2.55 | tsgit fb6bc5b0 |
|---|---|---|
| `checkout HEAD` (unforced), any shape | HEAD stays `refs/heads/main`, no reflog | detached, `checkout: moving from main to HEAD` |
| `checkout @` / `checkout -f @` | stays, no reflog | detached, `checkout: moving from main to @` |
| detached `checkout HEAD` | no reflog | `checkout: moving from <oid> to HEAD` |
| `checkout HEAD~0` | detached, `checkout: moving from main to HEAD~0` | same |
| `checkout [-f] --detach HEAD` | detached, `checkout: moving from main to HEAD` | same |
| `checkout -b nb HEAD` | `refs/heads/nb`, `checkout: moving from main to nb` | same |
| state planted × `checkout -f HEAD` / `-f main` | `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `MERGE_MSG`, `MERGE_MODE` removed; `ORIG_HEAD` kept | same state files (HEAD/reflog as A.1) |
| T × `checkout HEAD`, `checkout main`, `checkout t`, `checkout --detach main` | index stat refreshed (`f` not stale), nothing rewritten | `f` stale, nothing rewritten |
| E, S3a × unforced `checkout HEAD` / `main` | `f` / `a/payload` stays stale, nothing rewritten | same (HEAD/reflog as above) |
| UM, UMn × unforced `checkout HEAD` / `main` | exit 1 `error: you need to resolve your current index first` | `MERGE_HAS_CONFLICTS`, nothing changed |
| C, U, SA, ST, UMn × `checkout -- f keep` | rewrote — | rewrote f keep |
| Dw × `checkout -- f keep` / `checkout HEAD -- f keep` | `f` recreated, rewrote — | `f` recreated, rewrote keep |
| SD, SDk × `checkout -- f keep` | exit 1 `pathspec 'f' did not match` | `PATHSPEC_NO_MATCH` |
| SD × `checkout HEAD -- f keep` | `f` recreated, rewrote — | `f` recreated, rewrote keep |
| C, U, SA, UMn × `checkout HEAD -- f keep` | rewrote — | rewrote f keep |
| E, T, M, S2, S2e, S3b, LF × `checkout -- f keep` / `checkout HEAD -- f keep` | rewrote f | rewrote f keep |
| AU × `checkout -- f keep` / `checkout HEAD -- f keep` | rewrote f, flag `h` kept | rewrote f keep, flag `H` |
| ST, SDk × `checkout HEAD -- f keep` | rewrote f | rewrote f keep |
| UM × `checkout -- f keep` | exit 1 `error: path 'f' is unmerged`, stages 1–3 kept | ok, every stage of `f` dropped (no stage-0 entry), `keep` rewritten (A.3) |
| UM × `checkout HEAD -- f keep` | rewrote f | rewrote f keep |
| SW, S3i, GL, GLf × path restore | exit 1 `pathspec 'f' did not match` | `PATHSPEC_NO_MATCH` |
| E, M, S1, S2, S2e, S3b, LF, S3f, S3c, S3d, LR, ST, SDk × `stash push` | rewrote only the stashed path; HEAD reflog `reset: moving to HEAD` | rewrote every path; no HEAD reflog entry |
| SA, SD, Dw × `stash push` | rewrote —; HEAD reflog `reset: moving to HEAD` | rewrote `f keep` (SA) / `keep`; no HEAD reflog entry |
| C, U × `stash push` | nothing to stash, nothing rewritten | same |
| T × `stash push` | nothing rewritten, index stat refreshed | nothing rewritten, `f` stale |
| UM × `stash push` | exit 1, stdout `f: needs merge`, stderr `error: could not write index`, nothing changed | ok: stashed, `f` reset to v1, stages dropped |
| S3a, S3g, S3i × `stash push` | exit 1 `'a/payload' is beyond a symbolic link` | `PATHSPEC_BEYOND_SYMLINK` |

### A.3 — path restore and `stash push` refusals, ref tail (git 2.55.0 vs tsgit fb6bc5b0)

History: `base` = `f=v1`, `g=g1`, `keep=k` on `main`. `unmerged <p>` = stages 1–3 (`base`/`ours`/`theirs`), work
file `conflicted`; `unmerged2 <p>` = stages 2–3 only, path absent from HEAD. `keep` edited to `kedit` unless noted.
"nothing written" = `ls-files -s`, work tree, index file hash, object count, `refs/stash`, HEAD and branch reflogs,
hook log all equal before and after. stdout/stderr are git's bytes, each line `\n`-terminated.

| row | setup → command | git 2.55 | tsgit fb6bc5b0 |
|---|---|---|---|
| F10a | unmerged f → `checkout -- f` | exit 1, stderr `error: path 'f' is unmerged`, nothing written, no hook | ok `changedPaths: 0`; index drops every stage of `f` (status `D  f`, `?? f`), work file kept, hook fired |
| F10b | unmerged f → `checkout -- f keep` | exit 1, same stderr, `keep` stays `kedit`, nothing written | ok; `f` stages dropped, `keep` restored to `k`, hook fired |
| F10c | unmerged f → `checkout -- .` | exit 1, `error: path 'f' is unmerged`, nothing written | not run; same code path as F10d |
| F10d | unmerged f, g → `checkout -- .` | exit 1, stderr `error: path 'f' is unmerged` then `error: path 'g' is unmerged`, nothing written | ok; `f`, `g` stages dropped, `keep` restored, hook fired |
| F10g | unmerged2 n → `checkout -- n keep` | exit 1, `error: path 'n' is unmerged`, nothing written | ok; `n` dropped from the index (`?? n`), `keep` restored |
| F10h | unmerged f → `checkout -- keep` | exit 0, `keep` restored, `f` stages kept, hook `<h> <h> 0` | same |
| F10i | unmerged f → `checkout -- 'k*' f` | exit 1, `error: path 'f' is unmerged`, nothing written | not run; same code path as F10b |
| F10k | unmerged f → `checkout -- nosuch f` | exit 1, stderr `error: pathspec 'nosuch' did not match any file(s) known to git` only, nothing written | `PATHSPEC_NO_MATCH { pattern: 'nosuch' }`, nothing written |
| F10e | unmerged f → `checkout HEAD -- f keep` | exit 0, `f` stage 0 = HEAD's, `f=v1`, `keep=k`, hook fired | same |
| F10f | unmerged f → `checkout HEAD -- .` | exit 0, as F10e | same |
| F10j | unmerged2 n → `checkout HEAD -- n` | exit 1, `error: pathspec 'n' did not match any file(s) known to git` | `PATHSPEC_NO_MATCH` |
| F10l | unmerged2 n → `checkout HEAD -- .` | exit 0, `n` stages 2–3 and work file kept, `keep` restored, hook fired | same |
| F10m | unmerged2 n → `checkout HEAD -- n keep` | exit 1, pathspec `n` no match, nothing written | not run; same code path as F10j |
| F11a | `f` edited → `stash push -q` | exit 0; HEAD reflog top `reset: moving to HEAD` (raw: old = new = HEAD oid, `Ada <ada@example.com> 1700000000 +0000`); `main` reflog untouched; `refs/stash` reflog `WIP on main: 03f5ad2 base`; ORIG_HEAD = HEAD; no hook | exit ok; no HEAD reflog entry; no ORIG_HEAD; stash and its reflog same message |
| F11b | + untracked `u` → `stash push -q -u` | as F11a | not run; same code path as F11a |
| F11c | + `keep` staged → `stash push -q --keep-index` | as F11a, plus hook `post-checkout <h> <h> 0`; index keeps staged `keep`, tree `keep=s` | no HEAD reflog entry, no hook; index and tree same |
| F11d | `-u --keep-index` | as F11c | not run; same code path as F11c |
| F11e | detached HEAD → `stash push -q` | exit 0, no HEAD reflog entry, ORIG_HEAD = HEAD (O4), `WIP on (no branch): …` | no entry (same), no ORIG_HEAD |
| F11f | `stash push` (not quiet) | stdout `Saved working directory and index state WIP on main: 03f5ad2 base`, reflog as F11a | (rendering, ADR-249) |
| F11g | second push | two `reset: moving to HEAD` entries | none |
| F11h | `core.logAllRefUpdates=false`, HEAD log exists | entry still appended | (not probed) |
| R2 / R1 | `f` edited → `reset -q --hard HEAD` | HEAD log `reset: moving to HEAD`, `main` log untouched, ORIG_HEAD = HEAD | same |
| F11i / T11i | detached → `reset -q --hard HEAD` | no reflog entry | same |
| F12a | unmerged f → `stash push -q` | exit 1, stdout `f: needs merge`, stderr `error: could not write index`, nothing written (8 objects before and after, no `refs/stash`) | ok: stashed (13 objects), index `f` stage 0 = v1, tree `f=v1`, `keep=k` |
| F12b | + untracked `u` → `stash push -q -u` | as F12a, `u` kept | not run; same code path as F12a |
| F12c | `stash push -q --keep-index` | as F12a | not run; same code path as F12a |
| F12d | unmerged2 n → `stash push` | exit 1, stdout `n: needs merge`, stderr `error: could not write index`, nothing written | ok: stashed, `n` dropped from the index, work file `n` left untracked |
| F12e | unmerged f, `keep` clean → `stash push` | as F12a | not run; same code path as F12a |
| M1 / TM1 | real `merge side` conflicted on `f` (`MERGE_HEAD`, `MERGE_MODE`, `MERGE_MSG`) → `stash push -q` | exit 1, stdout `f: needs merge`, stderr `error: could not write index`, nothing written | `OPERATION_IN_PROGRESS { operation: 'merge' }`, nothing written |
| M2 | same merge, `f` resolved and added, `keep` edited → `stash push -q` | exit 0, stashed, `MERGE_HEAD`/`MERGE_MODE`/`MERGE_MSG` removed, HEAD log `reset: moving to HEAD` | `OPERATION_IN_PROGRESS` (by code, `stash.ts:575`) |
| K | marker planted (= HEAD) + `f` edited → `stash push -q` | exit 0 for each of `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` (marker removed) and `REBASE_HEAD` (marker kept); ORIG_HEAD written | `OPERATION_IN_PROGRESS` |
| O1 / O2 | `f` edited → `stash push -q` | ORIG_HEAD = HEAD oid | no ORIG_HEAD |

### A.4 — unforced switch refresh set (git 2.55.0 vs tsgit fb6bc5b0)

History: `base` = `f`, `a`, `s`, `g`, `keep` on `main`; `t` = `base` + `g=g2`, `other`. Index refreshed and older than
1 s before planting. "stale" = `ls-files --debug` mtime second differs from `lstat`.

| row | planted | command | git: stale after | tsgit: stale after |
|---|---|---|---|---|
| all | `f` touched; `a` assume-unchanged + touched; `s` skip-worktree + touched; `keep` edited; `g` touched (changed by the switch) | `checkout t` | `a`, `keep`, `s` (flags `h a`, `S s` kept) | `a`, `f`, `keep`, `s` |
| refuse | `f` touched; `g` edited | `checkout t` → exit 1 `error: Your local changes to the following files would be overwritten by checkout:` / `\tg` / `Please commit your changes or stash them before you switch branches.` / `Aborting` | `f`, `g` (nothing written) | `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['g'] }`; `f`, `g` |
| same | `f` touched | `checkout main` (on `main`) | none | `f` |
