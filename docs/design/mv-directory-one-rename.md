# Design — mv-directory-one-rename

> Brief: backlog 32.67. A directory `mv` that fails partway leaves the work tree half-moved, because
> `renameInWorkingTree` moves a directory leaf by leaf and the index is written only afterwards. git
> `rename(2)`s the directory in one step. Move a directory in one `fs.rename` wherever the adapter
> can. Keep a hardened leaf-by-leaf path for adapters that cannot (OPFS) behind a port capability.
> Status: draft → self-reviewed ×3 → accepted → revised against ADR-1217..1222 (D4 deviates:
> `skipErrors` copies git's data-destroying `-k` arms; ledger row 32.72 is folded) → revised
> against ADR-1223 (N1: a refused rename is a `skipped` entry, `'rename-failed'`) and ADR-1224
> (N2 deviates: under `skipErrors` a partial entry-by-entry move is removed from the destination)
> → revised against ADR-1226 (a destination beyond a symbolic link: R15–R17, § 8, rows Y1–Y20)
> → revised against ADR-1227 (an existing destination reached through a link and git's index
> replacement: R18, § 9, rows Z1–Z21; an absent untracked source: R19, § 10, rows U1–U12)

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
- **ADR-1226**: `mv` refuses a destination beyond a symbolic link as git does; under `skipErrors`
  each refused member is skipped in the index while the directory itself is still renamed through
  the link (§ 8).
- **ADR-1227**: two pinned refusal mismatches in `validateMove` are folded (DOCTRINE D-3): an
  existing destination reached through a symbolic link, with git's index replacement under
  `force` (§ 9), and an absent untracked source (§ 10). Both ride ADR-1222's `!`.
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
- **R15 — refuse a destination beyond a symbolic link (rows Y1, Y2, Y6, Y8, Y10, Y13, ADR-1226), without
  `skipErrors`.** When a pair's destination is absent on disk and one of its leading components
  (never the destination itself) is a symbolic link, `mv` refuses at planning, before anything is
  written, `dryRun` included: `MV_DESTINATION_BEYOND_SYMLINK { source, destination }`. A file
  source names itself and its target. A directory source names its first member in index order and
  that member's destination (git: `source=dir/a, destination=lnk/hooks/x/a`). The check is
  shape-based: a link to `.git`, to a directory inside the work tree, to a file, a dangling link,
  a tracked or untracked link, at the destination's parent or at a deeper ancestor all refuse, and
  `force` does not lift it (row Y2). It runs after `source-not-tracked`, `bad-source` and
  `into-self` (rows Y14, Y15) and before tsgit's destination-directory check (rows Y6, Y8). A
  destination that exists on disk, the link itself (row Y16) or an entry reached through it (rows
  Y17, Y18), is not this refusal (§ 8; R18). A regular file in a leading component is not a link
  (row Y19).
- **R16 — `skipErrors` arms (rows Y3–Y5, Y7, Y11, Y13, ADR-1226).** A file pair beyond a link is
  skipped and writes nothing: `skipped` holds `{ source, reason: 'destination-beyond-symlink' }`.
  A directory pair is still renamed on disk, through the link, while every member's index entry
  stays under the source: no member is in `moved`, `skipped` holds one
  `{ source: <member>, reason: 'destination-beyond-symlink' }` per addressable member, in index
  order (N4). The source is not deleted afterwards (members remain in the index, R11's condition is
  false), and a failed rename of that directory removes nothing at the destination (R14's third
  guard: the source is kept). `dryRun` with `skipErrors` returns the same `moved`/`skipped` and
  writes nothing (row Y13).
- **R17 — a destination ending in `/` resolves through a link (rows Y10–Y12, Y20).** `mv f inner/`
  with `inner` a symbolic link to a directory is into-directory mode, as git's `lstat("inner/")`
  follows the link; the target `inner/f` then meets R15. A trailing-slash destination naming a
  dangling link or a link to a file still refuses `MV_DESTINATION_DIRECTORY_MISSING` (rows Y11,
  Y12). Without the slash, a link is not a directory (row Y9: two sources into `inner` refuse
  `MV_DESTINATION_NOT_DIRECTORY`, as today).
- **R18 — an existing destination reached through a link, and git's index replacement (rows
  Z1–Z21, ADR-1227).** When the destination exists on disk and its parent is a symbolic link to a
  directory (at any depth), planning treats it as any existing destination: a file source refuses
  `MV_DESTINATION_EXISTS { source, destination }` (Z1, Z8), a directory source refuses the same
  code whatever `force` (Z10), `skipErrors` collects it as `'destination-exists'` (Z5), and
  `dryRun` refuses or returns the plan as `force` decides (Z7, Z8). With `force`, a file source is
  renamed through the link onto the existing entry (Z2–Z4, Z6, Z9, Z12, Z13, Z21). On every move,
  forced or not, link or not, writing index entry `P` first removes every stage-0 entry at a
  leading directory of `P` and every entry beneath `P/` (git's file/directory replacement, rows
  Z2, Z9, Z16, Z18–Z20); no other entry is touched (Z2: `sub/keep`, the entry the link's target
  holds, stays with its old blob). `moved` is unchanged: it lists the moves, not the entries
  the replacement removed (N7). `MV_DESTINATION_DIRECTORY_MISSING` stays for a parent that does
  not resolve to a directory.
