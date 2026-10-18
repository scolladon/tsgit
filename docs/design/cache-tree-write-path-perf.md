# Design — cache-tree at O(change), loose-write robustness, checkout write path, literal `add`, status-family joins

> Brief: backlog **31.10** (all) + **31.11** (all), one PR. `commit` maintains the `TREE` extension at O(change)
> the way git's `cache_tree_update` does, writes it into the index, and stops rebuilding every directory tree on
> every commit (ADR-1007, ADR-1010). Before that update it refreshes entry stats as git's `prepare_index` does
> (ADR-1008). `unpack_trees`-class writers produce git's `TREE` bytes, which closes ADR-964's named divergence
> (ADR-1009). `rm` records `REUC` and runs during a pending operation (ADR-1012). Loose object writes drop the per-write fanout `mkdir`. Checkout writes a file in git's
> syscall shape (`mode` at create, post-write `fstat`, buffered small writes). Literal-path `add` stats each path
> once and stages through the pool. Status-family joins, the ignore matcher and `ancestorsOf` lose their
> avoidable allocations. Benches for each.
> Status: revised against ADR-1007…ADR-1017 (decisions settled, §Decisions) → self-reviewed

<!-- cspell:ignore fanout utime utimes lstat lstats fstat umask REUC UNTR ewah mkstemp oids oid ITA ita bytewise unpack_trees dirmask rawsz ino inode mtime mtimes mktree subtrees subtree's LIFO fsync lutimes rwxr IFGITLINK ISSPARSEDIR mainc stagedc -->

## Context

### Binding constraints

| Source | Constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Every rule below comes from the pinned matrix (§D1) or from git `v2.55.0` source read at the cited function. Where the backlog text disagrees with the pins (it claims `writeObject` deflates before probing; it does not), the pin wins. |
| ADR-249 (structured data only) | No new option steers rendering. The only new data is `FileSystem.write`'s `mode` option and its returned `FileStat`. |
| ADR-964 / ADR-1009 | Chain invalidation for in-place writers stays. Its named divergence (replace writers leave changed chains invalid where git recomputes) is closed here: ADR-1009 supersedes the divergence clause only (§D3). |
| ADR-1007 … ADR-1017 | The settled decisions of this design. §Decisions maps each to its section. |
| ADR-965 | `IndexLock.commit(entries, kind, options)` stays the single index write path. This design adds two options (`cacheTree`, and `verified` for the racy smudge, §D2.5) and changes what `'replace'` does to `TREE`. |
| ADR-966 | Index entries are bytewise-ordered. The cache-tree update scans contiguous regions of that order (§D2.2). |
| ADR-623 | `fsck` exit bit 8 = a cache-tree oid that fails to parse. Invariant kept: tsgit never writes a valid `TREE` node whose oid it did not compute, check for existence, or carry unchanged. |
| ADR-963 | Unknown optional extensions are still dropped on every write. |
| ADR-511 / 949 | Every index write goes through `makeLock().commit`, which smudges racily-clean entries. The new `commit` index write gets that too, with the refresh's unchanged set passed as `verified` (§D2.5). |
| ADR-171 | `OPERATION_IN_PROGRESS` is the pending-operation refusal. `add` already excepts merge/cherry-pick/revert/rebase. §D5 gives `rm` the same exceptions. |
| Port contract `src/ports/file-system.ts` `writeExclusive` | "The adapter MUST ensure parent directories exist ... retries once ... a second ENOENT propagates as FILE_NOT_FOUND." All three adapters honour it today (§D4.1). |

All git pins ran in `mktemp -d` throwaways (scrubbed `GIT_*`, isolated `HOME`, signing off, git 2.55.0), never in
this worktree. Each recipe is in §Pin recipes. Each ran 2× with identical results. The orchestrator re-runs each 3×.

### What exists today (verified in the tree, branch base `c648b61f`)

