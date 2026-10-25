# Design — forced-checkout-displace-occupant

> Brief: backlog 32.29 — a checkout-family write must displace an occupant standing where git's checkout displaces it (a file or symlink in a leading path, a directory at the path), on every write path, while every unforced refusal matches git 2.55; every `applyChangeset` caller probed against git 2.55 with each occupant shape, forced and unforced.
> Status: draft → self-reviewed ×3 → accepted

## Context

- `applyChangesetInScope` (`src/application/primitives/apply-changeset.ts:787-814`) validates paths, splits the
  changeset into a delete wave and a write wave, runs the unforced pre-flight `assertNoDirtyOverwrite` → `checkDirty`
  (`:333`) → `evaluateDirtyPath` (`:286`), then `applyAllEntries` (`:712`): `applyDeleteWave` → `clearOccupants`
  (`:693`) → `applyWriteWave` (`:644`).
- Write paths: pooled (`writePooled`, `:629`; with a symlink in the wave `writePhaseOne` `:603` runs links one at a
  time first) and one-at-a-time (`applyWriteWave` `:658-662`, chosen when `everySourceLoadable` is false or a
  `filter.<driver>.process` is configured; with a symlink `writeOneByOne` `:616`). Regular content is written either
  streamed (`writeStreamedBlob`, whose `clearOccupant` `write-working-tree-file.ts:271` removes a directory) or
  in-core (`writeWorkingTreeEntry` → `writeRegularFile` `:78`, whose `rmIfExists` `:46` cannot remove a populated
  directory); symlinks go through the in-core arm (`:131`).
- Leading-path machinery: `createLeadingPathScanner` (`src/application/primitives/internal/symlinked-leading-path.ts`),
  memoised per prefix; `walkLeadingComponents` (`:141`) stops on a regular-file component (`:149`) and only reports
  symlinks; `ensureLeadingDirectories` (`:219`) is git's `create_directories`.
- Callers: `applyChangesetWithAttributes` from `materializeTree` (`materialize-tree.ts:396`) and
  `applySparseCheckout` (`commands/internal/apply-sparse-checkout.ts:214`, always `force: true`). `materializeTree`
  callers and their flags:

| caller | git equivalent probed | `force` | `forceRewriteAll` | own pre-flight |
|---|---|---|---|---|
| `checkout.ts:285` switch | `checkout t`, `checkout -f t`, `checkout -f HEAD` | opt | no | — |
| `checkout.ts:463` / `:486` path restore | `checkout -- p`, `checkout <rev> -- p` | yes | yes | — |
| `reset.ts:179` | `reset --hard <rev>` | yes | yes | — |
| `stash.ts:666` (push) | `stash push` | yes | yes | — |
| `internal/reset-worktree.ts:31` | `merge --abort` | yes | yes | — |
| `merge.ts:1053` fast-forward | `merge t` (ff) | no | no | — |
| `pull.ts` → merge; `pull.ts:440` | `pull <remote> t` (ff) | no | no | — |
| `internal/pull-into-void.ts:44` | `pull` into an unborn branch | no | no | — |
| `apply-merge-to-worktree.ts:538` (cherry-pick, revert, rebase, stash apply/pop, merge non-ff) | `cherry-pick t`, `merge t` (non-ff), `stash apply`, `stash pop` | yes | no | `findWouldOverwrite` (`find-would-overwrite.ts:113`) |
| `worktree.ts:211`, `materialize-worktree-from-head.ts:26` (submodule clone) | — | no | no | — |

  `worktree add` and the submodule materialisation write into a directory the command itself just created
  (`worktree.ts:115-119` refuses an existing non-empty target before materialising; `submodule.ts:752/914` materialise right
  after `cloneSubmoduleInto`), so no occupant can stand there; they get no probe row.
- Constraints: ADR-226 (byte-for-byte work-tree and index state, refusal conditions), ADR-249 (refusals are data:
  `localChanges` / `untracked` arrays, no display strings). Precedent (`docs/design/status-gitlink-parity.md` CO46):
  git's "Updating the following directories would lose untracked files" maps to tsgit's `untracked` class.

## Requirements

- R1 Forced (and post-pre-flight) writes displace, on the pooled, one-at-a-time, streamed and in-core write paths,
  for regular, symlink and gitlink entries: a regular file or symlink in a leading path is replaced by a directory; a
  directory at the path of an `add` or `update` entry (not a gitlink) is removed with its content.
- R2 A forced delete of a path beneath a regular file succeeds and removes nothing; a forced delete of a path that
  is now a directory (empty or not) leaves the directory and succeeds; the index drops the entry either way.
- R3 Unforced refusals match git 2.55 by class and path list, for every shape in Appendix A:
  `update`/`delete` beneath a regular file → `localChanges: [path]`; `update` at a directory → `localChanges: [path]`;
  `delete` at a directory → `untracked: [path]` when it holds an untracked survivor, else `localChanges: [path]`;
  `add` beneath a regular file or symlink → `untracked: [component]`, once per entry, unless the changeset removes it
  or it is ignored; `add` at a file or symlink → `untracked: [path]` unless ignored.
- R4 The merge-family pre-flight (`findWouldOverwrite`) applies R3's untracked and leading-path rules, so no
  `force: true` merge-family apply overwrites an untracked occupant git protects.
- R5 `pull` into an unborn branch protects ignored occupants too (git's `checkout_fast_forward` with
  `overwrite_ignore = 0`).
- R6 Sparse re-inclusion leaves an occupant (anything at the path, or a file/symlink in a leading path) in place,
  writes nothing for that entry, and clears its skip-worktree bit.
- R7 Every Appendix A row that is SAME on main stays SAME (regression guard); every in-perimeter DIFF row becomes SAME
  except the work-tree residue of git's own post-refusal restore (O3).
- R8 No new syscall on the clone path (all-`add` changesets with nothing on disk): the displacement check reuses the
  per-prefix memo the symlink check already walks.

## Design

### How the matrix was pinned