- **R19 — an absent untracked source is a bad source (rows U1–U12, ADR-1227).** A source with no
  index entry, exact or as a directory prefix, and no working-tree entry under `lstat` refuses
  `MV_BAD_SOURCE { source, destination }`, before any destination check (U3) and under `dryRun`
  (U4); `skipErrors` collects it as `'bad-source'` (U10, U12). A source present on disk under
  `lstat`, a dangling link included (U6), and absent from the index still refuses
  `MV_SOURCE_NOT_TRACKED` (U5). A tracked source missing from the disk keeps `MV_BAD_SOURCE` (U7,
  U8). A present directory with no tracked member is not changed by this requirement (U9, U11:
  git's `source directory is empty`, N8).

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

### Pinned matrix — destination beyond a symbolic link (ADR-1226)

git 2.56.0, macOS APFS, same isolation (`env -i`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, a
user-only config, `commit.gpgsign=false`), a fresh `mktemp -d` repository per command. Run 2/2:
Y3, Y11, Y12, Y15, Y18, Y20, `mv dir inner/` (Y10), `mv untracked inner/u` (Y14) and the `-k` half
of Y17; every other command 1/1. The session pinned Y1–Y5 2/2 beforehand. Fixture: tracked `dir/a dir/b dir/s/t f g sub/keep dup/f`, tracked links `lnk -> .git`,
`inner -> sub`, `dang -> nowhere`, `pointer -> f`, `deep/real/dl -> ../sub`, an untracked link
`loose -> sub` and an untracked file `untracked`. "Unchanged" means `ls-files` and the disk listing
equal the fixture. The tsgit column is the branch before this revision: Y1 was pinned by the
session; the other rows are read off `validateMove` and `resolveDestinationMode` (lstat semantics:
a leading link is followed, the last component is not).

| Row | Command | git | tsgit before |
|---|---|---|---|
| Y1 | `mv dir lnk/hooks/x` | exit 128 `destination is beyond a symbolic link, source=dir/a, destination=lnk/hooks/x/a`. Unchanged | moves: index `lnk/hooks/x/…`, disk `.git/hooks/x/…` |
| Y2 | `mv f lnk/hooks/pre-commit`; `mv -f f lnk/hooks/pre-commit` | both exit 128, same message with `source=f, destination=lnk/hooks/pre-commit`. Unchanged | moves `f` into `.git/hooks/pre-commit` |
| Y3 | `mv -k -v dir lnk/hooks/y` | exit 0, stdout `Renaming dir to lnk/hooks/y` (no member lines). Index unchanged (`dir/a dir/b dir/s/t`); disk: `dir` gone, `.git/hooks/y/{a,b,s/t}` | moves, index `lnk/hooks/y/…` |
| Y4 | `mv -k -v f lnk/hooks/pre-commit` | exit 0, no stdout. Unchanged | moves |
| Y5 | `mv -k -v dir f2 lnk/hooks` (`f2` absent) | exit 0, stdout `Renaming dir to lnk/hooks/dir` only. Index unchanged; `dir` now at `.git/hooks/dir` | moves `dir`, skips `f2` as `source-not-tracked` (`bad-source` after R19) |
| Y6 | `mv f inner/g`; `mv dir inner/x` | exit 128 `… beyond a symbolic link, source=f, destination=inner/g` / `source=dir/a, destination=inner/x/a`. Unchanged | `MV_DESTINATION_DIRECTORY_MISSING` (`lstat('inner')` is a link, not a directory) |
| Y7 | `mv -k -v dir inner/x` | exit 0, `Renaming dir to inner/x`. Index unchanged; disk `sub/x/{a,b,s/t}` (untracked), `dir` gone | `MV_DESTINATION_DIRECTORY_MISSING` (thrown under `skipErrors` too) |
| Y8 | `mv f loose/g` (untracked link), `mv f deep/real/dl/g` (deeper ancestor), `mv f dang/x` (dangling), `mv f pointer/x` (link to a file), `mv dir/a inner/absent/x` (missing below the link) | each exit 128, `beyond a symbolic link` naming that pair. Unchanged | `MV_DESTINATION_DIRECTORY_MISSING` |
| Y9 | `mv -k -v f dir inner`; `mv -k -v dir f inner` | exit 128 `destination 'inner' is not a directory` | `MV_DESTINATION_NOT_DIRECTORY` (parity) |
| Y10 | `mv f inner/`; `mv dir inner/` | exit 128 `… source=f, destination=inner/f` / `source=dir/a, destination=inner/dir/a` (into-directory mode through the link) | `MV_DESTINATION_DIRECTORY_MISSING { destination: 'inner/' }` |
| Y11 | `mv -k -v dir inner/`; `mv -k -v dir f inner/`; `mv -k -v f dir inner/` | exit 0, `Renaming dir to inner/dir` only. Index unchanged; disk `sub/dir/…`, `f` kept | `MV_DESTINATION_DIRECTORY_MISSING` |
| Y12 | `mv f dang/`; `mv f pointer/` | exit 128 `destination directory does not exist, source=f, destination=dang/` (resp. `pointer/`) | parity |
| Y13 | `mv -n dir lnk/hooks/x`; `mv -n -k -v dir lnk/hooks/x` | exit 128 after `Checking rename of 'dir' …` and `… 'dir/a' …`; with `-k`: exit 0, `Checking` lines for `dir`, `dir/a`, `dir/b`, then `Renaming dir to lnk/hooks/x`. Unchanged | plan returned (`dir/… → lnk/hooks/x/…`) |
| Y14 | `mv untracked inner/u` (an untracked file); the same with the file absent | exit 128 `not under version control, source=untracked, destination=inner/u` / `bad source, …` | parity for the present file; the absent one refuses `MV_SOURCE_NOT_TRACKED` (git: `bad source`), with or without a link; folded by R19 (§ 10) |
| Y15 | `mv dir dir/l/x` (`dir/l -> ../sub` tracked) | exit 128 `can not move directory into itself, source=dir, destination=dir/l/x` | parity |
| Y16 | `mv f lnk`; `mv f inner`; `mv dir inner` | exit 128 `destination exists` / `destination already exists` (the link is the destination, not a leading component) | parity |
| Y17 | `mv f inner/keep`; `mv -k -v f inner/keep` | exit 128 `destination exists, source=f, destination=inner/keep`; `-k`: exit 0, unchanged | `MV_DESTINATION_DIRECTORY_MISSING` (R18, § 9) |
| Y18 | `mv -f f inner/keep` | **exit 0**: `f` renamed through the link onto `sub/keep`; index drops `f` **and the `inner` link entry**, adds `inner/keep` | `MV_DESTINATION_DIRECTORY_MISSING` (R18, § 9) |
| Y19 | `mv dir sub/keep/x` (a regular file in a leading component) | exit 128 `renaming 'dir' to 'sub/keep/x' failed: Not a directory` | `MV_DESTINATION_DIRECTORY_MISSING` (unchanged, outside this revision) |
| Y20 | `mv f dup/f inner/` (both target `inner/f`) | exit 128 `beyond a symbolic link, source=f, destination=inner/f`: the first pair refuses before the collision is seen | `MV_DESTINATION_DIRECTORY_MISSING` |

**git's check, a reading of the rows** (inferred from the order of the refusals and from `-v`, not
from the source): in `builtin/mv.c`'s per-entry chain, after `bad source`, `into itself`, a
directory's `destination already exists`, `not under version control` and a file's `lstat(dst) ==
0` → `destination exists` (lifted by `-f`), an entry whose destination has a symbolic link in a
leading component (`has_symlink_leading_path`) is `destination is beyond a symbolic link`. A
directory source's own entry (mode `WORKING_DIRECTORY`) does not reach that check, so it is
refused only through its members, which are appended to the work list and checked one by one; the
first member refuses without `-k`. Under `-k` each refused member is dropped from the list and the
directory's own entry stays, so `rename(dir, …)` runs through the link and the index keeps every
member (Y3, Y7). The `-v` line for the directory is printed by the rename loop; a dropped file
entry prints nothing (Y4, Y5). Y18 shows the `-f` branch never reaching the link check: the
destination exists, so the chain stops there.

### Pinned matrix — an existing destination through a link, and the index replacement (ADR-1227)

