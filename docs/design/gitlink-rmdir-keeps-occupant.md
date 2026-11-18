# Design — gitlink-rmdir-keeps-occupant

> Brief: backlog 32.44. When a gitlink leaves the index, git only `rmdir`s its path. tsgit
> deletes a regular file or symlink standing there. The entry places the defect in
> `materializeTreeJudging` (`src/application/primitives/materialize-tree.ts`). The re-pin
> (lesson 033) shows the removal code there is already git's rule. The file goes because the
> repository facade's `FileSystem` wrapper drops the port's optional `rmdir`. The shared
> `removeEmptyDirectory` then falls back to `rm`, which removes files too.
> Status: draft → self-reviewed ×3

## Context

### The corrected backlog statement

32.44 was filed against git 2.55 on 23ff6c1e. Re-pinned on main 243a2f11 against git 2.56.0
(macOS, scrubbed `GIT_*`, signing off, `core.ignorecase` set explicitly to `false` and to `true` in
both twins, 2 repeats):

- **The defect is wider than filed.** It is not one-way only. Every apply that removes a gitlink
  over a regular file or a symlink deletes that occupant. The pinned set covers `reset --hard`,
  `checkout -f`, `stash push` (plain and `-u`), a two-way `checkout`, a fast-forward `merge`, a
  three-way `merge`, `cherry-pick` and `revert`, plus `reset --hard` inside a linked worktree
  (axes 1–2).
