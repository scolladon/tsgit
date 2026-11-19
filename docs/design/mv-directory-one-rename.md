# Design — mv-directory-one-rename

> Brief: backlog 32.67. A directory `mv` that fails partway leaves the work tree half-moved, because
> `renameInWorkingTree` moves a directory leaf by leaf and the index is written only afterwards. git
> `rename(2)`s the directory in one step. Move a directory in one `fs.rename` wherever the adapter
> can. Keep a hardened leaf-by-leaf path for adapters that cannot (OPFS) behind a port capability.
> Status: draft → self-reviewed ×3 → accepted

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
  (an optional port member with a fallback that gives the same answer). Both are precedents for D1.
- ADR-815..825: the rename kind rules. ADR-817: a directory renamed into itself refuses before the
  kind check. ADR-823: atomic only where the platform renames in one step.
- ADR-1194: `mv` relabels `PATH_TOO_LONG` from the rename to the repo-relative destination. This
  design extends the relabel to the one-step directory rename. Its consequence "a too-long source
  descendant of a directory move keeps naming itself" becomes leaf-path only (§ Design 3).
- ADR-1048 (removing a refusal git does not make ships as `fix`), ADR-1190 + DOCTRINE D-3 (a new
  refusal in an edited function is folded and marked breaking), DOCTRINE D-2.
- ADR-1170 (filing bar). Ledger row **32.72** (`mv -k` throws on a rename the host refuses, where git
  skips) sits in `docs/known-divergences.md`; D4 settles how it relates to this change.

## Requirements

- **R1 — one step where the adapter can.** On an adapter that declares the directory-rename
  capability (node, memory), `renameInWorkingTree` of a directory issues exactly one rename call
  for the directory itself. It does not `lstat`, `readdir` or `mkdir` any descendant and does not
  call `rmRecursive`.
- **R2 — deep descendants do not matter (rows 1–3).** `mv d e` where `d` holds a descendant whose
  absolute path exceeds the host `PATH_MAX` succeeds as git does. The index holds `e/…` for every
  tracked member, and the whole subtree, untracked included, sits under `e/`. The same holds inside
  a linked worktree.
- **R3 — all or nothing for the directory (node, memory).** If the directory's own rename is refused,
  then the index is not written, nothing under the source has moved, and the command throws.
- **R4 — case-only directory rename (row 5).** `mv d D` on a case-insensitive host refuses (git:
  exit 128) with index and disk unchanged, untracked content included, under both `core.ignorecase`
  values. `mv -n d D` returns the plan (git: exit 0, `d → D/d`).
