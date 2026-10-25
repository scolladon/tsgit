# Design — forced-checkout-displace-occupant

> Brief: backlog 32.29 — a checkout-family write must displace an occupant standing where git's checkout displaces it (a file or symlink in a leading path, a directory at the path), on every write path, while every unforced refusal matches git 2.55; every `applyChangeset` caller probed against git 2.55 with each occupant shape, forced and unforced.
> Status: draft → self-reviewed ×3 → accepted → revised against ADRs 1075–1080 (O1–O3 folded by ADR-1079, re-pinned against git 2.55) → self-reviewed ×3

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
- Reset-family callers (folded by ADR-1079). `hardResetWorktreeToCommit` (`internal/reset-worktree.ts:21-42`) runs
  `materializeTree` with `force: true, forceRewriteAll: true` for every caller. git uses three modes, named from the
  observed result (Appendix A.2; control match in the parity summary). "Untracked-protecting hard reset" is a hard
  reset that refuses to overwrite untracked occupants at paths absent from the current index (git's `reset_head` with
  `RESET_HEAD_HARD`, `UNPACK_RESET_PROTECT_UNTRACKED`: supporting evidence only).

| caller | git counterpart probed | git mode (observed) |
|---|---|---|
| `abort-merge.ts:56` | `merge --abort` | `reset --merge` |
| `internal/abort-sequencer-reset.ts:40` (from `internal/replay-sequence.ts:462`) | `cherry-pick --abort`, `revert --abort` | `reset --merge` |
| `internal/abort-sequencer-reset.ts:31` (from `cherry-pick.ts`, `revert.ts`) | `cherry-pick --skip`, `revert --skip` | `reset --merge` |
| `rebase.ts:1000` | `rebase --abort` (merge backend; git's apply backend gave identical rows on all 50 pairs) | untracked-protecting hard reset |
| `rebase.ts:978` | `rebase --skip` | untracked-protecting hard reset |
| `rebase.ts:875`, `rebase.ts:1842` | `rebase --skip` of a rescheduled pick, of an interactive stop | not probed separately (Still unpinned) |
| `internal/rebase-merges-steps.ts:71` | rebase-merges `reset <label>` | untracked-protecting hard reset |
| `rebase.ts:347` (`detachHead`), `:1137` (`detachInteractive`), `:1152` (`fastForwardOnto`) | `rebase t`, `rebase -i t`, `rebase t` when HEAD is an ancestor of `t` | two-way checkout, unforced; a refusal leaves HEAD and the branch unmoved |

  `stash push` snapshots the work tree in `classifyTracked` / `classifyEntry` / `projectEntry` (`stash.ts:250-340`)
  before `resetAfterPush` (`:658`, git's `reset --hard`). The non-fast-forward `merge` refuses in
  `materialiseNonConflictTree` (`merge.ts:1045`, clean result) and `assertNothingOverwritten` (`:1763`, conflicting
  result), and guards paths beyond a symlink in `assertNoneBeyondSymlink` (`:1779`, called from `:797` and `:1768`).
- Constraints: ADR-226 (byte-for-byte work-tree and index state, refusal conditions), ADR-249 (refusals are data:
  `localChanges` / `untracked` arrays, no display strings). Precedent (`docs/design/status-gitlink-parity.md` CO46):
  git's "Updating the following directories would lose untracked files" maps to tsgit's `untracked` class.

## Requirements

- R1 Forced (and post-pre-flight) writes displace, on the pooled, one-at-a-time, streamed and in-core write paths,
  for regular, symlink and gitlink entries: a regular file or symlink in a leading path is replaced by a directory; a
  directory at the path of an `add` or `update` entry (not a gitlink) is removed with its content.
- R2 A forced delete of a path beneath a regular file succeeds and removes nothing; a forced delete of a path that
  is now a directory (empty or not) leaves the directory and succeeds (the protected reset of R10 first refuses one
  holding an untracked file); the index drops the entry either way.
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
- R7 Every Appendix A row that is SAME on main stays SAME (regression guard); every DIFF row becomes SAME except the
  O4 rows (`checkout -f HEAD`, ADR-1080). A git precondition refusal (`rebase` "unstaged changes", `rebase --continue`
  before its `reset` step) and tsgit's `WORKING_TREE_DIRTY` with the same work tree, index and state count as SAME.
- R8 No new syscall on the clone path (all-`add` changesets with nothing on disk): the displacement check reuses the
  per-prefix memo the symlink check already walks.
- R9 `merge --abort` and `cherry-pick` / `revert` `--abort` / `--skip` reset as git's `reset --merge`: a path whose
  index entry equals the target is not touched (its occupant or local change stays); every other path runs R3's
  unforced rules from the index to the target; unmerged paths are reset without a check. A refusal names only the
  first offending path, with R3's class, and leaves the work tree, index, HEAD, `ORIG_HEAD`, `MERGE_HEAD` /
  `CHERRY_PICK_HEAD` / `REVERT_HEAD` and `sequencer/` as they were. `merge --abort` consumes `MERGE_AUTOSTASH` before
  its reset, so a refused abort neither applies nor stores it, as git does.
- R10 `rebase --abort`, `rebase --skip` and the rebase-merges `reset <label>` step reset as git's untracked-protecting
  hard reset: paths in the current index are rewritten as `reset --hard` (P1 displaces, P2 keeps and warns); an
  untracked occupant where the reset adds a path (a file or symlink at the path or in a leading component, a directory
  holding an untracked file) and a directory holding an untracked file where it deletes one refuse
  `untracked: [...]`, every offending path listed; ignored occupants are overwritten. A refusal leaves the rebase
  stopped: abort and skip keep `rebase-merge/` and HEAD; a refused `reset` step is back at the head of the todo and
  recorded in `done`.
- R11 Rebase start (`rebase t`, `rebase -i t`, fast-forward onto `t`) moves HEAD by an unforced two-way checkout:
  untracked occupants refuse (`untracked`), ignored ones are overwritten, and a refusal leaves HEAD, the branch, the
  work tree and the absence of rebase state as they were.
- R12 `stash push` builds its work-tree (W) tree as git does: a directory at a tracked non-gitlink path keeps the
  index entry; an index entry absent from HEAD whose work file is missing or unreachable keeps the index entry and is
  never refused as beyond a symlink; a HEAD entry absent from the index is recorded from the work tree when a file or
  symlink stands there, and refuses beyond a symlink. Its reset stays git's `reset --hard`.
- R13 A refused non-fast-forward merge, clean or conflicting, restores as git does: a tracked path beyond a symlink
  refuses (`localChanges`) before the strategy runs, with nothing touched; after a would-overwrite refusal the work
  tree is reset hard to HEAD and the local changes re-applied. Net effect: an occupant a stash cannot record is
  replaced by HEAD content, and a local modification survives.
- R14 Path restore (`checkout <rev> -- <p>`) drops index entries that collide file/directory with a restored entry: a
  tracked `d` when `d/x` is restored, tracked `d/*` when `d` is restored.

## Design

### How the matrix was pinned

A throwaway harness (outside the repository, `mktemp -d` per run, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*`
scrubbed, signing off, fixed author/committer dates) builds the same history with git 2.55 plumbing in two sibling
repositories, applies the occupant to both work trees, runs the git command in one and the tsgit equivalent (library
call; `pull` through the `git http-backend` transport of `test/integration/http-backend-transport.ts`) in the other,
then compares the recursive work-tree listing (type, link target, content), `git ls-files -s`, `git ls-files -t` and
the outcome (git exit code + refusal class/paths from stderr; tsgit error `code` + `localChanges`/`untracked`). Every
tsgit row ran on three variants: `pool` (default), `one` (`filter.probe.process` configured, no attribute using it →
one-at-a-time path) and `in-core` (`core.autocrlf=true` on both sides → in-core regular writes). git version was
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

**Revision probe (ADR-1079).** The same harness, extended with every reset-family caller, `stash push` (its W and I
trees compared through `git ls-tree -r stash@{0}` and `stash@{0}^2`), the non-fast-forward merge refusal and the
rebase start. git stops each operation in both repositories (`merge`, `cherry-pick`, `revert` or `rebase` conflicting
on `keep`; for the rebase-merges `reset` step each tool runs its own `rebase --rebase-merges u`, the planted `keep`
conflict is resolved, and the step runs on `rebase --continue`). The occupant is planted after the stop, then the
command runs. Variants are named by the reset's direction: target is the tree the reset or restore returns to,
current is the stopped (or incoming) state.

| variant | target | current |
|---|---|---|
| `/same` | v1 | v1 (the operation never touched the entry) |
| `/reset-updates` | v1 | v2 |
| `/reset-adds` | v1 | absent (the reset adds the entry back) |
| `/reset-deletes` | absent | v2 (the reset deletes the entry: the D shapes of A.1) |

Shapes: S1–S3f; I1 (ignored file `d`), I2 (directory of ignored `u` at `f`), I4 (ignored file `d`, link due); Y3
(directory `f/` and file `g` over two entries, for the length of the path list); M1 (tracked `f` modified, no
occupant); N0 (no occupant, control); N1 (tracked `f` deleted from disk, `stash push` only). Write-path variant: the
pooled one only, since these rows reach the same writers as A.1. git-only controls replayed on every stopped state
(`reset --merge`, `reset --keep`, `reset --hard`, `read-tree --reset -u`, all towards the same target) name each
caller's mode by the control whose outcomes it matches (work tree, index and exit status):

| command | pairs | `reset --merge` | `reset --keep` | `reset --hard` | `read-tree --reset -u` |
|---|---|---|---|---|---|
| `merge --abort` | 46 | 46 | 27 | 7 | 7 |
| `cherry-pick --abort` | 46 | 46 | 27 | 7 | 7 |
| `cherry-pick --skip` | 46 | 46 | 27 | 7 | 7 |
| `revert --abort` | 46 | 46 | 27 | 7 | 7 |
| `revert --skip` | 46 | 46 | 27 | 7 | 7 |
| `rebase --abort` (merge backend) | 46 | 17 | 10 | 36 | 36 |
| `rebase --abort` (apply backend) | 46 | 17 | 10 | 36 | 36 |
| `stash push` | 46 | 7 | 9 | 40 | 40 |

`rebase --abort`'s 10 misses against `reset --hard` are exactly its refusals of untracked occupants at paths absent
from the index (`/reset-adds`, and a directory holding an untracked file at a `/reset-deletes` path): a hard reset that
protects untracked files. The rebase-merges `reset` step, `rebase --skip` and the rebase start print the same
porcelain refusals ("would be overwritten by reset", "by checkout" at the start). `stash push`'s 6 misses are the S3a
and S3e snapshot refusals, which end the command before its reset.

### Parity summary

390 (shape, command) pairs probed, each on 2–3 write-path variants (Appendix A has every row). After folding
refusal-class equivalences already ratified (git "would lose untracked files" ≡ `untracked`; `STASH_APPLY_WOULD_OVERWRITE`
≡ git's refusal; "beyond a symbolic link" ≡ `localChanges`), **205 pairs diverge: 187 in the perimeter, 18 outside**. The revision probe adds 742 pairs (684 reset-family, merge-refusal and rebase-start pairs; 58 `stash push` pairs, stash trees included), 421 of them divergent; ADR-1079 puts them all in the perimeter. With O1–O3 folded, only O4 stays outside (8 `checkout -f HEAD` rows, ADR-1080).

| root cause | rows (Appendix A) | git 2.55 | tsgit main | perimeter |
|---|---|---|---|---|
| RC1 leading regular file never displaced | S1, S3d, X4 forced (`checkout -f t`, `reset --hard t`/`HEAD`, `checkout [t\|HEAD] -- p`, `stash push`); I1, I4 unforced adds | ok, `d/` real directory, entry written | `NOT_A_DIRECTORY`, nothing written, index unchanged | in |
| RC2 directory at an `update` / in-core / symlink write path | S3c `/update` `/same` forced; S2 `/update` `/same` forced on `in-core` only | ok, directory removed, file/link written | `DIRECTORY_NOT_EMPTY` | in |
| RC3 delete wave meets an occupant | D1, D4 forced; D2, D3, X2 forced; X1 forced | ok (D2/D3/X1/X2 warn `unable to unlink 'f'`, directory kept, entry dropped) | D1/D4 `NOT_A_DIRECTORY`; D2/D3/X2 `DIRECTORY_NOT_EMPTY`; X1 removes the empty dir | in |
| RC4a update/delete beneath a regular file, unforced | S1, S3d, I1, I4 `/update`; D1, D4 unforced (`checkout t`, `merge t` ff, `pull` ff) | exit 1 `localChanges: [d/x]` | `NOT_A_DIRECTORY` (pre-flight reads the path as absent; the write throws) | in |
| RC4b directory at an update/delete path, unforced | S2, S3c, I2, I5 `/update`; D2, D3, X1, X2, X3 unforced | exit 1 `localChanges: [f]` (update; delete holding no survivor) / `untracked: [f]` (delete holding a survivor) | `PERMISSION_DENIED` (reads the directory as a file) | in |
| RC4c add beneath a regular file, unforced | S1, S3d, X4, Y1 `/add`; every `pull` into unborn of S1/S3d | exit 1 `untracked: [d]` (once per entry: Y1 lists `d` twice) | `NOT_A_DIRECTORY` | in |
| RC4d ignored file/symlink at an added path, unforced | I6, I7 (`checkout t`, `merge t` ff) | ok, overwritten | refuses `untracked: [f]` | in |
| RC5 merge-family pre-flight misses occupants | S1, S3d `/add` `/update`, D1, D4, I1, I4 (cherry-pick, merge non-ff, stash apply/pop): crash; S3a, S3e, Y2 `/add`: **tsgit overwrites the untracked link git protects**; I2, I5, I6, I7 `/add`: tsgit refuses what git overwrites | refuses / ok per R3 | see left | in |
| RC6 sparse re-inclusion follows links and misses leading files | S1, S3d `/sparse` (`NOT_A_DIRECTORY`); S3a, S3b `/sparse` (**tsgit replaces the untracked link**) | ok + warn `already present`, occupant kept, skip-worktree cleared | see left | in |
| RC7 `pull` into unborn overwrites ignored occupants | I1–I5 `pull … (into unborn)` | exit 1 `untracked` / `would lose untracked` | I2, I3, I5 overwrite (ignored data lost); I1, I4 `NOT_A_DIRECTORY`; I6 ok | in |
| RC8 stash snapshot shape | `stash push`: S2, S3c, I2, Y3 `/same` `/reset-updates` `/reset-deletes`; S1, S3d, I1, I4, N1 `/reset-deletes`; S3a, S3e `/reset-adds` `/reset-deletes`; N0, S3b, S3f `/reset-adds` (A.3) | ok; W keeps the index entry for a directory and for a missing index-only file; a HEAD-only path is recorded from the work tree, refused beyond a symlink | `PERMISSION_DENIED`; W drops the index-only entry, or refuses `PATHSPEC_BEYOND_SYMLINK`; HEAD-only paths ignored | in (ADR-1079) |
| RC9a merge-family aborts and skips reset hard | every `merge --abort`, `cherry-pick` / `revert` `--abort` / `--skip` row (A.2) | `reset --merge` (46/46 controls): an occupant or local change at an untouched path stays; R3 refusals, first path only, exit 128, state kept | rewrites untouched paths (S2 `/same`: untracked `f/u` deleted; M1: local modification lost), crashes (RC1, RC2), overwrites untracked occupants at re-added paths | in (ADR-1079) |
| RC9b rebase aborts, skips and `reset` step overwrite untracked occupants | `rebase --abort`, `rebase --skip`, rebase-merges `reset`: every S shape and Y3 `/reset-adds`; S2, S3c, Y3 `/reset-deletes` | refuses `untracked` / `lose-untracked`, every path listed; ignored overwritten | overwrites (S2, S3a, S3b, S3c, S3e, S3f, Y3: untracked data lost) or crashes | in (ADR-1079) |
| RC9c rebase start overwrites untracked occupants | `rebase t`, `rebase -i t`, fast-forward: every S shape and Y3 `/reset-adds` | two-way checkout refuses `untracked` ("could not detach HEAD"), HEAD unmoved, no rebase state | overwrites (S2, S3a, S3b, S3c, S3e, S3f, Y3) or crashes | in (ADR-1079) |
| RC10 non-ff merge refusal skips git's save and restore | `merge t (non-ff)`, clean and conflicting: S1, S2, S3c, S3d, I1, I2, I4, Y3 `/reset-updates` `/reset-adds`; S3a, S3e `/same` | exit 2, work tree reset to HEAD and the local changes re-applied; S3a, S3e `/same`: exit 128 beyond-symlink before merging | refuses with the occupant kept, or crashes; S3a, S3e `/same` merge through | in (ADR-1079) |
| RC11 path restore keeps colliding index entries | T1 (`checkout t -- d/x` over a tracked `d`), T3 (`checkout t -- d` over tracked `d/x`, `d/y`) (A.4) | ok; the index drops `d` (T1), `d/x` and `d/y` (T3) | T1 `NOT_A_DIRECTORY` (RC1); T3 ok, but the index keeps `d/x`, `d/y` beside `d` | in (fold: same command, exposed by this probe) |
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

- RC8 — `classifyTracked` (`stash.ts:274`) enumerates stage-0 index entries only, so a HEAD entry absent from the
  index never reaches W (N0, S3b, S3f `/reset-adds`) and is never refused beyond a symlink (S3a, S3e `/reset-adds`).
  `classifyEntry` (`:264`) refuses every index entry beyond a symlink, including index-only ones git never lists
  (S3a, S3e `/reset-deletes`). `projectEntry` (`:332`) drops an `absent` entry, where git keeps an index-only entry
  whose file is missing (S1, S3d, I1, I4, N1 `/reset-deletes`). `projectEntry` → `hashFileAt` → `cleanedContent`
  (`:195`) `read`s a directory at a tracked path (EISDIR → `PERMISSION_DENIED`), where git keeps the index entry.
- RC9 — `hardResetWorktreeToCommit` (`reset-worktree.ts:31-37`) forces every path for all its callers. (a) Under
  `reset --merge`, the forced rewrite of `noop` paths destroys the occupants and local changes git keeps, and with no
  pre-flight a re-added path overwrites an untracked occupant. (b) The forced pass has no untracked check for paths
  absent from the current index. (c) `detachHead` (`rebase.ts:327-348`), `detachInteractive` (`:1123-1138`) and
  `fastForwardOnto` (`:1142-1153`) move HEAD first (`applyRefUpdates`), then force the reset, where git checks out
  unforced and leaves HEAD unmoved on refusal.
- RC10 — `materialiseNonConflictTree` (`merge.ts:1045-1058`) and `assertNothingOverwritten` (`:1763-1775`) refuse
  before any write and return. git's `merge` stashes the local changes before the strategy and, when the strategy
  refuses, resets hard and re-applies them (`builtin/merge.c` `save_state` / `restore_state`: supporting evidence).
  `assertNoneBeyondSymlink` (`:1779`) scans only the merge's changed paths. git's snapshot dies on any tracked path
  beyond a symlink (S3a, S3e `/same`).
- RC11 — `preserveOutOfScope` (`materialize-tree.ts:153-159`) keeps every out-of-scope index entry, including one
  that collides file/directory with a restored entry.

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
in place, git's warning emitted (ADR-1078), returns `undefined`; otherwise `rm` as today. The gitlink branch
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
(`resolved-deleted`); `merge.ts:1769`'s conflict path passes the same. (ADR-1076.)

**P5 — ignored occupants protected for `pull` into unborn (RC7)** — `MaterializeTreeOpts` and `ApplyChangesetOpts`
gain `ignoredOccupants?: 'overwrite' | 'protect'` (default `overwrite`, git's `overwrite_ignore = 1`);
`pull-into-void.ts:44` passes `protect`. Under `protect` the pre-flight's ignore probe answers "not ignored" and
`clearOccupants` runs the `protected` policy (removes nothing a pre-flight let through, which is nothing). (ADR-1077.)

**P6 — sparse re-inclusion (RC6)** — `includedChange` (`apply-sparse-checkout.ts:140`) asks "is anything in the way":
`lstatIfReachable` at the path (no follow) or a leading obstruction from one scanner shared by the build. Present →
`noopEntry` (nothing written; `assembleEntries` already clears skip-worktree), and git's `already present` warning per
ADR-1078.

**P7 — the stash snapshot follows git's work-tree tree (RC8).** `classifyTracked` (`stash.ts:274`) enumerates git's
W-tree path set: every stage-0 index entry plus every HEAD entry absent from the index (from `base.bTree`, which
`stashAndReset` already resolves). Per path, the shape decides before any content is read:

```ts
// any index entry:  directory at a non-gitlink path      → 'unchanged' (W keeps the index entry)
// index and HEAD:    beyond a symlink                     → refuse PATHSPEC_BEYOND_SYMLINK (unchanged)
//                    file in a leading path, or absent    → 'absent'    (W drops it, unchanged)
// index only:        unreachable or absent (any reason)   → 'unchanged' (W keeps the index entry, no refusal)
// HEAD only:         beyond a symlink                     → refuse PATHSPEC_BEYOND_SYMLINK
//                    file or symlink present              → hashed into W (mode from lstat)
//                    directory, absent or unreachable     → not in W
// otherwise:         compareAndRefresh (unchanged)
```

The I tree is unchanged (it matched git on every pair). `resetAfterPush` stays git's `reset --hard`: P1 displaces,
and P2 keeps a directory at a deleted index-only path with git's warning (Y3 `/reset-deletes`: `unable to unlink
'f'`). The leading-path probe is the shared scanner's `obstructingLeadingComponent`. The directory probe is the
`lstat` that `compareAndRefresh` already pays.

**P8 — each reset caller gets git's mode (RC9).** `reset-worktree.ts` exposes three helpers named by intent.
`hardResetWorktreeToCommit` loses its last caller and is removed. Refusals surface as `WORKING_TREE_DIRTY` through
`asMergeDirtyError` (`merge.ts:1033`), the code the merge and rebase families already throw.

| helper | callers | git mode | `materializeTree` call |
|---|---|---|---|
| `mergeResetWorktreeToCommit` | `abort-merge.ts:56`, `abort-sequencer-reset.ts:31`, `:40` | `reset --merge` | `force: false`, `unmergedPaths: 'reset'`; refusal narrowed to its first path |
| `protectedResetWorktreeToCommit` | `rebase.ts:875`, `:978`, `:1000`, `:1842`, `rebase-merges-steps.ts:71` | untracked-protecting hard reset | `force: true`, `forceRewriteAll: true`, `untrackedOccupants: 'protect'`, `unmergedPaths: 'reset'` |
| `checkoutWorktreeToCommit` | `rebase.ts:347`, `:1137`, `:1152` | two-way checkout | `force: false`, `headTree` = the current HEAD tree |

(`untrackedOccupants` and `unmergedPaths` are the option shape recommended in DC7. `rebase.ts:875` and `:1842` are
assigned with `rebase --skip` but not pinned separately: see Still unpinned.)

- P8a — `reset --merge`. Without `forceRewriteAll`, `computeChangeset` classifies every path whose index entry equals
  the target `noop`, so its occupant or local change stays (every `/same` row, M1). The rest goes through P3's
  unforced pre-flight unchanged: the observed refusals are exactly R3's classes. Update or delete beneath a file →
  local. Update at a directory → local. Delete at a directory holding an untracked file → untracked; holding only
  ignored files → local. Add beneath a file or symlink, or at a file or symlink → untracked unless ignored. Unmerged
  paths (`unmergedPaths: 'reset'`) are projected as tracked `update`s (or `delete`s, when the target lacks them),
  exempt from the dirty check: git rewrites the conflicted `keep` on every row and never refuses it. git names only the first offending path (Y3:
  `f`, not `g`), so the helper rethrows `WORKING_TREE_DIRTY` with the first path of `localChanges ∪ untracked` in
  `comparePaths` order. The refusal comes before any write, so every state file stays as it was. Ordering fix:
  `abortSequencerReset` (`abort-sequencer-reset.ts:39`) writes `ORIG_HEAD` after the reset (A.5: a refused
  multi-pick abort leaves `ORIG_HEAD` unchanged). `mergeAbort` keeps taking `MERGE_AUTOSTASH` before the reset (A.5).
- P8b — untracked-protecting hard reset. Every target path is rewritten (P1 `every`) after a pre-flight that runs
  only the untracked rules, through P3/P4's `classifyOccupant`. On `add` entries (path absent from the current
  stage-0 index), the add branch applies: a leading file or symlink → `untracked: [component]`; a file or symlink at
  the path → `untracked: [path]`; a directory holding an untracked file → `untracked: [path]`; anything ignored is
  expendable. On `delete` entries meeting a directory that holds an untracked file → `untracked: [path]`. `update`
  entries skip the pre-flight: on S2 `/same`, `rebase --abort` deletes the untracked `f/u` inside the directory at
  the tracked `f`. Every offending path is reported (Y3: `f` and `g`). Once untracked occupants are refused,
  `clearOccupants`' `every` policy only meets ignored or tracked-path occupants, which git overwrites (I1, I2, I4
  `/reset-adds`): no new policy. A refused `reset` step leaves the rebase stopped, with `reset <label>` at the head of
  `git-rebase-todo` and at the end of `done` (A.5).
- P8c — rebase start. `detachHead` (`rebase.ts:327`), `detachInteractive` (`:1123`) and `fastForwardOnto` (`:1142`)
  run the checkout before the HEAD update, and before any rebase state is written. git refuses with "could not
  detach HEAD", leaving HEAD on the branch and no `rebase-merge/`. The dirty-tree precondition already refuses every
  tracked change (those rows are SAME), so with index == HEAD the two-way checkout refuses only untracked occupants
  and overwrites ignored ones (I1, I4 `/reset-adds`).

**P9 — a refused non-fast-forward merge restores as git does (RC10).** tsgit refuses before its first write, so a
snapshot taken at refusal time equals the one git takes before the strategy. P9 takes it only on refusal (DC8):

1. Before `tryStrategies` (`merge.ts:767`, true merges only), the beyond-symlink guard scans every tracked path,
   not only the changed ones: git's snapshot dies on S3a, S3e `/same` (exit 128) before merging. It reuses
   `findTrackedBeyondSymlink` with the shared scanner.
2. On a would-overwrite refusal from `commitCleanMerge` (`merge.ts:1182`, through `materialiseNonConflictTree`) or
   from `persistConflictState` (`:1688`, through `assertNothingOverwritten`), once `materialiseAndApply` has released
   its index lock: snapshot the local
   changes with P7's builder (no ref written), hard-reset to HEAD (`force` + `forceRewriteAll`: P1 displaces, P2
   keeps), re-apply the snapshot to the work tree when it holds changes, then rethrow the refusal unchanged.

Observed net effect (A.2 `merge t (non-ff…)` rows). A directory at a tracked path (S2, S3c, I2) is replaced by HEAD's
file or link. A file in a leading path (S1, S3d, I1, I4) is removed: the snapshot recorded the tracked entry as
deleted, so the re-apply deletes it from the work tree again, and the index stays at HEAD. A local modification
survives (M1, Y3 `g`). Fast-forward merges keep their refusal without a restore (A.1 `merge t (ff)` rows: occupant
kept).

**P10 — path restore drops colliding index entries (RC11).** `preserveOutOfScope` (`materialize-tree.ts:153`) drops
an out-of-scope entry whose path is a leading directory of a restored target entry (tracked `d` when `d/x` is
restored: T1), or lies beneath one (tracked `d/x`, `d/y` when `d` is restored: T3), as git's index replaces them.
The work tree needs nothing new: P1 displaces T1's tracked file `d` as a leading-path obstruction, and the existing
directory clear removes T3's `d/`.

**Consistency across P1–P10 (self-review).**

- The protected reset (P8b) uses P3/P4's classifier in forced mode, restricted to its untracked branches. P1's
  `every` policy covers what remains, so P1 gains no third clear policy for it. P5's `protected` policy stays
  specific to the unforced `ignoredOccupants: 'protect'`.
- The merge reset (P8a) is P3's unforced pre-flight. Its only additions are the unmerged exemption, which P8b shares,
  and the first-path narrowing, which happens at the caller.
- P2's warning now also fires from the protected reset and the stash reset (git warns on I2 `/reset-deletes` and Y3
  `/reset-deletes`), still through ADR-1078's logger.
- P9 composes P7 (snapshot) and the hard reset (P1, P2). P4 is unchanged; P9 wraps its refusal.
- `untrackedOccupants` and P5's `ignoredOccupants` are orthogonal. No caller sets both: `pull-into-void` is unforced.

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

P7–P10 add no port call: they use the `lstat`, `readlink` and `read` the stash and reset paths already make, and the
existing `materializeTree` writers.

### Size-cap impact

P1–P6 touch `apply-changeset.ts`, `symlinked-leading-path.ts`, a new `occupant-clash.ts`, `find-would-overwrite.ts`,
`apply-sparse-checkout.ts`, `pull-into-void.ts`, and add one option to `materialize-tree.ts`. P7–P10 add
`reset-worktree.ts` (three helpers in place of one), `stash.ts` (snapshot path set), `merge.ts` (restore and the
up-front scan), `rebase.ts`, `abort-merge.ts`, `abort-sequencer-reset.ts`, `rebase-merges-steps.ts`, and two more
options plus the collision rule in `materialize-tree.ts`. All of them sit in the shared chunk reached by
`dist/esm/index.js`, `index.node.js`, `index.default.js`, `primitives/index.js` and `dist/browser/tsgit.js`.
Per-command entries (`commands/checkout.js`, `reset.js`, `merge.js`, `pull.js`, `stash.js`, `cherry-pick.js`,
`revert.js`, `rebase.js`, `sparse-checkout.js`) may carry part of it, depending on chunking. Expected growth is
~500–900 B gzip on each facade and on the browser bundle (P1–P6 ~200–350 B; P7–P10 ~300–550 B), above the 3–40 B
headroom. The caps will trip and are re-measured and raised from a clean measurement (`rm -rf dist .wireit` first) in
the same change. `api.json` changes for DC7 (a) or (b), on top of ADR-1077's option.

### 32.27 verdict — different defect, same family

Proof: every `/same` `checkout -f HEAD` row returns ok with the occupant untouched on all three write paths, while
`reset --hard HEAD` and `checkout -- p` on the same shapes do reach `applyChangeset` (they set `forceRewriteAll`) and
either succeed (S2, S3a, S3b, S3e, S3f) or hit this run's RC1/RC2. The forced switch (`checkout.ts:285-292`) passes
`force` without `forceRewriteAll`, so `computeChangeset` (`materialize-tree.ts:392-394`) classifies every path `noop`
and `splitWaves` (`apply-changeset.ts:419`) drops it: the 32.27 code path ends before `applyChangeset`. Its fix is
classification (git's one-way reset rewrites an index entry whose work-tree stat is not up to date), not displacement.
It depends on this change: once 32.27 upgrades those paths, S1, S3c, S3d need P1 to succeed. Ordering 32.29 → 32.27
holds; widening was DC6, settled by ADR-1080.

### Out of perimeter

- O4 = 32.27 (above), kept separate by ADR-1080.
- How to prove next (not proven here): `checkout -f HEAD` with a tracked file whose content alone was modified —
  run the same harness row with a content edit instead of an occupant.

### Still unpinned (pin before the part that depends on it)

- `rebase.ts:875` (skipping a rescheduled pick) and `rebase.ts:1842` (skipping an interactive stop): P8 assigns them
  the protected reset with `rebase --skip`. Pin: stop a `rebase -i` on an `edit` and on a rescheduled pick, plant an
  untracked file where the skip adds a path back, run `rebase --skip` in both tools.
- `cherry-pick --skip` / `revert --skip` refused mid-sequence: does `ORIG_HEAD` move? Pin: the A.5 multi-pick row
  with an occupant at a path where HEAD and the index disagree, then `--skip`. Until pinned, `skipSequencerReset`
  keeps its order.
- `reset --merge` naming one path when the refusals mix classes (an untracked occupant at an added path plus a
  directory at an updated one): P8a assumes path order. Pin: one abort holding both, check which path git names.
- An unmerged path whose conflicted file was itself replaced by an occupant (P8a and P8b exempt unmerged paths from
  the pre-flight). Pin: replace the conflicted `keep` by a directory holding an untracked file, then each abort.
- Restore after other true-merge refusals: `merge --squash`, `merge --no-commit`, and a strategy that fails without
  a would-overwrite refusal. Pin each with S2 `/reset-updates` before widening P9 beyond the probed `merge t`.

## Decision candidates

Settled, so not candidates: DC1 → ADR-1075, DC2 → ADR-1076, DC3 → ADR-1077, DC4 → ADR-1078, DC5 → ADR-1079 (O1–O3
folded), DC6 → ADR-1080. Each caller's reset mode, the first-path-only refusal of `reset --merge`, the autostash and
`ORIG_HEAD` ordering, and the stash path-set rules are set by matching git (A.2–A.5), so none of them is a candidate.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC7 | How P8's reset modes reach `applyChangeset` | (a) two optional additive enums on `MaterializeTreeOpts` / `ApplyChangesetOpts`, siblings of ADR-1077's `ignoredOccupants`: `untrackedOccupants: 'overwrite' \| 'protect'` (read with `force: true`) and `unmergedPaths: 'hidden' \| 'reset'` (b) one enum `resetMode: 'merge' \| 'protect-untracked'` naming git's reset flavour (c) internal only: a non-exported materialise entry used by `reset-worktree.ts`; public options unchanged | (a) | CLAUDE.md: commands are built from the primitives users get, so (c) keeps the abort semantics out of their reach. Orthogonal enums compose with `force` and `ignoredOccupants`, where (b) needs a mode per combination. (a) and (b) change `api.json` additively. |
| DC8 | When P9 takes its snapshot | (a) only on refusal: the up-front beyond-symlink scan of every tracked path, then snapshot, reset and re-apply after a refusal (b) git's order: snapshot before every true-merge strategy (c) only on refusal, without the up-front scan | (a) | Observably identical to git, since tsgit writes nothing before it refuses. (b) hashes every modified file on every successful merge, for objects no ref reaches. (c) diverges on S3a, S3e `/same`: git exits 128, tsgit merges. |

## Test strategy

Interop (each row compares work-tree listing, `ls-files -s`, `ls-files -t`, and the refusal class + paths;
peers via `makePeerPair` / `runGit` / `runGitEnv`, git's stderr parsed only to extract the path list):

- new `test/integration/checkout-occupant-displacement-interop.test.ts` — `describe.each` over shapes S1, S2, S3a–S3f,
  D1–D4, X1–X4, Y1 × `{ checkout t, checkout -f t, reset --hard t, checkout t -- p }` × `{ pool, one, in-core }`
  (variant = repo config written to both peers; `one` only on tsgit). Row shape:
  `{ shape, command, variant, expected: 'git' }` — the expectation is always "same as the peer".
- `test/integration/checkout-leading-symlink-interop.test.ts` — add the `/same` `reset --hard HEAD` and
  `checkout -- p` rows for S3c, S3d (link writes over a directory / under a file).
- `test/integration/cherry-pick-interop.test.ts` and `stash-interop.test.ts` — S1, S3a, S3d, S3e, I1, I2, I6 `/add` and
  S1, S3d `/update`, D1 rows (RC5), including the two data-loss rows (S3a, S3e `/add`).
- `test/integration/sparse-checkout-file-interop.test.ts` — S1, S3a, S3b, S3d `/sparse` × `{ disable, set }`.
- `test/integration/pull-fetch-head-interop.test.ts` (has the http-backend transport) — I1, I2, I6 into unborn and S1
  `/add` ff.
- `test/integration/merge-abort-interop.test.ts`: A.2 `merge --abort` rows (S1–S3f, I1, I2, I4, M1, Y3 × the four
  reset variants), the first-path-only refusal (Y3), state kept on refusal, and `MERGE_AUTOSTASH` consumed (A.5).
- `test/integration/cherry-pick-interop.test.ts` and `revert-interop.test.ts`: the `--abort` / `--skip` rows, and the
  refused multi-pick abort leaving `ORIG_HEAD`, HEAD and `sequencer/` (A.5).
- `test/integration/rebase-interop.test.ts`: `rebase --abort`, `rebase --skip`, start, fast-forward and `-i` start
  rows (untracked refusals, HEAD unmoved, no state written).
- `test/integration/rebase-merges-interop.test.ts`: the `reset` step `/reset-adds` rows and the rescheduled-step
  state (A.5).
- `test/integration/stash-interop.test.ts`: A.3 rows, comparing the W and I trees (`git ls-tree -r stash@{0}`,
  `stash@{0}^2`) as well as the work tree and index.
- `test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts`: the clean and conflicting non-ff restore
  rows, and the up-front S3a, S3e `/same` refusal.
- `test/integration/checkout-file-directory-swap-interop.test.ts`: T1, T2, T3 (A.4).

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
- `test/unit/application/commands/internal/reset-worktree.test.ts`: the three helpers; first-path narrowing; unmerged
  paths reset without a check; one row per protected-reset branch (add beneath file / symlink, add at file / symlink,
  add at a directory with and without an untracked survivor, delete at a directory, ignored expendable).
- `test/unit/application/primitives/materialize-tree.test.ts`: `untrackedOccupants`, `unmergedPaths`, and the P10
  rule in both directions.
- `test/unit/application/commands/stash.test.ts`: P7, one row per path class of the table.
- `test/unit/application/commands/merge.test.ts`: P9 order (snapshot → reset → re-apply → rethrow), nothing re-applied
  on an empty snapshot, the up-front scan.
- `test/unit/application/commands/abort-merge.test.ts`, `rebase.test.ts`, `internal/rebase-merges-steps.test.ts`,
  `cherry-pick.test.ts`, `revert.test.ts`: caller wiring, and nothing written to HEAD, `ORIG_HEAD` or the state files
  when the reset refuses.

Property lens: `obstructingLeadingComponent` is a classifier over a path, not a parser/serializer; the round-trip and
model lenses do not fit beyond what the example rows pin. Mutation: Stryker scoped per touched file (narrowed vitest
include per `.claude/workflow/mutation.md`), 0 survivors; bench: `bench:ab` on checkout of a large tree to confirm R8.

## Out of scope

- O4 above (= 32.27, ADR-1080), the next row.
- Gitlink occupants beyond X4 (submodule directory semantics are owned by the gitlink parity work).
- Case-folding filesystems: the existing fold rows of `checkout-leading-symlink-interop.test.ts` guard the
  intra-wave link race; no new fold shape was probed.

## Appendix A — pinned matrix

Cells: `exit <code> <class>:<paths>` from git's stderr (`local` = "local changes would be overwritten", `untracked` =
"untracked working tree files would be overwritten", `lose-untracked` = "Updating the following directories would
lose untracked files"); `→` the final work tree (`keep` omitted; `x/` directory, `x@->t` symlink, `x=c` file content).
tsgit: error `code` (`COD` = `CHECKOUT_OVERWRITE_DIRTY`, `WTD` = `WORKING_TREE_DIRTY`, `STASH_APPLY_WOULD_OVERWRITE`)
with its arrays, or `ok`; variants are listed only where they differ.


### A.1 — checkout-family callers (git 2.55.0 vs tsgit main 4899565f)

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
| `merge --abort` | yes | ok → d=occupant | pool+in-core: NOT_A_DIRECTORY → d=occupant / one: NOT_A_DIRECTORY → d=occupant keep=(conflict markers) |

##### S2 populated dir f/ where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 lose-untracked:f → f/ f/u=untracked | COD untracked=[f] → f/ f/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | ok → f=v2 |
| `merge t (ff)`, `pull self t (ff)`, `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| `cherry-pick t` | no | 128 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 lose-untracked:f → f/ f/u=untracked | STASH_APPLY_WOULD_OVERWRITE → f/ f/u=untracked |

##### S2 populated dir f/ where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | pool+one: ok → f=v2 / in-core: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| `cherry-pick t` | no | 128 local:f → f/ f/u=untracked | WTD local=[f] → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 local:f → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:f → f/ f/u=untracked | STASH_APPLY_WOULD_OVERWRITE → f/ f/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | WTD untracked=[f] → f/ f/u=untracked |

##### S2 populated dir f/ where file f due/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → f/ f/u=untracked | ok → f/ f/u=untracked |
| `checkout -f HEAD` | yes | ok → f=v1 | ok → f/ f/u=untracked |
| `reset --hard HEAD`, `checkout -- f`, `checkout HEAD -- f` | yes | ok → f=v1 | pool+one: ok → f=v1 / in-core: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |
| `stash push` | yes | ok → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `merge --abort` | yes | ok → f/ f/u=untracked | pool+one: ok → f=v1 / in-core: DIRECTORY_NOT_EMPTY → f/ f/u=untracked |

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
| `stash apply`, `stash pop` | no | 1 untracked:f → f@->nowhere | STASH_APPLY_WOULD_OVERWRITE → f@->nowhere |

##### S3b symlink f where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 local:f → f@->nowhere | COD local=[f] → f@->nowhere |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f=v2 | ok → f=v2 |
| `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f@->nowhere | WTD local=[f] → f@->nowhere |
| `cherry-pick t` | no | 128 local:f → f@->nowhere | WTD local=[f] → f@->nowhere |
| `merge t (non-ff)` | no | 2 local:f → f@->nowhere | WTD local=[f] → f@->nowhere |
| `stash apply`, `stash pop` | no | 1 local:f → f@->nowhere | STASH_APPLY_WOULD_OVERWRITE → f@->nowhere |
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
| `stash apply`, `stash pop` | no | 1 lose-untracked:l → l/ l/u=untracked | STASH_APPLY_WOULD_OVERWRITE → l/ l/u=untracked |

##### S3c populated dir l/ where symlink l due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| `checkout -f t`, `reset --hard t`, `checkout t -- l` | yes | ok → l@->t-v2 | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| `cherry-pick t` | no | 128 local:l → l/ l/u=untracked | WTD local=[l] → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 local:l → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:l → l/ l/u=untracked | STASH_APPLY_WOULD_OVERWRITE → l/ l/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | WTD untracked=[l] → l/ l/u=untracked |

##### S3c populated dir l/ where symlink l due/same

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout HEAD` | no | ok → l/ l/u=untracked | ok → l/ l/u=untracked |
| `checkout -f HEAD` | yes | ok → l@->t-v1 | ok → l/ l/u=untracked |
| `reset --hard HEAD`, `checkout -- l`, `checkout HEAD -- l` | yes | ok → l@->t-v1 | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| `stash push` | yes | ok → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `merge --abort` | yes | ok → l/ l/u=untracked | pool+in-core: DIRECTORY_NOT_EMPTY → keep=(conflict markers) l/ l/u=untracked / one: DIRECTORY_NOT_EMPTY → l/ l/u=untracked |

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
| `stash apply`, `stash pop` | no | 1 untracked:f → f=occupant | STASH_APPLY_WOULD_OVERWRITE → f=occupant |

##### S3f file f where symlink f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | 1 local:f → f=occupant | COD local=[f] → f=occupant |
| `checkout -f t`, `reset --hard t`, `checkout t -- f` | yes | ok → f@->t-v2 | ok → f@->t-v2 |
| `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f=occupant | WTD local=[f] → f=occupant |
| `cherry-pick t` | no | 128 local:f → f=occupant | WTD local=[f] → f=occupant |
| `merge t (non-ff)` | no | 2 local:f → f=occupant | WTD local=[f] → f=occupant |
| `stash apply`, `stash pop` | no | 1 local:f → f=occupant | STASH_APPLY_WOULD_OVERWRITE → f=occupant |
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
| `stash apply`, `stash pop` | no | 1 lose-untracked:f → f/ f/u=untracked | STASH_APPLY_WOULD_OVERWRITE → f/ f/u=untracked |
| `pull self t (into unborn)` | no | ok → f/ f/u=untracked other=o | ok → f/ f/u=untracked other=o |

##### D3 populated dir l/ where deleted symlink l stood/delete

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 lose-untracked:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| `checkout -f t`, `reset --hard t` | yes | ok + warn `unable to unlink` → l/ l/u=untracked other=o | DIRECTORY_NOT_EMPTY → l/ l/u=untracked |
| `cherry-pick t` | no | 128 lose-untracked:l → l/ l/u=untracked | WTD local=[l] → l/ l/u=untracked |
| `checkout t -- keep` | yes | ok → l/ l/u=untracked | ok → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 lose-untracked:l → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 lose-untracked:l → l/ l/u=untracked | STASH_APPLY_WOULD_OVERWRITE → l/ l/u=untracked |
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
| `stash apply`, `stash pop` | no | ok → f=v2 | STASH_APPLY_WOULD_OVERWRITE → f/ f/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:f → f/ f/u=untracked | ok → f=v2 |

##### I2 dir f/ of ignored u where file f due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:f → f/ f/u=untracked | PERMISSION_DENIED → f/ f/u=untracked |
| `cherry-pick t` | no | 128 local:f → f/ f/u=untracked | WTD local=[f] → f/ f/u=untracked |
| `merge t (non-ff)` | no | 2 local:f → f=v1 | PERMISSION_DENIED → f/ f/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:f → f/ f/u=untracked | STASH_APPLY_WOULD_OVERWRITE → f/ f/u=untracked |
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
| `stash apply`, `stash pop` | no | ok → l@->t-v2 | STASH_APPLY_WOULD_OVERWRITE → l/ l/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | ok → l@->t-v2 |

##### I5 dir l/ of ignored u where symlink l due/update

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t`, `merge t (ff)`, `pull self t (ff)` | no | 1 local:l → l/ l/u=untracked | PERMISSION_DENIED → l/ l/u=untracked |
| `cherry-pick t` | no | 128 local:l → l/ l/u=untracked | WTD local=[l] → l/ l/u=untracked |
| `merge t (non-ff)` | no | 2 local:l → l@->t-v1 | PERMISSION_DENIED → l/ l/u=untracked |
| `stash apply`, `stash pop` | no | 1 local:l → l/ l/u=untracked | STASH_APPLY_WOULD_OVERWRITE → l/ l/u=untracked |
| `pull self t (into unborn)` | no | 1 lose-untracked:l → l/ l/u=untracked | ok → l@->t-v2 |

##### I6 ignored file f where file f due/add

| commands | forced | git 2.55 | tsgit main |
|---|---|---|---|
| `checkout t` | no | ok → f=v2 | COD untracked=[f] → f=occupant |
| `merge t (ff)`, `cherry-pick t` | no | ok → f=v2 | WTD untracked=[f] → f=occupant |
| `stash apply` | no | ok → f=v2 | STASH_APPLY_WOULD_OVERWRITE → f=occupant |
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

### A.2 — reset-family callers, non-fast-forward merge refusal, rebase start (git 2.55.0 vs tsgit main 4899565f)

Variants as in "How the matrix was pinned" (revision probe). Cells: `exit <code> <class>:<paths>`. `(first only)` is
git's plain `reset --merge` message, which names one path: `local` = the entry is not up to date, `untracked` = an
untracked file would be overwritten, `lose-untracked` = updating the path would lose untracked files in it.
`unstaged (precondition)` is `rebase` refusing a dirty tree; `unresolved (continue precondition)` is
`rebase --continue` refusing the planted change before the `reset` step runs (both equivalent to tsgit's `WTD local`
with the same state, R7). `→` is the final work tree, `keep` included: `keep=(markers)` means the conflict is still
in the work tree, so the reset did not run. Every git refusal left the index and the state files (`MERGE_HEAD`,
`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `rebase-merge/`, HEAD) as they were. `rebase --abort` on git's apply backend
matched the merge backend on all 50 pairs and is omitted (tsgit has no apply backend).

##### S1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a |
| `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 |

##### S1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a |
| `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |

##### S1/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --abort (merge)` | 128 untracked:d → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t |
| `rebase-merges reset step` | 1 untracked:d → d=occupant keep=a | NOT_A_DIRECTORY → d=occupant keep=u |
| `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase t (fast-forward)` | 1 untracked:d → d=occupant keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | 128 untracked:d → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=t |

##### S1/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a |
| `merge t (non-ff)` | 2 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 untracked:d → d=occupant keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### S2/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f/ f/u=untracked keep=m | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a |
| `merge t (non-ff)` | ok → f/ f/u=untracked keep=k0 side=s | ok → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f/ f/u=untracked keep=(markers) side=s | conflict → f/ f/u=untracked keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 |

##### S2/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a |
| `merge t (non-ff)` | 2 local:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 |
| `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |

##### S2/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m |
| `rebase --abort (merge)` | 128 lose-untracked:f → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f/ f/u=untracked keep=t | ok → f/ f/u=untracked keep=t |
| `rebase-merges reset step` | 1 lose-untracked:f → f/ f/u=untracked keep=a | ok → keep=a other=o |
| `merge t (non-ff)` | 2 lose-untracked:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 lose-untracked:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 lose-untracked:f → f/ f/u=untracked keep=k0 side=s | ok → f=v1 keep=k0 side=s |
| `rebase t (fast-forward)` | 1 lose-untracked:f → f/ f/u=untracked keep=k0 | ok → f=v1 keep=k0 |
| `rebase --skip (pick changes entry)` | 128 lose-untracked:f → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=t |

##### S2/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |
| `rebase --abort (merge)`, `rebase --skip (pick changes entry)` | 128 lose-untracked:f → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a |
| `merge t (non-ff)` | 2 lose-untracked:f → f/ f/u=untracked keep=k0 side=s | WTD untracked=[f] → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 lose-untracked:f → f/ f/u=untracked keep=m side=s | WTD untracked=[f] → f/ f/u=untracked keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 |

##### S3a/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d@->nowhere keep=m | ok → d/ d/x=v1 keep=m |
| `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | ok → d/ d/x=v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | ok → d/ d/x=v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/x] → d@->nowhere keep=a |
| `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | ok → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | conflict → d@->nowhere keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/x] → d@->nowhere keep=k0 |

##### S3a/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | ok → d/ d/x=v1 keep=m |
| `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | ok → d/ d/x=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/x] → d@->nowhere keep=a |
| `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/x] → d@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/x] → d@->nowhere keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | ok → d/ d/x=v1 keep=t |

##### S3a/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=m |
| `rebase --abort (merge)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=m |
| `rebase --skip (merge)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t |
| `rebase-merges reset step` | 1 untracked:d → d@->nowhere keep=a | ok → keep=a other=o |
| `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/x] → d@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d@->nowhere keep=k0 side=s | ok → d/ d/x=v1 keep=k0 side=s |
| `rebase t (fast-forward)` | 1 untracked:d → d@->nowhere keep=k0 | ok → d/ d/x=v1 keep=k0 |
| `rebase --skip (pick changes entry)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/x=v1 keep=t |

##### S3a/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m |
| `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | ok → d/ d/x=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/x] → d@->nowhere keep=a |
| `merge t (non-ff)` | 2 untracked:d → d@->nowhere keep=k0 side=s | WTD untracked=[d] → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 untracked:d → d@->nowhere keep=m side=s | conflict → d/ d/x=v2 keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/x] → d@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/x] → d@->nowhere keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t |

