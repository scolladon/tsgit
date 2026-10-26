# Design — forced-checkout-same-commit

> Brief: backlog 32.27 — `checkout -f HEAD` with a populated index leaves a symlinked parent `a` in place where git
> 2.55 replaces the link with a directory (tracked `a/payload`). Root cause known (ADR-1080): the forced switch never
> reaches the apply because every unchanged path classifies `noop`. Fix the classification as git's one-way reset
> does, reuse the displacement shipped in #331, and fold every in-perimeter caller of the same classification.
> Status: draft → self-reviewed ×3

## Context

- The forced switch: `switchBranch` (`src/application/commands/checkout.ts:248-322`) calls `materializeTree`
  (`:285-294`) with `force: true`, no `forceRewriteAll`, no `headTree` (`headTreeOption` `:236-246` returns `{}` when
  forced), no `unmergedPaths`. Then `moveHead` (`:311`) always writes HEAD and a `checkout: moving from <x> to <arg>`
  reflog entry, `removeBranchState` (`:312`), `post-checkout` (`:315`).
- `materializeTree` (`src/application/primitives/materialize-tree.ts:475-528`): `computeChangeset` (`:488`, pure,
  `compute-changeset.ts:64-100` — `noop` iff index `id`+`mode` equal the target's), optional `projectUnmergedPaths`
  (`:489-491`), then `forceRewriteAll === true ? upgradeNoopsToUpdates(...)` (`:493-494`, `:290-299`: EVERY `noop`
  becomes `update`). `splitWaves` drops `noop` entries before the apply. `mergeNewIndexEntries` (`:218-235`) takes a
  written entry (post-write `lstat`, `STAGE0_FLAGS`, via `indexEntryFromStat`
  `internal/index-entry-from-stat.ts:38-58`) over the donor entry.
- `forceRewriteAll: true` callers (ADR-023 introduced it for `reset --hard`):

| caller | git counterpart |
|---|---|
| `reset.ts:179-191` | `reset --hard <rev>` |
| `checkout.ts:463-474` (`materializePathRestoreFromIndex`) | `checkout -- <p>` |
| `checkout.ts:485-497` (`materializePathRestoreLocked`) | `checkout <rev> -- <p>` |
| `stash.ts:811-816` (`resetAfterPush`) | `stash push`'s `reset --hard` |
| `internal/reset-worktree.ts:55` (`hardResetWorktreeToCommit`, from `merge.ts:887`) | merge strategy rewind, `reset --hard HEAD` |
| `internal/reset-worktree.ts:72-80` (`attemptProtectedResetWorktreeToCommit`) | `rebase --abort` / `--skip`, rebase-merges `reset` |

- `materializeTree`, `MaterializeTreeOpts` and `forceRewriteAll` are public (`src/application/primitives/index.ts:64-65`,
  `reports/api.json` `MaterializeTreeOpts.forceRewriteAll`).
- Stat judgement already in the tree, git's `ie_match_stat` as `verify_uptodate` uses it:
  `matchesCachedStat` (`internal/occupant-clash.ts:156-166`, private): mode (`deriveWorkingMode`) + `matchesContentStat`
  (`internal/is-entry-stat-clean.ts:76-82`: mtime, ctime, uid, gid, ino, size; `dev` excluded), then for a racy entry
  (`isRacy` `:26-30`) a content compare with checkin attributes (`compareFile`). It ignores `assumeValid`.
  `lstatBeyondLink` (`occupant-clash.ts:142-151`) maps `NOT_A_DIRECTORY` to unreachable. Status's
  `isEntryStatClean` (`is-entry-stat-clean.ts:83-91`) honours `assumeValid` and `compareAndRefresh`
  (`compare-working-tree-entry.ts:332`) hashes a stat-dirty file; neither is git's one-way-reset rule (see T and AU
  rows).
- Bounded fan-out: `boundedMapFor(ctx, 'ioBound')` (`internal/concurrency.ts`), used by `scan-tracked-entries.ts`.
- `GitIndex.indexMtime` (`domain/git-index/index-entry.ts:95`) is filled by `readIndex`; every caller above reads the
  index under its lock just before `materializeTree`.