- **R5 — empty subdirectories survive (row E)** on every adapter.
- **R6 — leaf path (adapters without the capability).** Every read (`lstat`, `readdir`) of the
  source subtree happens before the first move. Every source directory, empty ones included, is
  recreated at the destination. The source is cleaned up only by empty-directory removal
  (`removeEmptyDirectoryTree`), never by `rmRecursive`, so an entry still under the source is never
  deleted. A write fault after the first move leaves a partial move, which is documented
  (non-atomic, like the browser's own `rename`).
- **R7 — error data (ADR-249).** A refused one-step directory rename surfaces as D3 decides. Any
  `PATH_TOO_LONG` raised by the rename names the repo-relative destination (ADR-1194). The
  absolute-source `PATH_TOO_LONG` of rows 1–3 can no longer arise, because no descendant is read.
  Every other adapter refusal passes through unchanged, carrying the adapter's own `path` as a file
  rename's refusal does today. That surface is outside this change.
- **R8 — wrappers.** Every `FileSystem` wrapper forwards the new capability when the inner adapter
  has it, and omits it when the inner adapter lacks it. `wrapFsValidator` is the only one; it guards
  both paths as writes.
- **R9 — case-only file rename (row 6, if D5 = A).** With `core.ignorecase=true`, `mv f F` and
  `mv d/g d/G` succeed as git does. With `false`, they refuse `MV_DESTINATION_EXISTS` unless
  `force` is set, as today.
- **R10 — no hard-coded host limits.** Deep fixtures derive their depth from `getconf PATH_MAX <root>`.
  The case-insensitive rows probe the host instead of trusting `process.platform`.

## Design

### Pinned matrix (git 2.56.0, macOS APFS case-insensitive, `PATH_MAX` 1024)

Rows 1–4 were pinned by the session against dist built from 314c5bc7. Rows 5-k, 5-n, 6 and E, and the
adapter probe, were pinned for this design. Probes ran in `mktemp -d` throwaways with every `GIT_*`
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
| 5-k | as 5, both values, 2/2 | `mv -k d D` | **exit 0. Index `D/d/f D/d/g`. Disk: `d` deleted recursively, `d/u` lost**. Status `RD d/f -> D/d/f` | `skipErrors: true`: returns `moved` `d/f→D/d/f`, `d/g→D/d/g`. Index `D/d/f D/d/g`, disk emptied (pinned on dist) |
| 5-k′ | as 5, `core.ignorecase=false`, destination `S300` (`s`×300) | `mv -k d S300` | exit 0. Index `S300/f S300/g`. Disk: `d` deleted recursively | `skipErrors: true`: throws `PATH_TOO_LONG { path: 'S300/f' }` from the first leaf (`moveLeaf` relabel). Index `d/f d/g`, disk unchanged (pinned on dist) |
| 6 | tracked `f`, `d/g`; `core.ignorecase=true` | `mv f F` / `mv -f f F` / `mv d/g d/G` | exit 0, `R f -> F` / same / `R d/g -> d/G` | throws `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }` (session pin) |
| 6′ | as 6, `core.ignorecase=false` | `mv f F` / `mv -f f F` / `mv d/g d/G` | exit 128 `destination exists` / exit 0 `R f -> F` / exit 128 | refuses / moves / refuses (parity) |
| E | tracked `d/f`, empty `d/emp`, untracked `d/u` | `mv d e` | exit 0. Disk `e/emp e/f e/u` | returns OK. Disk `e/f e/u`: **`e/emp` lost** |

Adapter probe (dist `NodeFileSystem`, same host):

```
rename(<t>/d, <t>/D/d)        -> UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }; d/f, d/u intact
rename(<t>/s, <t>/e)  # s holds the 7-level deep chain -> ok, one call; top level now d, e
```

Not pinned here: Linux (`PATH_MAX` 4096). The interop rows derive the depth, so CI ubuntu covers it.
Also not pinned: Windows. A case-only directory rename there is unpinned; the one-step rename makes
any refusal non-destructive, but the code is unknown. No row asserts it.

Row 5-k′ shows that git's `-k` arm deletes the source directory recursively whenever the directory's
own rename fails, not only for the case-only alias. git skips the failed working-directory rename,
repaths the children's index entries anyway, and then deletes the source once no index entry remains
under it. D4 decides whether tsgit copies this.

### 1. Port — an optional directory-rename capability (D1 = A)

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

### 3. The leaf path — `moveTreeEntryByEntry` (D2 = A)

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
- A write fault after the first rename propagates. `mv` does not commit the index, so the work tree
  is partially moved and the index is unchanged. This is the browser `rename`'s documented
  degradation, restated in the `renameInWorkingTree` doc comment. No rollback (D2).

### 4. `mv.ts` — what changes

- **Nothing in the execution loop** under D3 = A / D4 = A. A refused one-step rename throws out of
  `renameInWorkingTree`, the `finally` releases the lock uncommitted, and R3 holds. Multi-source
  ordering stays as git's: earlier pairs have moved on disk and the index is unwritten (mv design,
  § Execution order).
- **Row 6 (D5 = A):** `destinationFree` gains git's `ignore_case` escape. git's `lstat(dst) == 0 &&
  (!ignore_case || strcasecmp(src, dst))` reads "exists" only when the names differ beyond ASCII
  case:

  ```ts
  const onDisk = (await lstatOrUndefined(ctx, target)) !== undefined
    && !(ignoreCase && asciiLower(source) === asciiLower(target));
  const exists = byPath.has(keyOfPath(target)) || onDisk;
  ```

  `ignoreCase` is read once per `mv` call (`(await readConfig(ctx)).core?.ignoreCase === true`,
  stash.ts precedent) and threaded through `buildPlan` → `validateMove` → `destinationFree` as part
  of a small options record, not as a boolean parameter. `destinationFree` currently takes
  `force: boolean`; folding `force` and `ignoreCase` into one `DestinationPolicy` record removes the
  boolean-parameter smell in the touched function. `byPath.has` stays case-exact: the index holds
  `f`, not `F`, and git's check here is the `lstat` alone.
- The `PlanItem`/`MvResult` shapes do not change.

### 5. Error data shapes (ADR-249)

No new code. Under D3 = A:

| Row | tsgit after |
|---|---|
| 1, 2, 3, E | success, git's data |
| 5 (node, darwin) | `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }`, already documented in `docs/use/errors.md` for "a directory onto a destination inside itself". Index and disk unchanged |
| 5-k | as 5, nothing changed (D4) |
| 5-k′ | `PATH_TOO_LONG { path: 'S300' }`: the directory itself is the destination now, not `S300/f`. Nothing changed (D4) |
| 5-n | the plan (unchanged) |
| one-step rename too long | `PATH_TOO_LONG { path: <repo-relative destination> }` (ADR-1194) |

`reports/api.json` changes: one optional member on `FileSystem`.