##### S3b/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f@->nowhere keep=m | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f@->nowhere keep=a | WTD local=[f] → f@->nowhere keep=a |
| `merge t (non-ff)` | ok → f@->nowhere keep=k0 side=s | ok → f@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f@->nowhere keep=(markers) side=s | conflict → f@->nowhere keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f@->nowhere keep=k0 | WTD local=[f] → f@->nowhere keep=k0 |

##### S3b/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f@->nowhere keep=(markers) | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f@->nowhere keep=a | WTD local=[f] → f@->nowhere keep=a |
| `merge t (non-ff)` | 2 local:f → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f@->nowhere keep=m side=s | WTD local=[f] → f@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f@->nowhere keep=k0 | WTD local=[f] → f@->nowhere keep=k0 |
| `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |

##### S3b/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:f (first only) → f@->nowhere keep=(markers) | ok → f=v1 keep=m |
| `rebase --abort (merge)` | 128 untracked:f → f@->nowhere keep=(markers) | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f@->nowhere keep=t | ok → f@->nowhere keep=t |
| `rebase-merges reset step` | 1 untracked:f → f@->nowhere keep=a | ok → keep=a other=o |
| `merge t (non-ff)` | 2 local:f → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f@->nowhere keep=m side=s | WTD local=[f] → f@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 untracked:f → f@->nowhere keep=k0 side=s | ok → f=v1 keep=k0 side=s |
| `rebase t (fast-forward)` | 1 untracked:f → f@->nowhere keep=k0 | ok → f=v1 keep=k0 |
| `rebase --skip (pick changes entry)` | 128 untracked:f → f@->nowhere keep=(markers) | ok → f=v1 keep=t |

##### S3b/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f@->nowhere keep=(markers) | ok → keep=m |
| `rebase --abort (merge)` | ok → keep=m | ok → keep=m |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f@->nowhere keep=a | WTD local=[f] → f@->nowhere keep=a |
| `merge t (non-ff)` | 2 untracked:f → f@->nowhere keep=k0 side=s | WTD untracked=[f] → f@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 untracked:f → f@->nowhere keep=m side=s | WTD untracked=[f] → f@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f@->nowhere keep=k0 side=s | WTD local=[f] → f@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f@->nowhere keep=k0 | WTD local=[f] → f@->nowhere keep=k0 |
| `rebase --skip (pick changes entry)` | ok → keep=t | ok → keep=t |

##### S3c/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → keep=m l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase --abort (merge)` | ok → keep=m l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → keep=t l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → keep=a l/ l/u=untracked | WTD local=[l] → keep=a l/ l/u=untracked |
| `merge t (non-ff)` | ok → keep=k0 l/ l/u=untracked side=s | ok → keep=k0 l/ l/u=untracked side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → keep=(markers) l/ l/u=untracked side=s | conflict → keep=(markers) l/ l/u=untracked side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked side=s | WTD local=[l] → keep=k0 l/ l/u=untracked side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked | WTD local=[l] → keep=k0 l/ l/u=untracked |