- Constraints: ADR-226 (byte-faithful work tree, index, reflog, refusals), ADR-249 (structured data), ADR-023 (the
  `forceRewriteAll` contract this design refines), ADR-1075 (displacement before the write wave, reused as-is),
  ADR-1080 (this fix kept separate).

## Requirements

- R1 A forced switch (`checkout -f <HEAD | @ | branch | oid | other commit>`) rewrites every stage-0 entry whose
  target `id`+`mode` equal the index's and whose work-tree path is not up to date, and leaves every up-to-date one
  untouched (no write, donor stat kept). Every occupant shape of Appendix A ends as git 2.55 leaves it.
- R2 "Up to date" is git's `ie_match_stat` with `CE_MATCH_IGNORE_VALID | CE_MATCH_IGNORE_SKIP_WORKTREE` on an
  `lstat` of the whole path (leading symlinks followed): absent (`ENOENT`) or unreachable (`ENOTDIR`) is stale; a
  mode/type change is stale; any of mtime, ctime, uid, gid, ino, size differing is stale (a `touch` alone is stale);
  all equal and not racy is up to date; all equal and racy is decided by content (the racy branch is the one #331
  pinned for `verify_uptodate`, design `forced-checkout-displace-occupant.md` "As shipped"; this matrix avoids racy
  entries). `assumeValid` is ignored. A
  skip-worktree entry is never judged and never rewritten. A gitlink is up to date iff a directory stands at its path.
- R3 A rewritten up-to-date-by-id entry keeps the prior entry's `assumeValid` flag (git keeps `h`).
- R4 Every `forceRewriteAll` caller (table above) follows R1–R3 instead of rewriting every path: `reset --hard`,
  path restore, `stash push`, rebase abort/skip, the merge rewind. Clean files are not rewritten.
- R5 A forced switch and `reset --hard` reset an unmerged path to the target: a conflicted path absent from the target
  is removed from the work tree and the index (UMn rows).
- R6 `checkout HEAD` / `checkout @` (forced or not, attached or detached, no `--detach`, no `-b`) moves no ref and
  writes no reflog entry; HEAD stays attached to its branch. Branch state (`MERGE_HEAD`, `CHERRY_PICK_HEAD`,
  `MERGE_MSG`, `MERGE_MODE`) is still removed and `post-checkout` still fires. `HEAD~0`, `--detach HEAD`, `-b x HEAD`
  keep today's (already faithful) behaviour.
- R7 (DC4) An unforced switch refreshes the index stat of a stat-dirty, content-clean entry as git does.
- R8 Every Appendix A row SAME today stays SAME; every DIFF row covered by R1–R7 becomes SAME. Out-of-perimeter rows
  (§ Out of perimeter) are unchanged.

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

### Parity summary

319 pairs. Set 1: 168 pairs, 30 SAME. Of the 140 forced-switch pairs, 90 differ in work tree, flags, stale index or
rewritten set; every `-f HEAD` / detached `-f HEAD` pair (56) differs in HEAD attachment or reflog. `ls-files -s`
never differs in set 1. Set 2: 140 pairs, 63 SAME. Sets 3–5: 11 pairs, 5 SAME.

Findings, each with the rows that prove it (Appendix A):

