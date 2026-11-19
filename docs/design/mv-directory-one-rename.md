# Design — mv-directory-one-rename

> Brief: backlog 32.67. A directory `mv` that fails partway leaves the work tree half-moved, because
> `renameInWorkingTree` moves a directory leaf by leaf and the index is written only afterwards. git
> `rename(2)`s the directory in one step. Move a directory in one `fs.rename` wherever the adapter
> can. Keep a hardened leaf-by-leaf path for adapters that cannot (OPFS) behind a port capability.
> Status: draft → self-reviewed ×3 → accepted → revised against ADR-1217..1222 (D4 deviates:
> `skipErrors` copies git's data-destroying `-k` arms; ledger row 32.72 is folded) → revised
> against ADR-1223 (N1: a refused rename is a `skipped` entry, `'rename-failed'`) and ADR-1224
> (N2 deviates: under `skipErrors` a partial entry-by-entry move is removed from the destination)

## Context

### What the backlog entry undercounts

32.67 was filed for a partial move (rows 1–3 below). Re-pinned on main 314c5bc7 against git 2.56.0
(macOS, APFS case-insensitive, `PATH_MAX` 1024, scrubbed `GIT_*`, isolated `HOME`), the same
function has four more defects:

- **Data loss (row 5).** A case-only directory rename `mv d D` on a case-insensitive file system
  empties the work tree, untracked `d/u` included. tsgit returns OK and the index becomes `D/d/f D/d/g`.
  Reproduced 2/2 with both `core.ignorecase` values. The mechanism: `D` resolves to the existing `d`,
  so the destination is `D/d` (into-dir mode, as in git). The leaf loop moves `d/f` to `D/d/f`, which
  is `d/d/f`, inside the source. Then `rmRecursive(d)` deletes everything. git's single
  `rename(d, D/d)` fails with `EINVAL` and nothing changes.
- **Wrong refusal (row 2).** A deep untracked chain under the first child makes tsgit refuse
  `PATH_TOO_LONG` before it moves anything. git succeeds.
- **Lost empty directories (row E).** `mv d e` with an empty `d/emp`: git keeps `e/emp`. tsgit drops
  it, because the leaf loop creates only the parents of leaves.
- **Mislabelled `PATH_TOO_LONG` (rows 1–3).** `data.path` is the *absolute source* path. The throw
  comes from `moveNode`'s `ctx.fs.lstat` on the deep source descendant, outside `moveLeaf`'s catch.
  `moveLeaf`'s comment ("can only mean the destination") does not cover it.

The original mv design (`docs/design/mv-atomic-rename.md`, § Index reparent / Working-tree rename)
specified "a single `fs.rename(source, target)`" for a directory. The leaf loop was introduced with
the command (#92, 2026-05-29), when the memory adapter could not rename directories. No ADR chose
it. Since ADR-815..825 the memory adapter renames directories natively. The doc comment on
`renameInWorkingTree` ("the memory and OPFS adapters are file-oriented") is stale for memory.

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/application/commands/internal/working-tree.ts` | `renameInWorkingTree(ctx: Context, rawFrom: string, rawTo: string): Promise<void>` | validates both ends, then `moveNode` |
| same | `moveNode(ctx, from: MoveEnd, to: MoveEnd)`, `moveLeaf(ctx, fromAbs, to: MoveEnd)`, `MoveEnd { abs, rel }`, `childOf` | `lstat` → directory: `readdir` + recurse + `rmRecursive(src)`; leaf: `mkdir(dirname(dst))` + `rename`. `moveLeaf` relabels `PATH_TOO_LONG` to `pathTooLong(to.rel)` (ADR-1194) |
| `src/application/commands/mv.ts` | `mv` | under the index lock: plan → `applyToIndex` (in memory) → `renameInWorkingTree` per plan item → `lock.commit`. A throw releases the lock without a commit |
| same | `PlanItem { source, target, entries }`, `Plan { planned, skipped }`, `buildPlan`, `applyToIndex(pathRules, byPath, planned)` (validates each repathed path with `validateIndexPath`, then `delete` + `set`), `plannedMoves`, `classifySource`, `refusal`, `MvSkipReason` | `skipErrors` today only collects planning refusals into `skipped`; an execution-time refusal throws whatever the flag. `Verdict.skip` and `refusal(reason: MvSkipReason, …)` share the public union. `lstatOrUndefined(ctx, path)` maps every `lstat` failure to `undefined` |
| `src/application/commands/internal/working-tree.ts` | `removeDirectory(ctx, rawPath)`, `repoPath`, `validateWorkingTreePathOn` | `removeDirectory` refuses a missing or non-directory path with `CHECKOUT_OVERWRITE_DIRTY`, then `rmRecursive` |
| same | `validateMove`, `destinationFree(ctx, byPath, target, kind, force)`, `resolveDestinationMode` | planning refusals. `destinationFree` treats any `lstat` hit on `target` as "exists" (row 6) |
| `src/ports/file-system.ts` | `FileSystem.rename`, `FileSystem.atomicRename?`, `FileSystem.rmdir?` | `rename`'s doc: on node and memory a directory source is renamed whole, and a destination inside the source refuses `UNSUPPORTED_OPERATION` (no `path`). On the browser a directory source refuses `FILE_NOT_FOUND` |
| `src/adapters/node/node-file-system.ts` | `NodeFileSystem.rename`, `.atomicRename` (delegates), `mapErrno` (`EINVAL` → default arm → `unsupportedOperation('filesystem', 'EINVAL')`) | |
| `src/adapters/memory/memory-file-system.ts` | `MemoryFileSystem.rename` → `assertRenamable` / `renameDirectory` (moves `directories`, `files`, `symlinks`, `times`, so empty subdirectories survive); `.atomicRename` (delegates) | `lstat` reports `dev: 0, ino: 0` |
| `src/adapters/browser/browser-file-system.ts` | `BrowserFileSystem.rename` (read + write + rm, files only), `rmdir`, no `atomicRename` | `lstat` reports `dev: 0, ino: 0` |
| `src/repository/wrap-fs-validator.ts` | `wrapFsValidator`, `guardedAtomicRename`, `guardedRmdir`, `guardedUtimeNow` | **the only `FileSystem` wrapper in `src`**. `createWorktreeFs` / `createObjectSourceAccess` / `makeWorktreeFs` / `makeConfinedFs` (`src/repository.ts`, `src/index.node.ts`) hand it either a raw `NodeFileSystem` or the detected adapter |
| `src/application/primitives/internal/empty-directories.ts` | `removeEmptyDirectoryTree(ctx, dir): Promise<boolean>` | git's `remove_dir_recurse(REMOVE_DIR_EMPTY_ONLY)`: never deletes a non-directory |
| `src/application/primitives/config-read.ts` | `readConfig(ctx).core?.ignoreCase` | precedent consumer: `src/application/commands/stash.ts` with `asciiLower` (`src/domain/pretty/ascii.ts`) |

### Constraining ADRs

- ADR-226 (prime directive), ADR-249 (structured data only; interop rebuilds git's view from fields).
- ADR-200 / 201 / 202 (mv API, options, granular `MV_*` codes), ADR-205 (porcelain interop scope).
- ADR-705 (optional `atomicRename`: the absence of a capability is a documented answer), ADR-873
  (an optional port member with a fallback that gives the same answer). Both are precedents for ADR-1217.
- ADR-815..825: the rename kind rules. ADR-817: a directory renamed into itself refuses before the
  kind check. ADR-823: atomic only where the platform renames in one step.
- ADR-1194: `mv` relabels `PATH_TOO_LONG` from the rename to the repo-relative destination. This
  design extends the relabel to the one-step directory rename. Its consequence "a too-long source
  descendant of a directory move keeps naming itself" becomes leaf-path only (§ Design 3).
- ADR-1048 (removing a refusal git does not make ships as `fix`), ADR-1190 + DOCTRINE D-3 (a new
  refusal in an edited function is folded and marked breaking), DOCTRINE D-2.
- DOCTRINE D-4 + ADR-936 / ADR-937: faithfulness binds git's data-destroying arms on skip and error
  paths.
- This change's own ADRs: ADR-1217 (port capability), ADR-1218 (entry-by-entry path), ADR-1219
  (refusal surface), **ADR-1220** (`skipErrors` copies git's `-k` outcome, data loss included, and
  folds ledger row 32.72), ADR-1221 (case-only rename under `core.ignorecase`), ADR-1222 (`fix(mv)!:`),
  **ADR-1223** (a refused rename under `skipErrors` is reported as `skipped`,
  `reason: 'rename-failed'`), **ADR-1224** (under `skipErrors` a failed entry-by-entry move ends in
  git's state: what it created at the destination is removed; without `skipErrors` ADR-1218 stands).
- ADR-1170 (filing bar). Ledger row **32.72** (`mv -k` throws on a file rename the host refuses,
  where git skips) leaves `docs/known-divergences.md` (ADR-1220, D-2).

## Requirements

- **R1 — one step where the adapter can.** On an adapter that declares the directory-rename
  capability (node, memory), `renameInWorkingTree` of a directory issues exactly one rename call
  for the directory itself. It does not `lstat`, `readdir` or `mkdir` any descendant and does not
  call `rmRecursive`.
- **R2 — deep descendants do not matter (rows 1–3).** `mv d e` where `d` holds a descendant whose
  absolute path exceeds the host `PATH_MAX` succeeds as git does. The index holds `e/…` for every
  tracked member, and the whole subtree, untracked included, sits under `e/`. The same holds inside
  a linked worktree.
- **R3 — all or nothing for the directory (node, memory), without `skipErrors`.** If the directory's
  own rename is refused, then the index is not written, nothing under the source has moved, and the
  command throws (ADR-1219). Earlier pairs of a multi-source call keep git's documented state (moved
  on disk, index unwritten; mv design, § Execution order); a failure on the first pair moves nothing
  (row J).
- **R4 — case-only directory rename (row 5), without `skipErrors`.** `mv d D` on a case-insensitive
  host refuses (git: exit 128) with index and disk unchanged, untracked content included, under both
  `core.ignorecase` values. `mv -n d D` returns the plan (git: exit 0, `d → D/d`).
- **R11 — `skipErrors`, a directory whose own rename fails (rows 5-k, 5-k′, C, H, K).** The call
  returns. The working-tree rename is skipped; every planned index entry of that directory is still
  repathed to the destination; after **every** pair's rename has run, the source directory is
  deleted recursively — untracked files, empty subdirectories and nested trees included — when no
  index entry remains under it. The deletion is deliberate (ADR-1220, D-4) and happens on every
  adapter, whatever the `TsgitError` refusal (`EINVAL` alias, `PATH_TOO_LONG`, any other adapter
  refusal; R7). `skipped` holds `{ source: <the directory>, reason: 'rename-failed' }` (ADR-1223);
  its members stay in `moved`, which is the index truth.
- **R12 — `skipErrors`, a file whose rename fails (rows F, I; ledger 32.72).** The call returns. That
  pair is skipped: its index entry stays at the source, the file stays on disk, and the other pairs
  proceed. The file is absent from `moved` and `skipped` holds `{ source, reason: 'rename-failed' }`
  (ADR-1223).
- **R14 — `skipErrors`, a partial entry-by-entry move (ADR-1224).** When a directory's move fails
  after it created entries at the destination (the leaf path, R6), the destination path is removed
  with everything beneath it, so the disk ends as git's (index repathed, source deleted by R11,
  nothing at the destination). The removal happens only when all three hold: the destination was
  absent immediately before this pair's move, it is present after the failure, and the directory's
  source is abandoned (no lossy member keeps it, N3). The first guard is load-bearing: planning
  proves the destination absent, but an earlier pair of the same call can make it exist through a
  case alias (row L), and then it holds that pair's content. Without `skipErrors` nothing is
  removed: ADR-1218's partial move stands.
- **R13 — index validation still precedes the first rename.** Every repathed index entry is checked
  against the index-path rules before any working-tree rename, as today, so an `INVALID_INDEX_ENTRY`
  refusal still leaves disk untouched.
- **R5 — empty subdirectories survive (row E)** on every adapter.
- **R6 — leaf path (adapters without the capability).** Every read (`lstat`, `readdir`) of the
  source subtree happens before the first move. Every source directory, empty ones included, is
  recreated at the destination. The source is cleaned up only by empty-directory removal
  (`removeEmptyDirectoryTree`), never by `rmRecursive`, so an entry still under the source is never
  deleted. A write fault after the first move propagates and leaves a partial move, which is
  documented (non-atomic, like the browser's own `rename`). The leaf path neither cleans up nor
  reports progress. R11's source deletion and R14's destination removal are `mv`'s `skipErrors`
  arm, separate steps after the move has failed, not part of the move.
- **R7 — error data (ADR-249).** A refused one-step directory rename surfaces unchanged (ADR-1219). Any
  `PATH_TOO_LONG` raised by the rename names the repo-relative destination (ADR-1194). The
  absolute-source `PATH_TOO_LONG` of rows 1–3 can no longer arise, because no descendant is read.
  Every other adapter refusal passes through unchanged, carrying the adapter's own `path` as a file
  rename's refusal does today. That surface is outside this change. Under `skipErrors` a
  `TsgitError` raised by a pair's working-tree rename is consumed into R11/R12's outcome (git's
  `if (ignore_errors) continue;` covers every `rename(2)` failure) and surfaces as the
  `'rename-failed'` skip reason, without the error itself (ADR-1223; git prints nothing either);
  anything that is not a `TsgitError` is a defect and still propagates, index unwritten.
- **R8 — wrappers.** Every `FileSystem` wrapper forwards the new capability when the inner adapter
  has it, and omits it when the inner adapter lacks it. `wrapFsValidator` is the only one; it guards
  both paths as writes.
- **R9 — case-only file rename (row 6, ADR-1221).** With `core.ignorecase=true`, `mv f F`,
  `mv d/g d/G` and `mv a/g A` (`A` aliasing `a`) succeed as git does. With `false`, they refuse
  `MV_DESTINATION_EXISTS` unless `force` is set, as today. The escape is a **file-source** escape:
  a directory source whose destination exists by case alias (`mv a/d A`) refuses
  `MV_DESTINATION_EXISTS` under both values (row 6-d), as today. This is what makes every directory
  destination absent at planning, the precondition R14 starts from.
- **R10 — no hard-coded host limits.** Deep fixtures derive their depth from `getconf PATH_MAX <root>`.
  The case-insensitive rows probe the host instead of trusting `process.platform`.

## Design

### Pinned matrix (git 2.56.0, macOS APFS case-insensitive, `PATH_MAX` 1024)

Rows 1–4 were pinned by the session against dist built from 314c5bc7. Rows 5-n, 6 and E, and the
adapter probe, were pinned for this design; the `-k` rows by its revision (below the table). Probes ran in `mktemp -d` throwaways with every `GIT_*`
unset, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1` and signing off. Fixture: `<q>` = `q`×200. The deep
chain is `<top>/<q>×(levels-1)/leaf` with `levels = PATH_MAX/201 + 2` (7 on macOS, 22 on Linux),
built with relative `cd` steps because an absolute `mkdir` is `ENAMETOOLONG`.

| Row | Setup | Command | git | tsgit today |
|---|---|---|---|---|
| 1 | tracked `d/f`, untracked deep chain `d/<q>/…/leaf` | `mv d e` | exit 0. ls-files `e/f`. status `R  d/f -> e/f` | throws `PATH_TOO_LONG { path: <abs source descendant> }` after moving `f`. Index `d/f`, status ` D d/f` + `?? e/f` (half-moved) |
| 2 | deep chain under `d/a`, tracked `d/z` | `mv d e` | exit 0, `e/z` | `PATH_TOO_LONG` before any move (wrong refusal, state intact) |
| 3 | row 1 inside a `git worktree add` tree | `mv d e` | as row 1 | as row 1 |
| 4 | plain file mv; directory mv with an untracked subdirectory | `mv f g`, `mv d e` | — | parity |
| 5 | tracked `d/f d/g`, untracked `d/u`; `core.ignorecase` true **and** false | `mv d D` | exit 128 `fatal: renaming 'd' to 'D/d' failed: Invalid argument`. Index and disk unchanged | returns OK. Index `D/d/f D/d/g`. **Work tree emptied, `d/u` lost** (2/2) |
| 5-n | as 5 (true) | `mv -n d D` | exit 0. Plan `d → D/d`, `d/f → D/d/f`, `d/g → D/d/g`. Nothing changes | returns the same plan (parity) |
| 5-k | tracked `d/f d/g d/s/t`, untracked `d/u d/s/u`, empty `d/emp`; both values, 2/2 each | `mv -k -v d D` | **exit 0**, no stderr. `-v`: `Renaming d to D/d`, then `d/f`, `d/g`, `d/s/t` → `D/d/…`. **Index `D/d/f D/d/g D/d/s/t`. Disk: nothing but `.git`** (`d/u`, `d/s/u`, `d/emp` lost). Status `RD d/f -> D/d/f` ×3 | `skipErrors: true`: returns `moved` for every member. Index `D/d/…`, disk emptied (pinned on dist, simpler fixture: the leaf loop's accident) |
| 5-k′ | as 5-k, `core.ignorecase=false`, destination `S300` (`s`×300), 2/2 | `mv -k -v d S300` | exit 0, `-v` as 5-k. Index `S300/f S300/g S300/s/t`. Disk: nothing but `.git`. Status `R  d/f -> S300/f` (plus `S300/f: File name too long` on stderr) | `skipErrors: true`: throws `PATH_TOO_LONG { path: 'S300/f' }` from the first leaf (`moveLeaf` relabel). Index `d/f d/g`, disk unchanged (pinned on dist) |
| C | `core.ignorecase=true`; tracked `d/f d/s/t e/e1`, untracked `d/u`, empty `d/emp`; 2/2 | `mv -k -v d e D` (`D` aliases `d`) | exit 0. `-v`: `d to D/d`, `e to D/e`, then the members. `rename(d, D/d)` fails; `rename(e, D/e)` succeeds **into `d`**; the cleanup then deletes `d`, `e`'s content with it. Index `D/d/f D/d/s/t D/e/e1`. Disk: nothing | returns all three moves. Index as git. **Disk `D/e/e1` survives** (dist, 2/2): the leaf loop removed `d` before moving `e` |
| H | tracked `L/f L/s/t b X/keep` (`L` = `l`×100, `X` = `<q>/<q>/<q>/<q>/p×140`, relative length 944), untracked `L/u`, empty `L/emp`; 2/2 | `mv -k -v L b X` | exit 0. `rename(L, X/L)` fails `ENAMETOOLONG` (relative 1045 > 1024); `b` moves. Index `X/b X/keep X/L/f X/L/s/t`. Disk: `L` deleted recursively, `X/b X/keep` | not pinned (same code path as C) |
| K | as H minus `L/s`, sources reversed | `mv -k -v b L X` | exit 0. `b` moves, `L`'s rename fails, `L` deleted. Index `X/b X/keep X/L/f` | not pinned |
| J | as H, no `-k` | `mv L b X` | exit 128 `fatal: renaming 'L' to 'X/L' failed: File name too long`. Index, disk unchanged (`b` not moved: `L` came first) | — (R3) |
| F | tracked `base other`; 2/2 | `mv -k -v base S300` | exit 0, `-v` prints `Renaming base to S300`. Index `base other`. Disk unchanged | throws `PATH_TOO_LONG { path: 'S300' }` (ledger 32.72) |
| I | tracked `M b X/keep` (`M` = `m`×100), `X` as H; 2/2 | `mv -k -v M b X` | exit 0. `M`'s rename fails, skipped: index keeps `M`, disk keeps `M`; `b` moves to `X/b` | not pinned (32.72's shape) |
| 6 | tracked `f`, `d/g`; `core.ignorecase=true` | `mv f F` / `mv -f f F` / `mv d/g d/G` | exit 0, `R f -> F` / same / `R d/g -> d/G` | throws `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }` (session pin) |
| 6′ | as 6, `core.ignorecase=false` | `mv f F` / `mv -f f F` / `mv d/g d/G` | exit 128 `destination exists` / exit 0 `R f -> F` / exit 128 | refuses / moves / refuses (parity) |
| 6-f | tracked `a/g`, `a/d/f`; `A` aliases `a` (host); both values | `mv a/g A` | true: exit 0, `Renaming a/g to A/g`, ls-files `A/g a/d/f`. false: exit 128 `destination exists, source=a/g, destination=A/g` | — (the file escape, into-dir mode) |
| 6-d | as 6-f; both values; 1/1 each | `mv a/d A` and `mv -k a/d A` | exit 128 `destination already exists, source=a/d, destination=A/d` under **both** values; `-k`: exit 0, nothing changes. Index and disk unchanged | refuses `MV_DESTINATION_EXISTS` (parity today; the escape must not reach a directory source) |
| L | tracked `x/d/f`, `y/D/g`, `y/D/u`, `T/keep`; both values; 1/1 each | `mv x/d y/D T` / `mv -k -v x/d y/D T` | no `-k`: exit 128 `renaming 'y/D' to 'T/D' failed: Directory not empty`, index unchanged, disk `T/d/f` (first pair moved). `-k`: exit 0, ls-files `T/D/g T/D/u T/d/f T/keep`, disk `T/d/f T/keep` plus empty `x`, `y`: `y/D` deleted, **`T/d/f` kept** | — (R14's first guard) |
| E | tracked `d/f`, empty `d/emp`, untracked `d/u` | `mv d e` | exit 0. Disk `e/emp e/f e/u` | returns OK. Disk `e/f e/u`: **`e/emp` lost** |

Adapter probe (dist `NodeFileSystem`, same host):

```
rename(<t>/d, <t>/D/d)        -> UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }; d/f, d/u intact
rename(<t>/s, <t>/e)  # s holds the 7-level deep chain -> ok, one call; top level now d, e
```

Not pinned here: Linux (`PATH_MAX` 4096). The interop rows derive the depth, so CI ubuntu covers it.
Also not pinned: Windows. A case-only directory rename there is unpinned; the one-step rename makes
any refusal non-destructive, but the code is unknown. No row asserts it.

The revision re-pinned 5-k with a nested tracked `d/s/t`, a nested untracked `d/s/u` and an empty
`d/emp`, and pinned 5-k′, C, H, K, J, F and I (same isolation; `-v` added only to observe the list
order; every `-k` row 2/2). The tsgit column of C is dist built from 314c5bc7, 2/2. The ADR-1224
revision pinned 6-f, 6-d and L (same isolation, same host) to check R14's precondition, and 6-d
again on a case-sensitive APFS scratch volume with a distinct pre-existing `A/d` (empty, and
holding `A/d/x`), `core.ignorecase=true` and `false`: exit 128 `destination already exists` each
time, `-k` exit 0 with nothing changed. git's directory-source check has no `ignore_case` escape.

**git's `-k` mechanism** — a reading of `builtin/mv.c`'s work list that every pinned row is consistent
with (the `-v` order exposes the list; the per-entry modes are inferred, not observed):

```
list   = [ every source, in argv order ]                       directory source: mode WORKING_DIRECTORY
       + [ each directory source's index members, appended ]   mode INDEX
for each list entry, in order:
  WORKING_DIRECTORY or file source: rename(src, dst); on failure, with -k: continue (skip the rest of this entry)
  WORKING_DIRECTORY: continue                                   no index work for the directory itself
  INDEX or file source: rename the index entry                  a skipped file never reaches this line
after the loop: for each directory source, when no index entry remains under "<src>/":
  remove_dir_recursively(src)                                   untracked content included (a renamed src: unpinned no-op)
write the index
```

So a directory whose rename failed still has its members repathed (they are separate `INDEX`
entries that never call `rename(2)`), and the cleanup, keyed on the index alone, deletes it. The
cleanup runs after **every** rename (row C: `e` is renamed into the aliased `d` and is lost with it).
A file source's index work sits behind its own `rename(2)`, so a refused file pair moves nothing
(rows F, I). Without `-k` the first failure dies before the index is written (row J). ADR-1220 copies
this outcome (§ 4).

tsgit's index-path rules accept the `S300/…` entries row 5-k′ needs: today's 5-k′ and
`pathspec-length-interop` row M2 both throw from the rename, i.e. after `applyToIndex` validated the
repathed paths in memory.


### 1. Port — an optional directory-rename capability (ADR-1217)

```ts
// src/ports/file-system.ts, next to atomicRename
/**
 * Rename the directory `src`, its whole subtree included (empty subdirectories and entries the
 * caller never listed), to `dst` in one platform step: either every entry moves or none does.
 * Refusals are `rename`'s, by delegation; a `dst` inside `src` (an alias by case folding
 * included) refuses UNSUPPORTED_OPERATION and moves nothing. OPTIONAL: present only where the
 * platform renames a directory natively. Node and memory provide it; OPFS cannot rename a
 * directory, so the browser adapter omits it, and a caller that finds it absent moves the
 * subtree entry by entry and must tolerate a partial move.
 */
readonly renameDirectory?: (src: string, dst: string) => Promise<void>;
```

- `NodeFileSystem.renameDirectory = (src, dst) => this.rename(src, dst)`. `MemoryFileSystem` the same.
  Both are class fields, like `atomicRename`, so a `{ ...fs }` spread in tests keeps them.
- `BrowserFileSystem`: no member. Its `rename` doc is unchanged.
- `wrapFsValidator`: add `guardedRenameDirectory(fs, guard): Pick<FileSystem, 'renameDirectory'>`,
  a copy of `guardedAtomicRename`'s shape (guard `s` and `d`, `.call(fs, s, d)`, `{}` when absent),
  spread next to `...guardedAtomicRename(fs, guard)`. No other wrapper exists in `src` (code map).
  The repository facade once dropped `rmdir` in this same function, so P1's wrapper rows are
  mandatory.

### 2. `renameInWorkingTree` — dispatch

```ts
export const renameInWorkingTree = async (ctx, rawFrom, rawTo) => {
  const from = moveEnd(ctx, validatePath(rawFrom));
  const to = moveEnd(ctx, validatePath(rawTo));
  const stat = await ctx.fs.lstat(from.abs);            // the source itself: mv just proved it exists
  if (!isPlainDirectory(stat)) return renameNamingDestination(ctx, ctx.fs.rename, from, to);
  const renameDirectory = ctx.fs.renameDirectory;
  if (renameDirectory !== undefined) return renameNamingDestination(ctx, renameDirectory, from, to);
  return moveTreeEntryByEntry(ctx, from, to);
};
```

- `renameNamingDestination` replaces `moveLeaf`. It is `mkdir(dirname(to.abs))` when that is not
  `''`, then `op.call(ctx.fs, from.abs, to.abs)`, with ADR-1194's catch:
  `isPathTooLong(err) → pathTooLong(to.rel)`, everything else rethrown unchanged. The comment
  "can only mean the destination" now holds. The source was `lstat`ed a moment earlier, so it is not
  too long, and `rename(2)` never resolves descendants. The `mkdir` is kept for parity with today's
  leaf path. `mv` has already proved the parent exists (`MV_DESTINATION_DIRECTORY_MISSING`), so on
  the `mv` route it is a no-op. Node's `rename` already creates the parent itself
  (`mkdir(dirname(realDst), { recursive: true })`). The other adapters are not asserted here, so the
  explicit `mkdir` stays.
- `isPlainDirectory(stat)`: `stat.isDirectory && !stat.isSymbolicLink`. This is today's predicate,
  extracted. The name avoids a clash with the private `isRealDirectory` in `empty-directories.ts`.
- The function stays under 20 lines. `MoveEnd`/`childOf` stay for the leaf path.

### 3. The leaf path — `moveTreeEntryByEntry` (ADR-1218)

Three phases, so that no read fault can strand a partial move (R6):

```
collect(from)  -> { dirs: MoveEnd[] (pre-order, from included), leaves: MoveEnd[] }   // lstat + readdir only
for dir of dirs:   mkdir(mapTo(dir).abs)                                             // R5: empties survive
for leaf of leaves: rename(leaf.abs, mapTo(leaf).abs)  with ADR-1194's relabel to mapTo(leaf).rel
removeEmptyDirectoryTree(ctx, from.abs)                                               // never deletes content
```

- `collect` is a pure walk returning immutable arrays. Reads that fault propagate before anything
  moves. A `PATH_TOO_LONG` from a source descendant keeps the adapter's error (ADR-1194's consequence,
  now leaf-path only). The memory and browser adapters never raise it.
- Cleanup through `removeEmptyDirectoryTree` (already shared by the ref store and the reflog writer)
  replaces `rmRecursive`. Suppose a destination aliases into the source on some third-party
  case-insensitive adapter: the moved entries stay under the source, the removal answers `false`, and
  nothing is lost. The `false` is ignored on purpose: what remains is exactly what the caller's
  renames put there.
- A write fault after the first rename propagates. Without `skipErrors`, `mv` does not commit the
  index, so the work tree is partially moved and the index is unchanged. This is the browser
  `rename`'s documented degradation, restated in the `renameInWorkingTree` doc comment. No rollback
  (ADR-1218). Under `skipErrors`, `mv` consumes that fault like any other directory refusal and
  removes what the move created at the destination (§ 4, R14, ADR-1224).
- The leaf path does **not** clean up and does not report how far it got. It stays a command that
  either completes or throws (CQS). Everything it writes lies under `to.abs`: the `mkdir` of
  `mapTo(from)` (= `to.abs`) comes first, its parent exists (`MV_DESTINATION_DIRECTORY_MISSING` at
  planning), and every later `mkdir` and `rename` targets a `mapTo` of a source descendant. So
  "what the move created" is exactly the `to.abs` subtree whenever `to.abs` was absent before the
  call, which `mv` can observe from outside with two `lstat`s. No flag, no progress record, no
  boolean parameter crosses the boundary.

### 4. `mv.ts` — what changes

**Without `skipErrors` the outcome is unchanged:** a refused rename throws out of the execution step,
the `finally` releases the lock uncommitted, and R3 holds. Multi-source ordering stays as git's:
earlier pairs have moved on disk and the index is unwritten (mv design, § Execution order; row J is
the first-pair case).

**The execution step is reordered so a skipped rename can keep git's index result (ADR-1220).**
Today `applyToIndex` repaths every planned entry in memory *before* the renames, so a skipped file
pair would still move in the index. The step becomes:

```ts
// mv, under the lock, after `if (opts.dryRun === true) return …`
return executePlan(ctx, lock, byPath, plan, opts); // plan: the existing `Plan` record

const executePlan = async (ctx, lock, byPath, { planned, skipped }: Plan, opts): Promise<MvResult> => {
  const repathed = planned.map((item) => repathItem(indexPathRulesOf(ctx), item)); // R13: validates every moved path, pure
  const executed = await renameEach(ctx, repathed, opts);                           // plan order, sequential; adds `outcome`
  const indexed = executed.filter(movesIndex);                                      // file: only when renamed; directory: always
  applyToIndex(byPath, indexed);
  await removeAbandonedSources(ctx, byPath, executed);                              // after EVERY rename (row C)
  await lock.commit(Array.from(byPath.values()), 'update');
  return { moved: movesOf(indexed), skipped: [...skipped, ...renameSkipsOf(executed)] }; // ADR-1223
};
```

- `PlanItem` gains `readonly kind: 'file' | 'directory'`, copied from the `Verdict` `buildPlan`
  already receives, and `readonly retained: ReadonlyArray<IndexEntry>`, the lossy members
  `validateMove` filters out under `skipErrors` (empty for a file and for a directory without one);
  `Verdict`'s success arm carries it to `buildPlan`. Both are internal. `kind` picks the index arm; `retained` decides whether a failed directory's
  source is abandoned (R14's third guard, N3).
- `renameSkipsOf(executed)` maps each `outcome: 'skipped'` record to
  `{ source: item.source, reason: 'rename-failed' }`, in plan order, after the planning skips.
- `repathItem(pathRules, item)` is today's `applyToIndex` body for one item, minus the map writes:
  it returns `{ item, moves: ReadonlyArray<{ from: IndexEntry; to: IndexEntry }> }` and runs
  `validateIndexPath` on every `to`. All items are repathed before the first rename, so an
  `INVALID_INDEX_ENTRY` still refuses with disk untouched (R13). `applyToIndex(byPath, indexed)`
  keeps only the map writes (`delete` + `set`).
- `renameEach` picks one strategy per call, `const run = opts.skipErrors === true ? renameOrSkip :
  renameOrThrow` (a strategy, not a boolean parameter), runs it per repathed item, in plan order,
  and returns `ReadonlyArray<{ item; moves; outcome: 'renamed' | 'skipped' }>` (one record, no
  index arithmetic across two parallel arrays):

  ```ts
  const renameOrThrow = async (ctx, item): Promise<RenameOutcome> => {
    await renameInWorkingTree(ctx, item.source, item.target);
    return 'renamed';
  };

  const renameOrSkip = async (ctx, item): Promise<RenameOutcome> => {
    const targetWasAbsent = (await lstatOrUndefined(ctx, item.target)) === undefined; // R14 guard 1
    try {
      await renameInWorkingTree(ctx, item.source, item.target);
      return 'renamed';
    } catch (err) {
      if (!(err instanceof TsgitError)) throw err;
      if (targetWasAbsent && abandonsSource(item)) await removePartialMove(ctx, item.target);
      return 'skipped';
    }
  };

  const abandonsSource = (item: PlanItem): boolean =>          // R14 guard 3 (N3)
    item.kind === 'directory' && item.retained.length === 0;

  const removePartialMove = async (ctx, target: FilePath): Promise<void> => {
    if ((await lstatOrUndefined(ctx, target)) === undefined) return;  // R14 guard 2
    await discardDirectory(ctx, target);
  };
  ```

  Without `skipErrors` the path is `renameOrThrow`: no extra `lstat`, no removal, ADR-1218's
  partial move stands. The refusal is not lost under `skipErrors`: it becomes the skipped outcome,
  reported as `'rename-failed'` (ADR-1223).
- **Why the removal lives in `mv.ts`, not in the leaf path.** The leaf path cannot tell a
  `skipErrors` call from a plain one without a flag, and a flag is a boolean parameter. `mv` can
  observe the only fact it needs (was `target` absent before, is it present now) with two reads,
  and the removal is then the same for both strategies of `renameInWorkingTree`. On the one-step
  path a refused `rename(2)` creates nothing at `target`, so guard 2 makes the removal a no-op
  there, except under a case alias where `target` names an existing entry; guard 1 covers that
  (row L, where `T/D` is `T/d`, already holding the first pair's content).
- **Why the removal runs immediately, not after the loop.** A later pair's guard 1 must see the
  disk git would show it. In git a failed `rename(2)` leaves nothing at `target`, so a later pair
  whose target aliases it finds it absent. Deferring the removal would make that later pair see
  the partial move as a pre-existing destination.
- **Why guard 2 reads the disk instead of trusting the failure.** Row 5-k′: `lstat('S300')` on
  node fails `PATH_TOO_LONG`, which `lstatOrUndefined` maps to absent, both before and after. Guard
  2 then skips a removal that would raise the same `PATH_TOO_LONG` out of the skip arm.
- **R14's precondition, checked per directory-mode branch.** Planning proves a directory's
  `target` absent in the index and on disk in both modes: rename mode checks `target` itself,
  into-dir mode checks `destDir/<basename>` (the existing `destDir` is not the target).
  `destinationFree`'s `ignore_case` escape is restricted to file sources (row 6-d), so no case
  alias lets a directory through, and `MV_INTO_SELF` refuses a target inside the source. The one
  route by which a directory's target exists at execution is an earlier pair of the same call
  creating it through a case alias (row L: `T/d` then `T/D`, distinct strings, so
  `assertNoTargetCollision` passes). Guard 1 is therefore measured per pair, at execution, not
  inherited from planning.
- `movesIndex({ item, outcome })` is `outcome === 'renamed' || item.kind === 'directory'`: git's
  `INDEX` members of a directory never call `rename(2)`, a file's index work sits behind its own.
- `removeAbandonedSources(ctx, byPath, executed)`: for each `{ kind: 'directory', outcome:
  'skipped' }` item, in plan order, when `classifySource(byPath, item.source).kind === 'untracked'`
  (no index entry left under it, git's `index_range_of_same_dir(src) < 1`, case-exact as git's
  index lookup is), call the new `discardDirectory(ctx, item.source)`. It runs after the
  whole rename loop because git's does (row C). A renamed directory is not visited: its source no
  longer exists, and git's pass over it is a silent no-op. No later pair can recreate a renamed
  source's path: in rename mode there is one source, and in into-directory mode every target is
  `destDir/<basename>`, which equals a source only when that source is inside `destDir`, which
  `MV_INTO_SELF` / `MV_DESTINATION_EXISTS` refuse at planning. A lossy member that `skipErrors` left
  in the index keeps its directory (the condition is git's, read on tsgit's index).
- New in `src/application/commands/internal/working-tree.ts`:

  ```ts
  /**
   * Delete the working-tree directory at `path` with everything beneath it, untracked content
   * included. A failed directory rename under git's `-k` ends with the source deleted once no
   * index entry remains under it, and with nothing at the destination; `mv` reproduces both on
   * purpose so the work tree matches git's. A missing path is not an error.
   */
  export const discardDirectory = async (ctx: Context, rawPath: string): Promise<void> =>
    ctx.fs.rmRecursive(repoPath(ctx, validateWorkingTreePathOn(rawPath, ctx)));
  ```

  One primitive serves both of git's `-k` deletions: the abandoned source (R11) and the partial
  move at the destination (R14). `removeDirectory` is not reused: it refuses a missing path with
  `CHECKOUT_OVERWRITE_DIRTY`, a checkout surface. `rmRecursive` is idempotent on a missing path and
  does not follow symlinks (port contract); rows 5-k, H show git deleting nested and empty
  directories alike.
- **R11 and R14 compose.** On a partial leaf-path failure the moved leaves sit under `target` and
  the rest under `source`. R14 removes `target` at once; R11 removes `source` after the loop.
  Disk ends as git's: neither exists. With a lossy member, neither removal runs (N3): the index
  keeps the lossy entry under `source`, so R11's condition is false, and `abandonsSource` is false.
  `abandonsSource` predicts R11's post-loop condition from planning data. The two agree because the
  only way another pair's index entry lands case-exactly under a directory source is an into-dir
  `destDir` inside that source, and then that source's own target is inside itself, so
  `MV_INTO_SELF` skipped it at planning.
- `mv` shrinks to orchestration (it is over 20 lines today); `executePlan` holds the execution.
- **Row 6 (ADR-1221):** `destinationFree` gains git's `ignore_case` escape. git's `lstat(dst) == 0 &&
  (!ignore_case || strcasecmp(src, dst))` reads "exists" only when the names differ beyond ASCII
  case:

  ```ts
  const onDisk = (await lstatOrUndefined(ctx, target)) !== undefined
    && !(kind === 'file' && ignoreCase && asciiLower(source) === asciiLower(target));
  const exists = byPath.has(keyOfPath(target)) || onDisk;
  ```

  The `kind === 'file'` operand is git's: its directory-source branch refuses "destination already
  exists" with no `ignore_case` escape (row 6-d, pinned on case-insensitive and case-sensitive
  volumes). Without it, `mv a/d A` under `core.ignorecase=true` would pass planning, a refusal git
  makes would be lost, and R14's absent-at-planning precondition would break.

  `ignoreCase` is read once per `mv` call (`(await readConfig(ctx)).core?.ignoreCase === true`,
  stash.ts precedent) and threaded through `buildPlan` → `validateMove` → `destinationFree` as part
  of a small options record, not as a boolean parameter. `destinationFree` currently takes
  `force: boolean`; folding `force` and `ignoreCase` into one `DestinationPolicy` record removes the
  boolean-parameter smell in the touched function. `byPath.has` stays case-exact: the index holds
  `f`, not `F`, and git's check here is the `lstat` alone.
- **`MvSkipReason` (ADR-1223).** The exported union gains `'rename-failed'`. The planning reasons
  get an internal alias, so `Verdict.skip`, `buildPlan` and `refusal()` cannot carry the new
  member and `refusal()`'s `switch` stays exhaustive without a dead arm:

  ```ts
  /** Per-source refusals that `skipErrors` collects rather than throwing. */
  export type MvSkipReason =
    | 'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self'
    | 'rename-failed';  // the working-tree rename was refused; see docs/use/commands/mv.md

  type PlanSkipReason = Exclude<MvSkipReason, 'rename-failed'>;
  // Verdict: { readonly skip: PlanSkipReason; … }
  const refusal = (reason: PlanSkipReason, source: FilePath, target: FilePath): TsgitError => …
  ```

  `PlanSkipReason` is derived with `Exclude` and stays unexported, so the public surface gains one
  literal and no new name (no forgotten-export entry in `reports/api.json`). `MvSkipped`'s shape is
  unchanged: `{ source, reason }`.

### 5. Error data shapes (ADR-249)

No new error code (ADR-1219):

| Row | tsgit after |
|---|---|
| 1, 2, 3, E | success, git's data |
| 5 (node, darwin) | `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }`, already documented in `docs/use/errors.md` for "a directory onto a destination inside itself". Index and disk unchanged |
| 5 without `skipErrors`, too long | `PATH_TOO_LONG { path: 'S300' }`: the directory itself is the destination now, not `S300/f`. Nothing changed (row 5-k′'s shape, no `-k`) |
| 5-k, 5-k′, C, H, K | returns. `moved` lists every member of the failed directory (index repathed); `skipped` holds `{ source: <dir>, reason: 'rename-failed' }`; disk: the source deleted (R11) |
| F, I | returns. The refused file is absent from `moved`; `skipped` holds `{ source: <file>, reason: 'rename-failed' }`; index and disk keep it (R12) |
| L | returns. `moved` lists `x/d/f → T/d/f` and `y/D/g`, `y/D/u` → `T/D/…`; `skipped` holds `{ source: 'y/D', reason: 'rename-failed' }`; `y/D` deleted, `T/d/f` kept (R14 guard 1) |
| leaf path, write fault after the first leaf, `skipErrors` | returns as 5-k: `skipped` `rename-failed`, index repathed, source and destination both gone (R11 + R14) |
| leaf path, same fault, no `skipErrors` | rejects with the adapter's fault; index unchanged; moved leaves stay at the destination (ADR-1218) |
| 6-d | `MV_DESTINATION_EXISTS { source: 'a/d', destination: 'A/d' }` under both `core.ignorecase` values (unchanged) |
| 5-n | the plan (unchanged) |
| one-step rename too long | `PATH_TOO_LONG { path: <repo-relative destination> }` (ADR-1194) |

`reports/api.json` changes: one optional member on `FileSystem`, and one literal
(`'rename-failed'`) in `MvSkipReason` (ADR-1223). No new exported name.

### 6. Breaking-change assessment

| Change | Public effect | Class |
|---|---|---|
| `FileSystem.renameDirectory?` | additive optional port member. Third-party adapters keep compiling and get the hardened leaf path | non-breaking (ADR-705 / ADR-873 shape) |
| rows 1–3, E, 6 | a refusal or wrong result git does not make is removed | `fix` (ADR-1048) |
| row 5 | `mv` that returned OK (destroying data) now throws | a new refusal from a returning call → breaking (ADR-1190, D-3) |
| leaf path | same success results; fewer deletions on faults | non-breaking |
| 5-k′ (directory) and F / I (file, ledger 32.72) under `skipErrors` | threw `PATH_TOO_LONG`, now returns with git's index and disk | refusal git does not make removed → `fix` (ADR-1048) |
| 5-k under `skipErrors` | returned and still returns the same `moved`, index and (emptied) disk; on main by accident of the leaf loop, now by R11 on every adapter | no change in outcome |
| C under `skipErrors` | returned and still returns the same index; the work tree now also loses what was renamed into the abandoned source, as git's does | wrong result → `fix`; data-destroying by design (ADR-1220) |
| `MvSkipReason` gains `'rename-failed'` (ADR-1223) | `skipped` gains entries for execution-time refusals; the union widens | a consumer's exhaustive `switch` over `MvSkipReason` stops compiling → breaking, covered by the same `!` |
| leaf path under `skipErrors` (ADR-1224) | threw the adapter's write fault with a partial move on disk; now returns, and the partial move is removed with the source | refusal git does not make removed; data-destroying by design (D-4) → `fix` |
| row 6-d | refuses today, still refuses: the `ignore_case` escape is scoped to file sources | no change |

So the change is `fix(mv)!:` (ADR-1222). The `-k` arms add no throw to a returning call.

### 7. Docs

- `src/application/commands/internal/working-tree.ts`: rewrite the `renameInWorkingTree` doc comment.
  It should describe one rename where the port can, and the three-phase degraded path otherwise.
- `docs/use/commands/mv.md`: one paragraph. A directory moves in one step on node and memory, so a
  refusal leaves it untouched. On the browser adapter a directory moves entry by entry, and a failure
  midway can leave it partially moved. A sentence on `core.ignorecase` case-only renames (ADR-1221).
- `docs/use/commands/mv.md`, `skipErrors`: the options-table row says it also skips a pair whose
  working-tree rename the file system refuses. A new **"Skipping errors deletes data as git does"**
  section states, with the 5-k example: a refused *file* rename leaves that file where it is, in the
  index and on disk; a refused *directory* rename still moves its tracked entries in the index, then
  deletes the source directory with everything in it, untracked files included, and so does anything
  another source of the same call moved into it. Both are reported in `skipped` with reason
  `'rename-failed'`; a directory's members also appear in `moved`, because the index moved them.
  On an adapter that moves a directory entry by entry (the browser), a move that fails partway
  under `skipErrors` also removes what it had already placed at the destination, so the result is
  the same as on node; without `skipErrors` the partial move stays. A directory holding a member
  `mv` cannot address keeps its source, and under N3 = B a partial move of it stays at the
destination (the lossy-member paragraph gains this). The
  `PATH_TOO_LONG` Throws line gains "unless `skipErrors`". The closing "first four are per-source"
  sentence becomes: the first four are planning refusals collected in `skipped` under their own
  reason; a working-tree rename the file system refuses is collected as `'rename-failed'`; the rest
  always throw. The `MvResult` block's `reason` comment lists the five reasons.
- `docs/use/commands/mv.md`, case-only renames: the `core.ignorecase` sentence says it applies to a
  file source only; a directory whose destination exists by case refuses whatever the setting.
- `docs/use/errors.md`: no row change (`UNSUPPORTED_OPERATION` already covers row 5).
- `docs/design/mv-atomic-rename.md`: untouched (history). This doc supersedes its leaf-loop drift.
- `docs/known-divergences.md`: **remove row 32.72** and its code block (folded, ADR-1220).
- `docs/BACKLOG.md`: tick 32.67 and strike it from the release-order table.

## Decision candidates

Settled by ADR-1217 (D1: optional `renameDirectory?`), ADR-1218 (D2: read-first entry-by-entry
path), ADR-1219 (D3: the adapter's refusal surfaces unchanged), ADR-1220 (D4: `skipErrors` copies
git's `-k` outcome, data loss included; ledger 32.72 folded), ADR-1221 (D5: case-only rename under
`core.ignorecase`), ADR-1222 (D6: `fix(mv)!:`).

N1, N2: Settled by ADR-1223, ADR-1224. (N1: a `skipped` entry `{ source, reason:
'rename-failed' }`, `refusal()` typed on the planning reasons. N2: under `skipErrors` a partial
entry-by-entry move is a refused directory rename and what it created at the destination is
removed; without `skipErrors` ADR-1218 stands.)

New candidate raised by the ADR-1224 revision:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| N3 | Under `skipErrors`, a partial entry-by-entry move of a directory that keeps its source because a lossy member stays in the index. git has no such state: it repaths every member and deletes the source. The state comes from tsgit's own lossy-member rule (`validateMove` drops lossy members under `skipErrors`; `docs/use/commands/mv.md`: lossy entries are never touched on disk), which keeps the entry under the source, so R11 keeps the source. ADR-1224's "remove what the move created" assumed the source is deleted too; here the leaves already moved exist **only** at the destination | **A** remove the destination anyway: the leaves already moved are deleted while their source directory survives, a loss neither git nor the no-fault path produces. **B** do not remove the destination when the source is kept: the moved leaves stay at the destination, the rest in the source, nothing is lost (ADR-1218's degradation, restricted to this arm). **C** move the moved leaves back into the source, then let R11 decide: reaches git's state, but it is a rollback ADR-1218 rejected, and the move back can fault in turn | **B** | D-4 binds git's data-destroying arms; it does not license destroying data git keeps, which A does. C is the only exact match, but it adds a second fault surface and a rollback path for an arm that needs a lossy (non-UTF-8) index entry, an adapter without `renameDirectory` (OPFS cannot hold such a name) and a write fault mid-move, none pinned. B costs one guard operand (`item.retained.length === 0`) and stays inside ADR-1224's stated premise (index repathed, source deleted, nothing at the destination), which holds exactly when no lossy member keeps the source. The design is written for B; A drops `abandonsSource`'s second operand and the `retained` field, C adds a reverse-move step in `renameOrSkip` |

Pre-decided by existing ADRs, not candidates: the `PATH_TOO_LONG` relabel to the repo-relative
destination (ADR-1194); refusing before writing the index without `skipErrors` (mv design +
ADR-202); `-n` returning the
plan (ADR-201, row 5-n parity).

## Parts (implementation order, TDD per part)

### P1 — port capability + adapters + wrapper

- Files: `src/ports/file-system.ts` (`FileSystem.renameDirectory?` doc + member, next to
  `atomicRename`); `src/adapters/node/node-file-system.ts` (`NodeFileSystem.renameDirectory` class
  field next to `atomicRename`, delegating to `this.rename`);
  `src/adapters/memory/memory-file-system.ts` (`MemoryFileSystem.renameDirectory` next to
  `atomicRename`); `src/repository/wrap-fs-validator.ts` (`guardedRenameDirectory` beside
  `guardedAtomicRename`, spread in `wrapFsValidator`'s returned object after
  `...guardedAtomicRename(fs, guard)`).
- Browser: no change. Add a unit row in `test/unit/adapters/browser/browser-file-system.test.ts`
  asserting `renameDirectory` is `undefined`, beside the existing `atomicRename` absence row.
- Tests:
  - `test/unit/ports/file-system.contract.ts` (runs on memory + node, and node on windows-latest in
    CI). Rows: a directory with a file, an empty subdirectory and a nested file moves whole (every
    relative entry present under `dst`, `src` absent). A `dst` inside `src` refuses
    `UNSUPPORTED_OPERATION` (assert `data.operation`; `reason` is adapter-specific, so only assert it
    is a string) and nothing moves. A missing `src` refuses `FILE_NOT_FOUND`. Guard the suite like
    the `lexists` rows (`if (fs.renameDirectory === undefined) throw …`).
  - `test/unit/repository/wrap-fs-validator.test.ts`: a new `describe('wrapFsValidator — the
    optional renameDirectory capability')` cloned from the `atomicRename` block at "the optional
    atomicRename capability". Present → forwarded with `this` bound. Absent → absent. Out-of-root
    `src` and out-of-root `dst` each refuse `PATHSPEC_OUTSIDE_REPO` in isolation.
  - `api.json`: regenerate (pre-push gate).

### P2 — `renameInWorkingTree` dispatch + hardened leaf path

- File: `src/application/commands/internal/working-tree.ts`. Replace `moveNode`/`moveLeaf` with
  `renameNamingDestination`, `moveTreeEntryByEntry` (collect / mkdir / rename / cleanup). Import
  `removeEmptyDirectoryTree` from `../../primitives/internal/empty-directories.js` (commands →
  primitives is allowed). Keep `MoveEnd`, `childOf`; add `mapTo(end, from, to)` for the leaf path's
  destination mapping. Rewrite the doc comment.
- Tests: `test/unit/application/commands/internal/working-tree.test.ts`, `describe('renameInWorkingTree')`.
  - Replace "Then it recurses leaf-by-leaf — readdir, mkdir the leaf parent, rename each leaf,
    rmRecursive the shell" with two describes:
    - capability present: spy on `renameDirectory`, `readdir` and `rmRecursive`. Expect exactly one
      `renameDirectory(<root>/old, <root>/new)` and zero `readdir` / `rmRecursive` (R1).
    - capability absent: build the fs with the house omission idiom
      `const { renameDirectory: _renameDirectory, ...leafOnly } = base.fs`, as
      `reftable-transaction.test.ts` / `fetch-pack.test.ts` do for `atomicRename`.
      `exactOptionalPropertyTypes` forbids `renameDirectory: undefined`. Every
      `readdir`/`lstat` happens before the first `rename` (record a call log and assert the index of
      the first `rename` exceeds the index of the last read), `mkdir` for every directory, no
      `rmRecursive`.
  - Leaf path, empty subdirectory survives (R5). Leaf path, a `readdir` fault on a deep child
    propagates with **no** rename performed (R6). Leaf path, an entry that cannot be removed stays
    (stub `removeEmptyDirectoryTree`'s `rmdir` to refuse `DIRECTORY_NOT_EMPTY`; the source file is
    still readable).
  - Leaf path, a `rename` fault on the second leaf: rejects with that very fault; the first leaf is
    under `new`, the second still under `old`, and nothing is removed on either side (ADR-1218, no
    cleanup in the primitive). The same call log asserts every `mkdir` / `rename` destination
    starts with `<root>/new/` or equals `<root>/new`: the "everything written lies under `to.abs`"
    invariant R14's removal relies on.
  - `PATH_TOO_LONG` relabel on the one-step path names `to.rel`; a `PERMISSION_DENIED` from it is
    rethrown as the same object (isolated guard tests, ADR-1194 shape).
- `test/unit/application/commands/mv.test.ts`, `describe('mv — a move the file system refuses')`:
  - "Given a directory move whose leaf rename the file system refuses as too long" now stubs
    `renameDirectory` (memory has it). It expects `{ code: 'PATH_TOO_LONG', path: 'e' }`. Add the
    same row with the capability removed, expecting `'e/f'` (leaf path).
  - "Given a directory move whose source descendant the file system refuses as too long" flips. With
    the capability, the move succeeds and the index holds `e/f` (row 1 at unit level: no descendant
    `lstat` is ever made). The leaf-path variant keeps `rejects.toBe(fault)` **and** adds
    "nothing moved, index unchanged" (R6).
  - New: without `skipErrors`, a `renameDirectory` refusing
    `unsupportedOperation('filesystem', 'EINVAL')` → `mv` rejects with that very error, the index is
    unchanged, and the source entries are still present (R3).
- Context: `failingRename` stubs only `rename`, and directory rows must stub `renameDirectory` too.
  `seedAndStage`, `indexEntry`, `exists`, `work`, `expectError` are the file's own helpers.

### P3 — `skipErrors` copies git when a rename fails (ADR-1220; folds ledger 32.72)

Depends on P2 (the directory arm needs the one-step refusal to be reachable).

- Files: `src/application/commands/mv.ts` — `PlanItem.kind` and `PlanItem.retained` (set in
  `validateMove`'s success verdict from the lossy members it filters out); `executePlan`,
  `repathItem`, `renameEach` with `renameOrThrow` / `renameOrSkip`, `abandonsSource`,
  `removePartialMove`, `movesIndex`, `renameSkipsOf`, `removeAbandonedSources` (§ 4);
  `applyToIndex` loses its validation (moved into `repathItem`); `mv` calls `executePlan` after the
  dry-run return. `MvSkipReason` gains `'rename-failed'`; `type PlanSkipReason =
  Exclude<MvSkipReason, 'rename-failed'>` (unexported) types `Verdict.skip` and `refusal(reason)`
  (ADR-1223). The `MvSkipReason` doc comment says the fifth reason is collected at execution.
  `src/application/commands/internal/working-tree.ts` — `discardDirectory` beside
  `removeDirectory`, reusing the module's `repoPath` and `validateWorkingTreePathOn`.
- Tests, `test/unit/application/commands/mv.test.ts`, a new
  `describe('mv — skipErrors and a move the file system refuses')` beside "a move the file system
  refuses", reusing `failingRename` (extended to stub `renameDirectory` when given a directory
  fault):
  - Given a tracked file whose rename refuses `PATH_TOO_LONG`, When `mv` with `skipErrors` → returns;
    the file is absent from `moved`; `skipped` equals `[{ source: 'base', reason: 'rename-failed' }]`;
    index and disk keep it (row F). Kills `renameSkipsOf`'s literal and its filter.
  - Given a planning skip (`ghost`, untracked) and a refused rename (`base`) in one call → `skipped`
    equals `[{ source: 'ghost', reason: 'source-not-tracked' }, { source: 'base', reason:
    'rename-failed' }]`: planning skips first, then execution skips in plan order.
  - Given two files where only the first rename refuses → the second moves in index and disk, the
    first stays (row I). Stub by path: the refusing stub throws only when `src` ends with the first
    name.
  - Given a directory `d` (tracked `d/f`, `d/s/t`, untracked `d/u`, empty `d/emp`) whose
    `renameDirectory` refuses `EINVAL` → returns; index `D/d/f D/d/s/t`; `moved` lists both;
    `skipped` equals `[{ source: 'd', reason: 'rename-failed' }]`; the work tree has no `d` (rows
    5-k/5-k′ at unit level, memory adapter; the alias is simulated by the refusing stub).
  - Given `d` refusing and `e` renaming into `d/e` (stub `renameDirectory` for `e` to call the real
    one with destination `d/e`) → after the call `d/e` is gone too: the cleanup runs after every
    rename (row C). Kills a per-item cleanup.
  - Isolated guards of the strategy choice and `renameOrSkip`: `skipErrors` off + `TsgitError` →
    rejects with that very error, index unchanged (kills the `skipErrors === true` ternary);
    `skipErrors` on + a plain `Error` → rejects with it, index unchanged (kills `instanceof`).
- Tests, same file, a new `describe('mv — skipErrors and a partial entry-by-entry move')` (R14,
  ADR-1224). Fixture: memory adapter with the capability stripped by the omission idiom (P2), wrapped
  by a local `faultOnRename(ctx, { at, fault })` that delegates every member to the inner fs and
  makes the `at`-th `rename` call (1-based) throw `fault` (`permissionDenied`-style `TsgitError`),
  so the leaf path has moved `at - 1` leaves when it fails. One row per guard:
  - **Removal happens.** `d` = tracked `d/f d/g`, untracked `d/u`, empty `d/emp`; fault at the 2nd
    rename; `mv(['d'], 'e', { skipErrors: true })` → returns; `skipped` `[{ source: 'd', reason:
    'rename-failed' }]`; index `e/f e/g`; neither `d` nor `e` exists. Kills the `discardDirectory`
    call in `removePartialMove`.
  - **Guard 1, target present before.** Two sources into `T` whose second target aliases the first:
    a path-folding wrapper maps `<root>/T/D…` to `<root>/T/d…` on every member (the memory adapter is
    case-sensitive; this simulates row L's host, and planning's `lstat(T/D)` still finds nothing
    because `x/d` has not moved yet). Tracked `x/d/f`, `y/D/g`, `y/D/u`; fault at the 3rd rename
    (the 1st is `x/d/f`, the 2nd `y/D/g`) → returns; `T/d/f` (the first pair's file) still exists;
    `y/D` is gone; `skipped` `[{ source: 'y/D', reason: 'rename-failed' }]`. Kills
    `targetWasAbsent`.
  - **Guard 2, target absent after.** The wrapper faults the first `mkdir` instead (the leaf path's
    `mkdir(<root>/e)`, before any rename), so nothing exists at `e` → returns; a `rmRecursive` spy
    is called with `<root>/d` only (R11), never with `<root>/e`. Kills the early return in
    `removePartialMove`: the memory `rmRecursive` is idempotent, so only the spy sees the mutant.
  - **Guard 3a, a file pair.** A file `base` → `S` whose stub `rename` writes `S` and then throws
    (the browser adapter's read/write/rm order failing on the `rm`) → returns; `S` still exists
    with `base`'s bytes, `base` exists, index keeps `base`. Kills `item.kind === 'directory'`.
  - **Guard 3b, a lossy member (N3 = B).** `seedMember`'s `d/y` plus a second addressable `d/z`
    and the lossy `d/<0xff>`, fault at the 2nd rename → returns; the first leaf stays under `e`, the
    other under `d`, the lossy entry stays in the index under `d/`, `d` exists. Kills
    `retained.length === 0`.
  - **Without `skipErrors`.** Same fixture as "removal happens", no option → rejects with the
    injected fault; index unchanged; the first leaf is under `e`, the rest under `d` (ADR-1218
    stands). Kills a removal leaking into the throw path.
  - `movesIndex`: the file row above kills `outcome === 'renamed'`; the directory row kills
    `kind === 'directory'`.
  - Cleanup condition: a directory with a lossy member under `skipErrors` whose rename refuses →
    the lossy entry stays in the index under `d/` and `d` is **not** deleted (kills the
    `classifySource(...).kind === 'untracked'` guard). Lossy seeding: the index-path-bytes helpers
    `mv.test.ts` already uses for its lossy rows.
  - R13: a plan whose second item fails `validateIndexPath` → `INVALID_INDEX_ENTRY`, and the first
    item has **not** been renamed on disk (kills a per-item validate-then-rename interleave).
- Context: `seedMember`, `indexView`, `captureError` live in `describe('mv on a directory holding a
  lossy member')` of the same file; hoist `seedMember` to module scope (or parameterise it with the
  extra member) rather than copy it. `failingRename` lives in `describe('mv — a move the file system
  refuses')`; `faultOnRename` / the path-folding wrapper are new local helpers of the new describe.
- Tests, `test/unit/application/commands/internal/working-tree.test.ts`,
  `describe('discardDirectory')`: removes a tree holding a file, a nested directory and an
  empty directory; a missing path resolves without error; an invalid path (`../x`) refuses as the
  module's other writers do.

### P4 — case-only file rename (ADR-1221)

- File: `src/application/commands/mv.ts`: `mv` reads `ignoreCase`; `buildPlan` → `validateMove` →
  `destinationFree` take a `DestinationPolicy { force, ignoreCase }` (replaces the `force: boolean`
  parameter). Import `readConfig` (`../primitives/config-read.js`) and `asciiLower`.
- Tests in `mv.test.ts` (memory adapter, which is case-sensitive, so the alias is simulated by an
  `lstat` stub that answers `F` with `f`'s stat). With `core.ignoreCase = true` `mv f F` moves; with
  `false` it refuses `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }`. A non-case-equal
  existing destination under `true` still refuses (isolated guard). Seed `core.ignorecase` through
  the config writer the stash tests use.
- Row 6-d at unit level (kills the `kind === 'file'` operand): a directory `a/d` into an existing
  directory `A` with an `lstat` stub answering `A/d` with `a/d`'s stat, `core.ignoreCase = true` →
  refuses `MV_DESTINATION_EXISTS { source: 'a/d', destination: 'A/d' }`, index and disk unchanged.
  The file twin `mv a/g A` (row 6-f, stub answering `A/g`) moves under `true`.

### P5 — cross-tool interop

File: `test/integration/mv-interop.test.ts`, as new describes. Use `GIT_AVAILABLE`, `runGit`,
`runGitEnv`, a `realpath`ed `mkdtemp` root and twin repos, the pattern of
`pathspec-length-interop.test.ts`. Compare `git ls-files -s` in both twins and the disk shape via
`find` run in the twin (relative output). **Never** compare `status` on rows 1–3: tsgit's walk
raises `PATH_TOO_LONG` past `PATH_MAX` (long-pathspec-refusals X2, out of scope).

- Rows 1, 2, 3 — `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`.
  `pathMax = Number(execFileSync('getconf', ['PATH_MAX', root]))` in `beforeAll`, with
  `levels = Math.floor(pathMax / 201) + 2`. The deep chain is built with
  `execFileSync('sh', ['-c', 'for i in …; do mkdir q… && cd q…; done; : > leaf'], { cwd })`, not
  `process.chdir`, which vitest worker threads refuse. An Arrange precondition asserts the absolute
  leaf length exceeds `pathMax`. Row 3 runs inside `git worktree add` of the twin and opens tsgit on
  the linked tree. Assert: same `ls-files -s`; `e/f` present, `d` absent; the leaf exists under
  `e` (shell `cd` chain + `test -f`).
- Row E — every platform with git: an empty `d/emp` survives as `e/emp` in both twins.
- Rows 5, 5-n, 5-k — gated on a host probe, not on the platform: `caseInsensitiveHost =` create
  `<root>/probe-a`, `lstat('<root>/PROBE-A')` succeeds. `describe.each(['true', 'false'])` over
  `core.ignorecase`. 5: git exit 128, tsgit rejects `UNSUPPORTED_OPERATION` with `reason` equal to
  git's errno name (`EINVAL` ↔ "Invalid argument" rebuilt from the field), and both twins keep
  `ls-files -s` and every disk entry, `d/u` included. 5-n: identical plan (`moved` ↔ git's
  `Renaming X to Y` lines minus the directory's own line, which carries no index entry).
- Row 5-k — same gate and `describe.each`, fixture as the pinned row (tracked `d/f d/g d/s/t`,
  untracked `d/u d/s/u`, empty `d/emp`). git `mv -k d D` exit 0, tsgit `skipErrors: true` returns.
  Assert parity of `ls-files -s` (`D/d/…`) and of the disk listing (empty but `.git` in both). The
  title says the source is deleted as git deletes it.
- Row C — same gate, `core.ignorecase=true`: tracked `d/f d/s/t e/e1`, untracked `d/u`.
  `mv -k d e D` in git, `mv(['d', 'e'], 'D', { skipErrors: true })` in tsgit. Assert `ls-files -s`
  and disk parity (both empty) — the row that pins the after-every-rename cleanup.
- Row H — `skipIf(!GIT_AVAILABLE || win32)`, PATH_MAX-derived: git measures the **relative** path it
  passes to `rename(2)`, the node adapter the **absolute** one, so the fixture must straddle both.
  Build `X` (relative length `pathMax - 150`, `<q200>` components plus a remainder) with the shell
  `cd` chain; sources `L` = `l`×200 (tracked `L/f`, untracked `L/u`) and file `b`. Preconditions
  asserted in Arrange: `rel(X/L) > pathMax` and `abs(X/b) < pathMax` (holds while the realpathed
  root is under 147 bytes). `mv -k L b X` both sides. Assert `ls-files -s` parity (`X/b X/L/f …`)
  and that `L` is gone and `X/b` present in both twins (shell `test`, as rows 1–3).
- Rows 5-k′, F — in `test/integration/pathspec-length-interop.test.ts` (it owns `S300`, `BASE`,
  `twins`, `snapshotOf`, `filesOf`), as rows M8 / M9 after M7. M8: a tracked `d/f d/s/t` plus
  untracked `d/u` (`twins`' `extraTracked` and `untracked` arguments write the files;
  `extraTracked` also stages them), `mv -k d S300` both sides,
  git exit 0, tsgit returns; `ls-files -s` parity and `filesOf` parity (`d` gone, `base` kept).
  `snapshotOf`'s `status` is **not** compared here: git prints `File name too long` warnings for
  `S300/…` (pinned), tsgit's walk is out of scope. M9: `mv -k base S300`, git exit 0, tsgit returns;
  `snapshotOf` and `filesOf` equal to before in both (row F; replaces the ledger's code block).
- Rows 6, 6′, 6-f, 6-d (ADR-1221) — same host probe and `describe.each` over `core.ignorecase`;
  assert the `ls-files -s` parity and the refusal parity (6-d: git exit 128 under both values,
  tsgit `MV_DESTINATION_EXISTS`; with `-k` / `skipErrors`, exit 0 and
  `skipped` `[{ source: 'a/d', reason: 'destination-exists' }]`, nothing changed in either twin).
- Row L — same host probe and `process.platform !== 'win32'` (Windows' directory-replace arm in
  `NodeFileSystem.rename` is unpinned for an aliased non-empty destination, § Out of scope),
  `describe.each` over `core.ignorecase`, tracked `x/d/f y/D/g y/D/u T/keep`. Without `-k`: git
  exit 128, tsgit rejects `DIRECTORY_NOT_EMPTY` (node's `mapErrno` of `ENOTEMPTY`, git's
  "Directory not empty" rebuilt from the code);
  `ls-files -s` parity (unchanged) and disk parity (`T/d/f` moved in both). With `-k`: `ls-files -s`
  parity (`T/D/g T/D/u T/d/f T/keep`), disk parity (`T/d/f T/keep`, `y/D` gone), tsgit `skipped`
  `[{ source: 'y/D', reason: 'rename-failed' }]`. This is R14's guard 1 on node: the one-step
  rename refuses, `T/D` is present after (it is `T/d`), so only guard 1 keeps the first pair's file.
- **Rebuilding git's view of a refused rename (ADR-249, ADR-1223).** git `-k` prints nothing for a
  refused `rename(2)` (rows 5-k, F: no stderr), so its only observable signals are the index and
  the disk, which every row above compares. Rows 5-k, C, H, L, M8 and M9 also run git with `-v`
  and rebuild its `Renaming X to Y` lines from tsgit's fields: one line per argv source (`source`
  → the test's mapped target, whether that source is in `moved`, in `skipped` as
  `'rename-failed'`, or a directory whose own line has no `moved` entry), then one line per
  `moved` entry whose `from` lies under a directory source. git orders member lines by argv
  source, `moved` by `from` bytes; the pinned rows' argv order is byte order, and a row where they
  differ compares member lines as a set. Each test also asserts `skipped`
  equals the pinned expectation, so the field that tells a caller the rename was refused is pinned
  against the run where git deleted or kept the data.

### P6 — docs

As § Design 7, including the removal of ledger row 32.72.

## Test strategy notes

### Property tests

Lens check (`.claude/workflow/property-testing.md`):

1. Round-trip: no. There is no parse/serialize pair.
2. Compositional matcher: no.
3. Total function over a grammar: no.
4. Counting invariant: **yes, for the leaf path.** Every entry of the source subtree (file,
   symlink, directory, empty directory) maps 1:1 to an entry at the destination with the same
   relative path and bytes, and the source is gone. The oracle is independent: the memory adapter's
   own `renameDirectory`, which the contract suite tests on its own.

Ship `test/unit/application/commands/internal/working-tree.properties.test.ts`. Given an arbitrary
tree (an `arbitraries.ts` sibling generating 0–4 levels, 0–5 entries per directory, empty
directories included, names from `[a-z]{1,8}`), seed two memory adapters identically. Move with the
capability on one and with it removed on the other, then compare the full `readdir`-recursive
listings and file bytes. `numRuns` 100 (composition / invariant tier, ADR-135). The example rows of
P2 stay (ADR-136).

### Mutation notes

- `renameInWorkingTree`'s dispatch: kill the `!== undefined` conditional with the two capability
  rows. Kill `isPlainDirectory`'s `!isSymbolicLink` operand with a symlink-to-directory source row on
  memory: it must go through `rename`, not `renameDirectory` (assert which spy was called).
- The read-before-write ordering in the leaf path is killed by the call-log row (P2). The
  `removeEmptyDirectoryTree` swap is killed by the "entry that cannot be removed stays" row.
- `destinationFree` (ADR-1221): isolated rows for `ignoreCase` false + case-equal, true + case-equal,
  true + case-different, and true + case-equal with a directory source (row 6-d, P4). Four rows
  kill the three `&&` operands and the `asciiLower` call.
- `skipErrors` execution (P3): the strategy ternary and `renameOrSkip`'s `instanceof` guard,
  `movesIndex`'s two operands, `renameSkipsOf`'s literal and filter, the cleanup's `untracked`
  condition and its after-the-loop placement each have an isolated row in P3. The source-side
  `discardDirectory` call is killed by the 5-k unit row (disk must be empty).
- Partial-move removal (P3, R14): one row per guard — `targetWasAbsent` (path-folding row),
  `removePartialMove`'s early return (`rmRecursive` spy row; the memory adapter's idempotent
  `rmRecursive` hides it otherwise), `abandonsSource`'s `kind === 'directory'` (file-pair row) and
  `retained.length === 0` (lossy row), the removal call itself ("removal happens" row), and the
  no-`skipErrors` row for a removal leaking into `renameOrThrow`.
- Equivalent-mutant watch: `abandonsSource` predicts R11's post-loop condition (§ 4, "R11 and R14
  compose"). A mutant replacing `retained.length === 0` with `true` is **not** equivalent: the
  lossy row sees the moved leaf deleted.
- Stryker scope: `working-tree.ts`, `wrap-fs-validator.ts` (new block), the two adapter one-liners
  and `mv.ts` hunks. Run on narrowed eponymous suites (`.claude/workflow/mutation.md`).

## Out of scope

- **`status`/walk past `PATH_MAX`** (long-pathspec-refusals X2): it is why rows 1–3 compare
  `ls-files` and disk, not `status`.
- **Windows case-only directory rename**: unpinned (no host). The contract row for a destination
  inside the source runs there, and the one-step rename makes any refusal non-destructive. Row L
  (a directory renamed onto a non-empty case alias) is likewise not run on Windows, where
  `NodeFileSystem.rename` takes its directory-replace arm.
- **A partial non-atomic *file* rename under `skipErrors`** (the browser's read/write/rm `rename`
  failing after the write): R14 is scoped to directory items, as ADR-1224 is; the file pair keeps
  ADR-1220's R12 outcome and the browser `rename`'s documented non-atomicity. The P3 file-pair row
  pins that the removal does not reach it.
- **The leaf path's descendant `PATH_TOO_LONG` naming an absolute path**: unreachable on the
  first-party adapters without the capability (browser: no `PATH_MAX`). It keeps ADR-1194's
  "names itself" consequence.