##### S3c/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:l (first only) → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase --abort (merge)` | ok → keep=m l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase --skip (merge)` | ok → keep=t l@->t-v2 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → keep=a l/ l/u=untracked | WTD local=[l] → keep=a l/ l/u=untracked |
| `merge t (non-ff)` | 2 local:l → keep=k0 l@->t-v1 side=s | PERMISSION_DENIED → keep=k0 l/ l/u=untracked side=s |
| `merge t (non-ff, conflicting)` | 2 local:l → keep=m l@->t-v1 side=s | WTD local=[l] → keep=m l/ l/u=untracked side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked side=s | WTD local=[l] → keep=k0 l/ l/u=untracked side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked | WTD local=[l] → keep=k0 l/ l/u=untracked |
| `rebase --skip (pick changes entry)` | ok → keep=t l@->t-v1 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |

##### S3c/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:l (first only) → keep=(markers) l/ l/u=untracked | ok → keep=m l@->t-v1 |
| `rebase --abort (merge)` | 128 lose-untracked:l → keep=(markers) l/ l/u=untracked | ok → keep=m l@->t-v1 |
| `rebase --skip (merge)` | ok → keep=t l/ l/u=untracked | ok → keep=t l/ l/u=untracked |
| `rebase-merges reset step` | 1 lose-untracked:l → keep=a l/ l/u=untracked | ok → keep=a other=o |
| `merge t (non-ff)` | 2 lose-untracked:l → keep=k0 l@->t-v1 side=s | PERMISSION_DENIED → keep=k0 l/ l/u=untracked side=s |
| `merge t (non-ff, conflicting)` | 2 lose-untracked:l → keep=m l@->t-v1 side=s | WTD local=[l] → keep=m l/ l/u=untracked side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 lose-untracked:l → keep=k0 l/ l/u=untracked side=s | ok → keep=k0 l@->t-v1 side=s |
| `rebase t (fast-forward)` | 1 lose-untracked:l → keep=k0 l/ l/u=untracked | ok → keep=k0 l@->t-v1 |
| `rebase --skip (pick changes entry)` | 128 lose-untracked:l → keep=(markers) l/ l/u=untracked | ok → keep=t l@->t-v1 |