| # | Finding | Proof rows | Perimeter |
|---|---|---|---|
| F1 | Forced switch rewrites nothing; git rewrites every stale entry and displaces the occupant | E, T, M, Dw, AU, S3a, S3g, S1, S2, S2e, S3b, LF, S3f, S3c, S3d, LR, GLf × 5 spellings | in (32.27) |
| F2 | git leaves an up-to-date entry alone even beyond a symlinked leading directory | S3i (both tools keep the link); GL, SW, C; GLp (git only) | regression guard |
| F3 | `reset --hard`, path restore, `stash push` rewrite every file; git only stale ones | C, T, Dw, SA, U … (`rewritten` column); RB (`rebase --abort`) | in (R4) |
| F4 | `reset --hard` drops the assume-unchanged flag; path restore too | AU × `reset --hard`, `checkout -- f`, `checkout HEAD -- f` | in (R3) |
| F5 | `reset --hard` rewrites a skip-worktree entry and drops its flag | SW × `reset --hard` | in (R2) |
| F6 | `reset --hard` replaces a link git keeps (stat through it matches) | S3i × `reset --hard` | in (R2) |
| F7 | Forced switch and `reset --hard` keep the work file of an unmerged path absent from the target | UMn × set 1 | in (R5) |
| F8 | `checkout HEAD` / `@` detaches and logs; git stays and logs nothing | every `-f HEAD`, `checkout HEAD`, `@` row | in (R6) |
| F9 | Unforced switch leaves a touched entry's stat stale; git refreshes it | T × `checkout HEAD`, `checkout main`, `checkout t`, `--detach main` | DC4 |
| F10 | `checkout -- f` on an unmerged `f`: git exits 1 `error: path 'f' is unmerged`, index kept; tsgit succeeds and drops the stages | UM × `checkout -- f keep` | out (DC5) |
| F11 | `stash push` writes no HEAD `reset: moving to HEAD` reflog entry | every `stash push` row that stashes | out (DC5) |
| F12 | `stash push` on an unmerged index: git exits 1 (`error: could not write index`), nothing stashed; tsgit stashes and resets | UM × `stash push` | out (DC5) |

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

### Fix design

**P1 — the stale-entry pass (RC1, RC2)** — new internal module
`src/application/primitives/internal/stale-entries.ts`, consumed by `materializeTree` in place of
`upgradeNoopsToUpdates`:

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

- `matchesCachedStat` and `lstatBeyondLink` move out of `occupant-clash.ts` into a shared internal home
  (`internal/is-entry-stat-clean.ts` for the judge, or a sibling `internal/index-stat-match.ts`; DC2), exported, and
  `occupant-clash.ts` imports them back: one `ie_match_stat`, two consumers. The racy branch builds its checkin
  attribute provider lazily, once per pass (today it builds one per call).
- The upgraded entry keeps `previousId`/`previousMode` = the index's, so the apply's displacement (ADR-1075) runs
  unchanged: S1, S3c, S3d need P1 of #331, the rest are plain writes.
- `materializeTree` order: `computeChangeset` → `projectUnmergedPaths` (when `reset`) → stale pass (when the option
  is set; DC1) → apply. The stale pass only touches `noop` entries, all stage-0, so it never meets a conflict stage.
- Sparse: `plan.indexForDiff` already lacks skip-worktree entries under a matcher; without a matcher, a manually set
  skip-worktree entry stays `noop` (R2).
- `MaterializeTreeResult.written` now counts rewrites only. `reset.ts:200`'s
  `written > 0 || deleted > 0 || matcher !== undefined` guard stays correct: every index change the reset makes is an
  `add`/`update`/`delete`; an all-up-to-date tree leaves the index as it was. The comment at `checkout.ts:498-503`
  ("`written` is always `pathSet.size`") becomes false and is reworded; the commit there is already unconditional.

**P2 — flag carry (RC3)** — `mergeNewIndexEntries` / `pickEntry` (`materialize-tree.ts:209-235`): when the written
entry replaces an old stage-0 entry with the same `id` and `mode`, the result keeps the old entry's `assumeValid`
flag. Only flags git copies for an identical entry: `assumeValid` is the one pinned (AU rows); skip-worktree entries
never reach a write (P1). An `update` whose id changed keeps today's fresh flags (not probed, unchanged).

**P3 — callers (RC1, RC2, RC4)** — option per DC1 (shown with the recommended rename `rewriteStale`):

| caller | today | after |
|---|---|---|
| `checkout.ts:285` forced switch | `force` | `force`, `rewriteStale: true`, `unmergedPaths: 'reset'` (forced only; the unforced path already refuses an unmerged index, `rejectUnmergedIndex` `:284`) |
| `reset.ts:179` | `force`, `forceRewriteAll` | `force`, `rewriteStale`, `unmergedPaths: 'reset'` |
| `checkout.ts:463`, `:486` path restore | `forceRewriteAll` | `rewriteStale` |
| `stash.ts:811` | `forceRewriteAll` | `rewriteStale` |
| `reset-worktree.ts:55` merge rewind | `forceRewriteAll` | `rewriteStale` (+ `unmergedPaths: 'reset'` per DC3) |
| `reset-worktree.ts:72` protected reset | `forceRewriteAll`, `unmergedPaths: 'reset'` | `rewriteStale`, `unmergedPaths: 'reset'` |