A throwaway harness (outside the repository, `mktemp -d` per run, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*`
scrubbed, signing off, fixed author/committer dates) builds the same history with git 2.55 plumbing in two sibling
repositories, applies the occupant to both work trees, runs the git command in one and the tsgit equivalent (library
call; `pull` through the `git http-backend` transport of `test/integration/http-backend-transport.ts`) in the other,
then compares the recursive work-tree listing (type, link target, content), `git ls-files -s`, `git ls-files -t` and
the outcome (git exit code + refusal class/paths from stderr; tsgit error `code` + `localChanges`/`untracked`). Every
tsgit row ran on three variants: `pool` (default), `one` (`filter.probe.process` configured, no attribute using it →
one-at-a-time path) and `incore` (`core.autocrlf=true` on both sides → in-core regular writes). git version was
asserted `2.55.0` in each run.

Shapes (`keep` is a tracked bystander in every tree; `t` is the target branch, child of `main`):

| id | occupant | due entry |
|---|---|---|
| S1 | regular file `d` | regular `d/x` |
| S2 | directory `f/` holding untracked `f/u` | regular `f` |
| S3a | dangling symlink `d` | regular `d/x` |
| S3b | dangling symlink `f` | regular `f` |
| S3c | directory `l/` holding untracked `l/u` | symlink `l` |
| S3d | regular file `d` | symlink `d/l` |
| S3e | dangling symlink `d` | symlink `d/l` |
| S3f | regular file `f` | symlink `f` |
| D1–D4 | S1, S2, S3c, S3d occupants | the target DELETES the entry |
| I1–I7 | S1, S2, S3a, S3d, S3c occupants made ignored (`.git/info/exclude`); I6/I7 an ignored file/symlink at an added `f` | as the S row |
| X1–X4 | empty dir at a deleted `f`; ignored-only dir at a deleted `f`; empty dir at an updated `f`; file `d` where a gitlink `d/s` is added | — |
| Y1/Y2 | file / symlink `d` where `d/x` and `d/y` are added | — |

Variants per S/I shape: `/add` (HEAD lacks the entry), `/update` (HEAD has v1, target v2; the work tree replaced
the entry by the occupant), `/same` (HEAD has v1, the command restores HEAD).

### Parity summary

390 (shape, command) pairs probed, each on 2–3 write-path variants (Appendix A has every row). After folding
refusal-class equivalences already ratified (git "would lose untracked files" ≡ `untracked`; `STASH_APPLY_WOULD_OVERWRITE`
≡ git's refusal; "beyond a symbolic link" ≡ `localChanges`), **205 pairs diverge: 187 in the perimeter, 18 outside**.

| root cause | rows (Appendix A) | git 2.55 | tsgit main | perimeter |
|---|---|---|---|---|
| RC1 leading regular file never displaced | S1, S3d, X4 forced (`checkout -f t`, `reset --hard t`/`HEAD`, `checkout [t\|HEAD] -- p`, `stash push`); I1, I4 unforced adds | ok, `d/` real directory, entry written | `NOT_A_DIRECTORY`, nothing written, index unchanged | in |
| RC2 directory at an `update` / in-core / symlink write path | S3c `/update` `/same` forced; S2 `/update` `/same` forced on `incore` only | ok, directory removed, file/link written | `DIRECTORY_NOT_EMPTY` | in |
| RC3 delete wave meets an occupant | D1, D4 forced; D2, D3, X2 forced; X1 forced | ok (D2/D3/X1/X2 warn `unable to unlink 'f'`, directory kept, entry dropped) | D1/D4 `NOT_A_DIRECTORY`; D2/D3/X2 `DIRECTORY_NOT_EMPTY`; X1 removes the empty dir | in |
| RC4a update/delete beneath a regular file, unforced | S1, S3d, I1, I4 `/update`; D1, D4 unforced (`checkout t`, `merge t` ff, `pull` ff) | exit 1 `localChanges: [d/x]` | `NOT_A_DIRECTORY` (pre-flight reads the path as absent; the write throws) | in |
| RC4b directory at an update/delete path, unforced | S2, S3c, I2, I5 `/update`; D2, D3, X1, X2, X3 unforced | exit 1 `localChanges: [f]` (update; delete holding no survivor) / `untracked: [f]` (delete holding a survivor) | `PERMISSION_DENIED` (reads the directory as a file) | in |
| RC4c add beneath a regular file, unforced | S1, S3d, X4, Y1 `/add`; every `pull` into unborn of S1/S3d | exit 1 `untracked: [d]` (once per entry: Y1 lists `d` twice) | `NOT_A_DIRECTORY` | in |
| RC4d ignored file/symlink at an added path, unforced | I6, I7 (`checkout t`, `merge t` ff) | ok, overwritten | refuses `untracked: [f]` | in |
| RC5 merge-family pre-flight misses occupants | S1, S3d `/add` `/update`, D1, D4, I1, I4 (cherry-pick, merge non-ff, stash apply/pop): crash; S3a, S3e, Y2 `/add`: **tsgit overwrites the untracked link git protects**; I2, I5, I6, I7 `/add`: tsgit refuses what git overwrites | refuses / ok per R3 | see left | in |
| RC6 sparse re-inclusion follows links and misses leading files | S1, S3d `/sparse` (`NOT_A_DIRECTORY`); S3a, S3b `/sparse` (**tsgit replaces the untracked link**) | ok + warn `already present`, occupant kept, skip-worktree cleared | see left | in |
| RC7 `pull` into unborn overwrites ignored occupants | I1–I5 `pull … (into unborn)` | exit 1 `untracked` / `would lose untracked` | I2, I3, I5 overwrite (ignored data lost); I1, I4 `NOT_A_DIRECTORY`; I6 ok | in |
| O1 stash snapshot reads a directory | S2, S3c `/same` `stash push` | ok | `PERMISSION_DENIED` (`stash.ts:195`) | out |
| O2 `merge --abort` rewrites untouched paths | every `/same` `merge --abort` | ok, occupant kept | rewrites it (S2: untracked `f/u` deleted) or crashes (RC1/RC2) | out |
| O3 git restores after a merge-strategy refusal | `merge t (non-ff)` on S1/S2/S3c/S3d `/update`, D1–D4, I1/I2/I4/I5 `/update` | exit 2, work tree restored to HEAD | crash today; after this change refuses with the occupant kept | out (residue) |
| O4 forced switch to the same commit is a no-op | every `/same` `checkout -f HEAD` (8 rows) | ok, occupant replaced by HEAD content | ok, occupant left | out (32.27) |

The brief's three cases are RC2 (symlink and in-core regular writes only: the streamed regular writer already removes
a directory, so S2 forced is SAME on `pool`/`one`), RC1 for regular writes, and RC1 for symlink writes on both the
pooled and the one-at-a-time paths.

### Root causes (main 4899565f)

- RC1 — `prepareLeadingDirectories` (`apply-changeset.ts:583-589`) runs only for regular entries of a wave that also
  writes a symlink (`writePhaseOne` `:610`, `writeOneByOne` `:623`); the symlink-free pooled branch (`:635-637`) and
  the symlink-free one-at-a-time branch (`:662`) never call it, and `isLinkWrite` entries (`:574`) skip it on both
  paths. `fs.write`/`fs.symlink` auto-create missing parents but refuse a file in the way (node ENOTDIR; memory
  `memory-file-system.ts:589-594`; browser maps `TypeMismatchError` to it, `browser-file-system.ts:257`).
- RC2 — `clearOccupants` (`:702`) skips every non-`add` entry; the in-core writers then `rmIfExists`
  (`write-working-tree-file.ts:46`) a populated directory, and `FileSystem.rm` removes only a file or an empty
  directory (`src/ports/file-system.ts:182`).
- RC3 — `applyDeleteEntry` (`:366-382`) calls `rmIfExists`, whose `lstat` throws `NOT_A_DIRECTORY` beneath a file
  (only `FILE_NOT_FOUND` is folded, `write-working-tree-file.ts:51`) and whose `rm` refuses a populated directory and
  removes an empty one, where git's `unlink` fails on any directory and warns.
- RC4a — `isDirtyUnder` (`:169-178`) asks `pathIsOccupied`, which folds `NOT_A_DIRECTORY` into "absent"
  (`internal/path-occupied.ts:12-15`); git's `verify_uptodate` only treats `ENOENT` as absent.
- RC4b — `readWorkingBytes` (`:103-122`) `read`s a directory (EISDIR → `PERMISSION_DENIED`).
- RC4c — `untrackedClashOf` (`:265-279`) only knows a symlinked leading component; `isUntrackedClash`'s
  `pathIsOccupied` again folds `NOT_A_DIRECTORY` to absent.
- RC4d — `isUntrackedClash` (`:258`) returns a clash for any non-directory without consulting the ignore rules.
- RC5 — `isUntrackedPresent` (`find-would-overwrite.ts:84-93`) `lstat`s the path itself: beneath a file it throws
  (caught → absent), beneath a dangling symlink it follows the link (absent), at a directory it is present regardless
  of ignore rules; a tracked changed path beneath a file is not flagged (`:133`), so the `force: true` apply then throws `NOT_A_DIRECTORY` at write time.
- RC6 — `includedChange` (`apply-sparse-checkout.ts:140-147`) probes with `ctx.fs.exists` (follows links, cannot see
  a leading file).
- RC7 — `checkoutFromEmptyTree` (`pull-into-void.ts:44-48`) runs `materializeTree` with `force: false`, whose
  unforced policy always exempts ignored occupants (`apply-changeset.ts:726`, `checkDirty`'s `isIgnoredPath`).

### Fix design

Data shape shared by all parts — the scanner learns to name an obstruction, not just a symlink:

```ts
// internal/symlinked-leading-path.ts
export type LeadingObstruction = { readonly path: FilePath; readonly kind: 'symlink' | 'file' };
readonly obstructingLeadingComponent: (path: FilePath) => Promise<LeadingObstruction | undefined>;
```

`walkLeadingComponents` (`:141`) returns the first `symlink` OR `other` component instead of stopping silently at
`other` (`:149`); `symlinkedLeadingComponent` / `hasSymlinkedLeadingPath` become projections of it (same memo, same
verdict cache), so no caller pays an extra `lstat`. A `missing` component still ends the walk.

**P1 — displacement before the write wave (RC1, RC2)** — `clearOccupants` (`apply-changeset.ts:693`), git's
`checkout_entry_ca` occupant handling done once, serially, before any pooled write:

```ts
for (const entry of writes) {                       // add AND update; lossy skipped
  const obstruction = await scanner.obstructingLeadingComponent(entry.path);
  if (obstruction?.kind === 'symlink') continue;    // unchanged: the write unlinks it
  if (obstruction?.kind === 'file') { await displaceFile(obstruction.path, policy); continue; }
  if (entry.mode === FILE_MODE.GITLINK) continue;   // git keeps a directory at a gitlink
  await clearDirectoryAt(entry.path, policy);       // every → rmRecursive; ignored → removeIgnoredBelow
}
```

`displaceFile` removes the file under `every`, and under `ignored` only when the ignore rules match it (after P3 the
pre-flight refused every other one); it re-settles the scanner prefix (`invalidate`) so the memo does not keep a
stale `other`. Each helper stays < 20 lines; `OccupantPolicy` gains the `protected` member of P5. Writes are
untouched: `fs.write` / `fs.symlink` / `mkdir` (gitlink) recreate the parents, `writePhaseOne`'s
`prepareLeadingDirectories` keeps serving links created by the wave itself. The pre-pass is complete because the writers of the work tree during one apply are only: the delete wave (removes
entry paths), `clearOccupants` (removes occupants), and the write wave (creates entry paths and, through the port's
auto-mkdir, their parent directories). None of them can create a file or symlink at a leading component of another
entry of the same wave: a tree cannot hold both `d` and `d/x`, and a deleted tracked `d` is gone before the pass. The
one exception is a case-folding disk (`D` and `d/x`), which stays with the existing `writePhaseOne` fold handling. Cost: adds already pay this walk and the at-path `lstat`; an `update` adds one memoised walk and one
`lstatIfReachable` (R8).

**P2 — delete wave (RC3)** — `applyDeleteEntry` (`:366`) probes with `lstatIfReachable` (`internal/fs-probes.ts:46`):
unreachable or absent → nothing removed, returns `undefined` (not pruned); a directory at a non-gitlink path → left
in place, git's warning emitted (DC4), returns `undefined`; otherwise `rm` as today. The gitlink branch
(`removeEmptyDirectory`) is unchanged.

**P3 — unforced pre-flight (RC4a–d)** — `evaluateDirtyPath` (`:286`) classifies the shape before any content read:

```ts
const obstruction = await scope.scanner.obstructingLeadingComponent(entry.path);
// update / delete (non-gitlink previous):
//   obstruction.kind === 'file'           → { class: 'local-changes', path: entry.path }
//   obstruction.kind === 'symlink'        → not dirty (unchanged: git sees it deleted)
//   directory at path, update             → local-changes
//   directory at path, delete             → holdsSurvivor ? untracked(entry.path) : local-changes
//   otherwise                             → isDirtyUnder (unchanged)
// add:
//   obstruction (file or symlink)         → untracked(obstruction.path) unless removed or ignored
//   directory at path                     → untracked(entry.path) iff holdsSurvivor (unchanged)
//   file / symlink at path                → untracked(entry.path) unless ignored   (RC4d)
```

The directory probe uses the `lstatIfReachable` the add branch already does. `isDirtyUnder`,
`createWorkingTreeDirtyCheck` and `isWorkingTreeDirty` keep their contract (sparse narrowing still uses them); only
the changeset pre-flight learns shapes. Refusal arrays keep one element per entry and `comparePaths` order (Y1/Y2: git
lists `d` once per entry, as tsgit already does for a symlink).

**P4 — merge-family pre-flight (RC5)** — the shape rules of P3 move to one internal module
(`src/application/primitives/internal/occupant-clash.ts`: `classifyOccupant(ctx, entryShape, scope)`), consumed by
`evaluateDirtyPath` and by `findWouldOverwrite` (`find-would-overwrite.ts:113`): an untracked changed path is a clash
per the `add` rules (leading obstruction, directory survivors, ignore rules), replacing `isUntrackedPresent`; a tracked
changed path beneath a regular file is a local change before `compareAndRefresh` runs. The removed set is the merge's
own deletions, passed by `applyMergeToWorktree` (`apply-merge-to-worktree.ts:527`) from `merged.outcomes`
(`resolved-deleted`); `merge.ts:1769`'s conflict path passes the same. (DC2.)

**P5 — ignored occupants protected for `pull` into unborn (RC7)** — `MaterializeTreeOpts` and `ApplyChangesetOpts`
gain `ignoredOccupants?: 'overwrite' | 'protect'` (default `overwrite`, git's `overwrite_ignore = 1`);
`pull-into-void.ts:44` passes `protect`. Under `protect` the pre-flight's ignore probe answers "not ignored" and
`clearOccupants` runs the `protected` policy (removes nothing a pre-flight let through, which is nothing). (DC3.)

**P6 — sparse re-inclusion (RC6)** — `includedChange` (`apply-sparse-checkout.ts:140`) asks "is anything in the way":
`lstatIfReachable` at the path (no follow) or a leading obstruction from one scanner shared by the build. Present →
`noopEntry` (nothing written; `assembleEntries` already clears skip-worktree), and git's `already present` warning per
DC4.

Unforced refusals that already match (every SAME row of Appendix A) keep their code path: P3 only adds branches
before the existing `isDirtyUnder` / `isUntrackedClash`, and their order (shape first, content second) is git's
(`verify_absent` → `check_leading_path`; `verify_uptodate` → `lstat` then `ie_match_stat`).

### Adapter impact

No port change. P1–P6 use `lstat` / `tryLstat` / `lstatIfReachable`, `rm`, `rmRecursive`, `readdir`, `mkdir`, all on
node, memory and browser. A leading regular file is refused `NOT_A_DIRECTORY` by all three (`node` ENOTDIR mapping,
`memory-file-system.ts:589-594`, `browser-file-system.ts:257` maps `TypeMismatchError`), which is what the pre-pass now prevents. Windows:
`rm` of a directory symlink is never issued by the new code (symlinks keep the existing unlink path); P2 never removes
a directory, so the Windows `rmdir`-on-file asymmetry is not reached. The browser adapter has no symlinks, so the
symlink rows are node/memory-only in unit tests.

### Size-cap impact

All six touched modules (`apply-changeset.ts`, `symlinked-leading-path.ts`, new `occupant-clash.ts`,
`find-would-overwrite.ts`, `apply-sparse-checkout.ts`, `pull-into-void.ts` + one option on `materialize-tree.ts`) sit
in the shared chunk reached by `dist/esm/index.js`, `index.node.js`, `index.default.js`, `primitives/index.js` and
`dist/browser/tsgit.js`; per-command entries (`commands/checkout.js`, `reset.js`, `merge.js`, `pull.js`, `stash.js`,
`cherry-pick.js`, `sparse-checkout.js`) may carry part of it depending on chunking. Expected growth ~200–350 B gzip on each facade and the
browser bundle, above the 3–40 B headroom: the caps will trip and are re-baselined from a clean measurement
(`rm -rf dist .wireit` first) in the same change.

### 32.27 verdict — different defect, same family

Proof: every `/same` `checkout -f HEAD` row returns ok with the occupant untouched on all three write paths, while
`reset --hard HEAD` and `checkout -- p` on the same shapes do reach `applyChangeset` (they set `forceRewriteAll`) and
either succeed (S2, S3a, S3b, S3e, S3f) or hit this run's RC1/RC2. The forced switch (`checkout.ts:285-292`) passes
`force` without `forceRewriteAll`, so `computeChangeset` (`materialize-tree.ts:392-394`) classifies every path `noop`
and `splitWaves` (`apply-changeset.ts:419`) drops it: the 32.27 code path ends before `applyChangeset`. Its fix is
classification (git's one-way reset rewrites an index entry whose work-tree stat is not up to date), not displacement.
It depends on this change: once 32.27 upgrades those paths, S1, S3c, S3d need P1 to succeed. Ordering 32.29 → 32.27
holds; widening is DC6.

### Out of perimeter

- O1 `stash push` hashes a directory at a tracked path as a file: `cleanedContent` (`stash.ts:195`) →
  `PERMISSION_DENIED` (S2, S3c `/same` `stash push`; git exit 0, path restored).
- O2 `merge --abort` (`reset-worktree.ts:31-35`, `force` + `forceRewriteAll`) rewrites paths the merge never touched;
  git keeps their occupants (all eight `/same` `merge --abort` rows; S2 deletes the untracked `f/u` today). **Warn:**
  P1 turns S1 and S3d `merge --abort` from a crash into deleting the untracked file `d` (DC5).
- O3 After a merge-strategy refusal git restores HEAD content over the occupant (`merge t (non-ff)` exit 2 rows:
  S2 `/update` work tree ends `f=v1`, `f/u` gone); tsgit refuses and leaves the occupant.
- O4 = 32.27 (above).
- How to prove next (not proven here): `checkout -f HEAD` with a tracked file whose content alone was modified —
  run the same harness row with a content edit instead of an occupant.
- Edge the implementation pins before P1 lands (not probed here): a TRACKED file `d` kept by the index while
  `checkout t -- d/x` restores `d/x` — run the harness row and assert work tree + `ls-files -s` against git.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC1 | Where displacement runs | (a) the serial pre-write `clearOccupants` pass, extended (b) `ensureLeadingDirectories` + directory clear before every write, inside each write path (c) displace-and-retry on `NOT_A_DIRECTORY` / `DIRECTORY_NOT_EMPTY` at write time | (a) | zero new syscalls on the clone path (R8), one place for four write paths, no single-flight needed for concurrent `rm` of a shared prefix that (b)/(c) would race on |
| DC2 | Merge-family pre-flight | (a) extract the shape rules to `internal/occupant-clash.ts`, used by `checkDirty` and `findWouldOverwrite` (b) duplicate the rules in `find-would-overwrite.ts` (c) drop `findWouldOverwrite`'s untracked branch and run `applyChangeset` unforced for clean merges | (a) | without it P1 turns S1/S3d cherry-pick/stash-apply crashes into deleting the untracked `d`; (c) changes the refusal error type the merge family returns (`would-overwrite` result) |
| DC3 | `pull` into unborn ignored protection | (a) fold now: `ignoredOccupants: 'overwrite' \| 'protect'` on `MaterializeTreeOpts`/`ApplyChangesetOpts` (b) file a backlog row, leave it | (a) | without it P1 turns I1/I4 crashes into deleting an ignored file git keeps; an enum, not a boolean param |
| DC4 | git's warnings (`unable to unlink '<path>'` on P2, `already present` on P6) | (a) none — the observable state is the data (b) `ctx.logger?.warn?.(…)` with git's text, as `detect-merge-renames.ts:147` does (c) a structured `retained` list on the results | (b) | existing precedent; no API/`api.json` change; ADR-249 binds returned data, a logger line is not returned data |
| DC5 | `merge --abort` occupant rewrite (O2), made worse by P1 | (a) file a backlog row now, ship P1 as is (b) widen: reset-worktree honours git's `reset --merge` for paths the merge did not touch (c) stopgap: reset-worktree runs P3's unforced untracked check first and refuses | (a), with the user's go | (b) is its own matrix (`reset --merge` vs `--hard`, rebase/cherry-pick/sequencer aborts); (c) is a new divergence; asking per "never file without asking" |
| DC6 | 32.27 | (a) keep separate, next row (b) widen this run to the forced-switch classification | (a) | different code path (classification ends before `applyChangeset`), proven above; it builds on P1 |

## Test strategy

Interop (each row compares work-tree listing, `ls-files -s`, `ls-files -t`, and the refusal class + paths;
peers via `makePeerPair` / `runGit` / `runGitEnv`, git's stderr parsed only to extract the path list):

- new `test/integration/checkout-occupant-displacement-interop.test.ts` — `describe.each` over shapes S1, S2, S3a–S3f,
  D1–D4, X1–X4, Y1 × `{ checkout t, checkout -f t, reset --hard t, checkout t -- p }` × `{ pool, one, incore }`
  (variant = repo config written to both peers; `one` only on tsgit). Row shape:
  `{ shape, command, variant, expected: 'git' }` — the expectation is always "same as the peer".
- `test/integration/checkout-leading-symlink-interop.test.ts` — add the `/same` `reset --hard HEAD` and
  `checkout -- p` rows for S3c, S3d (link writes over a directory / under a file).
- `test/integration/cherry-pick-interop.test.ts` and `stash-interop.test.ts` — S1, S3a, S3d, S3e, I1, I2, I6 `/add` and
  S1, S3d `/update`, D1 rows (RC5), including the two data-loss rows (S3a, S3e `/add`).
- `test/integration/sparse-checkout-file-interop.test.ts` — S1, S3a, S3b, S3d `/sparse` × `{ disable, set }`.
- `test/integration/pull-fetch-head-interop.test.ts` (has the http-backend transport) — I1, I2, I6 into unborn and S1
  `/add` ff.

Unit (memory adapter, Given/When/Then split, AAA, `sut`):

- `test/unit/application/primitives/internal/symlinked-leading-path.test.ts` — `obstructingLeadingComponent`: file
  first, symlink first, file beneath a real directory, missing component, memo reuse (one `lstat` per prefix, spied).
- `test/unit/application/primitives/apply-changeset.test.ts` — per P1 branch on both write paths (`traceWritesUnder`
  to assert the removal order: obstruction removed before the first write), per P2 branch, per P3 branch with a
  dedicated row for each guard (file vs symlink obstruction; update vs delete; survivor vs none; ignored vs not), and
  the `protect` policy rows.
- `test/unit/application/primitives/find-would-overwrite.test.ts` (+ its `.properties` sibling stays green) — P4 rows.
- `test/unit/application/commands/internal/apply-sparse-checkout.test.ts` — P6 rows (dangling link, leading file).
- `test/unit/application/commands/pull.test.ts` — `ignoredOccupants: 'protect'` reaches the apply.

Property lens: `obstructingLeadingComponent` is a classifier over a path, not a parser/serializer; the round-trip and
model lenses do not fit beyond what the example rows pin. Mutation: Stryker scoped per touched file (narrowed vitest
include per `.claude/workflow/mutation.md`), 0 survivors; bench: `bench:ab` on checkout of a large tree to confirm R8.

## Out of scope

- O1–O4 above (one line each, proof in Appendix A); 32.27 is the next row.
- Gitlink occupants beyond X4 (submodule directory semantics are owned by the gitlink parity work).
- Case-folding filesystems: the existing fold rows of `checkout-leading-symlink-interop.test.ts` guard the
  intra-wave link race; no new fold shape was probed.

## Appendix A — pinned matrix (git 2.55.0 vs tsgit main 4899565f)

Cells: `exit <code> <class>:<paths>` from git's stderr (`local` = "local changes would be overwritten", `untracked` =
"untracked working tree files would be overwritten", `lose-untracked` = "Updating the following directories would
lose untracked files"); `→` the final work tree (`keep` omitted; `x/` directory, `x@->t` symlink, `x=c` file content).
tsgit: error `code` (`COD` = `CHECKOUT_OVERWRITE_DIRTY`, `WTD` = `WORKING_TREE_DIRTY`, `SAWO` =
`STASH_APPLY_WOULD_OVERWRITE`) with its arrays, or `ok`; variants are listed only where they differ.

##### S1 file d where dir d/ due (d/x regular)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `pull self t (into unborn)`, `stash pop` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | yes | ok → d/ d/x=v2 | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `merge t (non-ff)` | no | 2 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### S1 file d where dir d/ due (d/x regular)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | yes | ok → d/ d/x=v2 | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `merge t (non-ff)` | no | 2 local:d/x → keep=keep | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### S1 file d where dir d/ due (d/x regular)/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → d=occupant | ok → d=occupant |
| `checkout -f HEAD` | yes | ok → d/ d/x=v1 | ok → d=occupant |
| `reset --hard HEAD`, `checkout -- d/x`, `checkout HEAD -- d/x`, `stash push` | yes | ok → d/ d/x=v1 | NOT_A_DIRECTORY → d=occupant |
| `merge --abort` | yes | ok → d=occupant | pool+incore: NOT_A_DIRECTORY → d=occupant / one: NOT_A_DIRECTORY → d=occupant keep=(conflict markers) |

##### S2 populated dir f/ where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 lose-untracked:f → f/ f/u=untracked | COD untracked=[f] → f/ f/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | ok → f=v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| `cherry-pick t` | no | 128 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 lose-untracked:f → f/ f/u=untracked | SAWO → f/ f/u=untracked |

##### S2 populated dir f/ where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | pool+one: ok → f=v2 / incore: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| `cherry-pick t` | no | 128 local:f → f/ f/u=untracked | WTD local=[f] → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 local:f → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:f → f/ f/u=untracked | SAWO → f/ f/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |

##### S2 populated dir f/ where file f due/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → f/ f/u=untracked | ok → f/ f/u=untracked |
| `checkout -f HEAD` | yes | ok → f=v1 | ok → f/ f/u=untracked |
| `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f` | yes | ok → f=v1 | pool+one: ok → f=v1 / incore: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| `stash push` | yes | ok → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `merge --abort` | yes | ok → f/ f/u=untracked | pool+one: ok → f=v1 / incore: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |

##### S3a symlink d where dir d/ due (d/x regular)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 untracked:d → d@->nowhere | COD untracked=[d] → d@->nowhere |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | yes | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| `cherry-pick t` | no | 128 untracked:d → d@->nowhere | ok → d/ d/x=v2 |
| `merge t (non-ff)` | no | 2 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| `stash apply`, `stash pop` | no | 1 untracked:d → d@->nowhere | ok → d/ d/x=v2 |

##### S3a symlink d where dir d/ due (d/x regular)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `cherry-pick t`, `pull self t (ff)`, `stash apply`, `stash pop` | no | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/x` | yes | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| `merge t (non-ff)` | no | 128 beyond-symlink → d@->nowhere | WTD local=[d/x] → d@->nowhere |
| `pull self t (into unborn)` | no | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |

##### S3a symlink d where dir d/ due (d/x regular)/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → d@->nowhere | ok → d@->nowhere |
| `checkout -f HEAD` | yes | ok → d/ d/x=v1 | ok → d@->nowhere |
| `reset --hard HEAD`, `checkout -- d/x`, `checkout HEAD -- d/x` | yes | ok → d/ d/x=v1 | ok → d/ d/x=v1 |
| `stash push` | yes | 1 beyond-symlink → d@->nowhere | PATHSPEC_BEYOND_SYMLINK → d@->nowhere |
| `merge --abort` | yes | ok → d@->nowhere | ok → d/ d/x=v1 |

##### S3b symlink f where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 untracked:f → f@->nowhere | COD untracked=[f] → f@->nowhere |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | ok → f=v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 untracked:f → f@->nowhere | WTD untracked=[f] → f@->nowhere |
| `cherry-pick t` | no | 128 untracked:f → f@->nowhere | WTD untracked=[f] → f@->nowhere |
| `merge t (non-ff)` | no | 2 untracked:f → f@->nowhere | WTD untracked=[f] → f@->nowhere |
| `stash apply`, `stash pop` | no | 1 untracked:f → f@->nowhere | SAWO → f@->nowhere |

##### S3b symlink f where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 local:f → f@->nowhere | COD local=[f] → f@->nowhere |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | ok → f=v2 |
| `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f@->nowhere | WTD local=[f] → f@->nowhere |
| `cherry-pick t` | no | 128 local:f → f@->nowhere | WTD local=[f] → f@->nowhere |
| `merge t (non-ff)` | no | 2 local:f → f@->nowhere | WTD local=[f] → f@->nowhere |
| `stash apply`, `stash pop` | no | 1 local:f → f@->nowhere | SAWO → f@->nowhere |
| `pull self t (into unborn)` | no | 1 untracked:f → f@->nowhere | WTD untracked=[f] → f@->nowhere |

##### S3b symlink f where file f due/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → f@->nowhere | ok → f@->nowhere |
| `checkout -f HEAD` | yes | ok → f=v1 | ok → f@->nowhere |
| `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f`, `stash push` | yes | ok → f=v1 | ok → f=v1 |
| `merge --abort` | yes | ok → f@->nowhere | ok → f=v1 |

##### S3c populated dir l/ where symlink l due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 lose-untracked:l → l/ l/u=untracked | COD untracked=[l] → l/ l/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- l` | yes | ok → l@->t-v2 | ok → l@->t-v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |
| `cherry-pick t` | no | 128 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 lose-untracked:l → l/ l/u=untracked | SAWO → l/ l/u=untracked |

##### S3c populated dir l/ where symlink l due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- l` | yes | ok → l@->t-v2 | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| `cherry-pick t` | no | 128 local:l → l/ l/u=untracked | WTD local=[l] → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 local:l → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:l → l/ l/u=untracked | SAWO → l/ l/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |

##### S3c populated dir l/ where symlink l due/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → l/ l/u=untracked | ok → l/ l/u=untracked |
| `checkout -f HEAD` | yes | ok → l@->t-v1 | ok → l/ l/u=untracked |
| `reset --hard HEAD`, `checkout -- l`, `checkout HEAD -- l` | yes | ok → l@->t-v1 | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| `stash push` | yes | ok → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `merge --abort` | yes | ok → l/ l/u=untracked | pool+incore: DIRECTORY_NOT_EMPTY → keep=(conflict markers) l/ l/u=untracked / one: DIRECTORY_NOT_EMPTY → l/ l/u=untracked |

##### S3d file d where dir d/ due (d/l symlink)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `pull self t (into unborn)`, `stash pop` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | yes | ok → d/ d/l@->t-v2 | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `merge t (non-ff)` | no | 2 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### S3d file d where dir d/ due (d/l symlink)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | yes | ok → d/ d/l@->t-v2 | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `merge t (non-ff)` | no | 2 local:d/l → keep=keep | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### S3d file d where dir d/ due (d/l symlink)/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → d=occupant | ok → d=occupant |
| `checkout -f HEAD` | yes | ok → d/ d/l@->t-v1 | ok → d=occupant |
| `reset --hard HEAD`, `checkout -- d/l`, `checkout HEAD -- d/l`, `stash push` | yes | ok → d/ d/l@->t-v1 | NOT_A_DIRECTORY → d=occupant |
| `merge --abort` | yes | ok → d=occupant | NOT_A_DIRECTORY → d=occupant keep=(conflict markers) |

##### S3e symlink d where dir d/ due (d/l symlink)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 untracked:d → d@->nowhere | COD untracked=[d] → d@->nowhere |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | yes | ok → d/ d/l@->t-v2 | ok → d/ d/l@->t-v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| `cherry-pick t` | no | 128 untracked:d → d@->nowhere | ok → d/ d/l@->t-v2 |
| `merge t (non-ff)` | no | 2 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |
| `stash apply`, `stash pop` | no | 1 untracked:d → d@->nowhere | ok → d/ d/l@->t-v2 |

##### S3e symlink d where dir d/ due (d/l symlink)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `cherry-pick t`, `pull self t (ff)`, `stash apply`, `stash pop` | no | ok → d/ d/l@->t-v2 | ok → d/ d/l@->t-v2 |
| `checkout -f t`, `reset --hard t`, `checkout t -- d/l` | yes | ok → d/ d/l@->t-v2 | ok → d/ d/l@->t-v2 |
| `merge t (non-ff)` | no | 128 beyond-symlink → d@->nowhere | WTD local=[d/l] → d@->nowhere |
| `pull self t (into unborn)` | no | 1 untracked:d → d@->nowhere | WTD untracked=[d] → d@->nowhere |

##### S3e symlink d where dir d/ due (d/l symlink)/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → d@->nowhere | ok → d@->nowhere |
| `checkout -f HEAD` | yes | ok → d/ d/l@->t-v1 | ok → d@->nowhere |
| `reset --hard HEAD`, `checkout -- d/l`, `checkout HEAD -- d/l` | yes | ok → d/ d/l@->t-v1 | ok → d/ d/l@->t-v1 |
| `stash push` | yes | 1 beyond-symlink → d@->nowhere | PATHSPEC_BEYOND_SYMLINK → d@->nowhere |
| `merge --abort` | yes | ok → d@->nowhere | ok → d/ d/l@->t-v1 |

##### S3f file f where symlink f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 untracked:f → f=occupant | COD untracked=[f] → f=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f@->t-v2 | ok → f@->t-v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |
| `cherry-pick t` | no | 128 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |
| `merge t (non-ff)` | no | 2 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |
| `stash apply`, `stash pop` | no | 1 untracked:f → f=occupant | SAWO → f=occupant |

##### S3f file f where symlink f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 local:f → f=occupant | COD local=[f] → f=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f@->t-v2 | ok → f@->t-v2 |
| `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f=occupant | WTD local=[f] → f=occupant |
| `cherry-pick t` | no | 128 local:f → f=occupant | WTD local=[f] → f=occupant |
| `merge t (non-ff)` | no | 2 local:f → f=occupant | WTD local=[f] → f=occupant |
| `stash apply`, `stash pop` | no | 1 local:f → f=occupant | SAWO → f=occupant |
| `pull self t (into unborn)` | no | 1 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |

##### S3f file f where symlink f due/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → f=occupant | ok → f=occupant |
| `checkout -f HEAD` | yes | ok → f@->t-v1 | ok → f=occupant |
| `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f`, `stash push` | yes | ok → f@->t-v1 | ok → f@->t-v1 |
| `merge --abort` | yes | ok → f=occupant | ok → f@->t-v1 |

##### S1 file d where dir d/ due (d/x regular)/sparse

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `sparse-checkout disable`, `sparse-checkout set /keep /d` | yes | ok + warn `already present` → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### S2 populated dir f/ where file f due/sparse

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `sparse-checkout disable`, `sparse-checkout set /keep /f` | yes | ok → f/ f/u=untracked | ok → f/ f/u=untracked |

##### S3a symlink d where dir d/ due (d/x regular)/sparse

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `sparse-checkout disable`, `sparse-checkout set /keep /d` | yes | ok + warn `already present` → d@->nowhere | ok → d/ d/x=v1 |

##### S3b symlink f where file f due/sparse

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `sparse-checkout disable`, `sparse-checkout set /keep /f` | yes | ok → f@->nowhere | ok → f=v1 |

##### S3c populated dir l/ where symlink l due/sparse

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `sparse-checkout disable`, `sparse-checkout set /keep /l` | yes | ok → l/ l/u=untracked | ok → l/ l/u=untracked |

##### S3d file d where dir d/ due (d/l symlink)/sparse

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `sparse-checkout disable`, `sparse-checkout set /keep /d` | yes | ok + warn `already present` → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### D1 file d where deleted d/x stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t`, `reset --hard t` | yes | ok → d=occupant other=o | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout t -- keep` | yes | ok → d=occupant | ok → d=occupant |
| `merge t (non-ff)` | no | 2 local:d/x → keep=keep | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | ok → d=occupant other=o | ok → d=occupant other=o |

##### D2 populated dir f/ where deleted file f stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 lose-untracked:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| `checkout -f t`, `reset --hard t` | yes | ok + warn `unable to unlink` → f/ f/u=untracked other=o | DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| `cherry-pick t` | no | 128 lose-untracked:f → f/ f/u=untracked | WTD local=[f] → f/ f/u=untracked |
| `checkout t -- keep` | yes | ok → f/ f/u=untracked | ok → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 lose-untracked:f → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 lose-untracked:f → f/ f/u=untracked | SAWO → f/ f/u=untracked |
| `pull self t (into unborn)` | no | ok → f/ f/u=untracked other=o | ok → f/ f/u=untracked other=o |

##### D3 populated dir l/ where deleted symlink l stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 lose-untracked:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| `checkout -f t`, `reset --hard t` | yes | ok + warn `unable to unlink` → l/ l/u=untracked other=o | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| `cherry-pick t` | no | 128 lose-untracked:l → l/ l/u=untracked | WTD local=[l] → l/ l/u=untracked |
| `checkout t -- keep` | yes | ok → l/ l/u=untracked | ok → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 lose-untracked:l → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 lose-untracked:l → l/ l/u=untracked | SAWO → l/ l/u=untracked |
| `pull self t (into unborn)` | no | ok → l/ l/u=untracked other=o | ok → l/ l/u=untracked other=o |

##### D4 file d where deleted d/l symlink stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t`, `reset --hard t` | yes | ok → d=occupant other=o | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout t -- keep` | yes | ok → d=occupant | ok → d=occupant |
| `merge t (non-ff)` | no | 2 local:d/l → keep=keep | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | ok → d=occupant other=o | ok → d=occupant other=o |

##### I1 ignored file d where dir d/ due (d/x regular)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `cherry-pick t`, `merge t (non-ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | ok → d/ d/x=v2 | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### I1 ignored file d where dir d/ due (d/x regular)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | 1 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 local:d/x → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `merge t (non-ff)` | no | 2 local:d/x → keep=keep | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### I2 dir f/ of ignored u where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `merge t (non-ff)`, `pull self t (ff)` | no | ok → f=v2 | ok → f=v2 |
| `cherry-pick t` | no | ok → f=v2 | WTD untracked=[f] → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | ok → f=v2 | SAWO → f/ f/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | ok → f=v2 |

##### I2 dir f/ of ignored u where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| `cherry-pick t` | no | 128 local:f → f/ f/u=untracked | WTD local=[f] → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 local:f → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:f → f/ f/u=untracked | SAWO → f/ f/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | ok → f=v2 |

##### I3 ignored symlink d where dir d/ due (d/x regular)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `cherry-pick t`, `merge t (non-ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| `pull self t (into unborn)` | no | 1 untracked:d → d@->nowhere | ok → d/ d/x=v2 |

##### I3 ignored symlink d where dir d/ due (d/x regular)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `cherry-pick t`, `pull self t (ff)`, `stash apply`, `stash pop` | no | ok → d/ d/x=v2 | ok → d/ d/x=v2 |
| `merge t (non-ff)` | no | 128 beyond-symlink → d@->nowhere | WTD local=[d/x] → d@->nowhere |
| `pull self t (into unborn)` | no | 1 untracked:d → d@->nowhere | ok → d/ d/x=v2 |

##### I4 ignored file d where dir d/ due (d/l symlink)/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `cherry-pick t`, `merge t (non-ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | ok → d/ d/l@->t-v2 | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### I4 ignored file d where dir d/ due (d/l symlink)/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)`, `stash apply`, `stash pop` | no | 1 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `cherry-pick t` | no | 128 local:d/l → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `merge t (non-ff)` | no | 2 local:d/l → keep=keep | NOT_A_DIRECTORY → d=occupant |
| `pull self t (into unborn)` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |

##### I5 dir l/ of ignored u where symlink l due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `merge t (non-ff)`, `pull self t (ff)` | no | ok → l@->t-v2 | ok → l@->t-v2 |
| `cherry-pick t` | no | ok → l@->t-v2 | WTD untracked=[l] → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | ok → l@->t-v2 | SAWO → l/ l/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | ok → l@->t-v2 |

##### I5 dir l/ of ignored u where symlink l due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| `cherry-pick t` | no | 128 local:l → l/ l/u=untracked | WTD local=[l] → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 local:l → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:l → l/ l/u=untracked | SAWO → l/ l/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | ok → l@->t-v2 |

##### I6 ignored file f where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | ok → f=v2 | COD untracked=[f] → f=occupant |
| `merge t (ff)`, `cherry-pick t` | no | ok → f=v2 | WTD untracked=[f] → f=occupant |
| `stash apply` | no | ok → f=v2 | SAWO → f=occupant |
| `pull self t (into unborn)` | no | 1 untracked:f → f=occupant | WTD untracked=[f] → f=occupant |

##### I7 ignored symlink f where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | ok → f=v2 | COD untracked=[f] → f@->nowhere |
| `cherry-pick t` | no | ok → f=v2 | WTD untracked=[f] → f@->nowhere |

##### X1 empty dir f/ where deleted file f stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)` | no | 1 local:f → f/ | PERMISSION_DENIED → f/ |
| `checkout -f t`, `reset --hard t` | yes | ok + warn `unable to unlink` → f/ other=o | ok → other=o |
| `cherry-pick t` | no | 128 local:f → f/ | WTD local=[f] → f/ |

##### X2 dir f/ of ignored u where deleted file f stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)` | no | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| `checkout -f t` | yes | ok + warn `unable to unlink` → f/ f/u=untracked other=o | DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| `cherry-pick t` | no | 128 local:f → f/ f/u=untracked | WTD local=[f] → f/ f/u=untracked |

##### X3 empty dir f/ where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)` | no | 1 local:f → f/ | PERMISSION_DENIED → f/ |
| `checkout -f t` | yes | ok → f=v2 | ok → f=v2 |
| `cherry-pick t` | no | 128 local:f → f/ | WTD local=[f] → f/ |

##### X4 file d where gitlink d/s due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 untracked:d → d=occupant | NOT_A_DIRECTORY → d=occupant |
| `checkout -f t` | yes | ok → d/ d/s/ | NOT_A_DIRECTORY → d=occupant |