##### S3c/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:l (first only) → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase --abort (merge)`, `rebase --skip (pick changes entry)` | 128 lose-untracked:l → keep=(markers) l/ l/u=untracked | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase --skip (merge)` | ok → keep=t l@->t-v2 | DIRECTORY_NOT_EMPTY → keep=(markers) l/ l/u=untracked |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → keep=a l/ l/u=untracked | WTD local=[l] → keep=a l/ l/u=untracked |
| `merge t (non-ff)` | 2 lose-untracked:l → keep=k0 l/ l/u=untracked side=s | WTD untracked=[l] → keep=k0 l/ l/u=untracked side=s |
| `merge t (non-ff, conflicting)` | 2 lose-untracked:l → keep=m l/ l/u=untracked side=s | WTD untracked=[l] → keep=m l/ l/u=untracked side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked side=s | WTD local=[l] → keep=k0 l/ l/u=untracked side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → keep=k0 l/ l/u=untracked | WTD local=[l] → keep=k0 l/ l/u=untracked |

##### S3d/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a |
| `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 |

##### S3d/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a |
| `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### S3d/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)`, `rebase --skip (pick changes entry)` | 128 untracked:d → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t |
| `rebase-merges reset step` | 1 untracked:d → d=occupant keep=a | NOT_A_DIRECTORY → d=occupant keep=a |
| `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase t (fast-forward)` | 1 untracked:d → d=occupant keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 |