The unforced switch does not get the option: git's two-way merge keeps an entry HEAD, the index and the target agree
on without writing it (T, E, S3a × unforced rows rewrite nothing).

`reset-worktree.ts`'s `ResetMode` pick (`:27-29`) and module doc (`:1-4`), `materialize-tree.ts:14-28` stat-source
contract and the option's TSDoc, `reset.ts:168-187` and `checkout.ts:466-472`, `:490-495` comments are rewritten to
state git's rule. ADR-023's "every path is written" consequence is refined by the decisions ADR.

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

**P5 — unforced refresh (F9; only if DC4 = fold)** — after the two-way apply, the unforced switch refreshes stage-0
entries it kept (`noop` and carried) whose stat drifted but whose content matches, reusing status's
`compareAndRefresh` (`compare-working-tree-entry.ts:332`) refreshed-entry output, and commits those stats. Cost: one
`lstat` per kept entry plus a hash per stat-dirty one, as `git status` pays.

### Performance

| operation, clean N-file tree | today | after |
|---|---|---|
| `checkout -f <same or other commit>` | 0 I/O for unchanged paths (unfaithful) | N `lstat`, 0 writes (git: N `lstat`) |
| `reset --hard`, `stash push`, rebase abort/skip, merge rewind | N blob reads + inflates + writes + `lstat` | N `lstat`, writes only for stale paths |
| `checkout [<rev>] -- <pathspec>` | one write per matched path | one `lstat` per matched path, writes only for stale |
| unforced switch | unchanged unless DC4 folds (then N `lstat` + hash per stat-dirty) | |

`lstat` fans out through `boundedMapFor(ctx, 'ioBound')`. The racy branch hashes only racy, stat-matching entries
(none on a tree older than its index). No new syscall on clone (`add`-only changesets have no `noop`). Bench plan:
`npm run bench:ab` on `test/bench/checkout.bench.ts` (the forced alternation pays the new `lstat` pass on shared
paths), plus two new scenarios in the same file: `checkout({ rev: 'HEAD', force: true })` and
`reset({ mode: 'hard', rev: 'HEAD' })` on the clean fixture (expected: reset drops by the cost of N writes).

### Adapter impact

None expected. On node, `lstat` follows leading symlinks (POSIX), which S3i pins. The memory adapter's
`lstatIfReachable` / `lstat` resolve through `walk(path, 'no-follow')` (`memory-file-system.ts:206-230`); a
`stale-entries` unit row with a leading link to the moved directory pins that it follows intermediate links. If it
does not, that row is the proof of an adapter defect, fixed in the same part.

### Size-cap impact

P1 ~250–400 B gzip (new module, lazy provider, bounded map), P2 ~40–80 B, P4 ~60–100 B, P5 ~150–250 B if folded;
headroom is under 100 B, so caps are re-measured from a clean build (`rm -rf dist .wireit`) and raised in the same
change. `api.json` changes if DC1 renames the option.

### Out of perimeter

- F10, F11, F12 (proof rows in Appendix A.2): path restore's unmerged refusal, `stash push`'s HEAD reflog entry and
  its unmerged refusal. Different behaviours (refusal paths, reflog writes) in other commands; the stale pass only
  changes which of their paths are rewritten. Warn-and-ask (DC5).
- Hunch, not proven: tsgit never reads `core.filemode` when judging stat (`deriveWorkingMode` compares the exec bit
  unconditionally), so with `core.filemode=false` a `chmod +x` would read stale where git's `ce_match_stat_basic`
  ignores it. To prove: rerun the M row with `core.filemode=false` on both sides.

## Decision candidates