### 6. Breaking-change assessment

| Change | Public effect | Class |
|---|---|---|
| `FileSystem.renameDirectory?` | additive optional port member. Third-party adapters keep compiling and get the hardened leaf path | non-breaking (ADR-705 / ADR-873 shape) |
| rows 1–3, E, 6 | a refusal or wrong result git does not make is removed | `fix` (ADR-1048) |
| row 5 | `mv` that returned OK (destroying data) now throws | a new refusal from a returning call → breaking (ADR-1190, D-3) |
| leaf path | same success results; fewer deletions on faults | non-breaking |

So the change is `fix(mv)!:` (D6).

### 7. Docs

- `src/application/commands/internal/working-tree.ts`: rewrite the `renameInWorkingTree` doc comment.
  It should describe one rename where the port can, and the three-phase degraded path otherwise.
- `docs/use/commands/mv.md`: one paragraph. A directory moves in one step on node and memory, so a
  refusal leaves it untouched. On the browser adapter a directory moves entry by entry, and a failure
  midway can leave it partially moved. Under D5, a sentence on `core.ignorecase` case-only renames.
- `docs/use/errors.md`: no row change (`UNSUPPORTED_OPERATION` already covers row 5).
- `docs/design/mv-atomic-rename.md`: untouched (history). This doc supersedes its leaf-loop drift.
- `docs/known-divergences.md`: under D4 = A, extend row 32.72 with rows 5-k / 5-k′. git's `-k`
  directory arm deletes the source recursively, and tsgit refuses with nothing changed (ADR).