##### S3d/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a |
| `merge t (non-ff)` | 2 untracked:d → d=occupant keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 untracked:d → d=occupant keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### S3e/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d@->nowhere keep=m | ok → d/ d/l@->t-v1 keep=m |
| `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | ok → d/ d/l@->t-v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | ok → d/ d/l@->t-v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/l] → d@->nowhere keep=a |
| `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | ok → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | conflict → d@->nowhere keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/l] → d@->nowhere keep=k0 |

##### S3e/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | ok → d/ d/l@->t-v1 keep=m |
| `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | ok → d/ d/l@->t-v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/l] → d@->nowhere keep=a |
| `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/l] → d@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/l] → d@->nowhere keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | ok → d/ d/l@->t-v1 keep=t |

##### S3e/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:d (first only) → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=m |
| `rebase --abort (merge)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=m |
| `rebase --skip (merge)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t |
| `rebase-merges reset step` | 1 untracked:d → d@->nowhere keep=a | ok → keep=a other=o |
| `merge t (non-ff)` | 128 beyond-symlink → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 128 beyond-symlink → d@->nowhere keep=m side=s | WTD local=[d/l] → d@->nowhere keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 untracked:d → d@->nowhere keep=k0 side=s | ok → d/ d/l@->t-v1 keep=k0 side=s |
| `rebase t (fast-forward)` | 1 untracked:d → d@->nowhere keep=k0 | ok → d/ d/l@->t-v1 keep=k0 |
| `rebase --skip (pick changes entry)` | 128 untracked:d → d@->nowhere keep=(markers) | ok → d/ d/l@->t-v1 keep=t |