git 2.56.0, macOS APFS, same isolation, a fresh `mktemp -d` repository per command, **every row
2/2** with identical output. Fixture A: tracked `f dir/a sub/other`, tracked links `inner -> sub`
and `deep/real/dl -> ../../sub`, and `sub/keep` tracked unless the row says otherwise. Fixture B:
tracked `f g t x/y sub/f dir/a td/f gone`, tracked `inner -> sub`, untracked `untracked`,
`ud/u`, the dangling link `dl2 -> nowhere` and the empty directory `emp`; after the commit the
disk drifts: `x` becomes a regular file, `t` becomes a directory holding untracked `t/keep`, and
`gone` and `td` are removed. Fixture C: tracked `f` and `lnk -> .git`. "Unchanged" means
`ls-files -s` and the disk listing equal the fixture's. The tsgit column of Z11–Z20 was pinned
on dist built from this branch before Parts 11–13 (2/2, fixture B, which also carries the
link-through rows as `inner/f`); Z1–Z10 and Z21 are read off `validateMove` (the same parent
check refuses them).

| Row | Fixture | Command | git | tsgit before |
|---|---|---|---|---|
| Z1 | A, `sub/keep` tracked and untracked | `mv f inner/keep` | exit 128 `destination exists, source=f, destination=inner/keep`. Unchanged | `MV_DESTINATION_DIRECTORY_MISSING { source: 'f', destination: 'inner/keep' }` |
| Z2 | A | `mv -f f inner/keep` | exit 0. Index: `f` **and `inner` removed**, `inner/keep` added (f's blob, `100644`); `sub/keep` **stays** with its old blob. Disk: `f` gone, `sub/keep` holds f's content, the link `inner` stays | as Z1 |
| Z3 | A, `sub/keep` untracked | `mv -f f inner/keep` | exit 0. Index: `f`, `inner` removed, `inner/keep` added. Disk as Z2 | as Z1 |
| Z4 | A, `inner` untracked | `mv -f f inner/keep` | exit 0. Index: `f` removed, `inner/keep` added, `sub/keep` stays. Disk as Z2 | as Z1 |
| Z5 | A | `mv -k f inner/keep` | exit 0, no output. Unchanged | as Z1 (thrown under `skipErrors` too) |
| Z6 | A | `mv -k -f f inner/keep` | as Z2 | as Z1 |
| Z7 | A | `mv -n -f f inner/keep` | exit 0, stdout `Checking rename of 'f' to 'inner/keep'`, `Renaming f to inner/keep`. Unchanged | as Z1 |
| Z8 | A | `mv -n f inner/keep` | exit 128 after the `Checking` line, `destination exists`. Unchanged | as Z1 |
| Z9 | A | `mv -f f deep/real/dl/keep` | exit 0. Index: `f` and **`deep/real/dl`** removed, `deep/real/dl/keep` added; `inner`, `sub/keep` stay | as Z1 (`destination: 'deep/real/dl/keep'`) |
| Z10 | A | `mv -f dir inner/keep` | exit 128 `destination already exists, source=dir, destination=inner/keep`. Unchanged | `MV_DESTINATION_DIRECTORY_MISSING { source: 'dir', … }` |
| Z11 | B | `mv f inner/` (`sub/f` exists); `mv f inner/f` | exit 128 `destination exists, source=f, destination=inner/f`. Unchanged | `MV_DESTINATION_DIRECTORY_MISSING`, `destination: 'inner/'` (resp. `'inner/f'`); after Part 12 (R17) the first also names `'inner/f'` |
| Z12 | B | `mv -f f inner/`; `mv -f f inner/f` | exit 0. Index: `f`, `inner` removed, `inner/f` added; `sub/f` stays | as Z11, `force` and `force` + `skipErrors` and `dryRun` alike |
| Z13 | B | `mv -k -f f inner/` | as Z12 | as Z11 |
| Z14 | B | `mv -f f inner` (the link is the destination) | exit 0. Index: `inner` now holds f's blob, `100644`; disk: `inner` a regular file | parity |
| Z15 | B | `mv f x` (`x` a file on disk, `x/y` in the index) | exit 128 `destination exists, source=f, destination=x` | parity |
| Z16 | B | `mv -f f x` | exit 0. Index: `f` and **`x/y`** removed, `x` added | returns; index holds **both `x` and `x/y`** |
| Z17 | B | `mv f t/keep` (`t` a file in the index, a directory on disk) | exit 128 `destination exists, source=f, destination=t/keep` | parity |
| Z18 | B | `mv -f f t/keep` | exit 0. Index: `f` and **`t`** removed, `t/keep` added | returns; index holds **both `t` and `t/keep`** |
| Z19 | B | `mv dir t/d` | exit 0. Index: `dir/a` and **`t`** removed, `t/d/a` added | returns; index holds **both `t` and `t/d/a`** |
| Z20 | B | `mv f t/new` | exit 0. Index: `f` and **`t`** removed, `t/new` added | returns; index holds **both `t` and `t/new`** |
| Z21 | C | `mv f lnk/description`; `mv -f f lnk/description`; `mv -k -f …` | exit 128 `destination exists`; with `-f` (and `-k -f`) **exit 0: `.git/description` overwritten with f's content**, index `f` and `lnk` removed, `lnk/description` added | `MV_DESTINATION_DIRECTORY_MISSING` (read off the code) |

**The replacement rule, as observed.** Writing index entry `P` drops every entry at a leading
directory of `P` (`inner` for `inner/keep`, `deep/real/dl` for `deep/real/dl/keep`, `t` for `t/d/a`)
and every entry beneath `P/` (`x/y` for `x`). It is not specific to links (Z16, Z18–Z20) or to
`-f` (Z19, Z20). The entry the link's target holds is not related to `P` by path and stays (Z2).
This is consistent with git's `add_index_entry` under `ADD_CACHE_OK_TO_REPLACE` (its
file/directory conflict check), which `rename_index_entry_at` goes through; the reading is
inferred from the rows, not from the source. tsgit's `add` already implements the rule with
`entriesAtLeadingDirectories` and `entriesBeneath` (src/domain/git-index/directory-file-conflict.ts).

### Pinned matrix — an absent untracked source (ADR-1227)