- **The locus is not `materialize-tree.ts`.** `applyDeleteEntry` already routes a gitlink to
  `removeGitlinkDirectory` (`src/application/primitives/apply-changeset.ts`). That calls
  `removeEmptyDirectory` (`internal/empty-directories.ts`), which runs
  `(ctx.fs.rmdir ?? ctx.fs.rm)`. `wrapFsValidator` (`src/repository/wrap-fs-validator.ts`) builds
  the `FileSystem` every `openRepository` context uses, and it does not forward `rmdir`. Every port
  member is forwarded except `rmdir?`: `atomicRename?` and `utimeNow?` have guarded pass-throughs and
  the optional probes go through `guardedPathProbe`. So `ctx.fs.rmdir` is `undefined` in
  production, and the fallback `rm` removes the file. Unit suites build `ctx.fs` from a bare
  `MemoryFileSystem`, which has `rmdir`, so they never saw it. Proof:
  - Stack trace of the removal (vitest probe, `node:fs/promises` wrapped):
    `NodeFileSystem.rm ← removeEmptyDirectory (empty-directories.ts:24) ← removeGitlinkDirectory
    (apply-changeset.ts:434) ← applyDeleteWave`.
  - Same tsgit `reset --hard` on the same fixture: `unsafeRawAdapters: false` ⇒ `new` deleted;
    `unsafeRawAdapters: true` (no wrapper, `rmdir` reachable) ⇒ `new` kept, status `?? new`, which
    is git's state (row K1).
  - `rmdir?` was added to the port by 0f8d0b16 (#318). The wrapper was never extended.
- **The stash-apply follow-up** exits **128** on git 2.56 (the entry said 1): `error: The following
  untracked working tree files would be overwritten by merge:\n\tnew\nPlease move or remove them
  before you merge.\nAborting`. With `rmdir` reachable, tsgit's existing apply judge refuses on
  its own with `STASH_APPLY_WOULD_OVERWRITE { untracked: ['new'] }` (After column, S1/S2). That
  was verified, not assumed.
- Two neighbouring divergences came out of the same probes: D2 (`stash push -u` collects files
  under a gitlink directory) and D3 (an added gitlink refuses a directory with content). D3 is
  wider than the stash row it was found on (axis 4).

### git's rule (source, v2.56.0)

```c
/* entry.c */
void unlink_entry(const struct cache_entry *ce, const char *super_prefix) {
	...                                            /* submodule_move_head only with recursion */
	if (check_leading_path(ce->name, ce_namelen(ce), 1) >= 0) return;
	if (remove_or_warn(ce->ce_mode, ce->name)) return;
	schedule_dir_for_removal(ce->name, ce_namelen(ce));
}
int remove_or_warn(unsigned int mode, const char *file) {
	return S_ISGITLINK(mode) ? rmdir_or_warn(file) : unlink_or_warn(file);
}
/* wrapper.c */
int rmdir_or_warn(const char *file) { return warn_if_unremovable("rmdir", file, rmdir(file)); }
static int warn_if_unremovable(const char *op, const char *file, int rc) {
	if (!rc || errno == ENOENT) return 0;
	warning_errno("unable to %s '%s'", op, file);   /* ENOTDIR → "Not a directory" */
	...
}
/* unpack-trees.c — verify_clean_subdirectory, the D3 rule */
if (S_ISGITLINK(ce->ce_mode)) {
	int sub_head = repo_resolve_gitlink_ref(the_repository, ce->name, "HEAD", &oid);
	if (!sub_head && /* submodule HEAD equals the entry oid */ 1) return 0;
	return verify_clean_submodule(...);   /* returns 0 unless submodule recursion is on */
}
```

So: a gitlink path is only ever `rmdir`ed. A file, a symlink or a non-empty directory stays, with
a warning, and the index loses the entry. An empty directory goes. An *added* gitlink never treats
a directory at its path as something to lose. A file or symlink there is still an untracked
occupant (`verify_absent`).

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/repository/wrap-fs-validator.ts` | `wrapFsValidator(fs, roots, allowExternalPaths, { guardReads })` | builds the confined `FileSystem` for `openRepository`'s main context and for every `worktreeFs` (`src/repository.ts`, the two `wrapFsValidator(` calls). Forwards every member except `rmdir?` |
| same file | `guardedAtomicRename`, `guardedUtimeNow`, `guardedPathProbe` | the precedent: an optional member is forwarded with its guard when the adapter has it, and left absent when it does not |
| `src/ports/file-system.ts` | `FileSystem.rmdir?: (path) => Promise<void>` | POSIX `rmdir`: a file or symlink refuses `NOT_A_DIRECTORY`, non-empty `DIRECTORY_NOT_EMPTY`, absent `FILE_NOT_FOUND` |
| `src/adapters/node/node-file-system.ts` | `rmdir`, `assertRmdirKind`, `PathPolicy.honoursRmdirKinds` | Windows (`honoursRmdirKinds: false`) gets an `lstat` kind check before the syscall, so a file and a directory symlink refuse `NOT_A_DIRECTORY` as on POSIX. No adapter change is needed |
| `src/adapters/memory/memory-file-system.ts`, `src/adapters/browser/browser-file-system.ts` | `rmdir` | both refuse a non-directory (`assertDirectoryEntry` on OPFS) |
| `src/application/primitives/internal/empty-directories.ts` | `removeEmptyDirectory(ctx, dir)`, `removeEmptyDirectoryTree`, `UNREMOVABLE_DIRECTORY_CODES` | `rmdir ?? rm`. The doc comment requires `dir` to be "known to be a directory" when `rmdir` is absent |
| `src/application/primitives/apply-changeset.ts` | `applyDeleteEntry`, `removeGitlinkDirectory(ctx, abs, path)` | gitlink delete → `removeEmptyDirectory`. Its precondition is not met: the path's kind is unknown. Warns `unable to rmdir '<p>': Directory not empty` through `ctx.logger?.warn` for a directory only |
| same file | `evaluateDirtyPath` (add branch), `evaluateProtectedPath` (add branch), `isLinkWrite`, the `entry.mode === FILE_MODE.GITLINK` skip in the directory-clearing loop | D3 in the checkout/merge-ff path: the add verdict comes from `classifyOccupant(ctx, { kind: 'add', path }, scope)`, which has no mode |
| `src/application/primitives/internal/occupant-clash.ts` | `classifyOccupant` | the shared occupant verdict (D3) |
| `src/application/primitives/find-would-overwrite.ts` | `findWouldOverwrite`, `untrackedSquat` | D3 in the three-way path (merge, cherry-pick, revert, stash apply via `applyMergeToWorktree`) |
| `src/application/primitives/internal/prune-emptied-directories.ts` | `removeIfEmptyDirectory`, `isRealDirectory` | the guarded form: when `rmdir` is absent, `lstat` first and `rm` only a real directory |
| `src/application/primitives/record-ref-update.ts` | `reflogPathKind` (`stat`, follows links), `clearLogDirectory` → `removeEmptyDirectoryTree` | a consumer whose result changes (row L1) |
| `src/application/primitives/ref-store.ts` | `clearDirectory`, `pruneEmptyParents` → `removeEmptyDirectory(Tree)` | consumers; see the consumer table |
| `src/application/commands/stash.ts` | `listUntracked(ctx, index)` → `walkWorkingTreeReporting(ctx, { ignore }, reportEmpty)` | D2: `tracked` holds `new` but the walk descends into `new/` and yields `new/x` |
| `src/application/commands/internal/clean-work-tree.ts` | `gitlinkPaths` | precedent: a gitlink's paths are taken from the stage-0 entries |

### Constraining ADRs and doctrine

- ADR-226 (prime directive), ADR-249 (structured output: no rendered text in results).
- ADR-1170 (filing bar): D1, D2 and D3 all give a wrong result on a well-formed repository. D1
  loses user bytes (`precious` is not in any object for the index-only rows reset by
  `reset --hard`/`checkout -f`). D2 gives a different stash commit. D3 refuses where git
  succeeds.
- DOCTRINE D-2 (fold a shared-primitive half whole, one interop pin per affected consumer) and
  D-3 / ADR-1190 / ADR-1204 (a new refusal where tsgit returned is breaking, `!`). ADR-1199 (a
  removed refusal is `fix`).
- Lesson 038: the consumer table below lists the callers of `removeEmptyDirectory` and
  `ctx.fs.rmdir`, the primitive the wrapper feeds, not only the callers of `materializeTree`.
- Lesson 042: every row is pinned under `core.ignorecase=false` and `=true`. No row depends on it.

## Pinned matrix (git 2.56.0, tsgit main 243a2f11, 2026-11-18)

Fixture: `a.txt` committed (branch `base` at that commit). The gitlink `new` is added with
`update-index --add --cacheinfo 160000,<HEAD>,new`. It is either **index-only** or **in-head**
(committed, and the target is `base`, which lacks it). The occupant at `new` is a regular file
`precious`, a symlink → `a.txt`, a directory holding `x`, or an empty directory. `a.txt` is edited.
"After" = the same tsgit build opened with `unsafeRawAdapters: true`, which is exactly the `rmdir`
reachability the D1 fix restores (the wrapper adds containment guards, nothing else). Raw outputs:
the session scratchpad (matrix, after, consumers, added-gitlink and ref-symlink outputs; not committed).
Every row has the same outcome under both `core.ignorecase` values. The axis 1 matrix ran twice per
value, the others once per value. All are deterministic file-state outcomes.

### Axis 1 — one-way removal of a gitlink (op × placement × occupant)

| # | Op | Placement | Occupant | git | tsgit main | After |
|---|---|---|---|---|---|---|
| O1 | `reset --hard` | index-only, in-head | file | 0, `warning: unable to rmdir 'new': Not a directory`; file kept; index `a.txt`; status `?? new` | 0; **file deleted**; status clean | = git |
| O2 | same | same | symlink | same, symlink kept | **symlink deleted** | = git |
| O3 | same | same | dir `new/x` | 0, `warning: unable to rmdir 'new': Directory not empty`; dir kept; `?? new/x` | match | match |
| O4 | same | same | empty dir | 0, removed | match | match |
| O5 | `checkout -f --detach <t>` | index-only, in-head | file / symlink / dir / empty | as O1–O4 | file/symlink **deleted**; dir/empty match | = git |
| O6 | `stash push` | index-only | file / symlink | 0, warning, occupant kept, `?? new` | **deleted** | = git |
| O7 | `stash push` | index-only | dir / empty | as O3/O4 | match | match |
| O8 | `stash push -u` | index-only | file / symlink | as O6 | **deleted** | = git |
| O9 | `stash push -u` | index-only | dir `new/x` | 0; **no untracked commit**; `new/x` kept, `?? new/x` | U tree holds `new/x`; `new/x` removed by the `-u` clean | **still differs (D2)** |
| O10 | `stash push`, `push -u` | in-head | all four | 0; occupant replaced by the gitlink's empty dir (the reset target keeps `new`) | match | match |
| O11 | `reset --hard` in a linked worktree | index-only | file / symlink | as O1/O2 | **deleted** | = git |
| O12 | `read-tree -u --reset HEAD` | index-only | all four | as O1–O4 | no surface | — |

### Axis 2 — two-way and three-way removal (in-head gitlink, `rmg` = a commit dropping it)

| # | Op | Occupant | git | tsgit main |
|---|---|---|---|---|
| T1 | `checkout base` (two-way, non-forced) | file / symlink | 0, `unable to rmdir 'new': Not a directory`, kept, `?? new` | **deleted** |
| T2 | `merge --ff-only rmg` | file / symlink | same | **deleted** |
| T3 | `merge rmg` (three-way, `main` diverged by `b.txt`) | file / symlink | same | **deleted** |
| T4 | `cherry-pick rmg` (diverged) | file / symlink | same | **deleted** |
| T5 | `revert <gitlink commit>` (diverged) | file / symlink | same | **deleted** |

All five take the same `applyDeleteEntry` → `removeGitlinkDirectory` path. The After build was not
run on axis 2. K1 shows the mechanism (rmdir reachable ⇒ occupant kept), and the interop suite is
the gate.

### Axis 3 — the stash-apply follow-up (after the push of axis 1)

| # | Stash pushed over | git `stash apply` | tsgit main | After |
|---|---|---|---|---|
| S1 | index-only + file (O6, O8) | **128**, `untracked working tree files would be overwritten by merge: new`; nothing changes | 0; stages `100644 new` | `STASH_APPLY_WOULD_OVERWRITE { paths: ['new'], localChanges: [], untracked: ['new'] }`; nothing changes |
| S2 | index-only + symlink | same | 0; stages `120000 new` | same as S1 |
| S3 | index-only + dir `new/x`, plain push (O7) | 0; stages `160000 new`, dir kept, `M a.txt`, `A new` | **refuses** `STASH_APPLY_WOULD_OVERWRITE { untracked: ['new'] }` | still refuses **(D3)** |
| S4 | index-only + dir, `push -u` (O9) | 0, `160000 new` staged | match (by another route: tsgit's U restore) | match |
| S5 | index-only + empty dir | 0, `160000 new` | match | match |
| S6 | in-head, all four | 0, match (symlink: git prints `error: expected submodule path 'new' not to be a symbolic link`, exits 0) | match | match |

### Axis 4 — an added gitlink over a directory with content (D3's reach)

Branch `G` adds gitlink `new`. On `main`, the untracked `new/x` stands on disk. "diverged" = `main`
has an extra commit `b.txt`.

| # | Op | git | tsgit main |
|---|---|---|---|
| A1 | `checkout G` (two-way) | 0; index `160000 new`; `new/x` kept | `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: ['new'] }` |
| A2 | `merge --ff-only G` | 0; same | `WORKING_TREE_DIRTY { localChanges: [], untracked: ['new'] }` |
| A3 | `merge G` (diverged, three-way) | 0; same | `WORKING_TREE_DIRTY { untracked: ['new'] }` |
| A4 | `cherry-pick G` (diverged) | 0; same | `WORKING_TREE_DIRTY { untracked: ['new'] }` |
| A5 | `stash apply` (= S3) | 0 | `STASH_APPLY_WOULD_OVERWRITE { untracked: ['new'] }` |
| A6 | forced add (`apply-changeset.test.ts` "a forced add of the gitlink") | — | already leaves the directory (unit row) |

### Axis 5 — other consumers of `rmdir` reachability

| # | Form | git | tsgit main (wrapped) | tsgit raw (= after D1) |
|---|---|---|---|---|
| K1 | `reset --hard`, index-only gitlink + file / symlink | occupant kept, `?? new` | deleted | kept, `?? new` |
| L1 | `.git/logs/refs/heads/x` is a symlink to an empty directory, `core.logAllRefUpdates=true`, `branch x` (×2) | 128, `cannot update the ref 'refs/heads/x': there are still logs under '.git/logs/refs/heads/x'`; no ref; symlink kept | 0; symlink replaced by a log file; ref created | `DIRECTORY_NOT_EMPTY { path: <…>/logs/refs/heads/x }`; no ref; symlink kept |
| L2 | `.git/refs/heads/x` is a symlink to an empty directory, `branch x` (×2) | 128, `there is a non-empty directory '.git/refs/heads/x' blocking reference` | 0, ref written | 0, ref written: **unchanged by the fix**. Out of perimeter, see the end |

## Consumer table (lesson 038)

The primitive the fix changes is **`ctx.fs.rmdir` reachability**. The callers are those of
`removeEmptyDirectory` / `removeEmptyDirectoryTree` and every reader of `ctx.fs.rmdir`, not only
`materializeTree`'s callers.

| Caller | Reached from | Kind of path it passes | Effect of `rmdir` becoming reachable | Pin |
|---|---|---|---|---|
| `apply-changeset.ts` `removeGitlinkDirectory` | every `applyChangeset` delete of a 160000 entry: `materializeTree(Judging)` (checkout switch, forced and two-way; `reset` hard/merge/keep; merge ff/squash; `pull`, `pull-into-void`; `worktree`; `stash` push reset/apply; `apply-sparse-checkout`; `materialize-worktree-from-head`; rebase via `reset-worktree.ts`) and `applyMergeToWorktree` (three-way merge, cherry-pick, revert, stash apply) | unknown kind | **the fix**: file/symlink kept; dir/empty unchanged | O1–O11, T1–T5 |
| `apply-changeset.ts` `removeIgnoredBelow` | clearing a directory that becomes a file | a `readdir` child with `isDirectory` | none: it is a real directory | — |
| `prune-emptied-directories.ts` `removeIfEmptyDirectory` | `applyChangeset` prune, `rm.ts`, `apply-merge-to-worktree.ts` | any | none observable: the `rmdir` branch replaces `lstat` + `rm` and gives the same verdict. One `lstat` fewer per scheduled directory | covered by existing suites |
| `record-ref-update.ts` `clearLogDirectory` → `removeEmptyDirectoryTree` | every ref update that creates a reflog | `stat`-judged directory (a symlink to one counts) | symlinked log dir: replaced today, refused after (git refuses) | L1 |
| `ref-store.ts` `clearDirectory` → `removeEmptyDirectoryTree` | a loose ref write over a directory | `pathKind` via `stat` | none: L2 diverges identically raw and wrapped | L2 |
| `ref-store.ts` `pruneEmptyParents` → `removeEmptyDirectory` | ref deletion | a parent directory, "known" | a symlinked parent directory would be kept instead of unlinked (git's `try_remove_empty_parents` uses `rmdir`). Not pinned. To prove: twin with `.git/refs/heads/d` → symlink to an empty dir holding `x`'s parent, `branch -D d/x`, compare `ls -l .git/refs/heads` | not pinned |
| `prune-worktrees.ts` `removeIfEmpty` | `worktree prune` | calls `ctx.fs.rm` after an empty `readdir` | none | — |
| Third-party `opts.fs` with an `rmdir` | any of the above | — | its `rmdir` is now called. It was never reachable through the wrapper before | wrapper unit row |
| Third-party `opts.fs` without `rmdir`, or `unsafeRawAdapters` over one | `removeGitlinkDirectory` | unknown kind | still deletes a file unless D-B below adds the guard | unit row (memory fs with `rmdir` removed) |

One-way vs two-way does not matter here. The removal is below the two-way carry
(`carryHeadAgreement` runs before the apply and never removes a gitlink itself), so every consumer
hits the same line.

## Requirements

Axes: **op** (one-way reset/forced checkout/stash push reset; two-way checkout/merge ff; three-way
merge/cherry-pick/revert/stash apply) × **placement** (index-only, in-head) × **occupant** (file,
symlink, non-empty dir, empty dir, absent) × **`core.ignorecase`** (false, true).

- **R1 — removing a gitlink (every op, both placements, both settings).** When an apply removes a
  160000 entry, its work-tree path is only ever `rmdir`ed. An empty directory is removed. A
  non-empty directory, a regular file and a symlink stay byte-identical. An absent path is no
  failure. The resulting index never holds the entry. A leading-symlink path is skipped as today.
  The op's result (exit, refs, index, other paths) is what it was before the fix. Only the occupant
  survives. A kept non-directory occupant is reported per D-C.
- **R2 — the confined filesystem.** `wrapFsValidator` exposes `rmdir` exactly when the wrapped
  adapter has it. The path is checked with the **write** guard (`guard`, never `readGuard`), as
  for `rm`, whatever `guardReads` says. An adapter without `rmdir` yields a wrapper without
  `rmdir`, which keeps the `rm` fallback. Applies to the main context and to every `worktreeFs`.
- **R3 — an adapter without `rmdir`** (per D-B). The gitlink removal does not reach `rm` unless
  the path is known to be a real directory (`lstat` first), as `removeIfEmptyDirectory` does.
- **R4 — stash apply after R1 (axis 3).** No code change. With the occupant kept, `stash apply`
  of a stash that adds `new` as a file or symlink refuses
  `STASH_APPLY_WOULD_OVERWRITE { paths: ['new'], localChanges: [], untracked: ['new'] }` and
  changes nothing (git: exit 128 and the untracked-overwrite message).
- **R5 — a symlinked reflog directory (L1).** Creating a reflog where `logs/<ref>` is a symlink to
  a directory refuses `DIRECTORY_NOT_EMPTY { path }`. The symlink stays and the ref is not
  written. This follows from R2 with no code of its own.
- **R6 — D3, if folded (D-D).** Adding a 160000 entry at a path that holds a directory (empty or
  not, any content, either setting) is no occupant clash in any judge. That covers the
  `apply-changeset` add verdicts (non-forced and `untrackedOccupants: 'protect'`) and
  `findWouldOverwrite`'s `untrackedSquat`. The directory is left as it is and the index gains the
  gitlink. A regular file or a symlink at that path still refuses `untracked: [path]` (S1/S2). A
  file at a *leading* component is judged as today. Out of scope: submodule recursion (no tsgit
  surface).
- **R7 — D2, if folded (D-E).** `stash push -u` never collects a path at or beneath a stage-0
  160000 index entry, nor an empty directory beneath one. When nothing else is untracked, the
  stash has no untracked parent and the `-u` clean removes nothing (O9).

### Every pinned row against its requirement

| Rows | Req | Walk |
|---|---|---|
| O1, O2, O5 (file/symlink), O6, O8, O11, T1–T5 | R1, R2 | `rmdir` reaches the adapter → `NOT_A_DIRECTORY` ∈ `UNREMOVABLE_DIRECTORY_CODES` → `removeEmptyDirectory` returns `false` → `removeGitlinkDirectory` returns `undefined` (not counted as deleted, no directory scheduled) → occupant kept. The index loses the entry because `assembleIndexEntries` builds from the target, not from the removal's result. K1 shows it end to end on O1/O2 |
| O3, O4, O5 (dir/empty), O7, O10 | R1 | unchanged paths (`DIRECTORY_NOT_EMPTY` / success). These already match |
| O9 | R7 | the defect is in `listUntracked`, independent of R2 (After still differs) |
| O11 | R2 | the linked worktree's context gets its fs from `worktreeFs`, the second `wrapFsValidator(` call. R2 must cover both calls |
| O12 | — | no `read-tree -u` surface |
| S1, S2 | R4 | After column. The kept occupant meets `findWouldOverwrite` as an untracked squat |
| S3, A1–A5 | R6 | one rule, three judges. A1/A2 go through `applyChangeset`'s `evaluateDirtyPath`. A3/A4/A5 go through `findWouldOverwrite` |
| S4–S6 | — | already match. S6's git `error:` line comes with exit 0 and the same state. Display only (ADR-249) |
| L1 | R5 | `clearLogDirectory` → `removeEmptyDirectoryTree`: `readdir` through the link (empty) → `removeEmptyDirectory(link)` → `rmdir` refuses `NOT_A_DIRECTORY` → `false` → `directoryNotEmpty(path)`. Same state as git |
| L2 | — | unchanged. Out of perimeter |

The walk found three gaps in the first draft's rules. (1) R1 first said "one-way reset", but T1–T5
prove the two-way and three-way consumers lose the file through the same line, so R1 is
op-independent. (2) The wrapper fix alone leaves `removeGitlinkDirectory` violating
`removeEmptyDirectory`'s documented precondition on an adapter without `rmdir`. Hence R3, a
decision (D-B), not a silent assumption. (3) L1 turns a success into a refusal. That is the only
new throw this change makes, and it drives D-F.

## Design

### 1. `wrapFsValidator` forwards `rmdir` (R2)

Mirror `guardedUtimeNow`:

```ts
/**
 * `rmdir` is optional on the port: an adapter without it stays without it behind the wrapper, so
 * `removeEmptyDirectory` keeps its `rm` fallback there; where it exists it is guarded as a write.
 */
const guardedRmdir = (fs: FileSystem, guard: (path: string) => void): Pick<FileSystem, 'rmdir'> => {
  const { rmdir } = fs;
  if (rmdir === undefined) return {};
  return {
    rmdir: (p) => {
      guard(p);
      return rmdir.call(fs, p);
    },
  };
};
```

and `...guardedRmdir(fs, guard),` beside `...guardedUtimeNow(fs, guard),` in the returned object.
`.call(fs, …)` keeps `BrowserFileSystem.rmdir` (a prototype method) bound. The Node and memory
`rmdir` are arrow fields and would not need it.

### 2. `removeGitlinkDirectory` stops relying on an unchecked precondition (R3, D-B = A shown)

Reuse the guard that already exists for the prune instead of copying it:

```ts
// internal/empty-directories.ts — moved from prune-emptied-directories.ts, exported
/** `removeEmptyDirectory` for a path of unknown kind: without `rmdir`, only a real directory reaches `rm`. */
export const removeIfEmptyDirectory = async (ctx: Context, path: string): Promise<boolean> =>
  ctx.fs.rmdir === undefined
    ? (await isRealDirectory(ctx, path)) && (await removeEmptyDirectory(ctx, path))
    : removeEmptyDirectory(ctx, path);

// apply-changeset.ts
const removeGitlinkDirectory = async (ctx, abs, path) => {
  if (await removeIfEmptyDirectory(ctx, abs)) return path;
  warnUnremovedGitlink(ctx, path, await lstatIfReachable(ctx.fs, abs));   // D-C
  return undefined;
};
```

`prune-emptied-directories.ts` imports it instead of defining it. That is a move, not a change.

### 3. The warning (D-C = A shown)

`removeGitlinkDirectory` already logs git's text for the directory case through `ctx.logger?.warn`.
A kept non-directory gets git's matching line:

```ts
const warnUnremovedGitlink = (ctx: Context, path: FilePath, stat: FileStat | undefined): void => {
  if (stat === undefined) return;                          // git: ENOENT is silent
  const reason = stat.isDirectory ? 'Directory not empty' : 'Not a directory';
  ctx.logger?.warn?.(`unable to rmdir '${path}': ${reason}`);
};
```

There is no structured warnings channel on `ResetResult`, `CheckoutResult`, `StashPushResult` or
`MergeResult`. ADR-249 forbids rendered text in results, but `ctx.logger` is the existing
diagnostic side channel (its siblings are `unable to unlink '<p>'` and the directory case above).
Adding a result field is option C of D-C.

### 4. D3 — an added gitlink yields to a directory (R6, if D-D = A)

The verdict is shared, so the mode goes to `classifyOccupant` once instead of three call-site
special cases. Today (`internal/occupant-clash.ts`):

```ts
export type OccupantShape =
  | { readonly kind: 'add'; readonly path: FilePath }
  | { readonly kind: 'update' | 'delete'; readonly path: FilePath };
const classifyAddedPath = async (ctx, path, scope) => {
  …
  if (stat.isDirectory) return (await holdsSurvivor(ctx, absPath, scope)) ? untracked(path) : CLEAR;
  …
};
```

After:

```ts
export type OccupantShape =
  | { readonly kind: 'add'; readonly path: FilePath; readonly mode: FileMode }
  | { readonly kind: 'update' | 'delete'; readonly path: FilePath };
// classifyAddedPath(ctx, shape, scope):
// git's verify_clean_subdirectory returns early for a gitlink: the directory is the submodule's.
if (stat.isDirectory) return shape.mode === FILE_MODE.GITLINK ? CLEAR : survivorVerdict(…);
```

`mode` is required on `add`, so the type checker finds every add call site: `evaluateDirtyPath`
and `evaluateProtectedPath` (`mode: entry.mode`) and `findWouldOverwrite`'s `untrackedSquat`.
`findWouldOverwrite(ctx, paths: ReadonlySet<FilePath>, currentIndex, removed)` gets no mode
today. It needs the result side's mode per added path. Its callers are `apply-merge-to-worktree.ts`
(from `merged.outcomes`) and `merge.ts`. The planner picks the carrier: a
`ReadonlyMap<FilePath, FileMode>` in place of the set, or a sibling `addedGitlinks` set. The
leading-component check (`classifyLeadingObstruction`) runs first and is unchanged, so a file in a
gitlink's leading path still refuses.

### 5. D2 — `listUntracked` prunes at gitlinks (R7, if D-E = A)

```ts
const listUntracked = async (ctx: Context, index: GitIndex): Promise<UntrackedListing> => {
  const tracked = new Set(index.entries.map(indexPathKey));
  const gitlinks = new Set(index.entries.filter(isStageZeroGitlink).map(escapedPathOf));
  const repoIgnore = await buildRepoIgnorePredicate(ctx);
  const ignore: WalkIgnorePredicate = (path, isDirectory) =>
    (isDirectory && gitlinks.has(path)) || repoIgnore(path, isDirectory);   // pruned before descent
  …
};
```

`WalkWorkingTreeOptions.ignore` prunes a directory before descent (`types.ts`), so `new/x` is
never `lstat`ed and `reportEmpty` never sees an empty subdirectory beneath it. `clean-work-tree.ts`
`gitlinkPaths` is the precedent for taking stage-0 gitlinks. The planner checks the predicate's
path form (relative, escaped) against `buildRepoIgnorePredicate`'s.

### 6. `materialize-tree.ts`

Untouched. The 32.44 entry's promised mutation run over `materialize-tree.ts` moves to the files
this change edits (Test plan, Mutation).

### 7. Docs

- `docs/use/` pages for `reset`, `checkout`, `stash`, `merge`: no option or result changes. One
  Behaviour bullet on `reset.md` and `checkout.md`: "a gitlink's path is only removed when it is an
  empty directory; anything else standing there is kept". With D-D, `checkout.md`/`merge.md` add
  "an added gitlink never counts a directory at its path as an untracked occupant".
- `docs/BACKLOG.md`: tick 32.44 with the corrected statement (locus = the fs wrapper; exit 128; the
  wider op set).

## Test plan

### Unit (memory adapter unless named)

- `test/unit/repository/wrap-fs-validator.test.ts`: new `describe('wrapFsValidator — the optional
  rmdir capability')`, mirroring the `utimeNow` block.
  - `Given an fs with rmdir and an in-root path` → forwarded once with that path (spy), resolves.
  - `Given an fs with rmdir and a path outside every root` → `PATHSPEC_OUTSIDE_REPO` with the path
    (assert `data`), adapter not called. Runs once with `guardReads: false` to kill a `readGuard`
    mutant.
  - `Given an fs without rmdir` → `'rmdir' in sut` is `false`.
  - `Given a BrowserFileSystem-like fs whose rmdir is a prototype method using this` → still bound.
- `test/unit/application/primitives/apply-changeset.test.ts`, beside `Given a gitlink delete over a
  directory that is already gone`:
  - `Given a gitlink delete over a regular file` / `over a symlink` (`it.each`) → occupant bytes
    kept, `deleted` 0, the parent directory not pruned, `warn` called with
    `"unable to rmdir 'sub': Not a directory"` (D-C).
  - `Given an fs without rmdir and a gitlink delete over a regular file` (memory fs with `rmdir`
    deleted on a spread copy) → file kept (R3). This kills the mutant that drops the `lstat` guard.
  - existing directory-not-empty and already-gone rows keep their assertions (kills
    `reason` swaps and the `stat === undefined` early return).
- `test/unit/repository/repository.test.ts` (the facade suite that opens a `MemoryFileSystem`
  through `openRepository`): `Given an index-only gitlink over a regular file, When reset hard runs through
  the facade` → file kept, index without `new`. This is the one unit row that runs through the
  wrapper. Without it the unit suites stay blind to the defect.
- If D-D = A: `test/unit/application/primitives/internal/occupant-clash.test.ts` (or its covering
  suite) adds a gitlink add over a non-empty directory → no clash, the same over a file → `untracked`,
  and a non-gitlink add over the same directory → `untracked` (kills a dropped mode test).
  `find-would-overwrite.test.ts` adds A3's shape. `apply-changeset.test.ts` adds a non-forced
  gitlink add over a populated directory (A1).
- If D-E = A: `test/unit/application/commands/stash.test.ts` adds `Given an index-only gitlink whose
  directory holds x, When push runs with includeUntracked` → no untracked parent, `new/x` kept. A
  sibling with one other untracked file → the U tree holds only that file.
- `test/unit/application/primitives/record-ref-update.test.ts` (or its covering suite): L1 on
  the memory adapter (symlinked log dir → `DIRECTORY_NOT_EMPTY`). This already holds there, so it
  pins behaviour rather than going red.

### Cross-tool interop — `test/integration/gitlink-removal-occupant-interop.test.ts` (new)

Built from the probe skeleton (`<scratch>/probe/gitlink-occupant.probe.test.ts`) with
`GIT_AVAILABLE`, `makePeerPair`, `runGit`/`tryRunGitWithExit` from `interop-helpers.ts`, and
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` for the symlink rows.
`describe.each(['false', 'true'])` sets `core.ignorecase` in **both** twins. Compared: occupant
kind and bytes at `new`, `ls-files -s` (oids stripped where the commit differs), `status
--porcelain=v1 -uall`, exit/refusal mapped field-to-message, and for stash rows the follow-up
`stash apply` and `rev-parse -q --verify stash^3` (untracked parent present or not).

- Axis 1: O1–O8, O10, O11 (each occupant, each placement).
- Axis 2: T1–T5 (one interop pin per consumer, D-2).
- Axis 3: S1, S2 (refusal ↔ git 128 message), S5, S6. S3 under D-D.
- Axis 4 (D-D): A1–A5.
- O9 (D-E).
- L1, in `test/integration/ref-transaction-interop.test.ts` beside its `still logs under` rows.

### Hand-verify covering set

`test/integration/checkout-*.test.ts`, `reset-interop.test.ts`, `stash-*.test.ts`,
`merge-interop.test.ts`, `cherry-pick*-interop.test.ts`, `revert*-interop.test.ts`,
`ref-transaction-interop.test.ts`. The wrapper sits under every interop suite, so a full
`npm run test:integration` run is part of validation, not a sampled pass.

### Property tests

None. No parser, decoder, matcher or serializer is touched. `wrap-fs-validator.properties.test.ts`
compares containment verdicts. It gains `rmdir` in its write-surface list only if that list is
enumerated there (planner checks).

### Mutation

Narrowed eponymous corpora: `wrap-fs-validator.ts` on `wrap-fs-validator*.test.ts`;
`apply-changeset.ts` (the gitlink removal and, under D-D, the add verdicts) on
`apply-changeset.test.ts`; `internal/empty-directories.ts` + `internal/prune-emptied-directories.ts`
on their suites; under D-D `occupant-clash.ts` and `find-would-overwrite.ts`; under D-E
`stash.ts` `listUntracked` on `stash*.test.ts`. A survivor that only an importer's test would kill
is hand-verified against the full covering set.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D-A | Where D1 is fixed | **A** forward `rmdir` through `wrapFsValidator` (§1). **B** leave the wrapper and `lstat`-guard `removeGitlinkDirectory` only. **C** fix inside `materialize-tree.ts`, as the entry says | **A** | The defect is that the port member is unreachable. A fixes every first-party adapter, the main and worktree contexts, the browser, and L1, and saves an `lstat` per pruned directory. B leaves `rmdir` dead in production and L1 diverging. C edits code that already follows git's rule |
| D-B | An adapter without `rmdir` (third-party `opts.fs`, or `unsafeRawAdapters` over one) | **A** route `removeGitlinkDirectory` through the existing guarded `removeIfEmptyDirectory`, moved to `empty-directories.ts` (§2). **B** leave it: only adapters that omit an optional port member are exposed | **A** | Without A, R1 still fails on such an adapter, and `removeEmptyDirectory`'s documented precondition stays violated by its caller. The guard already exists and A only moves it. Proven by the D1 trace, which is exactly this situation |
| D-C | How a kept non-directory occupant is reported | **A** `ctx.logger?.warn` with git's `unable to rmdir '<p>': Not a directory`, beside the existing directory-case line (§3). **B** report nothing, as today. **C** a structured `warnings`/`kept` field on reset/checkout/stash/merge results | **A** | Same function, same channel, same git text as the existing sibling. C is new public surface on four results for a diagnostic. B leaves the two arms inconsistent |
| D-D | D3 — an added gitlink refuses a directory with content (A1–A5, S3) | **A** fold: the mode-aware `classifyOccupant` (§4), interop pins A1–A5. **B** defer: file it in `docs/BACKLOG.md` with these pins (it clears the ADR-1170 bar: a wrong refusal on a well-formed repository) | **A** | This change's own probes exposed it (the 32.44 entry's stash-apply follow-up is S3). It is the same family (a gitlink's directory is the submodule's), and the shared verdict fixes all five consumers. CLAUDE.md: fold, don't file. Cost: it widens the change into the occupant judges, three files plus their mutation runs |
| D-E | D2 — `stash push -u` stashes and cleans files under a gitlink directory (O9) | **A** fold: prune gitlink paths in `listUntracked` (§5). **B** defer to the backlog | **A** | Exposed by this change's own pinned row (the entry names `push -u`). It is a different stash commit on a well-formed repository, it is local to one function, and `status` already shows the faithful set |
| D-F | Release marking | **A** `fix` throughout. **B** the commit restoring `rmdir` is `fix!`: L1 turns a returning ref update (`branch.create`, any reflog-creating write) into a `DIRECTORY_NOT_EMPTY` throw, which is ADR-1190 / ADR-1204 / D-3's trigger. The rest stays `fix` (D3 only removes refusals, ADR-1199) | **B** | D-3's rule is "a refusal where tsgit returned is breaking". L1 is that, pinned. The trigger is exotic (a symlinked log directory) and the refusal already happens on the memory and raw adapters, which argues for A. Under the ratified precedents that argument is not enough |

## Out of scope

- **L2** (a symlink to an empty directory at a loose ref path): deferred to impact triage as
  I1. The divergence is the same raw and wrapped, so this change does not touch it.
- **Submodule recursion** (`submodule.recurse`, `--recurse-submodules`): git's
  `submodule_move_head` / `verify_clean_submodule` act only with it. tsgit has no surface.
- **`read-tree -u`** (O12): no surface.
- **A symlink to a directory at an added gitlink's path**: `lstat` sees a symlink, so R6 still
  refuses it. git's `verify_absent` uses `lstat` too. Not pinned. To prove: axis 4 with `new` → a
  symlink to a directory, `checkout G`, both twins.
- **`pruneEmptyParents` over a symlinked parent ref directory**: see the consumer table (not
  pinned, proof recipe there).