##### S3e/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → d@->nowhere keep=m | ok → d@->nowhere keep=m |
| `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | ok → d/ d/l@->t-v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d@->nowhere keep=a | WTD local=[d/l] → d@->nowhere keep=a |
| `merge t (non-ff)` | 2 untracked:d → d@->nowhere keep=k0 side=s | WTD untracked=[d] → d@->nowhere keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 untracked:d → d@->nowhere keep=m side=s | conflict → d/ d/l@->t-v2 keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d@->nowhere keep=k0 side=s | WTD local=[d/l] → d@->nowhere keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d@->nowhere keep=k0 | WTD local=[d/l] → d@->nowhere keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d@->nowhere keep=t | ok → d@->nowhere keep=t |

##### S3f/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f=occupant keep=m | ok → f@->t-v1 keep=m |
| `rebase --abort (merge)` | ok → f@->t-v1 keep=m | ok → f@->t-v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f@->t-v1 keep=t | ok → f@->t-v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f=occupant keep=a | WTD local=[f] → f=occupant keep=a |
| `merge t (non-ff)` | ok → f=occupant keep=k0 side=s | ok → f=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f=occupant keep=(markers) side=s | conflict → f=occupant keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f=occupant keep=k0 | WTD local=[f] → f=occupant keep=k0 |

##### S3f/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f=occupant keep=(markers) | ok → f@->t-v1 keep=m |
| `rebase --abort (merge)` | ok → f@->t-v1 keep=m | ok → f@->t-v1 keep=m |
| `rebase --skip (merge)` | ok → f@->t-v2 keep=t | ok → f@->t-v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f=occupant keep=a | WTD local=[f] → f=occupant keep=a |
| `merge t (non-ff)` | 2 local:f → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f=occupant keep=m side=s | WTD local=[f] → f=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f=occupant keep=k0 | WTD local=[f] → f=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → f@->t-v1 keep=t | ok → f@->t-v1 keep=t |

##### S3f/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 untracked:f (first only) → f=occupant keep=(markers) | ok → f@->t-v1 keep=m |
| `rebase --abort (merge)` | 128 untracked:f → f=occupant keep=(markers) | ok → f@->t-v1 keep=m |
| `rebase --skip (merge)` | ok → f=occupant keep=t | ok → f=occupant keep=t |
| `rebase-merges reset step` | 1 untracked:f → f=occupant keep=a | ok → keep=a other=o |
| `merge t (non-ff)` | 2 local:f → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f=occupant keep=m side=s | WTD local=[f] → f=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 untracked:f → f=occupant keep=k0 side=s | ok → f@->t-v1 keep=k0 side=s |
| `rebase t (fast-forward)` | 1 untracked:f → f=occupant keep=k0 | ok → f@->t-v1 keep=k0 |
| `rebase --skip (pick changes entry)` | 128 untracked:f → f=occupant keep=(markers) | ok → f@->t-v1 keep=t |

##### S3f/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f=occupant keep=(markers) | ok → keep=m |
| `rebase --abort (merge)` | ok → keep=m | ok → keep=m |
| `rebase --skip (merge)` | ok → f@->t-v2 keep=t | ok → f@->t-v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f=occupant keep=a | WTD local=[f] → f=occupant keep=a |
| `merge t (non-ff)` | 2 untracked:f → f=occupant keep=k0 side=s | WTD untracked=[f] → f=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 untracked:f → f=occupant keep=m side=s | WTD untracked=[f] → f=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=occupant keep=k0 side=s | WTD local=[f] → f=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f=occupant keep=k0 | WTD local=[f] → f=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → keep=t | ok → keep=t |

##### I1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a |
| `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 |