| Asset | File : symbol | Status |
|---|---|---|
| Commit tree build | `src/application/commands/commit.ts` — `buildTreeFromIndex(ctx, entries)`, `insertEntry(node, parts, entry)`, `writeSubtree(ctx, node)`, `componentsOf`, `componentKey`, `SubtreeNode` (L387-467). One `boundedMapFor(ctx, 'ioBound', …)` per recursion level; `[head, ...rest]` per path segment; a `Map` pair per directory | **Replaced** (§D2). |
| Commit flow | `commit.ts` `commit(ctx, opts)` (L102-185): pre-commit hook → `readIndex` → `rejectUnmergedIndex` → `buildTreeFromIndex` → parent-tree equality → message hooks → `createCommit` → ref update. **The index is never written.** No intent-to-add handling | **Changed** (§D2.4). |
| Second tree builder | `src/application/primitives/synthesize-tree-from-index.ts` — `synthesizeTreeFromIndex(ctx, entries)` (explicit-stack trie frames, depth cap, path re-validation) | Reused by stash/rebase/checkout. Gains the cache-tree path only on the routes of §D3.4. |
| Loose writer | `src/application/primitives/write-object.ts` — `writeObject` → `serializeChecked` → `freshenObject` **(probe first, already)** → `storeLoose`, which `ctx.fs.mkdir(objectsDir(…, id.slice(0, 2)))` on **every** write, then `writeExclusive` | **Changed** (§D4.1). |
| Freshen | `src/application/primitives/internal/freshen-object.ts` — `freshenObject(ctx, id)` (`utimeNow` on a hit), `touchLooseCopy` | Unchanged. The cache-tree skip path does not call it (§D2.3). |
| Existence | `src/application/primitives/has-object.ts` — `hasObject(ctx, id, { mode: 'quick' \| 'recheck' })` (`'recheck'` = git's `ODB_HAS_OBJECT_RECHECK_PACKED`) | Reused by the cache-tree validity check. |
| `TREE` codec | `src/domain/git-index/cache-tree.ts` — `serializeCacheTree(root, digestLength)`, `invalidateCacheTree(root, paths)`, `namesEachSubtreeOnce`; parser `index-parser.ts` `parseCacheTree(data, digestLength)`; model `index-entry.ts` `CacheTreeEntry { path, nameBytes?, entryCount, subtreeCount, id?, children }` | Reused. New sibling module (§D2.2). |
| Carry policy | `src/domain/git-index/carry-extensions.ts` — `carryExtensions(previous, change, kind, settings)`, `withResolveUndo`, `withRestagedPaths`; `diff-index-entries.ts` `diffIndexEntries` | `TREE` for `'replace'` moves out of the pure carry into the lock (§D3.2). |
| Stat refresh | `src/application/primitives/compare-working-tree-entry.ts` — `compareAndRefresh(ctx, entry, scope)` (L256: one `lstat`, `statOnlyVerdict`, content compare only when the stat is not conclusive or the entry is racy; `refreshed = withStatData(entry, stat)` iff `unchanged` and `shouldRefresh`), `shouldRefresh` (L247: stage 0, not assume-valid / skip-worktree / ITA, content stat differs); `internal/index-entry-from-stat.ts` `withStatData` (L18) | Reused by `commit` (§D2.5). |
| Status tracked scan | `src/application/commands/status.ts` — `TrackedScan` (L250), `updateIndexIfAble` (L257: writes when `refreshed.length > 0` **or** `hasRacyTimestamp`), `scanTrackedTree` (L274), `scanEntry` (L324: skips skip-worktree), `ScannedEntry` (L340), `scanWorkingTree` (L346: `boundedMapFor(ctx, 'ioBound', …)`, `inIndexOrder` when a filter driver is configured), `trackedScanOf` (L370); `status` runs inside `withFilterProcessPool` (L155) | Scan **extracted** into a primitive shared with `commit` (§D2.5). Status's write trigger unchanged. |
| Racy smudge | `src/application/primitives/internal/smudge-racily-clean.ts` — `smudgeRacilyClean(ctx, entries, previous, verified = NOTHING_VERIFIED)` (L120), `IsVerified`; `index-lock.ts` `withRefreshedStat` (L229, private), `commitRefresh` | Reused. `commitLocked` gains a `verified` passthrough; `withRefreshedStat` is exported (§D2.5). |
| Index lock | `src/application/primitives/internal/index-lock.ts` — `IndexLock.commit(entries, kind, options?)`, `CommitOptions { restagedPaths?, resolveUndo? }`, `carriedByRule`, `carriedExtensions` (returns `[]` without a previous index), `commitLocked`, `stageLock` | **Changed** (§D2.4, §D3.2). |
| `REUC` record | `src/domain/git-index/resolve-undo.ts` `resolveUndoRecordOf(stages)` (L191); used by `add.ts` `resolvedRecords` (L1187) → `CommitOptions.resolveUndo` | Reused by `rm` (§D5). |
| `rm` | `src/application/commands/rm.ts` `rm(ctx, paths, opts)`: `assertNoPendingOperation(ctx)` with **no** exceptions; `byPath: Map<IndexPathKey, IndexEntry>` keyed by path only (the stages of one path collapse to the last); `lock.commit(…, 'update')` | **Changed** (§D5). |
| Working-tree writes | `src/application/primitives/internal/write-working-tree-file.ts` — `writeRegularFile` (`rmIfExists` → `fs.write` → `fs.chmod(0o644\|0o755)`), `writeStreamedBlob` → `writeServedBlob` (`fs.writeStream` + `chmod`), `createEmptyOutput`; `internal/write-converted-entry.ts` `createWorkingTreeWriter` | **Changed** (§D6). |
| Post-write stat | `src/application/primitives/apply-changeset.ts` `buildIndexEntry(ctx, absPath, relPath, id, mode)` (L368, an `lstat`); `applyWriteEntry` (L414) | **Changed** (§D6). |
| Node write | `src/adapters/node/node-file-system.ts` — `write` (L1196: `resolveWrite` → `assertWritableLeaf` → `mkdir -p` → `writeFile`), `writeStream` (`pipeline` + `createWriteStream`), `writeExclusive` → `createExclusive` (open first, `mkdir` only on ENOENT, one retry) | **Changed** (§D6). |
| Memory / browser write | `src/adapters/memory/memory-file-system.ts` `write` (L130), `writeExclusive` (L155, `ensureParentDirs`); `src/adapters/browser/browser-file-system.ts` `write` (L72), `writeExclusive` (L81, `walkToParent(…, true)`) | **Changed** (port shape, §D6). |
| Literal `add` | `src/application/commands/add.ts` — `addLiteralOnly` (L232), `stageLiterals` (L308, sequential `for … await stageOne`), `allLiteralsAreFiles` (L521, lstat #1), `stageOne` (L1224, lstat #2), `stageFromStat` → `freshStatOfSameKind` (L1289, lstat #3); pool template `dispatchInCleanOrder` / `stageWalkedEntries` | **Changed** (§D7). |
| Joins | `src/application/primitives/compute-changeset.ts` `computeChangeset` (`projectIndex`/`projectTarget` Maps, `[...allKeys].sort()` = UTF-16 order); `src/domain/diff/index-diff.ts` `diffIndexAgainstTreeBy` (`stage0IndexMap`, `unionPaths`); `src/application/commands/status.ts` `trackedEntriesOf`, `collectStagedKinds`, `buildChanges` | **Changed** (§D8). |
| Ignore | `src/domain/ignore/match.ts` `lastMatch` (forward scan, one object per matching rule); `src/domain/ignore/matcher-stack.ts` `matchInStackVerbose` (forward over levels, object per hit); `ancestorsOf` in `src/application/primitives/internal/ignore-evaluator.ts` (L81) and `src/application/primitives/is-ignored.ts` (L44): `segments.slice(0, i).join('/')` per depth = O(depth²) | **Changed** (§D9). |
| Benches | `test/bench/commit.bench.ts` (one staged file, scratch per iteration), `checkout.bench.ts` (tier tip↔root alternation, all-add/all-delete only — its header records the missing mixed fixture), `add.bench.ts`; `support/write-scratch.ts`, `support/fixture-scratch.ts` `copyFixtureToScratch`, `support/bench-dsl.ts` (no per-iteration hooks; vitest bench hooks do not run) | **Extended** (§D10). |

### Evidence (pre-change profile, 2026-10-18 10:37–10:45 Paris)

Harness: a plain `.mjs` driver over a names-preserved profile build, with the inspector profiler scoped to the
measured loop only. Fixture: 500 directories × `dNNN/sub/f{0..3}.txt` = 2000 files and 1001 trees, built by git 2.55
with `maintenance.auto=false`, `gc.auto=0`. Load average 2.6–5.5, no foreign stryker/vitest.

| Scenario (ms / iteration, 3 runs) | tsgit | git 2.55 (incl. process spawn) |
|---|---|---|
| literal add 1 file + commit | 22.3 / 22.6 / 23.1 | 27.3 / 27.5 / 27.5 (2 spawns) |
| checkout -f tip↔base (500 files differ) | 110 / 112 / 130 | 66 / 68 / 69 |
| literal add 200 paths (incl. 200 file writes) | 58 / 58 / 70 | not comparable (the shell write loop dominates) |
| status, clean, 2000 files | 52.3 / 52.8 / 52.8 | 27 / 28 / 35 |

Hot frames (inclusive share of loop samples):

- **commit**: `utimeNow` 17.3% (freshen touches each of the ~1000 **unchanged** trees on every commit; `lutimes` +
  `realpathForCreation`/`resolveWrite` 6.4%), `writeSubtree` 16.4%, `writeObject` 12.3%, `serializeAndHash` 11.6%,
  `serializeTreeContent` 7.3%, `encode` 6.5%, `freshenLoose` 7.9%, `probeLooseOid` 2.3%, `carryExtensions`/`carryTree`
  4.2% (add's index write), `boundedMap` 3.5%. ⇒ at least 35% of commit is O(all trees) work that a valid `TREE` skips.
- **checkout**: `readLooseCompressed`/`openAndAttemptSyncRead` 15%, `lstat` 9.2%, `writeStreamedBlob` 5.6%
  (`pipeline` + `WriteStream`), `rm`/`rmIfExists` 3%, `unlinkSymlinkedLeadingComponent` 2.6%, `realpathForCreation`
  2.4%, `createInflateStream` 2.4%. (14.4% `spawn` is the harness's own git call.) The 31.4 measurement: 95.3 µs/file
  for tsgit vs 71.3 for git, 8 syscalls vs 4.
- **literal add (200)**: `writeCleanedBlob` 7.1%, `storeLoose` 6.9% (deflate 4.8%), `lstat` 5.7% (`lstatOrMissing`
  2.5%, `symlinkedLeadingComponent` 1.8%), `carryTree` 2.7%, `stageLiterals` 2.4%, `stageOne` 1.8%.
- **status (clean)**: idle 59.5% (I/O wait), `lstat` 13.1%, `walkWorkingTree` 9.7%, gitignore load 5.1%,
  `scanUntracked` 3%, `ancestorsOf` 0.9%, `diffIndexAgainstTreeKeyed` 0.6%. The join/matcher targets of §D8–§D9 are
  each **under 1%** here. Their benefit is unproven (marked per part).

Probes (orchestrator, 3/3 stable):

1. git 2.55 `commit` writes a fully valid `TREE`. tsgit `commit` writes **no** `TREE` (the index is not rewritten).
2. `writeObject` already freshens before deflating. The backlog text is stale there. What remains: the per-write
   fanout `mkdir`, and freshen `utime`s on every hit.
3. With git's detached auto-maintenance pruning in the background, tsgit `commit` dies at iteration 13–15 with
   `FILE_NOT_FOUND` on `mkdir .git/objects/<xx>` (3/3). git's loose writer opens the tmpfile first and, on ENOENT,
   `mkdir`s the fanout and retries once (`object-file.c` `create_tmpfile`).

### Pinning harness

```sh
# env.zsh: source it; scrubbed git 2.55 in a fresh mktemp repo
export PATH=${GIT255:?set GIT255=<git-2.55.0>/bin}:/usr/bin:/bin
unset ${(k)parameters[(I)GIT_*]}
export GIT_CONFIG_NOSYSTEM=1 HOME=$(mktemp -d) GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@x \
       GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@x \
       GIT_AUTHOR_DATE='1700000000 +0000' GIT_COMMITTER_DATE='1700000000 +0000'
g() { git -c commit.gpgsign=false -c init.defaultBranch=main -c maintenance.auto=false -c gc.auto=0 \
          -c merge.conflictStyle=merge "$@"; }
idx() { python3 -I $PINS/idx.py .git/index; }   # "v<ver> n=<entries> ino=<inode> exts=SIG[len],… TREE: <decoded>"
settle() { sleep 1.1; g status >/dev/null; sleep 1.1; }
w() { mkdir -p ${1:h}; print -r -- "$2" > $1; }
REPO=$(mktemp -d); cd $REPO; g init -q
```

`idx.py` walks the v2/v3 entry table, then the extensions, and decodes `TREE` as
`<path>:<entry_count>/<subtrees>[:<oid7>]` in serialisation order (`<root>` for the empty name). Source in §Pin
recipes. "Rewritten" = `.git/index` got a new inode (lock-file rename). git source references are to `v2.55.0`.

## Requirements

- **R1** After a successful `commit`, the index carries a `TREE` byte-identical to the one `git commit` writes for
  the same index (§D1.1), and the commit's tree oid is unchanged except where R10 corrects it.
- **R2** `commit` refreshes entry stats the way git's `refresh_cache` does, then rewrites the index exactly when git
  does (§D1.2, ADR-1008): iff a stat was refreshed or the `TREE` read is not fully valid. A racy timestamp alone does
  not trigger the write (CW5), unlike `status`. It writes **before** the pre-commit hook and the
  nothing-to-commit/empty-message refusals, so a refused commit still leaves the updated `TREE`. An unmerged index
  refuses before any refresh or write.
- **R3** `commit` does O(change) tree work: a `TREE` node that is valid and whose object exists is reused without
  serialising, hashing, writing or freshening it (git `update_one`).
- **R4** Every `'replace'` index write (checkout of a branch, `reset --hard`, merge family, stash, pull, clone,
  worktree add) produces git's `TREE` bytes (§D1.3–§D1.4): carried nodes invalidated along changed paths, then
  repaired by hashing (valid iff the object exists), then the writer's in-place re-staged paths invalidated.
- **R5** In-place writers (`'update'`) are unchanged (ADR-964, carried forward by ADR-1009).
- **R6** `rm` of an unmerged path records its stages in `REUC` (git `remove_index_entry_at` → `record_resolve_undo`),
  and `rm` runs during a pending merge/cherry-pick/revert/rebase like git does (§D1.5).
- **R7** `writeObject` never `mkdir`s the fanout directory before a write. A fanout directory removed concurrently
  is recreated once by the adapter's `writeExclusive` retry (§D4.1).
- **R8** Checkout creates a regular file with git's creation mode (`0666`/`0777`, the process umask applied by the
  platform), writes it, and builds the index entry from the post-write `fstat` (§D1.6, §D6).
- **R9** Literal-path `add` stats each path once and stages through the bounded pool, in index order (§D7).
- **R10** `commit` excludes intent-to-add entries from the tree and marks their directory chain invalid, as git does
  (§D1.1 rows C7/I1). Today tsgit commits them (proven, §D1.1 T2). User-ratified fold, ADR-1007.
- **R11** Joins and the ignore matcher return identical results with fewer allocations (§D8–§D9).
- **R12** Benches show each targeted path (§D10).
- **R13** SHA-256 repositories: every `TREE` oid uses `ctx.hashConfig.digestLength`.

## Design

### D1. Pinned behaviour (git 2.55.0)

Notation: `TREE: <root>:6/5:15803ea a:1/1:33eb7e4 x:1/0:fd43cc8 …` in serialisation order. `-1/N` = invalid
(no oid). `ino` changes ⇔ rewritten.

#### D1.1 What `commit` writes into `TREE` (pin-commit.zsh, pin-ita.zsh, pin-tsgit-ita.mjs)

Fixture `a/x/f b/f c/f top bb/f zzz/f`.

| Row | Step | git result |
|---|---|---|
| C1 | `add -A` | no `TREE` (a fresh index) |
| C1 | `commit` | `<root>:6/5:15803ea a:1/1:33eb7e4 x:1/0:fd43cc8 b:1/0:5956ee4 c:1/0:5b372f8 bb:1/0:7109f23 zzz:1/0:ed7fd3d` |
| C3 | `add b/f` (changed) | `<root>:-1/5 a:valid x:valid b:-1/0 c bb zzz valid` |
| C3 | `commit` | fully valid, new root + `b` oids, the others' bytes unchanged |
| C7 | `add -N a/x/n` | **v3**, `<root>:-1/5 a:-1/1 x:-1/0 b c bb zzz valid` |
| C7 | `commit` (only the ITA differs → "nothing to commit") | rewritten, same chain invalid |
| I1 | staged `b` + ITA `a/n`, `commit` | tree = `a/f, b` (ITA **excluded**); `TREE: <root>:-1/1 a:-1/0` |
| T2 | same as I1, **tsgit** `commit` | tree = `a/f, a/n, b`: tsgit commits the ITA entry (empty-blob oid). **Defect** |
| C8 | pre-commit hook runs `git add c/f`; `commit` | final index = the hook's write: `<root>:-1/5 … b:1/0:5910a61 c:-1/0 …`; the commit tree has the hook's `c` |
| C9 | `rm -r zzz` + `commit` | `<root>:5/4:…` — the removed subtree is gone |

Readings (cross-checked with `cache-tree.c` `update_one`, `write_one`, `subtree_name_cmp`):

- **Subtree order is (name length, then bytes)**, not tree order: `a, b, c, bb, zzz`. `write_one` dies on any other
  order ("unsorted cache subtree").
- `entry_count` = the number of index entries the directory covers, recursively (CE_REMOVE excluded; tsgit has none).
- A valid node is reused iff `odb_has_object(oid)` (RECHECK_PACKED), **without freshening**. Only an invalid node is
  rebuilt and written through `odb_write_object` (which freshens on a hit).
- An ITA entry is left out of its tree and sets `to_invalidate`. Its directory and every ancestor (via
  `contains_ita`) get `-1`, but their tree objects are still written. In write mode the root oid feeds the commit.
  A subtree whose entries are all ITA hashes to the empty tree and is dropped from its parent.

#### D1.2 When `commit` rewrites the index (pin-commit-write.zsh, pin-commit.zsh)

`builtin/commit.c` `prepare_index` (plain commit, no pathspec): hold the lock → `refresh_cache` → if
`cache_changed || !cache_tree_fully_valid` then `cache_tree_update(WRITE_TREE_SILENT)` → `write_locked_index(COMMIT_LOCK
| SKIP_IF_UNCHANGED)` → `COMMIT_AS_IS`. This runs **before** `prepare_to_commit` (pre-commit hook, emptiness check,
message). After the hook, git re-reads the index file and runs `cache_tree_update(0)` in memory only. Nothing is
written again.

| Row | Before | Step | Rewritten? | TREE after |
|---|---|---|---|---|
| CW1 | fully valid, settled | `commit --allow-empty` | **no** | same |
| CW2 | fully valid, `touch b/f` (stat moved) | `commit --allow-empty` | **yes** (refresh) | same bytes; `b/f` stat refreshed |
| CW3 | fully valid | `commit` → nothing to commit, exit 1 | no | same |
| C4 | `<root>:-1 b:-1` (stat-only re-add) | `commit` → nothing to commit, exit 1 | **yes** | fully valid |
| C5 | `c` changed + added | `commit -m ''` → empty message, exit 1 | **yes** | fully valid incl. new `c` |
| CW4 | unmerged entries | `commit` → refused ("Committing is not possible because you have unmerged files") | no | unchanged |
| C8 | `b` invalid; hook stages `c` | `commit` | the pre-hook write (b valid), then the hook's own write (c invalid). No third write | as C8 |

tsgit has no commit-time stat refresh today (CW2). ADR-1008 ports it (§D2.5). The rows below pin how git's refresh
meets racy entries (pin-commit-refresh.zsh, pin-commit-smudge.zsh; 2× each, identical, 2026-10-18 ~11:25 Paris).

| Row | Before | Step | Rewritten? | Reading |
|---|---|---|---|---|
| CW5 | fully valid, `.git/index` mtime backdated (every entry racy), no stat moved | `commit --allow-empty` | **no** | refresh content-checks racy entries, finds them unchanged, marks them up to date; `SKIP_IF_UNCHANGED` has no racy term |
| CW5c | same | `status` | **yes** | `repo_update_index_if_able` writes on `has_racy_timestamp`: status's trigger, not commit's |
| CW6 | fully valid, `b/f` content changed, not staged | `commit --allow-empty` | **no** | a modified entry is not refreshed (quiet) and changes nothing |
| CW7 | fully valid, index backdated, `touch b/f` | `commit --allow-empty` | **yes** | `b/f` refreshed (`size` intact); the racy unchanged `a/f` is up to date, so not smudged |
| CW8 | `core.trustctime=false`; `b/f` racy, same size/mtime/inode, new content; `touch a/f` | `commit --allow-empty` | **yes** | `a/f` refreshed; `b/f` not up to date and racy → smudged, `size: 0` (`do_write_index`, ADR-949) |

The pin `pin-continue-refresh.zsh` (2×, identical) shows `cherry-pick --continue` and `rebase --continue` refresh a
touched clean file's stat too (`a/f` index mtime moves to the file's). tsgit's continue routes do not refresh:
`compareAndRefresh`'s `refreshed` is consumed only by `status.ts`, the sole caller of `commitRefresh` (grep). See DC-10.

#### D1.3 `unpack_trees`-class writers (pin-unpack.zsh)

Start of every row: root and `c` invalidated (`touch c/f; add c/f`); `TREE: <root>:-1/3 a:1/1:021ca62 x:1/0:d66240d
b:1/0:5956ee4 c:-1/0`. `other` changes `b/f` and adds `z/f`.

| Row | Writer | TREE after |
|---|---|---|
| U1 | `checkout other` | fully valid `<root>:5/4:26e9e24 … z:1/0:8ab6bf5` |
| U2 | `checkout -b same` (same tree) | **fully valid** (`c` repaired) |
| U3 | `reset --hard` (same HEAD) | fully valid |
| U4 | `reset --hard HEAD~1` | fully valid, new oids |
| U5 | `reset` (mixed, same HEAD) | **unchanged** (root, `c` stay invalid) |
| U6 | `reset HEAD~1` (mixed) | chain of the changed path invalid: `<root>:-1 a:-1 x:-1`, `c` still `-1` |
| U6k | `reset --keep HEAD~1` | fully valid |
| U7 | `merge other` (clean, non-ff) | fully valid |
| U8 | `merge --ff-only` | fully valid |
| U9 | `merge` (conflict on `b/f`) | `<root>:-1/4 a valid b:-1/0 c valid z valid` |
| U10 / U11 / U12 | `cherry-pick` / `revert` / `rebase` (clean) | fully valid |
| U13 | `stash push` | fully valid |
| U15 | `stash pop --index` (staged `b/f`) | fully valid, `b:1/0:bb7fee7` |
| U16 | `stash apply` (staged `b/f`, no `--index`) | `<root>:-1 b:-1/0`, `c` **repaired valid** |
| U17 | `checkout other -- z/f` | chain only (in-place) |
| U18 | `checkout -- c/f` | unchanged |
| U19 / U20 | `clone` / `worktree add` | fully valid |

Readings (`unpack-trees.c` `unpack_trees` tail; `builtin/reset.c` `reset_index`):

- `unpack_trees` moves the source `TREE` into the result, invalidates the path of every entry it changes
  (`cache_tree_invalidate_path`), and, unless `skip_cache_tree_update`, runs `cache_tree_update(WRITE_TREE_SILENT |
  WRITE_TREE_REPAIR)`. **REPAIR** hashes each invalid node's tree without writing it. The node is valid iff that
  object already exists, else `-1`.
- `reset --hard` skips the update and calls `prime_cache_tree` from the target tree. The bytes are the same as REPAIR's
  over an index equal to that tree (every subtree oid exists, counts agree).
- Mixed `reset` is an in-place writer for `TREE` (U5, U6), despite `reset_index`'s `prime_cache_tree` call for MIXED.
  The pin wins, and it matches tsgit's existing `'update'` classification.

#### D1.4 REPAIR edge rows (pin-repair.zsh, pin-merge-mixed.zsh, pin-sequencer.zsh)

| Row | Case | TREE after | Reading |
|---|---|---|---|
| R1 | `checkout other` carrying a staged `c/f` | `<root>:-1/4 … c:-1/0 z valid` | `c`'s hashed tree does not exist → `-1`; so does root. **Priming from the target tree would be wrong.** |
| S1 | `stash apply` of a worktree-only change of `c/f` | `<root>:-1 c:-1` | merge repairs `c` (the stash's W tree holds it), then the un-staging step invalidates `c` |
| S2 | `stash apply`, stash had a staged **new** `n/f` | fully valid, root valid | root = the stash's I tree, which exists |
| S3 | `stash apply --index` (new `n/f` + staged `c/f`) | fully valid | |
| S4 | `stash apply` onto a dirty `b/f` | `<root>:-1 c:-1`, `b` valid | |
| U21 | conflicted `b/f` + cleanly merged `d/` | `<root>:-1/2 b:-1/0 d:2/0:b8e6607` | merge-ort wrote the merged `d` tree, so REPAIR finds it |
| Q1 | `cherry-pick` conflict, resolve, `add`, `--continue` | fully valid, `REUC` kept | the sequencer commit goes through `cache_tree_update` + index write |
| Q2 | `rebase` conflict, resolve, `add`, `--continue` | fully valid, `REUC` kept | same |
| Q3 | `stash push --keep-index` (staged `b/f`, stat-only re-add of `a/f`) | `<root>:-1/3 a valid b:-1/0 c valid` | reset to HEAD (primed), then index paths restored in place → chain of `b` |

One rule covers every row of §D1.3–§D1.4:

```
TREE_after = invalidate( repair( invalidate(TREE_before, changedPaths), entries ), restagedPaths )
```

`repair` treats a directory holding an unmerged or ITA entry as invalid (with its ancestors). `restagedPaths` are the
paths a writer re-stages in place after its unpack: the un-staged paths of `stash apply` (S1/S4/U16) and the
`iTree ≠ bTree` paths of `--keep-index` (Q3). Without a previous `TREE` (clone, worktree add, an index from an older
tsgit), `repair` runs over all directories (U19/U20).

#### D1.5 `REUC` on `rm`, and `UNTR` (pin-reuc-untr.zsh, pin-tsgit-rm.mjs)

| Row | Step | Result |
|---|---|---|
| E2 | conflicted `a/f`, `git rm a/f` | `REUC[85]`: `a/f` stages 1/2/3 recorded; `TREE` chain stays invalid |
| E3 | conflicted `a/f`, `git rm --cached a/f` | same `REUC` |
| E4 | conflicted `a/f`, `git add a/f` | same `REUC` (tsgit already does this, #319) |
| E5 | `commit` after the add-resolve | `TREE` fully valid, **`REUC` kept** |
| E6 | `reset --hard` | `REUC` dropped |
| T3 | **tsgit** `rm a/f` during the merge | refused `OPERATION_IN_PROGRESS`; stages untouched, no `REUC` |
| U0 | `core.untrackedCache` unset, `status` | no `UNTR` created |
| U1 / U2 | `core.untrackedCache=true`, `status` ×2 | `UNTR[468]` created; second status writes nothing |
| U3 / U4 | `add b/f` (tracked set unchanged) / `commit` | `UNTR` same length, kept |
| U5 | `add u/t2` (tracked set grows) | `UNTR[381]`: **updated** in place (directory `u` invalidated) |
| U6 / U7 | `commit` / `checkout HEAD~1` | `UNTR` kept |
| U8 | `core.untrackedCache=false`, `status` | `UNTR` dropped |

tsgit today: `UNTR` is forwarded iff the tracked set did not change, else dropped (`carryUntracked`). U5 is where they
differ: git updates, tsgit drops. With the config `true`, the next git `status` rebuilds it (U1). With the config unset,
an `UNTR` created by `git update-index --untracked-cache` stays lost. ADR-1014 keeps the rule and names the
divergence.

#### D1.6 Checkout file creation (pin-umask.zsh, pin-tsgit-umask.mjs; `entry.c`)

`write_entry` → `open_output_fd` → `create_file`: `open(path, O_WRONLY|O_CREAT|O_EXCL, (mode & 0100) ? 0777 : 0666)`.
The content goes to the fd (streamed, `odb_stream_blob_to_fd`), then `fstat_checkout_output` (`fstat` on the fd when
`state->refresh_cache` and no base dir), then `close`. Before that, `checkout_entry_ca` `lstat`s the path and unlinks an
occupant. There is no `chmod`.

| Row | umask | git `f` / `x` | tsgit `f` / `x` |
|---|---|---|---|
| M1 / T1 | 027 | `-rw-r-----` / `-rwxr-x---` | `644` / `755` (explicit `chmod`) — **divergence** |
| M2 | 077 | `-rw-------` / `-rwx------` | (not run; same mechanism) |

Creating with git's mode and dropping the `chmod` is both the syscall fix and the faithfulness fix (user-ratified fold,
ADR-1013).

### D2. `commit` maintains `TREE` (31.10 core)

#### D2.1 Shape

```
lock → read index → reject unmerged → refresh stats (§D2.5) → carried = parse(TREE)
  ├─ nothing refreshed ∧ fullyValid(carried) → release lock (no write)         [CW1, CW3, CW5, CW6]
  ├─ refreshed ∧ fullyValid(carried)         → lock.commit(refreshedEntries, 'update',
  │                                              { cacheTree: carried, verified })  [CW2, CW7, CW8]
  └─ ¬fullyValid(carried)                    → update(write) → lock.commit(refreshedEntries, 'update',
                                                 { cacheTree, verified })            [C1, C3, C4, C5, C7]
pre-commit hook
  ├─ hook ran → re-read index → update(write) in memory (no index write)  [C8]
  └─ no hook  → tree = the root oid from the pass above
parent-tree equality / message hooks / createCommit / ref update          (unchanged)
```

The lock is released before the hook (git commits it: `COMMIT_LOCK`). The hook's own `git add` must be able to take it.
A fully valid `TREE` needs no update pass when only stats moved: git's `cache_tree_update` over a fully valid tree
reuses every node, so the bytes are the carried ones (CW2).

#### D2.2 Domain core — `src/domain/git-index/cache-tree-update.ts` (new)

A pure planner over **bytewise-sorted** entries (ADR-966). It transcribes `update_one`'s region scan without a trie: a
directory's entries are one contiguous run of the index, found by prefix comparison on the path bytes. There are no
`Map`s, no `[head, ...rest]`, and no per-segment string splits beyond one `indexOf('/')` per entry per level.

```ts
/** git's subtree_name_cmp: shorter name first, then bytes. */
export const compareSubtreeNames = (a: Uint8Array, b: Uint8Array): number;

/** A directory whose tree must be (re)built; children before parents (post-order). */
export interface TreeBuild {
  readonly node: number;                       // index into plan.nodes
  readonly files: ReadonlyArray<IndexEntry>;   // stage-0, non-ITA leaves of this directory
  readonly subtrees: ReadonlyArray<number>;    // child node indices, in tree-entry order
}
export interface CacheTreePlan {
  readonly nodes: ReadonlyArray<PlannedNode>;  // nodes[0] = root
  readonly builds: ReadonlyArray<TreeBuild>;   // post-order; empty when every reused node is valid
}
export interface PlannedNode {
  readonly nameBytes: Uint8Array;
  readonly entryCount: number;                 // entries covered (git's i - skip_count)
  readonly reused?: ObjectId;                  // carried valid oid, existence still to be checked
  readonly invalid: boolean;                   // holds ITA / unmerged (to_invalidate / contains_ita)
  readonly children: ReadonlyArray<number>;    // ordered by compareSubtreeNames
}
export const planCacheTree = (entries: ReadonlyArray<IndexEntry>, carried: CacheTreeEntry | undefined): CacheTreePlan;
export const toCacheTreeEntry = (plan: CacheTreePlan, ids: ReadonlyArray<ObjectId | undefined>): CacheTreeEntry;
```

- Reuse of a carried node needs `entryCount >= 0` and `id`. Its existence is checked in §D2.3, and the node becomes a
  build when the object is missing (git: `odb_has_object` false → rebuild).
- A subtree present in the carried tree but absent from the entries is discarded (`discard_unused_subtrees`). A new
  directory gets a fresh node at its `compareSubtreeNames` position (`find_subtree(…, create=1)`).
- `toCacheTreeEntry` emits `-1` and no `id` for `invalid` nodes. Root ordering and counts follow §D1.1.
- Entries not in index order (an index written by tsgit before ADR-966): the caller sorts a copy with
  `pathComparatorFor` first. A linear `isIndexOrdered` check avoids the sort in the normal case.

#### D2.3 Application driver — `src/application/primitives/internal/update-cache-tree.ts` (new)

```ts
export type TreeSink = 'write' | 'repair';
export interface CacheTreeResult {
  readonly cacheTree: CacheTreeEntry;
  /** Root tree oid. Defined in 'write' mode even when the root is invalid (ITA), as git's it->oid is. */
  readonly rootTree: ObjectId | undefined;
}
export const updateCacheTree = (
  ctx: Context, entries: ReadonlyArray<IndexEntry>, carried: CacheTreeEntry | undefined, sink: TreeSink,
): Promise<CacheTreeResult>;
export const isCacheTreeFullyValid = (ctx: Context, root: CacheTreeEntry | undefined): Promise<boolean>;
```

- Reused node: `hasObject(ctx, id, { mode: 'recheck' })`. **No freshen, no `utime`** (git: `odb_has_object`). ADR-1010.
- Build in `'write'` mode: `writeTree(ctx, treeEntries)` → `writeObject` (probe/freshen/write, unchanged). In
  `'repair'` mode: `serializeAndHash` only, then `hasObject(…, 'recheck')`. Missing → the node and its ancestors become
  `-1`.
- Parallelism: the builds of one depth are independent. **One** `limiterFor(ctx, 'ioBound')` instance per call wraps
  only the leaf `writeTree`/hash calls, never a recursion step. A parent never holds a slot while awaiting its children,
  so a bounded limiter cannot deadlock. This replaces the per-level `boundedMapFor` minting.
- `isCacheTreeFullyValid` mirrors `cache_tree_fully_valid`: every node `entryCount >= 0` and its object exists.
- Unmerged entries: `planCacheTree` marks their directories invalid. `commit` never reaches that case (it refuses
  first). Replace writers rely on it (U9, U21).

#### D2.4 `commit.ts` changes

- Delete `buildTreeFromIndex`, `insertEntry`, `writeSubtree`, `componentsOf`, `componentKey`, `SubtreeNode`,
  `TreeName`, and the `boundedMapFor` import.
- New `prepareIndexTree(ctx): Promise<ObjectId | undefined>` (≤20 lines; split the branch of §D2.1 into a helper):
  acquire the lock, `readIndex` (under the lock, so `indexMtime` is the racy reference of ADR-949),
  `rejectUnmergedIndex`, the stat refresh of §D2.5 (P4b), parse the carried `TREE` (a parse failure counts as no
  `TREE`, as `carryTree` does), then the branch of §D2.1, with `finally lock.release()`. It returns the root oid when
  no hook can change the index. P4 lands it without the refresh (write iff not fully valid); P4b inserts the refresh
  and widens the trigger.
- Move `runPreCommitHook` after `prepareIndexTree` (git order, C8). If the hook ran, re-read the index and call
  `updateCacheTree(…, 'write')` in memory for the tree oid. Whether a hook ran: extend `runPreCommitHook` to return a
  boolean (invoked or not), from the hook runner's "no hook file" outcome. Check its current signature in
  `src/application/primitives/internal/hooks*.ts` during the part.
- `IndexLock.commit` gains `CommitOptions.cacheTree?: CacheTreeEntry`. When present it replaces the carried `TREE`
  (serialised at `digestLength`). `REUC`/`UNTR` follow the normal `'update'` carry. The entries are unchanged, so both
  survive (E5, U4).
- Refusal order kept: config/pending/hook-config refusals that precede `prepare_index` in git stay before the lock.
  The empty-message and nothing-to-commit refusals now come **after** the index write (C4, C5).

#### D2.5 `commit` refreshes entry stats (ADR-1008)

git (`builtin/commit.c` `prepare_index` → `refresh_cache(REFRESH_QUIET)` → `read-cache.c` `refresh_index` →
`refresh_cache_ent`), per entry, against tsgit's `compareAndRefresh` + `shouldRefresh` + status's `scanEntry`:

| Entry | git | tsgit (shared scan) | Same outcome |
|---|---|---|---|
| unmerged | not reached: commit refuses first (CW4) | `rejectUnmergedIndex` precedes the refresh | yes |
| skip-worktree | `ce_mark_uptodate`, no `lstat` (F1: touched, not refreshed, no write) | `scanEntry` skips it | yes |
| assume-valid (`CE_VALID`) | `ce_mark_uptodate`, no `lstat` (F2) | `lstat`, `shouldRefresh` false | yes (one extra `lstat`, no data change) |
| intent-to-add | `ie_match_stat` reports it changed: never refreshed (F3: entry mtime stays 0) | `shouldRefresh` false | yes |
| gitlink | compares the submodule HEAD; stat never filled (F4: touched, no write) | delta never `unchanged` | yes |
| stat matches, not racy | up to date | `statOnlyVerdict` unchanged, no refresh | yes |
| stat matches, racy, same content | content check, up to date, not refreshed (CW5) | content compare unchanged, not refreshed, **verified** | yes |
| stat matches, racy, new content | not up to date; smudged if the index is written (CW8) | `modified`, not verified → `smudgeRacilyClean` zeroes `fileSize` | yes |
| stat moved, same content | refreshed, `cache_changed` (CW2) | `refreshed = withStatData(entry, stat)` | yes |
| stat moved, new content | left as is, quiet (CW6) | `modified`, not refreshed | yes |

F1–F4 come from pin-commit-refresh-flags.zsh (2×, identical): a touched entry of that kind keeps its index mtime and,
with a valid `TREE`, the commit writes nothing. F5 (a plain file) is the control: refreshed and written.

Write trigger: git writes with `COMMIT_LOCK | SKIP_IF_UNCHANGED`, i.e. iff `cache_changed` (a refreshed entry, or the
cache-tree update). There is **no** `has_racy_timestamp` term: that term belongs to `repo_update_index_if_able`
(status, CW5c). So commit's trigger is `statRefreshed || !cacheTreeFullyValid`, and status's `updateIndexIfAble`
keeps its own `refreshed ∨ racy` trigger. The two share the per-entry refresh, not the trigger.

Reuse, not a second comparator:

```ts
// src/application/primitives/internal/scan-tracked-entries.ts (new; bodies moved from status.ts)
export interface TrackedScan {
  readonly workingMap: Map<FilePath, WorkingTreeDelta>;
  readonly refreshed: ReadonlyArray<IndexEntry>;
}
export const scanTrackedEntries = (
  ctx: Context, index: GitIndex, stage0: ReadonlyArray<IndexEntry>, onScanned: () => void,
): Promise<TrackedScan>;
/** git's CE_UPTODATE: the scan found the path unchanged, by stat or by content. */
export const verifiedBy = (scan: TrackedScan): IsVerified;
```

- The bodies of `scanTrackedTree` (minus the tracker), `scanEntry`, `scanWorkingTree`, `trackedScanOf` move verbatim:
  one `compareAndRefresh` per entry through the `ioBound` pool, clean drivers heard in index order (`inIndexOrder`),
  the check-in attribute provider built once. `onScanned` replaces the progress tracker, because a primitive cannot
  import `commands/internal/progress-tracker.ts`. Status passes `tracker.tick`; commit passes a no-op (git's commit
  refresh is `REFRESH_QUIET`).
- `commit` wraps `prepareIndexTree` in `withFilterProcessPool` (scopes nest), as `status`/`add`/`checkout` do: a
  stat-drifted file is content-compared through its clean filter, as in git's refresh.
- `prepareIndexTree`: `scan = scanTrackedEntries(ctx, index, index.entries, noop)` (no unmerged entry survives the
  refusal, so every entry is stage 0), `entries = withRefreshedStat(index, scan.refreshed)`, then §D2.1.
- `index-lock.ts`: export `withRefreshedStat` unchanged. `CommitOptions.verified?: IsVerified` is passed by
  `commitLocked` to `smudgeRacilyClean`. Without it the smudge re-`lstat`s and re-hashes every racy entry the scan
  already verified: same bytes, double cost. A refreshed entry is never smudged either way: its stat differs from the
  index as read, so it is not "carried over" (git: `fill_stat_cache_info` sets `CE_UPTODATE`).
- `'update'` kind with entries that differ only in stat: `diffIndexEntries` reports no tracked-set change, so `REUC`
  and `UNTR` are forwarded (E5, U4) and `cacheTree` overrides `TREE`.

Cost: one `lstat` per stage-0, non-skip-worktree entry per commit, which git also pays. On the 500-directory row that
is 2000 `lstat`s. A micro-measure (2000 `lstat({ bigint: true })` over 500 directories on APFS, pool width 16 and 64,
3 runs, load 6–12) gave medians of 4.3–6.3 ms. §Evidence's clean status agrees: `lstat` is 13.1% of 52.3 ms ≈ 6.9 ms
for the same 2000 files. Expected: +5–7 ms per commit on the 22.3 ms add+commit row, which takes back a large share of
P4's saving. git's 27.3 ms on that row already includes its refresh. `bench:ab` P4→P4b isolates the refresh cost;
base→P4b shows the net. ADR-1017 does not apply: the refresh is a faithfulness fix and ships whatever it costs.

### D3. `unpack_trees`-class writers produce git's `TREE` (closes ADR-964's divergence, ADR-1009)

#### D3.1 Rule

§D1.4's formula, computed inside the lock's `'replace'` path, so every replace writer gets it with no per-site code.
The exception is the two stash sites that pass `restagedPaths`.

#### D3.2 `index-lock.ts` changes

- `carriedByRule`: for `'replace'`, `carryExtensions` no longer touches `TREE` (new `CarryKind` handling: `TREE`
  excluded from the pure carry when `kind === 'replace'`). The lock computes it:
  `updateCacheTree(ctx, smudged, invalidateCacheTree(parsedPrev, diff.changedPaths), 'repair')`, then
  `invalidateCacheTree(result, restagedPaths)`.
- `withRestagedPaths` keeps merging `restagedPaths` into `changedPaths` for `'update'` only. For `'replace'` they are
  applied after the repair (the two operations do not commute).
- `carriedExtensions` / `carriedByRule`: with no previous index, or a previous index without extensions, `'replace'`
  still emits a repaired `TREE` (U19/U20); the current early returns apply to `'update'` only. A previous `TREE` that
  fails to parse (or names a subtree twice) counts as absent: full repair, never a refusal.
- Output order stays `TREE`, `REUC`, `UNTR`.

#### D3.3 Writer-site changes

| Site | Change |
|---|---|
| `stash.ts` `applyUnderLock` non-index branch (`lock.commit(entries, 'replace', { restagedPaths })`, ~L815) | None. Its `restagedPaths` (from `unstageChangesUnlessNew`) are already git's un-staged set (S1, S4, U16). Verify by interop. |
| `stash.ts` `resetAfterPush` (`'replace'`, ~L591) with `keepIndex` | Pass `restagedPaths` = the paths where `iTree` and `bTree` differ (Q3). |
| `stash.ts` `reinstateIndex` (~L714), conflict branch (~L801) | None (U15, U9 shape). |
| `merge.ts` `materialiseAndApply` (~L1051), `underIndexLock` (~L1742) | None in the lock. **Verify** that a conflicted merge writes the merged trees of its clean directories, as merge-ort does (U21). If `mergeTreesToTree` (`apply-merge-to-worktree.ts` L550) skips them on conflict, write them: git's object set includes them. |
| `checkout.ts` `switchBranch` (~L266) | **Verify** U2: `checkout -b <new>` on the same tree must rewrite the index (git does). If tsgit skips the write, that is a route row (§D3.5), fixed by writing with `'replace'`. |
| `reset.ts` `hardResetFromCommit` (~L201), `internal/reset-worktree.ts` (~L38) | None. |
| `materialize-worktree-from-head.ts` (~L27), `worktree.ts` (~L212) | None (no previous index → full repair). |
| `pull.ts` (~L446), `internal/pull-into-void.ts` (~L52), `cherry-pick.ts` (~L257), `revert.ts` (~L147), `internal/replay-sequence.ts` (~L188, ~L250), `internal/rebase-merges-steps.ts` (~L154, ~L157) | None. |

#### D3.4 `write_index_as_tree` routes (ADR-1011)

git's `write_index_as_tree` (`cache-tree.c`) updates the cache tree and **writes the index** when it was not fully
valid. The sequencer `--continue` commits (Q1, Q2) reach it and leave a fully valid `TREE` with `REUC` kept. tsgit's
equivalents build the tree through `synthesizeTreeFromIndex` and never write: `rebase.ts` `continueStop` (~L731) and
the interactive resume (~L1593), `internal/replay-sequence.ts` finalise (~L403). Per ADR-1011, these call
a shared `writeIndexCacheTree(ctx)` (lock → read → fully-valid check → update + write iff not fully valid; it lives
in `internal/update-cache-tree.ts`, and `commit`'s `prepareIndexTree` shares its locked core). Whether these routes
also run §D2.5's refresh, as git's do (pin-continue-refresh.zsh), is DC-10; the recommended (a) passes the same scan
and widens the trigger exactly as in `prepareIndexTree`. The stash push/apply
calls (`stash.ts` ~L364, ~L797) are followed by a replace write that overwrites `TREE` anyway, so they stay as they are.

#### D3.5 Routes that bypass or re-admit the `TREE` invariant

Invariant: a node with `entryCount >= 0` covers no path whose entry differs from that node's tree, and its object
exists. Every index writer must either keep it (in-place chain invalidation), restore it (update/repair), or drop
`TREE`.

| Route | Today | After | Pin |
|---|---|---|---|
| `add` ×4 sites, `rm`, `mv`, mixed `reset`, `reset -- <p>`, `checkout [<tree>] -- <p>`, `apply-sparse-checkout`, `submodule add` | chain invalidation (`'update'`) | unchanged | sibling §D1.5, U5/U6/U17/U18 |
| `commit` | no write | refresh (§D2.5) + update (write) + index write iff refreshed ∨ not fully valid | C1–C9, CW1–CW8 |
| every `'replace'` site (§D3.3) | chain invalidation only | invalidate → repair → invalidate restaged | U1–U21, R1, S1–S4, Q3 |
| sequencer `--continue` commits (§D3.4) | no write | update + write (ADR-1011); refresh per DC-10 | Q1, Q2 (+ Q1r, Q2r under DC-10 (a)) |
| `status` refresh (`commitRefresh`) | `TREE` verbatim | unchanged | sibling E1 |
| a pre-commit hook that writes the index | n/a | its write wins; commit does not rewrite after the hook | C8 |
| an index from a third party with a `TREE` whose oid is missing | reused blindly by nobody | `hasObject` miss → rebuilt (write) or `-1` (repair) | covered by unit tests (no git pin: `fsck` territory) |
| a `TREE` that names one subtree twice | dropped (`namesEachSubtreeOnce`) | still dropped before plan/repair | existing |
| SHA-256 | `digestLength` everywhere | same; plan/serialize/hash take `ctx.hashConfig` | interop twin |
| an index in UTF-16 order (written by an older tsgit) | n/a | sorted copy before planning | unit |
| writers that bypass `IndexLock` (none expected) | — | grep `serializeIndex(` and `fs.write(.*index` during P4; any hit is a route row | — |

### D4. Loose object writes

#### D4.1 Drop the per-write fanout `mkdir`

`storeLoose` (`write-object.ts`) loses its `ctx.fs.mkdir(objectsDir(…))` line. `writeExclusive` already gives git's
`create_tmpfile` shape on every adapter: Node `createExclusive` opens first and `mkdir -p`s the parent only on ENOENT,
with one retry. Memory `ensureParentDirs` and browser `walkToParent(…, create=true)` cannot race. git differs in using a
tmpfile + rename (`finalize_object_file`). tsgit writes the final name exclusively and maps `FILE_EXISTS` to the
freshen-on-collision branch. That is already the ADR'd shape and does not change.

Concurrent-prune robustness: a fanout directory removed between `freshenObject`'s probe and the write is recreated
by the adapter's retry. A second ENOENT (removed again between `mkdir` and the retry) propagates as `FILE_NOT_FOUND`,
which is git's single-retry semantics. Expected effect: one `resolveWrite`+`mkdir` fewer per new object (part of
`storeLoose` 6.9% in add). **Benefit measured, not assumed.**

#### D4.2 Freshen stays

`freshenObject` keeps `utime`ing on a hit for objects actually written (git's `odb_write_object` →
`odb_freshen_object`). The 17.3% `utimeNow` share drops because valid subtrees are no longer written (§D2.3), not
because freshen changes.

### D5. `rm` records `REUC` and runs during a pending operation (user-ratified fold, ADR-1012)

- `rm.ts`: `assertNoPendingOperation(ctx, { except: [MERGE, CHERRY_PICK, REVERT, REBASE] })`, the list `add.ts` (L197)
  uses. **Verify** with pin rows E2c/E2r (rm during cherry-pick/revert) in the part. The recipe is in pin-reuc-untr.zsh.
- Group entries by path with their stages: `byPath` becomes `Map<IndexPathKey, ReadonlyArray<IndexEntry>>`. Today a
  path's stages collapse to the last one. Hunch: a tsgit `rm b` next to an unrelated conflicted path, reached without a
  pending marker (a `stash apply` conflict), drops that path's stages 1/2. Prove it with a red unit test before the fix.
- Removed unmerged paths → `resolveUndoRecordOf(stages)` → `lock.commit(…, 'update', { resolveUndo })`. `--cached`
  records too (E3).
- The safety valve (`classifyEntries`) runs on stage-0 entries only. Pin what `git rm` does with an unmerged path whose
  worktree file differs (a recipe line in pin-reuc-untr.zsh, run during the part) before deciding whether
  `classifyEntries` needs a stage rule.

### D6. Checkout write path and the `FileSystem.write` port (ADR-1013)

#### D6.1 Port (ADR-1013 option 1)

```ts
// src/ports/file-system.ts
export interface WriteOptions {
  /** Creation permission bits, git's 0o666 / 0o777. The platform applies the process umask. Ignored when the file exists. */
  readonly mode?: number;
}
readonly write: (path: string, data: Uint8Array, options?: WriteOptions) => Promise<FileStat>;
readonly writeStream: (path: string, source: AsyncIterable<Uint8Array>, options?: WriteOptions) => Promise<FileStat>;
```

The resolved `FileStat` is the post-write `fstat` of the open descriptor (Node), or the adapter's synthesised stat
(memory: the stored entry; browser: the same synthesis `lstat` already does). Existing callers ignore the result. The
return-type widening is source-compatible.

| Adapter | `write` with `mode` |
|---|---|
| Node | `resolveWrite` → `assertWritableLeaf` (Windows only) → `fs.promises.open(real, WRITE_CREATE_FLAGS, mode)`, `mkdir -p` + one retry only on ENOENT (the `createExclusive` pattern, which removes today's unconditional `mkdir`) → `handle.write` → `handle.stat({ bigint })` for `ctimeNs`/`mtimeNs` → `close` in `finally`. `writeStream`: the same handle with chunked `handle.write` instead of `pipeline` + `WriteStream`. |
| Memory | records `mode & ~0o022` where its `chmod` records permission bits (a named constant: memory has no process umask; 022 is Node's default, so memory/Node parity holds for default-umask tests); returns its stat. |
| Browser (OPFS) | no permission bits: `mode` is accepted and ignored, as `chmod` is today; returns a synthesised stat. |

Windows: Node passes `mode` to `open`. Windows honours only the write bit, and `0o666`/`0o777` both keep it, so no
`PathPolicy` capability flag is needed. **Only CI's Windows legs prove it.** The part's PR body must flag it.

#### D6.2 Checkout call sites

- `writeRegularFile(ctx, fullPath, content, mode?)` → `rmIfExists` (git's `checkout_entry` `lstat` + unlink, kept) →
  `ctx.fs.write(fullPath, content, { mode: creationModeOf(mode) })` and **no `chmod`**. It returns the `FileStat`.
  `creationModeOf`: `100755` → `0o777`, else `0o666` (git `create_file`). Without a `mode` (buffered writers that are
  not checkout), there is no option, as today.
- `writeServedBlob` / `writeStreamedBlob`: below `BUFFERED_WRITE_LIMIT = 1 MiB` (ADR-1016; a named constant; the located blob's
  size is known from its header) read whole and call `write`; otherwise `writeStream`. Both take `{ mode }` and return
  the stat. `createEmptyOutput` takes `{ mode }` too, without `chmod`.
- `writeWorkingTreeEntry` / `writeWorkingTreeEntryStream` / `WorkingTreeWriter.writeBlob` return
  `Promise<FileStat | undefined>` (`undefined` for symlink/gitlink/lossy, which keep their `lstat`).
- `apply-changeset.ts` `applyWriteEntry` builds the entry from the returned stat. `buildIndexEntry(ctx, absPath, …)`
  keeps the `lstat` fallback only for an `undefined` stat. Factor the stat→entry mapping onto
  `index-entry-from-stat.ts` `indexEntryFromStat` instead of duplicating its fields.

Expected effect: per added file, from {lstat, realpath, mkdir, open, write, close, chmod(+lstat), lstat} to {lstat,
open, write, fstat, close}, the cached realpath aside. Target is git parity (~71 µs/file). The frames are
`writeStreamedBlob` 5.6%, part of `lstat` 9.2%, and `realpathForCreation` 2.4%. **Measured after the commit** with the
§D10 rows.

### D7. Literal-path `add`

- `allLiteralsAreFiles` returns the `FileStat` per literal (`ReadonlyMap<FilePath, FileStat>`, or `undefined` when a
  literal routes to the walk). `stageLiterals` passes that stat to `stageOne`, which stops calling `lstatOrMissing`.
- `stageFromStat` gains a `fresh: FileStat` input for callers that hold a full stat. `freshStatOfSameKind` (the TOCTOU
  re-`lstat`) runs only for the walk's readdir-sourced `EntryKind`. The literal's stat **is** the fresh stat. git's
  `add_file_to_index` `lstat`s once.
- Staging goes through `dispatchInCleanOrder(ctx, ordered, stage, span)` in `trackedFirst` order. That is the walk path's
  pool and span rule (`span = safeCrlf ? 'write' : 'clean'`). The per-path bookkeeping (`added`, `modified`,
  `restagedPaths`, `inserted`, `eolNotices`) folds over the ordered outcomes after the pool, so the result order is
  unchanged.
- `PATHSPEC_NO_MATCH` for a literal that vanished between probe and stage: the probe already returned `undefined`
  and routed to the walk, so the pathspec refusal stays where it is today.

Expected effect: −2 `lstat`s per path and pooled staging, on `stageLiterals` 2.4% + `lstatOrMissing` 2.5% + the serial
await chain. **Measured.**

### D8. Merge-joins and the byte-order comparator (benefit unproven: frames < 1%; ADR-1017)

- `computeChangeset`: replace `projectIndex`/`projectTarget`/`allKeys` + `.sort()` with a merge-join over the
  stage-0 index entries and the target entries, both ordered by `compareEntryPath` (bytewise, ADR-966). Verify that
  `materializeTree`'s flattened target is in that order (tree traversal order = full-path byte order), and add a
  linear order check plus a sort fallback, as in §D2.2. The output is in bytewise order, which removes the UTF-16
  divergence named in `apply-changeset.ts`'s comment (~L362).
- `diffIndexAgainstTreeBy`: the same join over `index.entries` (stage 0) and `FlatTree.entries`. `FlatTree.entries`
  is a `Map`, so the join needs its iteration order proven bytewise. Check `flattenEscapedTree`. If it is not, keep the
  Map lookup and drop only `unionPaths`.
- `status.ts` `buildChanges`: join `stagedKindMap` and `workingMap` (both index-ordered) instead of `Set` + `sort`.
  `trackedEntriesOf` keeps `stage0Map` (random access by `buildChangedPath`).
- Gate (ADR-1017): `bench:ab`, 5 rounds, on §D10's status row. Keep what beats noise. A change that only moves output
  into git's byte-order sorting stays without a gain, because it is a faithfulness fix (the `computeChangeset` order).
  Drop the rest. The PR reports each piece as kept or dropped, with its numbers.

### D9. Ignore matcher and `ancestorsOf` (benefit unproven: `ancestorsOf` 0.9%; ADR-1017 gate)

- `lastMatch` scans from the last rule backward and returns the first hit (git `last_matching_pattern_from_list`).
  No object is allocated per intermediate match.
- `matchInStackVerbose` scans the stack from the end and returns at the first level that yields a rule index. Levels
  are pushed root-first, and non-ancestor levels are skipped by `relativize`, so "first from the end" = "last match
  wins".
- `ancestorsOf` (both copies; extract one into `src/domain/ignore/ancestors-of.ts`) walks `indexOf('/')` and emits
  `path.slice(0, i)`: O(depth) slices, no `split`/`join`.
- Properties: `matchInStackVerbose` equals a reference forward scan over arbitrary stacks (`fc` over rulesets from
  `test/unit/domain/ignore` arbitraries). `ancestorsOf(p)` equals the old split/join definition.

### D10. Benches

- `commit.bench.ts`: new row "500 directories, one file changed per commit". The factory builds one scratch (500 ×
  4 files, committed) once. Each `sut` iteration rewrites one file (rotating directory), runs a literal `add`, then
  `commit`. The state keeps moving forward, so the bench needs no reset. Builder:
  `write-scratch.ts` `buildWideCommitScratch(directories, filesPerDirectory)`.
- `add.bench.ts`: new row "literal add of 200 paths". The factory builds once; each iteration rewrites the 200 files'
  content (part of the sut, as in the harness) and calls `add(paths)`.
- `checkout.bench.ts`: split the alternation into **root→tip** and **tip→root** rows plus a **mixed** row (add +
  update + delete in one changeset). Reset (ADR-1015): a pool of pre-built scratch copies consumed one per iteration
  if `bench-dsl` can cap iterations, else checkout+reset pairs minus a reset-only row. The mixed fixture is a
  write-scratch builder (ADR-1015).
- Every row's before/after goes through `npm run bench:ab -- <base> HEAD 5`, run after the commit, with a +10% bound
  (memory hint). §Evidence above is the baseline the parts quote. The 500-directory commit row is read twice: P3→P4
  (the cache-tree saving) and P4→P4b (the refresh cost, §D2.5).

### D11. Edge checklist

- `commit` with no index (unborn, nothing staged): `readIndex` refuses as today; the lock is released in `finally`.
- `commit` now **always** takes `index.lock`, even when `TREE` is fully valid (git `repo_hold_locked_index(…,
  LOCK_DIE_ON_ERROR)` in `prepare_index`). An existing lock → `RESOURCE_LOCKED` (or a stale-lock break under
  `breakStaleLockMs`), where today's `commit` never looked at the lock. That is git's refusal: pin the exit code and
  message during P4 (`touch .git/index.lock; g commit --allow-empty -m x`).
- `commit` without a usable identity: git resolves the author in `prepare_to_commit`, after `prepare_index`. Pin during
  P4 whether git rewrites the index before dying (`env -u GIT_AUTHOR_NAME … g -c user.useConfigOnly=true commit`
  over an invalid `TREE`). tsgit refuses before the lock today. Keep that order unless the pin shows a write.
- `commit` with a `TREE` that parses but names a missing object: `isCacheTreeFullyValid` is false → update → write.
  That matches git (`cache_tree_fully_valid` checks existence).
- `commit` under `noVerify`: no hook, the tree is the root from the pre-hook pass.
- A hook that **removes** `index` or leaves `index.lock`: the post-hook re-read errors propagate (unchanged surface).
- `commit` with only ITA differences (C7): written, `NOTHING_TO_COMMIT` after. The tree excludes ITA (R10).
- An all-ITA directory: dropped from its parent's tree object (empty-tree skip).
- A gitlink in a directory: counted in `entryCount`, its existence not checked (git `ce_missing_ok` for
  `S_IFGITLINK`).
- Depth: `planCacheTree` is iterative (explicit stack). The `core.maxTreeDepth` cap stays in
  `synthesizeTreeFromIndex`. `commit` had no cap before and gets none (git has none, `synthesize-tree-from-index.ts`
  header).
- `repair` over 500 changed directories (checkout tip↔base) adds about 500 hash + `hasObject` calls. git pays the same.
  It is offset by §D6. Measured on the checkout rows.
- Concurrent prune during `commit` (Evidence 3): R7 + the reuse path's `hasObject('recheck')` miss → rebuild. Never
  a dangling valid node.
- `rm` of an unmerged path whose stages include a gitlink: `resolveUndoRecordOf` already handles the modes.
- Memory adapter umask constant vs a test that sets `process.umask`: memory ignores the process umask by design. Only
  Node tests assert umask effects.
- `commit` refresh with a working-tree file missing: `compareAndRefresh` returns `absent`, nothing refreshed, no write
  from the refresh (git: `lstat` fails, entry left, quiet).
- `commit` refresh on a stat-drifted file under a clean filter: the filter runs (inside `withFilterProcessPool`), as in
  git's refresh. A failing driver surfaces as it does in `status` today (same scan code).
- `commit` refresh under `noVerify`, with a hook, or with `allowEmpty`: the refresh runs in every case (git's
  `prepare_index` runs before all of them). Only an unmerged index or an earlier refusal skips it.
- `core.trustctime=false` is not read by tsgit (`grep -rn trustctime src`: no hit), so CW8's exact recipe has no tsgit
  twin. Its shape is pinned by a unit test with a fixed clock (P4b).

## Pin recipes

Each script sources the harness (`env.zsh` + `idx.py` beside it, §Pinning harness). Run it as
`GIT255=<git-2.55.0>/bin zsh <script>` from a scratch directory outside the repo. The tsgit probes (`*.mjs`) take the
built entry as their argument: `node <probe> <dist>/esm/index.node.js`, with git 2.55 first on `PATH`.

```python
# idx.py <index-file>
import sys, os
f = sys.argv[1]; d = open(f, 'rb').read(); ino = os.stat(f).st_ino
n = int.from_bytes(d[8:12], 'big'); pos = 12; ver = int.from_bytes(d[4:8], 'big')
for _ in range(n):
    ext = int.from_bytes(d[pos+60:pos+62], 'big') & 0x4000; fixed = 62 + (2 if ext else 0)
    nul = d.index(b'\0', pos + fixed); pos += ((nul - pos + 8) // 8) * 8
exts = []; tree = ''
while pos < len(d) - 20:
    sig = d[pos:pos+4].decode('latin1'); ln = int.from_bytes(d[pos+4:pos+8], 'big'); body = d[pos+8:pos+8+ln]
    exts.append(f'{sig}[{ln}]')
    if sig == 'TREE':
        j = 0; out = []
        while j < len(body):
            z = body.index(b'\0', j); name = body[j:z].decode('utf-8', 'replace'); nl = body.index(b'\n', z)
            ec, sc = body[z+1:nl].decode().split(); j = nl + 1; oid = ''
            if int(ec) >= 0: oid = ':' + body[j:j+20].hex()[:7]; j += 20
            out.append(f'{name or "<root>"}:{ec}/{sc}{oid}')
        tree = ' '.join(out)
    pos += 8 + ln
print(f'v{ver} n={n} ino={ino} exts={",".join(exts) or "-"} TREE: {tree or "none"}')
```

(SHA-1 only. A SHA-256 twin reads 32 bytes per oid. Entry padding: an entry occupies `(62 + name + 8) & ~7` bytes in
v2/v3.)

```zsh
# pin-commit.zsh — D1.1 C1..C9
PINS=${0:A:h}; source $PINS/env.zsh
w a/x/f 1; w b/f 2; w c/f 3; w top 4; w bb/f 5; w zzz/f 6
g add -A; echo "C1 add: $(idx)"; g commit -q -m one; echo "C1 commit: $(idx)"
w b/f 22; g add b/f; echo "C3 add: $(idx)"; g commit -q -m two; echo "C3 commit: $(idx)"
settle; touch b/f; g add b/f; echo "C4 add: $(idx)"; g commit -q -m nothing; echo "C4 refused=$?: $(idx)"
w c/f 33; g add c/f; g commit -q -m ''; echo "C5 empty-msg=$?: $(idx)"
w a/x/n 7; g add -N a/x/n; echo "C7 add -N: $(idx)"; g commit -q -m ita; echo "C7 commit: $(idx)"
g rm -q --cached a/x/n; settle
mkdir -p .git/hooks; print -r -- $'#!/bin/sh\necho hook >> c/f; git add c/f' > .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit; w b/f 222; g add b/f; g commit -q -m hook
echo "C8 commit+hook: $(idx) c=$(git rev-parse --short HEAD:c)"; rm .git/hooks/pre-commit
g rm -q -r zzz; g commit -q -m rmdir; echo "C9: $(idx)"
cd /; rm -rf $REPO $HOME

# pin-commit-write.zsh — D1.2 CW1..CW4
PINS=${0:A:h}; source $PINS/env.zsh
w a/f 1; w b/f 2; g add -A; g commit -q -m one; settle
echo "CW1 before: $(idx)"; g commit -q --allow-empty -m e; echo "CW1 after: $(idx)"
settle; echo "CW2 before: $(idx)"; touch b/f; g commit -q --allow-empty -m s; echo "CW2 after: $(idx)"
settle; echo "CW3 before: $(idx)"; g commit -q -m nothing; echo "CW3 refused=$?: $(idx)"
g checkout -q -b side; w a/f side; g commit -qam side; g checkout -q main; w a/f main; g commit -qam main
g merge -q side >/dev/null 2>&1; echo "CW4 conflicted: $(idx)"; g commit -q -m m; echo "CW4 refused: $(idx)"
cd /; rm -rf $REPO $HOME

# pin-ita.zsh — D1.1 I1 (control for pin-tsgit-ita.mjs, which runs the same steps with tsgit's commit)
PINS=${0:A:h}; source $PINS/env.zsh
w a/f 1; w a/n new; w b 2; g add a/f; g commit -q -m base; w b 3; g add b; g add -N a/n
g commit -q -m m; echo "I1 ls-tree: $(git ls-tree -r --name-only HEAD | paste -sd, -) | $(idx)"
cd /; rm -rf $REPO $HOME

# pin-unpack.zsh — D1.3 U0..U20
PINS=${0:A:h}; source $PINS/env.zsh
w a/x/f 1; w b/f 2; w c/f 3; w top 4; g add -A; g commit -q -m base
g checkout -q -b other; w b/f other; w z/f z; g add -A; g commit -q -m other
g checkout -q main; w a/x/f main; g commit -qam main; g tag mainc
fresh() { g checkout -q -f main; g reset -q --hard mainc; g stash clear; settle; touch c/f; g add c/f; }
row() { echo "$1 | $(idx)"; }
fresh; row U0
fresh; g checkout -q other; row U1
fresh; g checkout -q -b same; row U2; g checkout -q main; g branch -qD same
fresh; g reset -q --hard; row U3
fresh; g reset -q --hard HEAD~1; row U4
fresh; g reset -q; row U5
fresh; g reset -q HEAD~1; row U6
fresh; g reset -q --keep HEAD~1; row U6k
fresh; g merge -q --no-edit other >/dev/null; row U7
fresh; g checkout -q -b ff mainc~1; settle; touch c/f; g add c/f; g merge -q --ff-only mainc; row U8
g checkout -q main; g branch -qD ff
fresh; w b/f mine; g commit -qam mine; g merge -q --no-edit other >/dev/null 2>&1; row U9; g merge --abort
fresh; g cherry-pick other >/dev/null; row U10
fresh; g revert --no-edit HEAD >/dev/null; row U11
fresh; g checkout -q -b rb other; g rebase -q mainc >/dev/null 2>&1; row U12; g checkout -q main; g branch -qD rb
fresh; w top dirty; g stash push -q; row U13
fresh; w b/f staged; g add b/f; w top wt; g stash push -q; settle; touch c/f; g add c/f
g stash pop -q --index; row U15
fresh; w b/f staged2; g add b/f; g stash push -q; settle; touch c/f; g add c/f; g stash apply -q; row U16
fresh; g checkout -q other -- z/f; row U17
fresh; g checkout -q -- c/f; row U18
C=$(mktemp -d); g clone -q $REPO $C/cl; cd $C/cl; row U19
g worktree add -q ../wt other; cd ../wt; echo "U20 | $(python3 -I $PINS/idx.py $(git rev-parse --git-dir)/index)"
cd /; rm -rf $REPO $C $HOME

# pin-repair.zsh — D1.4 R1, S1..S4
PINS=${0:A:h}; source $PINS/env.zsh
w a/x/f 1; w b/f 2; w c/f 3; w top 4; g add -A; g commit -q -m base
g checkout -q -b other; w b/f other; w z/f z; g add -A; g commit -q -m other; g checkout -q main
reset0() { g checkout -q -f main; g reset -q --hard; g stash clear; settle; }
reset0; w c/f staged; g add c/f; g checkout -q other; echo "R1 | $(idx)"
reset0; w c/f wt-only; g stash push -q; g stash apply -q; echo "S1 | $(idx)"
reset0; w n/f new; g add n/f; g stash push -q; g stash apply -q; echo "S2 | $(idx)"
reset0; w n/f new; g add n/f; w c/f stagedc; g add c/f; g stash push -q; g stash apply -q --index; echo "S3 | $(idx)"
reset0; w c/f wt; g stash push -q; w b/f wtb; g stash apply -q; echo "S4 | $(idx)"
cd /; rm -rf $REPO $HOME

# pin-merge-mixed.zsh — D1.4 U21
PINS=${0:A:h}; source $PINS/env.zsh
w b/f b; w d/1 one; w d/2 two; g add -A; g commit -q -m base
g checkout -q -b side; w b/f side; w d/1 side1; g commit -qam side
g checkout -q main; w b/f main; w d/2 main2; g commit -qam main
g merge -q side >/dev/null 2>&1; echo "U21 | $(idx)"
cd /; rm -rf $REPO $HOME

# pin-sequencer.zsh — D1.4 Q1..Q3
PINS=${0:A:h}; source $PINS/env.zsh
w a/f base; w b/f b; w c/f c; g add -A; g commit -q -m base
g checkout -q -b side; w a/f side; g commit -qam side; g checkout -q main; w a/f main; g commit -qam main
g cherry-pick side >/dev/null 2>&1; w a/f fixed; g add a/f; GIT_EDITOR=true g cherry-pick --continue >/dev/null
echo "Q1 | $(idx)"
g reset -q --hard main; g checkout -q side; g rebase main >/dev/null 2>&1; w a/f fixed2; g add a/f
GIT_EDITOR=true g rebase --continue >/dev/null 2>&1; echo "Q2 | $(idx)"
g checkout -q main; g reset -q --hard; settle; w b/f staged; g add b/f; w c/f wt; touch a/f; g add a/f
g stash push -q --keep-index; echo "Q3 | $(idx)"
cd /; rm -rf $REPO $HOME

# pin-reuc-untr.zsh — D1.5 E1..E6, U0..U8 (+ the D5 verification rows E2c/E2r/E2d to add during the part)
PINS=${0:A:h}; source $PINS/env.zsh
reuc() { g ls-files --resolve-undo; }
w a/f base; w b/f b; g add -A; g commit -q -m base
g checkout -q -b side; w a/f side; g commit -qam side; g checkout -q main; w a/f main; g commit -qam main
g merge -q side >/dev/null 2>&1; g rm -q a/f; echo "E2 | $(idx)"; reuc
g reset -q --hard; g merge -q side >/dev/null 2>&1; g rm -q --cached a/f; echo "E3 | $(idx)"; reuc
g reset -q --hard; g merge -q side >/dev/null 2>&1; w a/f fixed; g add a/f; echo "E4 | $(idx)"
g commit -q -m merged; echo "E5 | $(idx)"; g reset -q --hard HEAD; echo "E6 | $(idx)"
# E2c: same with `g cherry-pick side` instead of merge; E2r: `g revert` of a conflicting commit;
# E2d: conflicted a/f with a modified worktree file, plain `g rm a/f` → exit code + message
w u/new untracked; settle; echo "U0 | $(idx)"
g config core.untrackedCache true; g status >/dev/null; echo "U1 | $(idx)"; g status >/dev/null; echo "U2 | $(idx)"
w b/f bb; g add b/f; echo "U3 | $(idx)"; g commit -q -m c; echo "U4 | $(idx)"
w u/t2 x; g add u/t2; echo "U5 | $(idx)"; g commit -q -m d; echo "U6 | $(idx)"
g checkout -q HEAD~1; echo "U7 | $(idx)"
g config core.untrackedCache false; g status >/dev/null; echo "U8 | $(idx)"
cd /; rm -rf $REPO $HOME

# pin-umask.zsh — D1.6 M1, M2
PINS=${0:A:h}; source $PINS/env.zsh
w f plain; w x exec; chmod +x x; g add -A; g commit -q -m base; rm f x
umask 027; g checkout -q -- f x; echo "M1 $(stat -f '%Sp %N' f x | paste -sd' ' -)"   # GNU: stat -c '%A %n'
rm f x; umask 077; g checkout -q -- f x; echo "M2 $(stat -f '%Sp %N' f x | paste -sd' ' -)"
cd /; rm -rf $REPO $HOME
```

Refresh pins (§D1.2 CW5–CW8, §D2.5 F1–F5, DC-10). They carry their own scrubbed env (same as `env.zsh`, no fixed dates; dates
do not reach the index) and detect a rewrite by the index inode:

```sh
# pin-commit-refresh.zsh: commit's refresh vs racy entries and modified files
export PATH=$GIT255:/usr/bin:/bin
unset ${(k)parameters[(I)GIT_*]}
export GIT_CONFIG_NOSYSTEM=1 HOME=$(mktemp -d) GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@x GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@x
g() { git -c commit.gpgsign=false -c init.defaultBranch=main -c maintenance.auto=false -c gc.auto=0 "$@"; }
ino() { stat -f %i .git/index; }
sz() { git ls-files --debug b/f | awk '/size:/{print $2}' | head -1; }
settle() { sleep 1.1; g status >/dev/null; sleep 1.1; }
w() { mkdir -p ${1:h}; print -r -- "$2" > $1; }
REPO=$(mktemp -d); cd $REPO; g init -q
w a/f 1; w b/f 2; g add -A; g commit -q -m one; settle
i=$(ino); touch -t 202001010000 .git/index; g commit -q --allow-empty -m r; echo "CW5 racy-only commit rewritten=$([[ $(ino) != $i ]] && echo yes || echo no)"
i=$(ino); g status >/dev/null; echo "CW5c racy-only status rewritten=$([[ $(ino) != $i ]] && echo yes || echo no)"
settle; i=$(ino); w b/f 3; g commit -q --allow-empty -m m; echo "CW6 modified-unstaged commit rewritten=$([[ $(ino) != $i ]] && echo yes || echo no)"
g checkout -q -- b/f; settle
i=$(ino); touch -t 202001010000 .git/index; touch b/f; g commit -q --allow-empty -m t; echo "CW7 racy+stat-moved commit rewritten=$([[ $(ino) != $i ]] && echo yes || echo no) b-size=$(sz)"
cd /; rm -rf $REPO $HOME

# pin-commit-smudge.zsh: a racy entry whose content changed under an identical stat, written by commit
export PATH=$GIT255:/usr/bin:/bin
unset ${(k)parameters[(I)GIT_*]}
export GIT_CONFIG_NOSYSTEM=1 HOME=$(mktemp -d) GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@x GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@x
g() { git -c commit.gpgsign=false -c init.defaultBranch=main -c maintenance.auto=false -c gc.auto=0 -c core.trustctime=false "$@"; }
ino() { stat -f %i .git/index; }
sz() { git ls-files --debug $1 | awk '/size:/{print $2}' | head -1; }
w() { mkdir -p ${1:h}; print -r -- "$2" > $1; }
REPO=$(mktemp -d); cd $REPO; g init -q
w a/f 1; w b/f 2; g add -A; g commit -q -m one
touch -t 203001010000 b/f; g add b/f; g commit -q --allow-empty -m pin  # b/f mtime in the future: racy vs any index
print -rn -- $'3\n' 1<> b/f; touch -t 203001010000 b/f                  # same size, same mtime, same inode
i=$(ino); sleep 1.1; touch a/f; g commit -q --allow-empty -m s
echo "CW8 rewritten=$([[ $(ino) != $i ]] && echo yes || echo no) b-size=$(sz b/f) a-size=$(sz a/f)"
cd /; rm -rf $REPO $HOME

# pin-continue-refresh.zsh: does a sequencer --continue refresh stats (commit's refresh_cache)?
export PATH=$GIT255:/usr/bin:/bin
unset ${(k)parameters[(I)GIT_*]}
export GIT_CONFIG_NOSYSTEM=1 HOME=$(mktemp -d) GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@x GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@x GIT_EDITOR=true
g() { git -c commit.gpgsign=false -c init.defaultBranch=main -c maintenance.auto=false -c gc.auto=0 "$@"; }
mt() { git ls-files --debug a/f | awk '/mtime:/{print $2}' | head -1; }
fm() { stat -f %m:%Fm a/f 2>/dev/null | cut -d: -f1; }
w() { mkdir -p ${1:h}; print -r -- "$2" > $1; }
for op in cherry-pick rebase; do
REPO=$(mktemp -d); cd $REPO; g init -q
w a/f 1; w b/f 2; g add -A; g commit -q -m base
g checkout -q -b side; w b/f side; g commit -qam side
g checkout -q main; w b/f main; g commit -qam main
if [[ $op == cherry-pick ]]; then g cherry-pick side >/dev/null 2>&1; else g checkout -q side; g rebase main >/dev/null 2>&1; fi
w b/f resolved; g add b/f; sleep 1.1; touch a/f; before=$(mt)
g $op --continue >/dev/null 2>&1; echo "$op --continue: a/f index-mtime before=$before after=$(mt) file=$(fm)"
cd /; rm -rf $REPO
done
rm -rf $HOME

# pin-commit-refresh-flags.zsh: entries git's commit refresh never refreshes
export PATH=$GIT255:/usr/bin:/bin
unset ${(k)parameters[(I)GIT_*]}
export GIT_CONFIG_NOSYSTEM=1 HOME=$(mktemp -d) GIT_AUTHOR_NAME=p GIT_AUTHOR_EMAIL=p@x GIT_COMMITTER_NAME=p GIT_COMMITTER_EMAIL=p@x
g() { git -c commit.gpgsign=false -c init.defaultBranch=main -c maintenance.auto=false -c gc.auto=0 -c protocol.file.allow=always "$@"; }
ino() { stat -f %i .git/index; }
settle() { sleep 1.1; g status >/dev/null; sleep 1.1; }
w() { mkdir -p ${1:h}; print -r -- "$2" > $1; }
mt() { git ls-files --debug $1 | awk '/mtime:/{print $2}' | head -1 | cut -d: -f1; }
row() { local i=$(ino) n0; g commit -q --allow-empty -m $1-untouched; n0=$([[ $(ino) != $i ]] && echo yes || echo no)
  i=$(ino); touch $2; g commit -q --allow-empty -m $1; echo "$1 untouched-rewritten=$n0 touched-rewritten=$([[ $(ino) != $i ]] && echo yes || echo no) entry-mtime=$(mt $2) file-mtime=$(stat -f %m $2)"; }
SUB=$(mktemp -d); (cd $SUB; g init -q; w s 1; g add s; g commit -q -m s)
REPO=$(mktemp -d); cd $REPO; g init -q
w a/f 1; w b/f 2; w c/f 3; g add -A; g submodule add -q $SUB sm 2>/dev/null; g commit -q -m one; settle
g update-index --skip-worktree a/f; settle; row F1-skip-worktree a/f
g update-index --no-skip-worktree a/f; g update-index --assume-unchanged b/f; settle; row F2-assume-valid b/f
g update-index --no-assume-unchanged b/f; settle; w n/x 4; g add -N n/x; g commit -q -m ita 2>/dev/null; settle; row F3-ita n/x
g rm -q --cached n/x; rm -rf n; g commit -q --allow-empty -m c; settle; row F4-gitlink sm
settle; row F5-control c/f
cd /; rm -rf $REPO $SUB $HOME
# The first, untouched commit after `update-index` rewrites because `update-index` invalidated the entry's TREE chain;
# the touched column is the reading.
```

tsgit probes (same steps, tsgit for the step under test): `pin-tsgit-ita.mjs` (I1 setup with `git`, then
`repo.commit`, then `git ls-tree -r --name-only HEAD`), `pin-tsgit-rm.mjs` (E1 setup, then `repo.rm(['a/f'])`, then
`git ls-files -s` and `--resolve-undo`), `pin-tsgit-umask.mjs` (M1 setup, `process.umask(0o027)`,
`repo.checkout({ paths: ['f', 'x'] })`, `statSync(…).mode & 0o777`).

## Implementation parts (pre-chewed, dependency order)

Every part is TDD: GWT titles, AAA, `sut`, data-asserting refusals. `npm run validate` is green before each commit.
A part that changes an exported type regenerates `reports/api.json` (`npx typedoc --json reports/api.json
--disableSources --out reports/api-tmp && rm -rf reports/api-tmp`) in the same commit. A part that grows `dist` past
the `check:size`/`check:tarball` headroom (~80–100 B) adds a `chore(size)` commit with attribution in
`docs/design/bundle-size-optimization.md`.

| Part | Commit | Files / symbols | Context, tests, pin |
|---|---|---|---|
| **P1** loose write: no per-write `mkdir` | `perf(write-object): let the exclusive write create the fanout directory` | `src/application/primitives/write-object.ts` `storeLoose` (drop the `ctx.fs.mkdir(objectsDir(…))` line; `objectsDir` import may become unused). Test `test/unit/application/primitives/write-object.test.ts` | RED: (1) an `fs` proxy (spread of the memory adapter) counting `mkdir` → 0 calls across a write of a new object. (2) A fault proxy whose `writeExclusive`, on its first call, `rm`s the fanout directory before delegating (memory adapter: the parent is recreated) → `writeObject` resolves and the object reads back. (3) A proxy whose `writeExclusive` throws `FILE_NOT_FOUND` → propagates with `data.code`/`data.path` asserted. Node retry semantics are already covered by the adapter's `createExclusive` tests; confirm with `grep -n "ENOENT" test/unit/adapters/node/*write-exclusive*` and add the "fanout removed between probe and open" row there if absent. Evidence 3 (prune race) is the motivating repro. The deterministic tests replace it. **Measure**: `storeLoose` share on the add row. |
| **P2** cache-tree planner (domain) | `feat(cache-tree): plan a cache-tree update over the sorted index` | New `src/domain/git-index/cache-tree-update.ts`: `compareSubtreeNames`, `planCacheTree`, `toCacheTreeEntry`, `isIndexOrdered`; export via `src/domain/git-index/index.ts`. Tests `test/unit/domain/git-index/cache-tree-update.test.ts` + `.properties.test.ts`; arbitraries `test/unit/domain/git-index/arbitraries.ts` | Examples are the §D1.1 rows as data: C1's order `a, b, c, bb, zzz`; root `6/5`; C3 reuse of `a`/`c`/`bb`/`zzz`; C7/I1 ITA chain `-1`; C9 discarded subtree; an all-ITA directory dropped. Properties: (a) every directory present in the entries has exactly one node; (b) `entryCount(root) = #entries`; (c) children strictly ordered by `compareSubtreeNames`; (d) a carried valid node whose region is unchanged is reused (`reused` set), and any node covering a changed path is a build; (e) `serializeCacheTree(toCacheTreeEntry(…))` round-trips through `parseCacheTree`. Pure: no ctx. |
| **P3** cache-tree driver | `feat(cache-tree): update the cache-tree in write and repair modes` | New `src/application/primitives/internal/update-cache-tree.ts`: `updateCacheTree`, `isCacheTreeFullyValid`. Uses `writeTree` (`src/application/primitives/write-tree.ts`), `serializeAndHash` (`internal/serialize-and-hash.ts`), `hasObject` (`has-object.ts`), `limiterFor` (`internal/concurrency.ts`). Test `test/unit/application/primitives/internal/update-cache-tree.test.ts` (memory adapter) | `'write'`: built trees exist afterwards; a reused node's object gets **no** `utimeNow` call (spy the fs: zero `utimeNow` on reused paths, ≥1 for a rebuilt one that already existed). `'repair'`: a node whose hashed tree is absent → `-1` with ancestors (R1 shape); present → valid (S2 shape); no object is written (count loose files before/after). Missing reused oid → rebuilt (write) / `-1` (repair). Unmerged entry → its chain `-1` (U9). `rootTree` defined under ITA in write mode. Concurrency: a limiter of size 1 completes a 3-level tree (deadlock guard). SHA-256 twin through `hashConfig`. |
| **P4** `commit` writes `TREE` (+ ITA fix) | `feat(commit): maintain the cache-tree and write it into the index` | `src/application/commands/commit.ts` (§D2.4: delete the trie, add `prepareIndexTree`, move `runPreCommitHook`); `src/application/primitives/internal/index-lock.ts` `CommitOptions.cacheTree`, `carriedExtensions`/`carriedByRule` override; hook runner return value (locate `runPreCommitHook`). Tests `test/unit/application/commands/commit.test.ts`, `commit.properties.test.ts` (keep green: tree oids unchanged for non-ITA indexes), new `test/unit/application/primitives/internal/index-lock-cache-tree.test.ts`; interop **new** `test/integration/commit-cache-tree-interop.test.ts` (helpers `runGit`/`git`/`makePeerPair` from `test/integration/interop-helpers.ts`) | Interop rows = §D1.1 + §D1.2 executed twice (git peer, tsgit peer) on identical content and dates; assert raw `TREE` payload bytes equal, `REUC`/`UNTR` presence equal, and rewritten-or-not (inode) equal for CW1/CW3/C4/C5/C7/CW4 (CW2 joins in P4b, which adds the refresh). ITA (I1 vs T2): commit tree oid equal to git's. Hook row C8: tsgit's final index `TREE` = git's. The add→commit→add sequence on the 4-file fixture compares the `-1` counts after each step. Unit: `NOTHING_TO_COMMIT` and `EMPTY_COMMIT_MESSAGE` still throw (data asserted) **after** the index was rewritten (read the index back). Unmerged → refusal, index bytes untouched. Run the routes grep from §D3.5. `reports/api.json` if `CommitOptions` (lock) is exported. **Measure**: the 500-dir commit row (P12, landed first per the recommended order), `bench:ab` P3→P4. Expected: −30% or more, per §Evidence. |
| **P4b** `commit` refreshes stats (ADR-1008) | `feat(commit): refresh index stats before updating the cache-tree, as git does` | **New** `src/application/primitives/internal/scan-tracked-entries.ts`: `TrackedScan`, `scanTrackedEntries(ctx, index, stage0, onScanned)`, `verifiedBy(scan)` (§D2.5). Bodies moved from `src/application/commands/status.ts`: `TrackedScan` (L250), `scanTrackedTree` (L274, minus `createGranularityTracker`), `scanEntry` (L324), `ScannedEntry` (L340), `scanWorkingTree` (L346), `trackedScanOf` (L370). Their imports move with them: `compareAndRefresh` + `WorkingTreeDelta` (`compare-working-tree-entry.ts`), `CleanOrder`/`configuresFilterDriver`/`inIndexOrder` (`internal/clean-order.ts`), `boundedMapFor` (`internal/concurrency.ts`), `AttributeProvider`/`buildCheckinAttributeProvider` (`internal/read-gitattributes.ts`), `IsVerified` (`internal/smudge-racily-clean.ts`), `escapedPathOf` (`src/domain/git-index/index-path-key.ts`). **Changed** `status.ts`: `scanTrackedTree` creates the tracker and calls `scanTrackedEntries(…, tracker.tick)`; `updateIndexIfAble` passes `verifiedBy(scan)` (behaviour unchanged, racy trigger kept). **Changed** `src/application/primitives/internal/index-lock.ts`: export `withRefreshedStat` (L229); `CommitOptions.verified?: IsVerified`, read by `commitLocked` into `smudgeRacilyClean(ctx, entries, previous, options.verified)`. **Changed** `src/application/commands/commit.ts`: `prepareIndexTree` inserts the scan after `rejectUnmergedIndex`, merges with `withRefreshedStat`, writes iff `scan.refreshed.length > 0 \|\| !fullyValid` (fully valid → `cacheTree: carried`), passes `verified`; `commit` wraps the `prepareIndexTree` call in `withFilterProcessPool` (`internal/filter-process-pool.ts`). Tests: new `test/unit/application/primitives/internal/scan-tracked-entries.test.ts` (memory adapter; skip-worktree skipped, refreshed only for drifted stat-same-content entries, `onScanned` called once per scanned entry, `verifiedBy` true only for `unchanged`); `test/unit/application/commands/commit.test.ts`; `test/unit/application/primitives/internal/index-lock.test.ts` (`verified` passthrough); keep green `status.test.ts`, `status-refresh.test.ts`, `status-clean-order.test.ts`, `status-filter-skip.test.ts`, `smudge-racily-clean.test.ts`; interop `test/integration/commit-cache-tree-interop.test.ts` (rows below) with `status-refresh-interop.test.ts`, `status-racy-clean-interop.test.ts`, `index-racy-smudge-interop.test.ts` kept green | RED first, one per guard: (1) CW2: settled commit, `utimes` moves `b/f`'s mtime, same bytes → `commit({ allowEmpty: true })` rewrites the index; `b/f`'s entry stat equals `lstat`; `TREE` bytes unchanged. (2) CW5: index mtime backdated, nothing moved, fully valid `TREE` → index bytes and inode untouched (guards against copying status's racy trigger). (3) CW6: `b/f` content changed, unstaged → no write, entry stat unchanged. (4) CW8 shape on the memory adapter with a fixed clock (ADR-949's repro pattern): a same-size rewrite in the index's tick plus another entry's moved stat → written, the racy modified entry has `fileSize: 0`, the refreshed one keeps its size. (5) skip-worktree entry with a drifted stat is not refreshed (`scanEntry`'s skip, now in the moved code). (6) `verified` passthrough: a racy unchanged entry is read once per commit, not twice (count `fs.read` on its path). (7) Refusal ordering: unmerged index → `MERGE_HAS_CONFLICTS` (`data.count`, `data.paths` asserted), zero `lstat` on worktree paths (no refresh ran). Interop (git peer vs tsgit peer, rewritten-or-not by inode, entry stat vs `lstat`, `TREE` bytes, `git fsck` exit 0): CW1–CW4, C4, C5 re-run under the refresh, plus CW2, CW5, CW6, CW7. CW5 backdates `.git/index` with `utimes` in both peers. `reports/api.json` untouched (all symbols internal). **Measure**: `bench:ab` P4→P4b on the 500-dir commit row = the refresh cost (expected +5–7 ms, §D2.5); base→P4b = the net. |
| **P5** replace writers repair `TREE` | `feat(index): repair the cache-tree on replace writes as unpack_trees does` | `index-lock.ts` (§D3.2); `src/domain/git-index/carry-extensions.ts` (`carryTree` skips `'replace'`; `withRestagedPaths` scoped to `'update'`); `stash.ts` `resetAfterPush` keep-index `restagedPaths`; verifications in `merge.ts`/`apply-merge-to-worktree.ts` `mergeTreesToTree` (U21) and `checkout.ts` `switchBranch` (U2). ADR-1009 supersedes ADR-964's divergence clause. Tests `carry-extensions.test.ts` (replace no longer touches `TREE`), `index-lock-cache-tree.test.ts`; interop `test/integration/index-extensions-interop.test.ts` (tighten every `'replace'` row from "valid nodes carry git's oid" to **byte equality**) | Interop rows U1–U21, R1, S1–S4, Q3 (pin-unpack/pin-repair/pin-merge-mixed/pin-sequencer). Each row runs the same git-made start state through tsgit's writer and git's writer in twin repos and compares `TREE` bytes. U5/U6 stay `'update'` (regression rows). If U21 or U2 fails on verification, the fix joins this part (same invariant). **Measure**: the checkout rows (repair adds hashing; expect a small cost, offset by P8). |
| **P6** `write_index_as_tree` routes | `fix(sequencer): write the updated cache-tree when continuing a stopped pick` | `rebase.ts` `continueStop` (~L731), interactive resume (~L1593); `internal/replay-sequence.ts` finalise (~L403). Folded by ADR-1011. Under DC-10 (a), the routes reuse P4b's `scanTrackedEntries` + trigger through `writeIndexCacheTree`, and the part follows P4b | Interop Q1/Q2 in `test/integration/index-extensions-interop.test.ts`: `TREE` bytes and `REUC` kept, equal to git's. Under DC-10 (a), Q1r/Q2r (pin-continue-refresh.zsh): a touched clean file's entry stat equals `lstat` after `--continue`, as with git. |
| **P7** `rm` records `REUC` | `fix(rm): record resolve-undo and run during a pending merge, as git rm does` | `src/application/commands/rm.ts` (`assertNoPendingOperation` except list; `byPath` stage-preserving; `resolveUndo` option); `src/domain/git-index/resolve-undo.ts` `resolveUndoRecordOf` (reuse). Tests `test/unit/application/commands/rm.test.ts`; interop `test/integration/rm-interop.test.ts` | First RED: the stage-collapse hunch (§D5) on a memory index with an unrelated conflicted path. Interop E2/E3 (+E2c/E2r/E2d once pinned): `git ls-files --resolve-undo` equal, `REUC` bytes equal, `git fsck` exit 0. T3 flips from `OPERATION_IN_PROGRESS` to success. |
| **P8** `FileSystem.write` mode + stat; checkout write path | `perf(checkout): create files with git's mode and stat the written descriptor` | Port `src/ports/file-system.ts` (`WriteOptions`, `write`/`writeStream` signatures); adapters `src/adapters/node/node-file-system.ts` (`write`, `writeStream`), `src/adapters/memory/memory-file-system.ts` (`write`, `writeStream`, mode store), `src/adapters/browser/browser-file-system.ts` (`write`, `writeStream`); callers `src/application/primitives/internal/write-working-tree-file.ts` (`writeRegularFile`, `createEmptyOutput`, `writeServedBlob`, `writeStreamedBlob`, `writeWorkingTreeEntry*`), `internal/write-converted-entry.ts` (`WorkingTreeWriter` return types), `apply-changeset.ts` (`applyWriteEntry`, `buildIndexEntry`), `internal/index-entry-from-stat.ts`. ADR-1013 (port shape, umask fold). Tests: adapter contract suites under `test/unit/adapters/{node,memory,browser}/` (find with `grep -rln "writeStream" test/unit/adapters`), `write-working-tree-file.test.ts`, `apply-changeset.test.ts`; interop `test/integration/blob-streaming-checkout-interop.test.ts` (+ a umask row) | Contract rows per adapter: the returned stat's `size`/`isFile` match; Node `mode` → `0o666 & ~umask` / `0o777 & ~umask` (read the current umask; `process.umask(mask)` throws inside worker threads, so the restrictive-umask row lives in the interop test's child process); an existing file keeps its mode (`open` ignores `mode`, so the umask row must start absent); the leaf-symlink refusal is unchanged (`PERMISSION_DENIED`); ENOENT parent → created once. Checkout: no `chmod` call (spy); the index entry stat equals `lstat` afterwards (ino/size/mtime). Interop M1: tsgit checkout under umask 027 → `640`/`750` (POSIX only; skip on Windows by `process.platform`). Windows: no `PathPolicy` flag (§D6.1); the PR must call out the Windows CI legs. `reports/api.json`. **Measure**: checkout rows. Target ~71 µs/file. |
| **P9** literal `add` single stat + pool | `perf(add): stat each literal path once and stage literals through the pool` | `src/application/commands/add.ts` `allLiteralsAreFiles`, `stageLiterals`, `stageOne`, `stageFromStat`, `freshStatOfSameKind`, `dispatchInCleanOrder`. Tests `test/unit/application/commands/add.test.ts`, `add-clean-order.test.ts` (slow-lstat proxy pattern for order under `safeCrlf: true`) | RED: an `lstat`-counting proxy → 1 call per literal (today 3). Order: outcomes and loose-object creation order under `safeCrlf: true` stay in index order (reuse the slow-proxy test). `PATHSPEC_NO_MATCH` data asserted for a missing literal. `add-interop` stays green. **Measure**: the literal-add row. |
| **P10** joins + comparator | `perf(status): merge-join the sorted index and tree sequences` | `src/application/primitives/compute-changeset.ts` `computeChangeset`; `src/domain/diff/index-diff.ts` `diffIndexAgainstTreeBy`; `src/application/commands/status.ts` `buildChanges`; comparator `src/domain/git-index/index-writer.ts` `compareEntryPath`/`pathComparatorFor` | **Benefit unproven** (< 1% frames). Properties: join result = the old Map/Set result over arbitrary sorted pairs (`compute-changeset.properties.test.ts`, `index-diff.properties.test.ts`); `computeChangeset` output bytewise-ordered for surrogate vs U+E000+ paths (example + property). Gate: status/checkout rows. ADR-1017: keep only what `bench:ab` (5 rounds) shows above noise, or what moves output into git's byte-order sorting (a faithfulness fix). The PR reports each piece kept or dropped, with numbers. |
| **P11** ignore matcher + `ancestorsOf` | `perf(ignore): scan ignore rules backward and stop at the first match` | `src/domain/ignore/match.ts` `lastMatch`; `src/domain/ignore/matcher-stack.ts` `matchInStackVerbose`; new `src/domain/ignore/ancestors-of.ts` used by `internal/ignore-evaluator.ts` and `is-ignored.ts` (delete both private copies; their existing Stryker comments go with the deleted code) | **Benefit unproven** (0.9%). Property tests of §D9. `is-ignored` provenance (`level`, `ruleIndex`) unchanged. Existing ignore interop stays green. ADR-1017 gate: kept only on a measured gain. |
| **P12** benches | `test(bench): price wide commits, literal add, and directional mixed checkouts` | `test/bench/commit.bench.ts`, `test/bench/add.bench.ts`, `test/bench/checkout.bench.ts`; `test/bench/support/write-scratch.ts` (`buildWideCommitScratch`, `buildLiteralAddScratch`, `buildMixedCheckoutScratch`, ADR-1015) | No per-iteration hooks (memory: vitest bench hooks are dead); setup in the factory; teardown synchronous. Reset strategy per ADR-1015 (pre-built copy pool; checkout+reset pairs minus a reset-only row if iterations cannot be capped). Landing this part **first** (before P1) gives the orchestrator before/after rows for every perf part. Order: P12, P1, P2, P3, P4, P4b, P5, P6, P7, P8, P9, P10, P11. |

## Decisions

Adopted under ADR-226 because the pins settle them, recorded in the ADRs below: subtree order, entry counts, the
commit write timing (before the hook and the refusals, C4/C5/C8), no write when nothing changed (CW1/CW3/CW5/CW6), the
REPAIR rule for replace writers (§D1.4), `REUC` kept by commit (E5).

| # | Subject | ADR | Chosen |
|---|---|---|---|
| — | `commit` maintains `TREE`, writes it before the hook; ITA exclusion (**user-ratified fold**) | ADR-1007 | port `update_one`; ITA left out, chain invalid (§D2, R10) |
| DC-1 | `FileSystem.write` port shape; checkout creation mode with umask, no `chmod` (**user-ratified fold**) | ADR-1013 | (a) widen `write`/`writeStream`: `options?: { mode }`, resolve `FileStat` (§D6.1) |
| DC-2 | `commit`'s index-write trigger vs git's refresh | ADR-1008 | (b) port the refresh, reuse `compareAndRefresh`; write iff refreshed ∨ not fully valid (§D2.5, P4b). User-ratified against the designer's (a) |
| — | Replace writers repair `TREE` | ADR-1009 | git's REPAIR rule; supersedes ADR-964's divergence clause only (§D3) |
| DC-3 | `UNTR` maintenance | ADR-1014 | (a) keep forward-or-drop; named, bounded divergence (§D1.5) |
| DC-4 | Freshen on the valid-subtree skip | ADR-1010 | (a) existence check only, no `utime` (§D2.3) |
| DC-5 | `write_index_as_tree` routes (sequencer `--continue`) | ADR-1011 | (a) fold P6 (§D3.4) |
| — | `rm` records `REUC`, runs during pending operations (**user-ratified fold**) | ADR-1012 | fold (§D5, P7) |
| DC-6 | Checkout bench reset strategy | ADR-1015 | (a) pre-built copy pool, falling back to (b) checkout+reset pairs minus a reset-only row (§D10) |
| DC-7 | Mixed-changeset fixture | ADR-1015 | (a) write-scratch builder (§D10) |
| DC-8 | Buffered-write threshold | ADR-1016 | (a) `BUFFERED_WRITE_LIMIT = 1 MiB` (§D6.2) |
| DC-9 | Parts with an unproven benefit (P10, P11) | ADR-1017 | (a) implement, keep only a measured gain or a byte-order fix (§D8, §D9) |

### Decision candidates

One open, surfaced by this revision.

| # | Subject | Options | Recommendation |
|---|---|---|---|
| **DC-10** | Refresh on the sequencer `--continue` routes. ADR-1008 covers `commit`; ADR-1011 folds P6 for `TREE` and `REUC` only. git's `cherry-pick --continue` and `rebase --continue` refresh a touched clean file's stat (pin-continue-refresh.zsh, 2×). tsgit's do not (`compareAndRefresh`'s `refreshed` is consumed only by `status.ts`) | (a) P6 routes run P4b's scan and the same trigger through `writeIndexCacheTree`; interop Q1r/Q2r; (b) P6 writes `TREE` only (write iff not fully valid), refresh-at-continue filed as a follow-up; (c) refresh on `rebase --continue` only | **(a)**: ADR-226 points there, the code is P4b's helper plus a trigger, and P6 already touches each route. Cost: one `lstat` per entry per `--continue`, as git pays. (b) leaves a pinned gap on routes this PR edits. (c) has no basis in the pins: both routes refresh. |

## Test strategy

- **Unit**: per part (table above). Refusals are asserted field by field (try/catch + `.data`). Every isolated guard
  gets its own test (`entryCount < 0` vs missing `id`; missing object vs invalid node).
- **Property siblings**: `cache-tree-update.properties.test.ts` (P2); join equivalence (P10); matcher/ancestors
  equivalence (P11). `cache-tree.properties.test.ts` stays green.
- **Interop** (scrubbed env, signing off, `interop-helpers.ts`): `commit-cache-tree-interop.test.ts` (P4: TREE byte
  equality + rewrite parity + ITA tree oid; P4b: CW1–CW7 rewrite parity and refreshed stats), `index-extensions-interop.test.ts` (P5/P6: replace rows tightened to byte
  equality, Q1/Q2), `rm-interop.test.ts` (P7), `blob-streaming-checkout-interop.test.ts` (P8 umask row). SHA-256 twin
  for commit and checkout-replace. Every interop row also asserts `git fsck` exit 0.
- **Mutation**: P2/P3 are the dense logic. Kill tests target the `compareSubtreeNames` length branch, the ITA
  `to_invalidate` vs `contains_ita` paths, and repair-missing vs repair-present. Equivalent mutants follow the repo
  policy (prove or remove the guard).
- **Benches**: §D10, via `bench:ab` after each perf commit, 5 rounds, +10% bound.

## Risks

- **`commit` takes the index lock.** A caller that commits while another writer holds `index.lock` now gets
  `RESOURCE_LOCKED`, as `git commit` dies. That is a behaviour change visible to library callers.
- **Hook ordering change in `commit`.** The pre-commit hook now runs after an index write and with the lock released.
  A hook that relied on tsgit's old order (hook before any index access) sees git's order instead. The C8 interop row
  pins it.
- **Commit tree oids change only for ITA indexes** (R10). Any test fixture that committed an ITA entry with tsgit
  changes expectation. Grep `intentToAdd: true` under `test/` during P4.
- **Commit-time refresh cost.** Every commit now `lstat`s every tracked entry and content-compares stat-drifted or
  racy ones (§D2.5): about +5–7 ms on the 500-directory row, a large share of P4's saving. git pays the same. P4→P4b
  makes it visible on its own.
- **Commit can now run clean filters.** A stat-drifted file under a filter driver is content-compared at commit, as in
  git's refresh. A failing driver now fails `commit` where it did not before, the same way it fails `status`.
- **Repair cost on checkout.** Hashing every changed directory makes a 500-directory checkout do about 500 extra
  hash + existence calls. P8 is expected to more than offset it. P5 and P8 are measured separately so a regression is
  attributable.
- **Writer-site verifications (U2, U21)** may uncover object-set or index-write gaps in `merge`/`checkout`. They are
  in-invariant and fixed in P5, which may grow that part.
- **Port widening.** Every `FileSystem` implementation outside the repo (user adapters) must now return a stat from
  `write`/`writeStream`. It is a breaking change for third-party adapters (semver-major signal for the PR), accepted
  in ADR-1013.
- **Windows.** `mode` at create and `handle.stat()` on Windows are verified only by CI's Windows legs (memory hint).
  The PR body must ask for them.
- **Size caps.** P2/P3 add domain code. Expect a `chore(size)` bump, attributed.

## Out of scope

- `UNTR` maintenance (ADR-1014).
- `core.trustctime` (not read by tsgit; §D11).
- Partial commits (`commit <paths>`, `-a`, `--only`): tsgit `CommitOptions` has no such mode. git's `COMMIT_PARTIAL`
  path writes a temporary index and is not modelled.
- `stash push`'s `iTree` and `stash apply`'s `cTree` `write_index_as_tree` side effect (overwritten by the following
  replace write; no observable difference).
- Sparse-index directory entries in the cache-tree (`S_ISSPARSEDIR`): tsgit does not write sparse indexes.