Fixture B of the matrix above, same isolation, every row 2/2 (git and tsgit). U12 uses the long
fixtures of test/integration/pathspec-length-interop.test.ts on an index holding only `base`:
`S300` (`s`×300), `P5000` (25 × `p`×200), `DIR805/nope` (four 200-byte components). The tsgit
column is dist built from this branch before Parts 11–13, except U12 (that file's rows M3 and M7).

| Row | Command | git | tsgit before |
|---|---|---|---|
| U1 | `mv ghost z` | exit 128 `bad source, source=ghost, destination=z` | `MV_SOURCE_NOT_TRACKED { source: 'ghost', destination: 'z' }` |
| U2 | `mv ghost dir` (into a directory) | exit 128 `bad source, source=ghost, destination=dir/ghost` | `MV_SOURCE_NOT_TRACKED { destination: 'dir/ghost' }` |
| U3 | `mv ghost missing/z` (missing parent) | exit 128 `bad source, source=ghost, destination=missing/z` | `MV_SOURCE_NOT_TRACKED` |
| U4 | `mv -n ghost z` | exit 128 after `Checking rename of 'ghost' to 'z'`, `bad source` | `MV_SOURCE_NOT_TRACKED` |
| U5 | `mv untracked z` (present, untracked file) | exit 128 `not under version control, source=untracked, destination=z` | parity |
| U6 | `mv dl2 z` (untracked dangling link) | exit 128 `not under version control` | parity (`lstat` sees the link) |
| U7 | `mv gone z` (tracked, removed from disk) | exit 128 `bad source` | parity |
| U8 | `mv td z` (tracked directory, removed) | exit 128 `bad source` | parity |
| U9 | `mv ud z`; `mv emp z` (present directory without a tracked member) | exit 128 `source directory is empty, source=ud, destination=z` (resp. `emp`) | `MV_SOURCE_NOT_TRACKED` (N8, not folded here) |
| U10 | `mv -k -v ghost untracked gone f dir` | exit 0, stdout `Renaming f to dir/f`; index gains `dir/f` | returns, `skipped` `ghost: 'source-not-tracked'`, `untracked: 'source-not-tracked'`, `gone: 'bad-source'` |
| U11 | `mv -k -v ud emp f dir` | exit 0, stdout `Renaming f to dir/f`; `ud/u`, `emp` stay | `skipped` `ud`, `emp`: `'source-not-tracked'` (N8; read off the code) |
| U12 | `mv S300 short`, `mv P5000 short`, `mv DIR805/nope short`; `mv -k S300 short` | each exit 128 `bad source, source=<it>, destination=short`; `-k`: exit 0 | `MV_SOURCE_NOT_TRACKED`; `-k`: `skipped` `'source-not-tracked'` (rows M3, M7 assert it) |

git refuses `bad source` from a failed `lstat` of the source before it consults the index for
an untracked path (U1–U4, U12); only a source that `lstat` finds is then `not under version
control` (U5, U6) or `source directory is empty` (U9). tsgit classifies against the index first,
so an absent untracked path never reaches its `lstat`.


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
Today `applyToIndex` moves every planned entry in memory *before* the renames, so a skipped file
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
| Y1, Y6 (directory), Y10 (directory) | `MV_DESTINATION_BEYOND_SYMLINK { source: 'dir/a', destination: 'lnk/hooks/x/a' }` (first member, index order). Nothing changed |
| Y2, Y6, Y8, Y10 (file) | `MV_DESTINATION_BEYOND_SYMLINK { source: 'f', destination: 'lnk/hooks/pre-commit' }`, `force` included. Nothing changed |
| Y3, Y5, Y7, Y11 (directory, `skipErrors`) | returns. `moved` has no member of `dir`; `skipped` holds `{ source: 'dir/a' }`, `{ source: 'dir/b' }`, `{ source: 'dir/s/t' }` with `reason: 'destination-beyond-symlink'` (N4), after the planning skips of earlier sources; disk: `dir` renamed through the link |
| Y4 (file, `skipErrors`) | returns `{ moved: [], skipped: [{ source: 'f', reason: 'destination-beyond-symlink' }] }`; nothing written |
| Y13 | `dryRun`: the refusal; `dryRun` + `skipErrors`: Y3's `moved`/`skipped`, nothing written |
| Y12, Y14–Y16, Y9 | unchanged (parity) |
| Y17, Z1, Z8, Z11, Z15, Z17, Z21 (no `force`) | `MV_DESTINATION_EXISTS { source: 'f', destination: 'inner/keep' }` (resp. that row's pair). Nothing changed |
| Z5 (`skipErrors`) | returns `{ moved: [], skipped: [{ source: 'f', reason: 'destination-exists' }] }`; nothing changed |
| Z10 | `MV_DESTINATION_EXISTS { source: 'dir', destination: 'inner/keep' }`, `force` included |
| Y18, Z2–Z4, Z6, Z9, Z12, Z13, Z21 (`force`) | returns `{ moved: [{ from: 'f', to: 'inner/keep' }], skipped: [] }`; the index as git's (link entry removed, `sub/keep` kept); disk: renamed through the link |
| Z7 (`dryRun` + `force`) | returns the same `moved`; nothing written |
| Z16, Z18–Z20 | returns the same `moved` as before; the index now as git's (`x/y`, resp. `t`, removed) |
| U1–U4, U12 | `MV_BAD_SOURCE { source: 'ghost', destination: 'z' }` (resp. that row's pair); under `skipErrors` `{ source, reason: 'bad-source' }` |
| U5–U9, U11 | unchanged |

The message, rebuilt by `src/domain/error.ts` from the fields as the other `MV_*` codes are:
`destination is beyond a symbolic link, source=<source>, destination=<destination>` (N5).

`reports/api.json` changes: one optional member on `FileSystem`, and one literal
(`'rename-failed'`) in `MvSkipReason` (ADR-1223). ADR-1226 adds one literal
(`'destination-beyond-symlink'`) to `MvSkipReason`, one `TsgitErrorData` variant and one
exported factory `mvDestinationBeyondSymlink` (N5 = A).

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
| Y1, Y2 (ADR-1226) | returned after writing through the link; now throws `MV_DESTINATION_BEYOND_SYMLINK` | a new refusal from a returning call → breaking (ADR-1190, D-3), under the same `!` |
| Y6, Y8, Y10 | threw `MV_DESTINATION_DIRECTORY_MISSING`; now throw `MV_DESTINATION_BEYOND_SYMLINK` | a consumer matching the old code stops matching → breaking, same `!` |
| Y3, Y5 under `skipErrors` | returned with the index repathed through the link; now return with the index unchanged and per-member `skipped` entries | wrong result → `fix`; the disk outcome (directory renamed through the link) is git's, by design (ADR-1226, D-4) |
| Y4 under `skipErrors` | returned after writing through the link; now returns having written nothing | wrong result → `fix` |
| Y7, Y11 under `skipErrors` | threw `MV_DESTINATION_DIRECTORY_MISSING`; now return | refusal git does not make removed → `fix` (ADR-1048) |
| Y17, Z1, Z8, Z10, Z11, Z21 (ADR-1227) | threw `MV_DESTINATION_DIRECTORY_MISSING`; now throw `MV_DESTINATION_EXISTS` | a consumer matching the old code stops matching → breaking, same `!` |
| Y18, Z2–Z4, Z6, Z7, Z9, Z12, Z13; Z5 under `skipErrors` | threw; now return as git does | refusal git does not make removed → `fix` (ADR-1048); Z21 writes through a link into the administrative directory, as git does (N9) |
| Z16, Z18–Z20 | returned with an index holding a path and an entry beneath it; now return with git's index | wrong result → `fix`; the removed entries are index-only, the disk is untouched |
| U1–U4, U12 (ADR-1227) | threw `MV_SOURCE_NOT_TRACKED`; now throw `MV_BAD_SOURCE`; under `skipErrors` the reason changes from `'source-not-tracked'` to `'bad-source'` | a consumer matching the old code or reason stops matching → breaking, same `!` |
| `MvSkipReason` gains `'destination-beyond-symlink'`; `TsgitErrorData` gains `MV_DESTINATION_BEYOND_SYMLINK` | the unions widen | an exhaustive `switch` stops compiling → breaking, same `!` |

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
- `docs/use/commands/mv.md`, destination beyond a symbolic link (ADR-1226): the `MvSkipReason`
  signature line gains `'destination-beyond-symlink'`; the Throws list gains
  `MV_DESTINATION_BEYOND_SYMLINK` (a leading directory of the destination is a symbolic link,
  wherever it points); the "Skipping errors deletes data as git does" section gains: a directory
  whose destination lies beyond a symbolic link is still renamed through the link, its members stay
  in the index under the source and are reported in `skipped` one by one, so the work tree then
  lacks them, as git's does; a file is skipped and nothing is written. The closing sentence's
  "first four" planning refusals become five. A destination ending in `/` that names a link to a
  directory is a directory destination.
- `docs/use/commands/mv.md`, ADR-1227: the `force` option row says a forced move onto an
  existing file reached through a symbolic link renames through the link, as git does, and the
  Throws entry of `MV_DESTINATION_DIRECTORY_MISSING` no longer covers a parent that is a link to a
  directory. A short "Index replacement" paragraph: writing a moved path removes any index entry
  at a leading directory of it, and any entry beneath it, as git does; such entries are not
  listed in the result. The Throws entries read: `MV_BAD_SOURCE` — a source is missing from the
  working tree (tracked or not); `MV_SOURCE_NOT_TRACKED` — a source on disk is not in the index.
- `docs/use/errors.md`: no row change (`UNSUPPORTED_OPERATION` already covers row 5; the `MV_*`
  codes are documented on the command page, not there).
- `docs/design/mv-atomic-rename.md`: untouched (history). This doc supersedes its leaf-loop drift.
- `docs/known-divergences.md`: **remove row 32.72** and its code block (folded, ADR-1220).
- `docs/BACKLOG.md`: tick 32.67 and strike it from the release-order table.

### 8. Destination beyond a symbolic link (ADR-1226)

**Where it lives.** One planning check in `validateMove`, after `into-self` and before the
destination-directory check, so the order of rows Y6, Y8, Y14 and Y15 holds:

```ts
// validateMove, after the into-self line
if (await destinationBeyondSymlink(ctx, policy.scanner, target)) {
  return beyondSymlinkVerdict(classified.kind, source, target, entries, classified.entries, opts);
}
// … then the parent-directory check and destinationFree, unchanged

// git's chain reaches the link check only when the destination does not exist (Y16–Y18)
const destinationBeyondSymlink = async (ctx, scanner, target): Promise<boolean> =>
  (await lstatOrUndefined(ctx, target)) === undefined && (await beyondSymlink(scanner, target));
```

**Which primitive it reuses.** `createLeadingPathScanner(ctx).hasSymlinkedLeadingPath` from
src/application/primitives/internal/symlinked-leading-path.ts, the `has_symlinked_leading_path`
equivalent `add`, `stash`, checkout's stale-entry pass and `merge` already use. Shape-based (it
fires for a link inside the work tree, Y6), it never scans the leaf (Y16), it stops at a missing
component (nothing lies beneath), and a regular file in a leading component is reported as
`kind: 'file'`, not a link (Y19). Wrapped in `beyondSymlink(scanner, target)` from
src/application/commands/internal/resolve-pathspec.ts, which maps a `PATH_TOO_LONG` from a prefix
`lstat` to "not a link" (git's `lstat_cache` records a failed `lstat` that way); today it is
module-private, and this change exports it unchanged rather than copying it. Without that wrapper
a too-long prefix would turn rows H and 5-k′ into a `PATH_TOO_LONG` throw at planning.

**One scanner per call.** `DestinationPolicy` gains `readonly scanner: LeadingPathScanner`, built
in `destinationPolicyOf` beside `force` and `ignoreCase`. Its per-prefix memo then spans every
pair of the call.

**`lstat` cost.** Per pair: one `lstat(target)` for the gate, plus one `lstat` per leading prefix
of `target` not yet in the scanner's memo. Into-directory mode shares `destDir`, so N sources
cost one prefix walk in total and one map lookup each after it. A directory's members cost
**nothing**: the scan is on the pair's target, not per member. That is equivalent to git's
per-member scan because every member destination is `target/<rest>`, its leading components are
`target`'s leading components plus `target` and the directories below it, and the gate has just
proved `target` absent, where the walk stops. The verdict is therefore the same for every member,
which is why git names the first one.

**The verdict.**

```ts
const beyondSymlinkVerdict = (kind, source, target, entries, members, opts): Verdict => {
  if (kind === 'file') return { skip: 'destination-beyond-symlink' };
  if (opts.skipErrors === true) return { kind, entries: [], retained: members, skippedMembers: entries };
  const first = entries[0] as IndexEntry; // non-empty: the bad-source line above returned otherwise
  return { skip: 'destination-beyond-symlink', source: first.path, target: repath(first, source, target) };
};
```

- A file pair: `buildPlan`'s skip arm. Without `skipErrors` `refusal()` throws
  `mvDestinationBeyondSymlink(source, target)`; with it `skipped` gets `{ source, reason }` and the
  pair writes nothing (Y4).
- A directory pair without `skipErrors`: the refusal names the first addressable member and its
  destination (Y1). A lossy member never reaches here without `skipErrors`: `memberBadSource`
  refused first. `entries` keep index order (`classifySource` walks `byPath`, read in index
  order), so the first is git's first.
- A directory pair with `skipErrors`: a `PlanItem` with `entries: []`, so no member is repathed,
  moved or validated, and `retained` = every member, the field that already means "members left in
  the index under the source". The directory still goes through `renameEach` and is renamed
  through the link, as git's `WORKING_DIRECTORY` entry is (Y3, Y7). `retained` being non-empty
  keeps R11 and R14 inert: `removeAbandonedSources` finds members under the source, and
  `abandonsSource` is false, so a failed rename of this directory deletes nothing (git:
  `index_range_of_same_dir(src)` is not empty). The success arm of `Verdict` gains
  `readonly skippedMembers: ReadonlyArray<IndexEntry>` (empty on every other path); `buildPlan`
  appends `{ source: member.path, reason: 'destination-beyond-symlink' }` for each one, in order,
  where it appends planning skips today.
- `MvSkipReason` gains `'destination-beyond-symlink'`. It is a planning reason, so
  `PlanSkipReason` (an `Exclude` of `'rename-failed'`) includes it and `refusal()` gains its arm.
  The literal follows git's own reason; no naming alternative is a candidate.

**R17 — trailing slash.** `resolveDestinationMode` reads the destination with
`ctx.fs.stat` (follows a link) when `destination` ends in `/`, and with `lstat` otherwise, through
a `statOrUndefined` twin of `lstatOrUndefined`. git's `lstat("inner/")` resolves the link because
of the slash; `stat("inner")` is the port's way to ask the same question. A dangling link or a link
to a file is not a directory under either call (Y12). The existing `isSymbolicLink !== true`
operand stays: `stat` never reports a link, so it remains the documented equivalent mutant.

**An existing destination reached through a link (R18).** Rows Y17, Y18 are § 9's: the gate's
`lstat(target) === undefined` keeps R15 from refusing them as `beyond`, and § 9 lets the parent
check pass a parent that resolves to a directory, so `destinationFree` answers as git does.

### 9. An existing destination through a link, and the index replacement (ADR-1227, R18)

**Planning — the parent check follows the parent's own link.** After Part 12, `validateMove` runs
the beyond-symlink gate before the parent check. The gate refuses every absent target that has a
link in a leading component, so the parent check now meets a parent that is a link only when the
target exists on disk (Y17, Z1–Z13, Z21): an absent target under a link to a directory, a dangling
link or a link to a file is refused by R15 first. The parent check therefore reads the parent
with `stat` (follows a link) instead of `lstat`:

```ts
// validateMove, after the beyond-symlink gate: the `if` and its Stryker comment are unchanged
if (parent !== '' && !(await isDirectoryOnDisk(ctx, parent))) {
  throw mvDestinationDirectoryMissing(source, target);
}

// `stat` follows the parent's own link, as rename(2) does
const isDirectoryOnDisk = async (ctx: Context, path: FilePath): Promise<boolean> =>
  (await statOrUndefined(ctx, path))?.isDirectory === true;
```

- `statOrUndefined` is Part 12's twin of `lstatOrUndefined` (R17). The name `isDirectoryOnDisk`
  stays because the existing Stryker comment above the `if` names it. Its
  `isSymbolicLink !== true` operand and equivalent-mutant comment are dropped: `stat` never
  reports a link, so the operand would be dead code. The parent check is its only caller.
- `destinationFree` is unchanged. Its `lstat(target)` already follows leading links, so the
  existing `sub/keep` reads as "exists": a file source refuses `'destination-exists'` unless
  `force` (Z1, Z5, Z8), a directory source always refuses (Z10). The verdict and the refusal
  code are the existing ones.
- This is equivalent to skipping the parent check when the target exists: after R15, a parent
  that is a link reaches the check only then. The `stat` form states the condition being checked
  ("the parent resolves to a directory") and costs the same single call.
- Execution needs no change: `renameNamingDestination` runs `mkdir(dirname(to.abs))` on the link
  (node: `mkdir -p` on a link to a directory is a no-op; memory: `mkdirThroughLeafSymlink` returns
  when the link resolves to a directory), then `rename`, which resolves the leading link as
  `rename(2)` does. The plan for Part 14 asks the implementer to confirm the memory adapter's
  `rename` follows a leading link before relying on it in a unit row.

**Execution — `applyToIndex` applies git's replacement rule.** Every move removes its `from`
entries, then writes each `to` after removing the entries that conflict with it by path:

```ts
const applyToIndex = (byPath: Map<IndexPathKey, IndexEntry>, indexed: ReadonlyArray<ExecutedItem>): void => {
  const moves = indexed.flatMap(({ moves }) => moves);
  for (const { from } of moves) byPath.delete(indexPathKey(from));
  const remaining = Array.from(byPath.values()); // index order: read sorted, only deletions so far
  for (const { to } of moves) {
    for (const stale of conflictsWith(byPath, remaining, to.path)) byPath.delete(indexPathKey(stale));
    byPath.set(indexPathKey(to), to);
  }
};

// git's file/directory replacement: a leading directory held by a file, or entries beneath the path
const conflictsWith = (byPath, remaining, path: FilePath): ReadonlyArray<IndexEntry> => [
  ...entriesAtLeadingDirectories(byPath, path),
  ...entriesBeneath(remaining, path),
];
```

- Reused, not re-implemented: `entriesAtLeadingDirectories(byKey, path)` (stage-0 entries at
  `a`, `a/x` for `a/x/y`, map lookups) and `entriesBeneath(sorted, path)` (binary search in an
  index-ordered array, lossy entries compared by bytes) from
  src/domain/git-index/directory-file-conflict.ts, the pair `add` uses for the same rule.
  `remaining` is in index order without a sort: `readIndexMap` inserts entries in on-disk order
  and only deletions have happened when it is taken.
- The sweep is per `to`, not per `from`. Deleting every `from` before the first `set` is the one
  ordering change against today's interleaved `delete` + `set`; it cannot change a result today
  produces, because planning refuses a target that is another move's source (an existing target is
  `'destination-exists'`, overlapping sources are refused, and two moves never share a target).
- Cost: one `Array.from` of the index per call, then per moved entry one map lookup per leading
  component and one binary search. Today's loop was one `delete` + `set` per entry.
- `moved` is unchanged (N7 = A): git's `-v` prints nothing for a replaced entry, and the index
  read-back shows it.
- `dryRun` returns before `applyToIndex`, so it is unaffected (Z7).
- Z21 is git's data-destroying arm (D-4): with `force`, `mv` writes through a tracked link into
  the administrative directory. The design copies it (N9 = A).

### 10. An absent untracked source is a bad source (ADR-1227, R19)

**Where it lives.** `validateMove`'s first line. An `untracked` classification asks the disk
before it answers:

```ts
const classified = classifySource(byPath, source);
if (classified.kind === 'untracked') return { skip: await untrackedVerdictOf(ctx, source) };
// … unchanged

// git's chain: a failed lstat of the source is `bad source` before the index is consulted
const untrackedVerdictOf = async (ctx: Context, source: FilePath): Promise<PlanSkipReason> =>
  (await lstatOrUndefined(ctx, source)) === undefined ? 'bad-source' : 'source-not-tracked';
```

- `lstat`, not `stat`: an untracked dangling link is present (U6). `lstatOrUndefined` maps every
  `lstat` failure to absent, a `PATH_TOO_LONG` included, which is git's answer for `S300`,
  `P5000` and `DIR805/nope` (U12).
- The order of the other checks is untouched. A tracked source missing from disk is already
  `'bad-source'` through `sourceExistsOnDisk` (U7, U8). The verdict carries no `source`/`target`
  override, so `refusal()` names the user's source and the mode's target, as git does (U2: into-dir
  mode names `dir/ghost`).
- The reason travels the existing `skip` arm: under `skipErrors` the source lands in `skipped`
  with `'bad-source'` (U10, U12); under `dryRun` the refusal throws as before (U4).
- One extra `lstat` per untracked source, only on the refusal path.
- U9 / U11 (a present directory with no tracked member, git: `source directory is empty`) keep
  `MV_SOURCE_NOT_TRACKED`: tsgit has no code for git's reason, so folding it is a new refusal code
  and a new skip reason (N8).

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
| N3 | Under `skipErrors`, a partial entry-by-entry move of a directory that keeps its source because a lossy member stays in the index. git has no such state: it moves every member's index entry and deletes the source. The state comes from tsgit's own lossy-member rule (`validateMove` drops lossy members under `skipErrors`; `docs/use/commands/mv.md`: lossy entries are never touched on disk), which keeps the entry under the source, so R11 keeps the source. ADR-1224's "remove what the move created" assumed the source is deleted too; here the leaves already moved exist **only** at the destination | **A** remove the destination anyway: the leaves already moved are deleted while their source directory survives, a loss neither git nor the no-fault path produces. **B** do not remove the destination when the source is kept: the moved leaves stay at the destination, the rest in the source, nothing is lost (ADR-1218's degradation, restricted to this arm). **C** move the moved leaves back into the source, then let R11 decide: reaches git's state, but it is a rollback ADR-1218 rejected, and the move back can fault in turn | **B** | D-4 binds git's data-destroying arms; it does not license destroying data git keeps, which A does. C is the only exact match, but it adds a second fault surface and a rollback path for an arm that needs a lossy (non-UTF-8) index entry, an adapter without `renameDirectory` (OPFS cannot hold such a name) and a write fault mid-move, none pinned. B costs one guard operand (`item.retained.length === 0`) and stays inside ADR-1224's stated premise (index repathed, source deleted, nothing at the destination), which holds exactly when no lossy member keeps the source. The design is written for B; A drops `abandonsSource`'s second operand and the `retained` field, C adds a reverse-move step in `renameOrSkip` |

New candidates raised by the ADR-1226 revision:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| N4 | How `skipped` reports a directory whose members lie beyond a link under `skipErrors` (Y3, Y7). git drops each member entry and still renames the directory | **A** one entry per addressable member, `{ source: 'dir/a', reason: 'destination-beyond-symlink' }`, in index order. **B** one entry for the pair, `{ source: 'dir', reason }`. **C** no entry | **A** | A is git's granularity: the refusal is per member and git's message names the member. It keeps both arrays literal: `moved` is the index truth (nothing moved), `skipped` lists exactly the paths whose index entry stayed, and the directory, which **was** renamed, is in neither. The `-v` rebuild then needs no reason-specific rule (the directory's line is printed because `dir` is not a skipped source). B reports as skipped a directory that was renamed, the inverse of `'rename-failed'` (ADR-1223), where the directory was not renamed and its members did move. C leaves a caller unable to tell from the result that the work tree now lacks every member. Cost of A: `skipped.source` can name a path that is not an argv source; the docs say so |
| N5 | The error for R15. ADR-1226's Consequences name `PATHSPEC_BEYOND_SYMLINK` "naming the member's source and destination", but that code's data is `{ path }` only (src/domain/commands/error.ts) | **A** a new `MV_DESTINATION_BEYOND_SYMLINK { source, destination }`, factory `mvDestinationBeyondSymlink(source, destination)`, beside the other `MV_*` codes; ADR-1226's Consequences amended to name it. **B** reuse `PATHSPEC_BEYOND_SYMLINK { path: <destination> }`: no new code, the source is lost from the data (an interop test must re-derive the member from the destination). **C** widen `PATHSPEC_BEYOND_SYMLINK` with an optional `source`: one code, two shapes, and its message builder must branch | **A** | ADR-202 gives `mv` granular `MV_*` codes, and every one of git's `bad` reasons carries `{ source, destination }` (ADR-249: the fields rebuild git's `source=…, destination=…` line). A is the only option that satisfies ADR-1226's "naming the member's source and destination" as written. Its cost is one extra plan part (the code, its message, the exhaustiveness switch and `api.json`, plan Part 11), because the six-file ceiling cannot hold it with the behaviour. B collapses Parts 11 and 12 into one |
| N6 | Rows Y17, Y18: an existing destination reached through a link. Before and after this change tsgit refuses `MV_DESTINATION_DIRECTORY_MISSING` where git refuses `destination exists` (Y17) or, with `-f`, succeeds through the link and replaces the link's index entry (Y18) | **A** fold now: the parent check follows a final link, and `mv` gains git's index directory/file replacement on add (drop `inner` when adding `inner/keep`). **B** record both rows in `docs/known-divergences.md` under the filing bar (ADR-1170) and keep this revision to the refusal. **C** schedule a backlog item | **A**, as its own part after Part 13, re-pinned first | Same function, same refusal family, and the gate in § 8 was shaped around it, so it is inside the change's perimeter by the fold rule. It is not part of Parts 11–13 because it is new behaviour (an index replacement rule `mv` lacks, Y18 deletes a tracked link's entry), and the index outcome of a replacement under a directory member is unpinned. B is the lighter path if the user scopes the run to ADR-1226 |

N6: Settled by ADR-1227 (option A, fold; the absent untracked source of Y14 is folded with it).

New candidates raised by the ADR-1227 revision:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| N7 | Whether `MvResult` reports the index entries the replacement rule removes (`inner` in Z2, `x/y` in Z16, `t` in Z18–Z20) | **A** no: `moved` keeps listing the moves only; the docs say replaced entries are not listed. **B** a new `replaced: ReadonlyArray<FilePath>` field, in index order. **C** report them in `skipped` | **A** | git reports nothing for them (`-v` in Z2, Z7: one `Renaming` line), and the caller can read the index back. B widens `MvResult` and `api.json` for data no pinned consumer needs (YAGNI); it stays additive if one appears. C is wrong: nothing was skipped |
| N8 | Rows U9, U11: a present directory with no tracked member (untracked files only, or empty). git refuses `source directory is empty`; tsgit refuses `MV_SOURCE_NOT_TRACKED`. Pinned 2/2, same function, outside ADR-1227's two folds | **A** fold as a later part: a new `MV_SOURCE_DIRECTORY_EMPTY { source, destination }` and skip reason `'source-directory-empty'` (error code, message, exhaustiveness, `api.json`, unit + interop rows). **B** record a row in `docs/known-divergences.md` under the filing bar (ADR-1170). **C** reuse `MV_BAD_SOURCE` | **A**, as a Part 16 planned after this revision is accepted | Same refusal chain and same `validateMove` line R19 edits, so the fold rule (DOCTRINE D-3) points at A. It is not folded silently because it adds a public code and a public skip reason beyond what ADR-1227 decided. C carries git's wrong reason, which ADR-249's rebuilt message would expose |
| N9 | Row Z21: with `force`, `mv f lnk/description` (`lnk -> .git`) overwrites `.git/description` through the link and records `lnk/description`, as git does. R18 copies it | **A** copy git (DOCTRINE D-4; ADR-1226 ratified the same choice for the `-k` arm that renames into `.git`). **B** refuse `MV_DESTINATION_BEYOND_SYMLINK` when the resolved destination lies inside the git directory, a documented divergence. **C** refuse every forced move through a link | **A** | The behaviour is git's on a call the user forced; ADR-1226's ratification covers the same write surface under `-k`. B needs a realpath of the destination (a new port read) and an ADR; C diverges on every Z2-shaped row. The interop row pins A against git |

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

### P7 — destination beyond a symbolic link (ADR-1226)

- The error code (N5 = A): `MV_DESTINATION_BEYOND_SYMLINK` in the `TsgitErrorData` union and
  `mvDestinationBeyondSymlink` in src/domain/commands/error.ts, its message in src/domain/error.ts,
  its re-export in src/domain/commands/index.ts, its case in the shared exhaustiveness switch and
  a data + message row in test/unit/domain/error.test.ts.
- `mv.ts` as § 8: `destinationBeyondSymlink`, `beyondSymlinkVerdict`, `Verdict.skippedMembers`,
  `DestinationPolicy.scanner`, the `refusal()` arm, `statOrUndefined` and R17's branch; export
  `beyondSymlink` from resolve-pathspec.ts. Unit rows on the memory adapter with links created by
  `ctx.fs.symlink(target, path)` (the check reads the disk; the link need not be tracked, Y8).

### P8 — interop and docs for P7

Rows Y1–Y5, Y7, Y10–Y13 and Y15 in test/integration/mv-interop.test.ts, `skipIf(!GIT_AVAILABLE ||
win32)` (a tracked link needs `core.symlinks`). Each compares `ls-files -s` and the disk listing
of both twins, `pathExists` for `.git/hooks/<name>` / `sub/<name>`, rebuilds git's refusal line
from `data.source`/`data.destination`, and, for the `-k -v` rows, git's stdout with
`mvVerboseLines`, which learns to drop a source that `skipped` names with a planning reason (git
prints nothing for it, Y4, Y5). Docs as § 7.

### P9 — an existing destination through a link, and the index replacement (ADR-1227, R18)

`mv.ts` as § 9: `isDirectoryOnDisk` reads with `stat`; `applyToIndex` deletes every
`from` first and sweeps `conflictsWith` per `to`. Unit rows on the memory adapter (links by
`ctx.fs.symlink`); Part 12's Y17 guard row flips to `MV_DESTINATION_EXISTS` / success. Interop
rows for Y17, Y18 and the Z rows the plan's Part 14 lists (Z21, the `.git` write, included) in
test/integration/mv-interop.test.ts. Docs as § 7.

### P10 — an absent untracked source (ADR-1227, R19)

`mv.ts` as § 10: `untrackedVerdictOf`. Every existing row asserting `MV_SOURCE_NOT_TRACKED` or
`'source-not-tracked'` for an absent path flips to `MV_BAD_SOURCE` / `'bad-source'`, or gains the
file on disk when its point is the untracked classification (the corrupt-index tolerance rows).
Interop: the existing ghost row in mv-interop, rows M3/M7 in pathspec-length-interop, and U5,
U6, U10. Docs as § 7.

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

§ 9's replacement adds no property sibling: it composes `entriesAtLeadingDirectories` and
`entriesBeneath`, whose grammar is covered by
test/unit/domain/git-index/directory-file-conflict.properties.test.ts. `applyToIndex` is
module-private orchestration; its rows are examples (Z16, Z18–Z20).

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
- Beyond a symbolic link (P7): isolated rows for the gate's two operands (an existing destination
  through a link, Y17, must stay `MV_DESTINATION_DIRECTORY_MISSING`; an absent one beyond a link
  refuses), for `beyondSymlinkVerdict`'s `kind === 'file'` and `skipErrors === true` arms (file
  with and without the flag, directory with and without it), for the first-member naming (two
  members, the refusal names the first), for the `skippedMembers` order, for the tolerance (an
  `lstat` stub raising `PATH_TOO_LONG` on the link's prefix must not refuse) and for R17's
  ternary (`f inner/` into-directory mode vs two sources into `inner` refusing
  `MV_DESTINATION_NOT_DIRECTORY`). The order against `into-self` is killed by Y15 at unit level.
- Existing destination through a link (P9): the `stat` in `isDirectoryOnDisk` is killed by Z2
  at unit level (an `lstat` refuses `MV_DESTINATION_DIRECTORY_MISSING`); `?.isDirectory === true`
  by a parent that is a regular file (`mv f g/x`, `g` a file: still refuses the missing
  directory) and an absent parent. `conflictsWith`'s two operands each have an isolated row: a
  leading-directory entry only (Z18-shaped: `t` in the index, `t/keep` on disk) and an
  entry-beneath only (Z16-shaped). Emptying the first loop's body (the `from` deletions) is
  killed by any move reading the old path back from the index.
- Absent untracked source (P10): `untrackedVerdictOf`'s ternary is killed by U1 (absent →
  `MV_BAD_SOURCE`) and U5 (present → `MV_SOURCE_NOT_TRACKED`) as isolated rows; U6 (a dangling
  link) kills a `stat` substitution.
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
- **A present directory with no tracked member** (U9, U11): git's `source directory is empty`,
  tsgit's `MV_SOURCE_NOT_TRACKED`. Candidate N8; not changed by R19.
- **Unmerged entries and the replacement rule**: `entriesAtLeadingDirectories` returns stage-0
  entries only, as in `add`; a conflicted leading-directory entry under a forced `mv` is unpinned.
- **A link whose target lies outside the work tree** (`out -> /elsewhere`, `mv -f f out/keep`):
  git renames outside the repository; tsgit's write guard is unpinned for it. How to prove: an
  interop row with an absolute-target link, comparing exit codes and the outside file.
- **A destination present in the index but absent on disk beyond a link**: unpinned. § 8 checks
  the link before `destinationFree`, so it would refuse `MV_DESTINATION_BEYOND_SYMLINK`.
- **Windows**: the P8 rows need tracked links and are skipped there.
- **The leaf path's descendant `PATH_TOO_LONG` naming an absolute path**: unreachable on the
  first-party adapters without the capability (browser: no `PATH_MAX`). It keeps ADR-1194's
  "names itself" consequence.