##### I1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a |
| `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |

##### I1/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → d/ d/x=v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=m |
| `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t |
| `rebase-merges reset step` | ok → keep=a other=o | NOT_A_DIRECTORY → d=occupant keep=u |
| `merge t (non-ff)` | 2 local:d/x → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/x → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | ok → d/ d/x=v1 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase t (fast-forward)` | ok → d/ d/x=v1 keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/x=v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |

##### I1/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/x (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d/ d/x=v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/x] → d=occupant keep=a |
| `merge t (non-ff)` | ok → d/ d/x=v2 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → d/ d/x=v2 keep=(markers) side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/x] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/x] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### I2/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f/ f/u=untracked keep=m | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a |
| `merge t (non-ff)` | ok → f/ f/u=untracked keep=k0 side=s | ok → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f/ f/u=untracked keep=(markers) side=s | conflict → f/ f/u=untracked keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 |

##### I2/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a |
| `merge t (non-ff)` | 2 local:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 |
| `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |

##### I2/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f/ f/u=untracked keep=t | ok → f/ f/u=untracked keep=t |
| `rebase-merges reset step` | ok → keep=a other=o | ok → keep=a other=o |
| `merge t (non-ff)` | 2 local:f → f=v1 keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f=v1 keep=m side=s | WTD local=[f] → f/ f/u=untracked keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | ok → f=v1 keep=k0 side=s | ok → f=v1 keep=k0 side=s |
| `rebase t (fast-forward)` | ok → f=v1 keep=k0 | ok → f=v1 keep=k0 |
| `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |

##### I2/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |
| `rebase --abort (merge)` | ok + warn `unable to unlink` → f/ f/u=untracked keep=m | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked keep=a | WTD local=[f] → f/ f/u=untracked keep=a |
| `merge t (non-ff)` | ok → f=v2 keep=k0 side=s | ok → f=v2 keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f=v2 keep=(markers) side=s | WTD untracked=[f] → f/ f/u=untracked keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 side=s | WTD local=[f] → f/ f/u=untracked keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f/ f/u=untracked keep=k0 | WTD local=[f] → f/ f/u=untracked keep=k0 |
| `rebase --skip (pick changes entry)` | ok + warn `unable to unlink` → f/ f/u=untracked keep=t | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |

##### I4/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a |
| `merge t (non-ff)` | ok → d=occupant keep=k0 side=s | ok → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → d=occupant keep=(markers) side=s | conflict → d=occupant keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 |

##### I4/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a |
| `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### I4/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip`, `rebase --abort (merge)` | ok → d/ d/l@->t-v1 keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d=occupant keep=t | ok → d=occupant keep=t |
| `rebase-merges reset step` | ok → keep=a other=o | NOT_A_DIRECTORY → d=occupant keep=a |
| `merge t (non-ff)` | 2 local:d/l → keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:d/l → keep=m side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | ok → d/ d/l@->t-v1 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase t (fast-forward)` | ok → d/ d/l@->t-v1 keep=k0 | NOT_A_DIRECTORY → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d/ d/l@->t-v1 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### I4/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:d/l (first only) → d=occupant keep=(markers) | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --abort (merge)` | ok → d=occupant keep=m | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase --skip (merge)` | ok → d/ d/l@->t-v2 keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → d=occupant keep=a | WTD local=[d/l] → d=occupant keep=a |
| `merge t (non-ff)` | ok → d/ d/l@->t-v2 keep=k0 side=s | NOT_A_DIRECTORY → d=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → d/ d/l@->t-v2 keep=(markers) side=s | NOT_A_DIRECTORY → d=occupant keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → d=occupant keep=k0 side=s | WTD local=[d/l] → d=occupant keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → d=occupant keep=k0 | WTD local=[d/l] → d=occupant keep=k0 |
| `rebase --skip (pick changes entry)` | ok → d=occupant keep=t | NOT_A_DIRECTORY → d=occupant keep=(markers) |

##### M1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f=modified keep=m | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)`, `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f=modified keep=a | WTD local=[f] → f=modified keep=a |
| `merge t (non-ff)` | ok → f=modified keep=k0 side=s | ok → f=modified keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f=modified keep=(markers) side=s | conflict → f=modified keep=(markers) side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=modified keep=k0 side=s | WTD local=[f] → f=modified keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f=modified keep=k0 | WTD local=[f] → f=modified keep=k0 |

##### M1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f=modified keep=(markers) | ok → f=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 keep=m | ok → f=v1 keep=m |
| `rebase --skip (merge)` | ok → f=v2 keep=t | ok → f=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f=modified keep=a | WTD local=[f] → f=modified keep=a |
| `merge t (non-ff)` | 2 local:f → f=modified keep=k0 side=s | WTD local=[f] → f=modified keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f → f=modified keep=m side=s | WTD local=[f] → f=modified keep=m side=s |
| `rebase t (start)`, `rebase -i t (start)` | 1 unstaged (precondition) → f=modified keep=k0 side=s | WTD local=[f] → f=modified keep=k0 side=s |
| `rebase t (fast-forward)` | 1 unstaged (precondition) → f=modified keep=k0 | WTD local=[f] → f=modified keep=k0 |
| `rebase --skip (pick changes entry)` | ok → f=v1 keep=t | ok → f=v1 keep=t |

##### Y3/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | ok → f/ f/u=untracked g=occupant keep=m | ok → f=v1 g=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 g=v1 keep=m | ok → f=v1 g=v1 keep=m |
| `rebase --skip (merge)` | ok → f=v1 g=v1 keep=t | ok → f=v1 g=v1 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked g=occupant keep=a | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=a |
| `merge t (non-ff)` | ok → f/ f/u=untracked g=occupant keep=k0 side=s | ok → f/ f/u=untracked g=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 1 conflict → f/ f/u=untracked g=occupant keep=(markers) side=s | conflict → f/ f/u=untracked g=occupant keep=(markers) side=s |

##### Y3/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 local:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m |
| `rebase --abort (merge)` | ok → f=v1 g=v1 keep=m | ok → f=v1 g=v1 keep=m |
| `rebase --skip (merge)` | ok → f=v2 g=v2 keep=t | ok → f=v2 g=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked g=occupant keep=a | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=a |
| `merge t (non-ff)` | 2 local:f,g → f=v1 g=occupant keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:f,g → f=v1 g=occupant keep=m side=s | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=m side=s |

##### Y3/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m |
| `rebase --abort (merge)` | 128 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=(markers) | ok → f=v1 g=v1 keep=m |
| `rebase --skip (merge)` | ok → f/ f/u=untracked g=occupant keep=t | ok → f/ f/u=untracked g=occupant keep=t |
| `rebase-merges reset step` | 1 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=a | ok → keep=a other=o |
| `merge t (non-ff)` | 2 local:g → f=v1 g=occupant keep=k0 side=s | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 local:g → f=v1 g=occupant keep=m side=s | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=m side=s |

##### Y3/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `merge --abort`, `cherry-pick --abort`, `cherry-pick --skip`, `revert --abort`, `revert --skip` | 128 lose-untracked:f (first only) → f/ f/u=untracked g=occupant keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |
| `rebase --abort (merge)` | 128 lose-untracked:f → f/ f/u=untracked g=occupant keep=(markers) | DIRECTORY_NOT_EMPTY → f/ f/u=untracked keep=(markers) |
| `rebase --skip (merge)` | ok → f=v2 g=v2 keep=t | ok → f=v2 g=v2 keep=t |
| `rebase-merges reset step` | 1 unresolved (continue precondition) → f/ f/u=untracked g=occupant keep=a | WTD local=[f,g] → f/ f/u=untracked g=occupant keep=a |
| `merge t (non-ff)` | 2 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=k0 side=s | WTD untracked=[f,g] → f/ f/u=untracked g=occupant keep=k0 side=s |
| `merge t (non-ff, conflicting)` | 2 lose-untracked:f + untracked:g → f/ f/u=untracked g=occupant keep=m side=s | WTD untracked=[f,g] → f/ f/u=untracked g=occupant keep=m side=s |

### A.3 — `stash push` with its stash trees (git 2.55.0 vs tsgit main 4899565f)

Variants: target = HEAD, current = the index (`/reset-updates`: v2 staged; `/reset-adds`: entry removed from the index
only; `/reset-deletes`: v2 staged as a new file). `W[...]` is `git ls-tree -r stash@{0}` (`mode:oid:path`, symlink mode
printed `000`). The I tree matched git on every pair and is omitted.

##### S1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S1/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S1/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d=occupant keep=k0 W[644:8c13:d/x 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S2/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:6267:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 |

##### S2/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 |

##### S2/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### S2/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok + warn `unable to unlink` → f/ f/u=untracked keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 |

##### S3a/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 |

##### S3a/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 |

##### S3a/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] |

##### S3a/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d@->nowhere keep=k0 W[644:8c13:d/x 644:9b37:keep] | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 |

##### S3b/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] |

##### S3b/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] |

##### S3b/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[000:5425:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### S3b/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 W[000:5425:f 644:9b37:keep] | ok → keep=k0 W[000:5425:f 644:9b37:keep] |

##### S3c/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 l@->t-v1 W[644:9b37:keep 000:5b45:l] | PERMISSION_DENIED → keep=k0 l/ l/u=untracked |

##### S3c/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 l@->t-v1 W[644:9b37:keep 000:d085:l] | PERMISSION_DENIED → keep=k0 l/ l/u=untracked |

##### S3c/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 l@->t-v1 W[644:9b37:keep] | ok → keep=k0 l@->t-v1 W[644:9b37:keep] |

##### S3c/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok + warn `unable to unlink` → keep=k0 l/ l/u=untracked W[644:9b37:keep 000:d085:l] | PERMISSION_DENIED → keep=k0 l/ l/u=untracked |

##### S3d/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S3d/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S3d/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S3d/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d=occupant keep=k0 W[000:d085:d/l 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### S3e/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 |

##### S3e/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 |

##### S3e/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | 1 beyond-symlink → d@->nowhere keep=k0 | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] |

##### S3e/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d@->nowhere keep=k0 W[000:d085:d/l 644:9b37:keep] | PATHSPEC_BEYOND_SYMLINK → d@->nowhere keep=k0 |

##### S3f/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] |

##### S3f/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] |

##### S3f/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f@->t-v1 keep=k0 W[644:69bf:f 644:9b37:keep] | ok → f@->t-v1 keep=k0 W[644:9b37:keep] |

##### S3f/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 W[644:69bf:f 644:9b37:keep] | ok → keep=k0 W[644:69bf:f 644:9b37:keep] |

##### I1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I1/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/x=v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I1/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d=occupant keep=k0 W[644:8c13:d/x 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I2/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:6267:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 |

##### I2/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 |

##### I2/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### I2/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok + warn `unable to unlink` → f/ f/u=untracked keep=k0 W[644:8c13:f 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked keep=k0 |

##### I4/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I4/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I4/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d/ d/l@->t-v1 keep=k0 W[644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### I4/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → d=occupant keep=k0 W[000:d085:d/l 644:9b37:keep] | NOT_A_DIRECTORY → d=occupant keep=k0 W[644:9b37:keep] |

##### N0/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 | ok → f=v1 keep=k0 |

##### N0/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:8c13:f 644:9b37:keep] |

##### N0/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:6267:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### N0/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 W[644:8c13:f 644:9b37:keep] | ok → keep=k0 W[644:8c13:f 644:9b37:keep] |

##### M1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] |

##### M1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] | ok → f=v1 keep=k0 W[644:2e09:f 644:9b37:keep] |

##### N1/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### N1/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### N1/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 keep=k0 W[644:9b37:keep] | ok → f=v1 keep=k0 W[644:9b37:keep] |

##### N1/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → keep=k0 W[644:8c13:f 644:9b37:keep] | ok → keep=k0 W[644:9b37:keep] |

##### Y3/same

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 g=v1 keep=k0 W[644:6267:f 644:69bf:g 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 |

##### Y3/reset-updates

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 g=v1 keep=k0 W[644:8c13:f 644:69bf:g 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 |

##### Y3/reset-adds

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok → f=v1 g=v1 keep=k0 W[644:69bf:g 644:9b37:keep] | ok → f=v1 g=v1 keep=k0 W[644:9b37:keep] |

##### Y3/reset-deletes

| commands | git 2.55 | tsgit main |
|---|---|---|
| `stash push` | ok + warn `unable to unlink` → f/ f/u=untracked keep=k0 W[644:8c13:f 644:69bf:g 644:9b37:keep] | PERMISSION_DENIED → f/ f/u=untracked g=occupant keep=k0 |

### A.4 — path restore over a tracked file/directory swap (git 2.55.0 vs tsgit main 4899565f)

##### T1 tracked file `d`; `t` tracks `d/x`

| commands | git 2.55 | tsgit main |
|---|---|---|
| `checkout t -- d/x`, `checkout t -- d` | ok → d/ d/x=v2; index `d/x` only | NOT_A_DIRECTORY (every write path) → d=tracked; index `d` |
| `checkout -f t`, `reset --hard t` | ok → d/ d/x=v2; index `d/x` only | same (SAME) |

##### T2 tracked file `d` modified; `t` tracks `d/x`

| commands | git 2.55 | tsgit main |
|---|---|---|
| `checkout t -- d/x` | ok → d/ d/x=v2 (the local change to `d` is gone); index `d/x` only | NOT_A_DIRECTORY (every write path) → d=modified; index `d` |

##### T3 tracked `d/x`, `d/y`; `t` tracks a file `d`

| commands | git 2.55 | tsgit main |
|---|---|---|
| `checkout t -- d` | ok → d=file; index `d` only | ok → d=file; index `d`, `d/x`, `d/y` (file/directory collision) |

### A.5 — one-off pins (git 2.55.0)

| scenario | git 2.55 | tsgit main |
|---|---|---|
| `merge --autostash t` stops on a conflict, a directory replaces the updated `f`, `merge --abort` | exit 128 local:f; `MERGE_AUTOSTASH` gone, stash list empty, the stashed change to `dirty` not re-applied; `MERGE_HEAD` kept | not run: the abort cannot refuse on main |
| `cherry-pick A C`: `A` applied, `C` stopped; a directory replaces `f` (which `A` changed); `cherry-pick --abort` | exit 128 local:f; HEAD, `ORIG_HEAD`, `sequencer/`, `CHERRY_PICK_HEAD` unchanged | not run (`abort-sequencer-reset.ts:39` writes `ORIG_HEAD` before the reset) |
| same stop, `cherry-pick --skip` | exit 0: the index entry of `f` equals HEAD, so it is untouched; `ORIG_HEAD` = HEAD; sequence finished | not run |
| rebase-merges `reset onto` refused (S2 `/reset-adds`) | exit 1 lose-untracked:f; `reset onto` heads `git-rebase-todo` and ends `done`; HEAD detached at the last pick | overwrites, deleting `f/u`, and completes the rebase |