Settled by matching git, so not candidates: the up-to-date rule (R2, every row of A.1), the skip-worktree exemption
(SW), the flag carry (AU), the bare-`HEAD` stay and its exact spellings (set 3, set 4), the UMn reset for the forced
switch and `reset --hard` (F7), and folding R4 into `reset --hard` / path restore / `stash push` / rebase abort and
the merge rewind (F3–F6: same function, proven rows, fold rule; the rewind is git's `reset --hard HEAD`, #331 R15).

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC1 | Public option shape for "rewrite stale noops" | (a) keep `forceRewriteAll`, change its meaning to git's rule (b) rename to `rewriteStale` (breaking, `api.json`, major) (c) add `rewriteStale`, keep `forceRewriteAll` with today's meaning | (b) | (a) leaves a name that says "all" for an option that rewrites only stale paths. (c) keeps an unfaithful mode with no internal caller, which is dead code in the library. (b) costs a major bump; the project already batches breaking changes. Against (b): the work-tree content is the same as today for every shape the old flag got right, so (a) is a docs-only break. |
| DC2 | Home of the shared `ie_match_stat` judge | (a) move `matchesCachedStat` + `lstatBeyondLink` into `internal/is-entry-stat-clean.ts` (b) new `internal/index-stat-match.ts` (c) reuse status's `compareAndRefresh` | (a) | (a) keeps every stat rule in one module. (b) is a new file with one function. (c) hashes a stat-dirty file and reports a touched file clean: git rewrites it (T rows), so (c) is unfaithful. |
| DC3 | Does the merge rewind (`hardResetWorktreeToCommit`) also get `unmergedPaths: 'reset'`? | (a) yes, it is git's `reset --hard HEAD` (b) no, leave it until a row pins it | (b) | No row pins it. A rewind runs between strategies, and whether a conflicted index can reach it needs a multi-strategy conflicting merge probe. To prove: `merge -s resolve -s ort` with a conflicting first strategy that leaves `n` unmerged and absent from HEAD, compared with tsgit's rewind. Against (b): (a) is consistent with `reset.ts`. |
| DC4 | Fold F9 (unforced switch refreshes stat-dirty, content-clean entries) | (a) fold as P5 (b) keep out, warn-and-ask with the T × unforced rows | (a) | Same function (`switchBranch`), proven by four rows. The fold rule applies. Cost: one `lstat` per kept entry on every unforced switch, plus a hash per stat-dirty one, the same as `git status`. Against (a): only the index's stat cache differs (`ls-files -s` equal), and the unforced switch is the hot path. |
| DC5 | F10–F12 (path restore unmerged refusal; `stash push` HEAD reflog; `stash push` unmerged refusal) | (a) keep out, warn-and-ask with the A.2 rows (b) fold | (a) | These are refusal and reflog behaviours of other command paths, not the classification. Folding needs their own refusal pins (message class, state kept). Against (a): `stash.ts` and the path restore call sites are edited by P3 (option rename). |

## Test strategy

Interop, against git 2.55 (`PATH` must resolve `git` to 2.55.0; the suite asserts the version as the #331 suites do).
Each row compares the work-tree listing (with exec bit), `ls-files -s`, `ls-files -v`, the rewritten set and, for
switch rows, HEAD's symref and HEAD reflog (count and top subject). Racy entries are avoided without sleeping
(lesson 012): after building, back-date every work file's mtime with `utimesSync(now - 10 s)` and run
`git update-index --refresh` in both peers, so every entry is older than the index.

- New `test/integration/checkout-forced-same-commit-interop.test.ts` (`@proves surface: repo.checkout`,
  `interopSurface: checkout`): `describe.each` over A.1 shapes × `{ -f HEAD, -f main, -f <oid>, -f t, detached -f HEAD }`.
  Row shape `{ shape, command, expected: 'git' }`. It also holds set 3 (bare `HEAD` / `@` spellings), set 4 (branch
  state removed) and, if DC4 folds, set 5 (unforced refresh). Fixtures come from `occupant-displacement-fixtures.ts`
  (`buildHistory`, `replacing`, `fileAt`, `danglingLinkAt`, `directoryHolding`, `movedBehindLink`,
  `copiedBehindLink`, `assumingUnchanged`, `listing`, `indexState`), extended with `touchedAt`, `chmodAt`,
  `skipWorktree`, `unmergedAt` and a `rewrittenPaths(before, after)` inode/mtime diff.
- `test/integration/reset-interop.test.ts`: `reset --hard HEAD` × A.1 shapes, with the AU, SW, S3i, UMn rows and the
  clean-tree "nothing rewritten" row.
- `test/integration/checkout-leading-symlink-interop.test.ts`: the existing `checkout -f HEAD` row
  (`:173-200`) gains a populated-index variant (the literal 32.27 shape).
- Path restore: C, T, AU, S2, ST rows × `checkout -- f keep`, `checkout HEAD -- f keep` in the new file.
- `test/integration/stash-interop.test.ts`: C, T, E rows asserting `keep` is not rewritten.
- `test/integration/rebase-reset-interop.test.ts`: RB (clean bystander kept, touched one rewritten on `--abort`).

Lesson 015: P1 and P3 change a step every forced checkout, `reset --hard`, path restore, `stash push` and rebase
abort/skip runs. The part gate runs every interop file that drives those commands (`grep -lE
"\.checkout\(|reset\(\{|stash\.push|\.abort\(|\.skip\(" test/integration` → 36 files today) and reports the count.

Unit (memory adapter, Given/When/Then split, AAA, `sut`):

- `test/unit/application/primitives/internal/stale-entries.test.ts`: one row per verdict branch (skip-worktree,
  lossy, `ENOENT`, `ENOTDIR`, gitlink with and without a directory, mode change, each of mtime / ctime / uid / gid /
  ino / size alone, racy with equal and with different content, `assumeValid` ignored), and the provider built once
  for two racy entries.
- `test/unit/application/primitives/internal/occupant-clash.test.ts` stays green on the moved judge (no new rows).
- `test/unit/application/primitives/materialize-tree.test.ts`: the option upgrades only stale `noop`s; the flag carry
  on a rewritten AU entry; `written` counts rewrites only; a stale pass after `projectUnmergedPaths`.
- `test/unit/application/commands/checkout.test.ts`: `staysOnHead`, one row per guard (`HEAD`, `@`, `detach`,
  `createBranch`, other rev); result `branch`/`detached` on attached and detached HEAD.
- `test/unit/application/commands/reset.test.ts`, `internal/reset-worktree.test.ts`, `stash.test.ts`: the option
  and `unmergedPaths` reach `materializeTree`.

Lesson 017: a kill test whose expectation keeps an occupant, refuses or crashes is first reproduced through the
public command against git 2.55. S3i (link kept) and SW (edited file kept) are git's outcomes and are already pinned
in Appendix A.

Mutation: `stale-entries.ts`, the moved judge, `materialize-tree.ts`, the `checkout.ts` switch region; narrowed
Stryker buckets per prefix.

## Out of scope

- F10–F12 and the `core.filemode` hunch (above).
- The two-way (unforced) merge's own classification of changed paths: unchanged and already covered by #331.
- `update`s whose id changes: their flags stay fresh as today (no row probes `CE_VALID` across a content change).
- Not probed, behaviour unchanged: a forced checkout on an unborn HEAD, intent-to-add entries, `core.filemode=false`.

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
| UM × `checkout -- f keep` | exit 1 `error: path 'f' is unmerged`, stages 1–3 kept | ok, stages dropped, `keep` rewritten |
| UM × `checkout HEAD -- f keep` | rewrote f | rewrote f keep |
| SW, S3i, GL, GLf × path restore | exit 1 `pathspec 'f' did not match` | `PATHSPEC_NO_MATCH` |
| E, M, S1, S2, S2e, S3b, LF, S3f, S3c, S3d, LR, ST, SDk × `stash push` | rewrote only the stashed path; HEAD reflog `reset: moving to HEAD` | rewrote every path; no HEAD reflog entry |
| SA, SD, Dw × `stash push` | rewrote —; HEAD reflog `reset: moving to HEAD` | rewrote `f keep` (SA) / `keep`; no HEAD reflog entry |
| C, U × `stash push` | nothing to stash, nothing rewritten | same |
| T × `stash push` | nothing rewritten, index stat refreshed | nothing rewritten, `f` stale |
| UM × `stash push` | exit 1 `error: could not write index`, nothing changed | ok: stashed, `f` reset to v1, stages dropped |
| S3a, S3g, S3i × `stash push` | exit 1 `'a/payload' is beyond a symbolic link` | `PATHSPEC_BEYOND_SYMLINK` |