- `docs/BACKLOG.md`: tick 32.67 and strike it from the release-order table.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | How `renameInWorkingTree` knows a directory can move in one step | **A** a new optional port method `renameDirectory?` (node + memory delegate to `rename`; browser omits; `wrapFsValidator` forwards and guards). **B** reuse `atomicRename`'s presence (today exactly node + memory) and call it for directories. **C** make `rename` accept directory sources on every adapter: the browser emulates a directory move inside the adapter and the command always calls one `rename` | **A** | A follows ADR-705/873: an optional capability whose absence is a documented answer, and a third-party adapter keeps working through the fallback. B couples two meanings. `atomicRename`'s contract is about atomic replacement, and the directory-source rules in `rename`'s doc are per adapter, so an adapter can provide `atomicRename` for files only. C breaks every third-party adapter whose `rename` is file-only, which works today through the leaf loop, and moves the leaf loop into the browser adapter. The brief's "check every leaf before moving the first" is not an option: row 1 fails on the source descendant's own `lstat`, so a pre-check refuses where git succeeds. Row 5 has no leaf fault at all |
| D2 | The leaf path (adapters without D1's capability) on partial failure | **A** collect-then-move (all reads first), recreate every directory, and clean up with `removeEmptyDirectoryTree`. A write fault leaves a documented partial move. **B** A plus a best-effort rollback of moved leaves on a write fault. **C** keep today's interleaved walk + `rmRecursive` | **A** | A removes the read-fault class of row 1, the data-loss class of row 5, and row E on every adapter, reusing an existing primitive. B's rollback is itself a sequence of non-atomic renames that can fail, there is no pinned fault to justify it, and OPFS `rename` already documents partial failure. C keeps `rmRecursive` deleting whatever an aliased move left under the source |
| D3 | Error surface of a refused one-step directory rename (row 5: `EINVAL`) | **A** propagate the adapter's refusal unchanged (`UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EINVAL' }`, already documented in `docs/use/errors.md`). `PATH_TOO_LONG` keeps ADR-1194's relabel. **B** relabel to `MV_INTO_SELF { source: 'd', destination: 'D/d' }` when the reason is `EINVAL`. **C** a new `MV_RENAME_FAILED { source, destination, reason }` for every execution-time rename refusal (supersedes ADR-1194's relabel) | **A** | Same refusal and the same unchanged state as git. The errno class git prints is in `reason`, and no union member is added. This matches the existing "a rename refused for another reason rethrows that very error" contract (`mv.test.ts`). B names a refusal git does not make here (git's into-self check is case-exact `strncmp`) and keys on a free-text `reason`. Node also maps `EXDEV`/`EBUSY`/`EROFS` to `UNSUPPORTED_OPERATION`, so B must filter on `EINVAL` and is brittle. C rebuilds git's two-name message fully, but it adds a public union member for what ADR-1194 already declined for one errno |
| D4 | `skipErrors` (`-k`) when a directory's own rename fails (rows 5-k, 5-k′) | **A** keep refusing with nothing changed, plus an ADR recording a deliberate divergence: never replicate git's recursive deletion of the source. Ledger 32.72 gains the directory rows. **B** replicate git: skip the rename, repath the children's index entries, delete the source tree recursively. **C** skip the pair without damage: record it in `skipped` with a new `MvSkipReason`, nothing moved, index untouched for it (folds 32.72's file half too) | **A** | B copies a git defect that deletes untracked data. That is not a faithfulness target any ADR can justify to a user. C adds a public union member and reworks the execution loop to apply the index per executed pair. That is ledger 32.72's whole scope (file sources included) and outside the directory-move perimeter. A keeps the state safe and ships no API change for `-k`. Ledger 32.72 stays the place where `-k` skip semantics get decided |
| D5 | Row 6: case-only *file* rename refused `MV_DESTINATION_EXISTS` under `core.ignorecase=true` | **A** fold: git's `ignore_case && !strcasecmp(src, dst)` escape in `destinationFree`, with `ignoreCase` read once per call (§ 4). **B** out of perimeter: report it as IMPACT and leave filing to the user | **A** | It is the same command and the same case-only family pinned by this change, and git's condition is one line (`builtin/mv.c`'s `lstat(dst) == 0 && (!ignore_case \|\| strcasecmp(src, dst))`). The precedent helper exists (`stash.ts` + `asciiLower`), and it is a pinned refusal mismatch (git succeeds, tsgit refuses) on a well-formed repository, above ADR-1170's bar. B is right if the user holds the perimeter to `working-tree.ts`: `destinationFree` is a different function, not otherwise edited |
| D6 | Release marking | **A** `fix(mv)!:`. **B** `fix(mv):` (row 5's new refusal treated as a bug fix, since the old return destroyed data). **C** `feat(mv)!:` (the new port member counted as a feature) | **A** | ADR-1190 / D-3: a returning call that now throws is breaking whatever it did before. The port member is optional and additive (ADR-873 shipped under its PR's marking, not its own). B is defensible only if the user rules that a data-destroying return was never a contract |

Pre-decided by existing ADRs, not candidates: the `PATH_TOO_LONG` relabel to the repo-relative
destination (ADR-1194); refusing before writing the index (mv design + ADR-202); `-n` returning the
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
  - New: a `renameDirectory` refusing `unsupportedOperation('filesystem', 'EINVAL')` → `mv` rejects
    with that very error, the index is unchanged, and the source entries are still present (R3).
- Context: `failingRename` stubs only `rename`, and directory rows must stub `renameDirectory` too.
  `seedAndStage`, `indexEntry`, `exists`, `work`, `expectError` are the file's own helpers.

### P3 — case-only file rename (only if D5 = A)

- File: `src/application/commands/mv.ts`: `mv` reads `ignoreCase`; `buildPlan` → `validateMove` →
  `destinationFree` take a `DestinationPolicy { force, ignoreCase }` (replaces the `force: boolean`
  parameter). Import `readConfig` (`../primitives/config-read.js`) and `asciiLower`.
- Tests in `mv.test.ts` (memory adapter, which is case-sensitive, so the alias is simulated by an
  `lstat` stub that answers `F` with `f`'s stat). With `core.ignoreCase = true` `mv f F` moves; with
  `false` it refuses `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }`. A non-case-equal
  existing destination under `true` still refuses (isolated guard). Seed `core.ignorecase` through
  the config writer the stash tests use.

### P4 — cross-tool interop

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
  `Renaming X to Y` lines). 5-k: a **divergence row**; its title states that tsgit refuses and
  keeps every file where git deletes the source. It asserts tsgit's state, not git's (D4 = A).
- Rows 6, 6′ (D5 = A) — same host probe and `describe.each` over `core.ignorecase`; assert the
  `ls-files -s` parity and the refusal parity.

### P5 — docs

As § Design 7.

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
- `destinationFree` (D5): isolated rows for `ignoreCase` false + case-equal, true + case-equal, and
  true + case-different. Three rows kill both `&&` operands and the `asciiLower` call.
- Stryker scope: `working-tree.ts`, `wrap-fs-validator.ts` (new block), the two adapter one-liners
  and `mv.ts` hunks. Run on narrowed eponymous suites (`.claude/workflow/mutation.md`).

## Out of scope

- **Ledger 32.72** (`-k` skip semantics for execution-time rename refusals). D4 = A keeps it ledgered
  and adds the directory rows.
- **`status`/walk past `PATH_MAX`** (long-pathspec-refusals X2): it is why rows 1–3 compare
  `ls-files` and disk, not `status`.
- **Windows case-only directory rename**: unpinned (no host). The contract row for a destination
  inside the source runs there, and the one-step rename makes any refusal non-destructive.
- **The leaf path's descendant `PATH_TOO_LONG` naming an absolute path**: unreachable on the
  first-party adapters without the capability (browser: no `PATH_MAX`). It keeps ADR-1194's
  "names itself" consequence.
