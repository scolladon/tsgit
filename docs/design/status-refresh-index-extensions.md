# Design — `status` refresh write-back, stat-cache arming, index extension round-trip

> Brief: make `status` an occasional index writer under git's optional `index.lock` (refresh
> write-back, `refresh?: boolean` as the structured `--no-optional-locks`); arm the
> `ie_match_stat` stat cache on every working-tree comparison (`rm`, `stash`, would-overwrite,
> apply-merge, clean-work-tree) and pool `stash`'s hashing; carry the index extensions git
> carries through every index write instead of serialising `extensions: []`. Backlog 31.4,
> run 1 = (a) + (b) + (d-i). (c) shipped in #313 (ADR-949). (d-ii), (e), (f) are out of scope
> (§Out of scope).
> Status: draft → self-reviewed ×3

<!-- cspell:ignore bytewise refreshable IEOT EOIE FSMN sdir FFFD DFFF misordered ENOSPC realise -->

## Context

### Binding constraints

| Source | Constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Every rule below comes from the pinned matrix (§D1) or from git 2.55.0 source read at the cited line, not from memory. Where the backlog's starting point disagrees with git (unknown extensions are dropped, not forwarded; the lock is taken after the refresh, not before the read), the pin wins and the gap goes to §Decision candidates. |
| ADR-249 (structured data only) | `status` gains one data option (`refresh`). No rendered text, no warning text: the "ignoring ZZZZ extension" stderr line git prints has no tsgit counterpart. |
| ADR-511 | `indexMtime` is the comparator's optional racy-guard argument. Its stated consequence ("`rm`/`stash`/clean-work-tree/apply-merge adopt it later by passing the argument") is what (b) does. No new ADR is needed for the threading itself. |
| ADR-949 | Every index write goes through `makeLock().commit`, which smudges racily-clean carried-over entries. The refresh write uses the same path, so smudging applies to it too, as git's `do_write_index` does. |
| ADR-953 / 954 | The stash W-tree capture converts through check-in conversion and, under `core.safecrlf=true`, converts and writes objects in index order (`'write'` clean-order span). Pooling `stash` keeps that span. |
| ADR-950 / 956 / #316 | The comparator's miss path converts worktree bytes (`convertedWorktreeBytes`). Arming the stat cache only adds a hit path in front of it; the miss path stays as it is. |
| ADR-209 | `compare-working-tree-entry.ts` remains the only "is this entry dirty" primitive. The refresh verdict is computed there, not in `status`. |
| ADR-021 / 023 | `reset` already reuses stat data from the index it replaces. Carrying extensions does not change that. |
| ADR-623 | `fsck` exit bit 8 = a cache-tree oid that fails to parse. A carried `TREE` must never contain an oid tsgit did not get from git or compute (§D4.3 invariant). |
| ADR-855 / 568 / 633 / 634 | Session caches: the refresh write goes through `invalidateIndexCache`. The status stat map (634) is unchanged. |
| Backlog 31.4 ruling (2026-09-10) | Recorded as PD-0 in §Decision candidates. Two of its sub-clauses conflict with the pins (§D1.3, §D1.1) and are raised as DC-1 and DC-2, not changed silently. |

All pins below ran in `mktemp -d` throwaways, never in this worktree.

### What exists today (verified in the tree, main `c38b045a`)

| Asset | File : symbol | Status for this feature |
|---|---|---|
| Index write path | `src/application/primitives/internal/index-lock.ts` — `acquireIndexLock(ctx, opts)`, `IndexLock { release, commit(entries) }`, `makeLock` (lines 108-146): `serializeIndex({ version: 2, entries: smudgeRacilyClean(…), extensions: [], trailerSha: [] })`, write `index.lock`, rename, `invalidateIndexCache(ctx)` | **Change.** `commit` takes a carry mode (§D4). New optional acquisition for `status` (§D2.3). |
| Racy smudge | `src/application/primitives/internal/smudge-racily-clean.ts` — `smudgeRacilyClean(ctx, entries)`; `carriedOver` re-reads the on-disk index through `readIndexAt` | Reused. The previous on-disk index it reads is the same one the extension carry needs (§D4.2), so it is read once. |
| Parser | `src/domain/git-index/index-parser.ts` — `parseIndex(bytes, digestLength)` accepts **v2/v3 only** (line 63, v4 → `INVALID_INDEX_HEADER`); `parseExtensions` keeps every optional extension as `{ signature, data }` (a `slice()` copy, line 233), throws on a lowercase (mandatory) one; `parseCacheTree(data, digestLength)` | Reused. No cache-tree **serialiser** exists → new (§D4.3). |
| Writer | `src/domain/git-index/index-writer.ts` — `serializeIndex(index, digestLength)` writes `index.extensions` in order; version = 3 iff an entry has extended flags else 2 (lines 75-80); `compareEntryPath` (lines 42-47) compares with JS `<`, i.e. **UTF-16 code-unit order** | Writer reused. Comparator: DC-8. |
| REUC decoder | `src/domain/git-index/resolve-undo.ts` — `parseResolveUndo` (read-only; consumed by `fsck/roots.ts`) | No change. REUC is carried as opaque bytes. |
| Index model | `src/domain/git-index/index-entry.ts` — `GitIndex { version: 2\|3, entries, extensions, trailerSha, indexMtime? }`, `IndexExtension { signature, data }`, `CacheTreeEntry` | Reused. `trailerSha` is what git's `verify_index` compares (§D2.3). |
| Read | `src/application/primitives/read-index.ts` — `readIndex(ctx)`, `readIndexAt(ctx, stat)`, `indexMtimeFrom(stat)`, `invalidateIndexCache(ctx)` | Reused. |
| Comparator | `src/application/primitives/compare-working-tree-entry.ts` — `compareWorkingTreeDelta(ctx, entry, provider?, indexMtime?)`, `compareWorkingTreeEntry(ctx, entry, provider?)` (no `indexMtime`), `statOnlyVerdict`, `convertedWorktreeBytes`, `readThresholdBeforeHashing` | **Change.** Gains a refresh-reporting variant (§D2.1) and `indexMtime` on the enum projection (§D3). |
| Stat-cache rules | `src/application/primitives/internal/is-entry-stat-clean.ts` — `IndexMtime`, `isRacy` (**nanosecond-aware**), `matchesContentStat`, `isEntryStatClean` | Reused, plus a second-granularity `hasRacyTimestamp` (DC-2). |
| Entry from stat | `src/application/primitives/internal/index-entry-from-stat.ts` — `indexEntryFromStat(stat, mode, id, path)` (sets `STAGE0_FLAGS`) | The refresh needs a variant that keeps the entry's flags, id and mode (§D2.1). |
| `status` | `src/application/commands/status.ts` — `status(ctx)` (no options), `statusInScope`, `scanStatusTree`, `scanWorkingTree` (pooled, `ioBound`), `configuresFilterDriver`, `scanUntracked`; facade `src/repository.ts:970-973` | **Change** (§D2). |
| Internal `status` callers | `describe.ts` `computeDirty` (line 169), `worktree.ts` `worktreeRemove` (line 382), `submodule.ts` `assertSubmoduleClean` (line 426) | Keep the default `refresh` (pinned §D1.8). |
| Stat-cache-less comparisons | `rm.ts` `classifyEntries` (line 165, sequential loop); `stash.ts` `classifyTracked` (line 234), `projectWorkingTree`, `hashUntracked` (all sequential `for…await`); `find-would-overwrite.ts` `findWouldOverwrite` (line 119, sequential); `apply-merge-to-worktree.ts` → `findWouldOverwrite` (line 481); `commands/internal/clean-work-tree.ts` (line 64) | **Change** (§D3). |
| Pooling pattern | `add.ts` `stageWalkedEntries` / `dispatchInCleanOrder` (lines 320-400): `withCleanOrder(ctx, …, span)`, `limiterFor(ctx, 'ioBound')`, `span = safeCrlf === true ? 'write' : 'clean'` | Template for `stash` (§D3.2). |
| Env | `Context.env?: EnvReader` (`src/ports/context.ts:311`); precedent `resolve-notes-ref.ts:50` (`GIT_NOTES_REF`) | `GIT_OPTIONAL_LOCKS` read through it (DC-4). |
| Error mapping | Node `mapErrno` (`node-file-system.ts:301-330`): `EACCES`/`EPERM` → `PERMISSION_DENIED`; anything unlisted (incl. **`EROFS`**) → `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EROFS' }`. Memory adapter: no read-only mode. Browser (`browser-file-system.ts:80-90`): OPFS `DOMException`s propagate **unmapped** | Degrade predicate (§D2.4, DC-3). |
| Benches | `test/bench/status.bench.ts` (tiered, on the **shared read-only** fixture cache), `status-dirty.bench.ts`, `support/fixture-scratch.ts` `copyFixtureToScratch`, `support/tiered-bench.ts`; no `stash` bench | §D6. |

### Pinning harness

```sh
g() { env -i PATH="<git-2.55.0>/bin:/usr/bin:/bin" HOME=<tmp>/home GIT_CONFIG_NOSYSTEM=1 \
        GIT_CEILING_DIRECTORIES=<tmp> $EXTRA_ENV \
        git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }
idx() { python3 -I <scratch>/idx.py "$@"; }   # prints "v<version> n=<entries> exts=<SIG>[<len>]#<sha1-8 of payload>,…",
                                              # the decoded TREE ("<path>:<entry_count>/<subtrees>[:<oid7>]"), and
                                              # with --entries each entry's stage/flags/size/mtime/ctime/ino;
                                              # --add-ext SIG:hex appends an extension and re-hashes the trailer
$ g version
git version 2.55.0
```

"Rewritten" means `.git/index` got a new inode (a lock-file rename), not just new bytes. A rewrite with identical
bytes is still a rewrite, and a shasum would miss it. Settling = `sleep 1.1; g status; sleep 1.1`, so no entry is
racy at the start of a probe. git source references are to the `v2.55.0` tag (`read-cache.c`, `builtin/commit.c`).

## Requirements

- **R1** `status` refreshes the stat data of every stage-0 entry whose content is unchanged but whose stat fields
  moved. It writes the index exactly when git does: an entry was refreshed, **or** an entry is racy against the
  index as read (§D1.1, DC-2). The written index is byte-equivalent to git's under readback (entries, flags, ids,
  extensions per §D1.4).
- **R2** `status` never writes when `refresh: false`, when `GIT_OPTIONAL_LOCKS` is false (DC-4), when `index.lock`
  exists, or when the lock cannot be created on a read-only `.git`. In all four cases it returns the same
  `StatusResult` it returns today and does not throw (§D1.2).
- **R3** A concurrent index writer can never lose an update to a `status` refresh write (§D2.3, DC-1).
- **R4** The `StatusResult` is identical with and without refresh. The refresh changes what is on disk, not what
  status reports.
- **R5** `rm`, `stash`, `findWouldOverwrite` (merge, apply-merge-to-worktree) and clean-work-tree get the same
  verdicts as today with the stat cache armed. The miss path still converts through check-in conversion.
- **R6** `stash push` hashes tracked and untracked files through a bounded pool. Under `core.safecrlf=true` it keeps
  ADR-954's index-order conversion and write span (refusal data and loose-object set unchanged).
- **R7** A refresh-only write (status) keeps `TREE`, `REUC` and `UNTR` byte-identical. It drops `UNTR` when
  `core.untrackedCache=false`, and it drops unknown optional extensions (§D1.4).
- **R8** Every other index write carries extensions per the policy of §D4: `TREE` stays valid only for directories
  whose entries did not change, `REUC` follows git's keep/drop per writer class, `UNTR` is kept only when the
  tracked-path set is unchanged, and unknown extensions are dropped. A carried `TREE` never claims an oid for a
  directory whose entries changed.
- **R9** Hash width: carried `TREE` / `REUC` / `UNTR` bytes and the trailer check work for SHA-1 and SHA-256
  repositories.
- **R10** (conditional on DC-8) Index entries are written in git's bytewise path order.
- **R11** Mandatory-extension and v4 refusals are unchanged (`INVALID_INDEX_*`).
- **R12** Benches show the state that CI measures: `status` on a stat-invalid copy (the CI cache restore) and on a
  settled fixture, plus a `stash` scenario.

## Design

### D1. Pinned behaviour (git 2.55.0)

#### D1.1 When `status` writes the index

Fixture: `a b d/c d/e/f` committed, then settled.

| # | Probe | Rewritten | Notes |
|---|---|---|---|
| Q1 | settled, nothing moved, `g status --porcelain` | no | |
| P3 | `touch b` (same content), `g status` | **yes** | `b`'s entry gets the new mtime/ctime; size, id and ino are unchanged |
| R2 | `tar cf` + `tar xf` copy of the repo (ino + ctime move on every file), `g status` | **yes**; a second `g status` → no | `TREE` is byte-identical before and after (`TREE[77]#685ec909`) |
| P11 | content of `d/e/f` changed, nothing else moved | no | a dirty entry is not refreshable (`refresh_cache_ent` keeps it), so `cache_changed` stays 0 |
| Q2 | `echo a2 > a; g add a; g status` (`a`'s mtime is in the same second as the index) | **yes**; again in the same second → yes; after 1 s → yes; then settled → no | racy-only rewrite: `repo_update_index_if_able` writes on `cache_changed \|\| has_racy_timestamp` (`read-cache.c:2748-2757`) |
| Q4 | `touch -t <now, :00 ns> b` (mtime `…946.0`, index `…946.085`) → status, then status again | yes, yes | the build tests raciness **at second granularity**: `is_racy_stat` (`read-cache.c:355-368`) compares nanoseconds only under `USE_NSEC`, and this binary behaves as built without it. The racy trigger therefore fires for an entry in the same second as the index even when the entry's nanoseconds are smaller. tsgit's `isRacy` compares nanoseconds (DC-2) |
| P10 | `touch b d/c; g status -- d` | yes, **both** refreshed | tsgit `status` takes no pathspec, so this is recorded only |

#### D1.2 Suppressors and degradation

| # | Probe | Exit | Rewritten | stderr |
|---|---|---|---|---|
| P4 | `touch b; GIT_OPTIONAL_LOCKS=0 g status` | 0 | no | — |
| P9 | `GIT_OPTIONAL_LOCKS=false g status` | 0 | no | — |
| P9 | `GIT_OPTIONAL_LOCKS=bogus g status` | **128** | no | `fatal: bad boolean environment value 'bogus' for 'GIT_OPTIONAL_LOCKS'` |
| P5 | `g --no-optional-locks status` | 0 | no | — |
| Q3 | racy-only state, `GIT_OPTIONAL_LOCKS=0` | 0 | no | — |
| P6 | `: > .git/index.lock; g status` | 0 | no; the lock is left untouched (0 bytes) | — |
| P7 | `chmod a-w .git; g status` | 0 | no | — |
| P7b | `chmod a-w .git/index` (directory writable) | 0 | **yes** (the rename replaces the read-only file) | — |
| P8 | plain `g status` afterwards | 0 | yes | — |

Source: `cmd_status` takes the lock with `repo_hold_locked_index(…, 0)` (`builtin/commit.c:1634-1635`). Flags `0`
means no `LOCK_DIE_ON_ERROR` and no `LOCK_REPORT_ON_ERROR`, so **any** failure to create the lock gives `fd < 0`
and status continues read-only. A failed write after that is not reported either: `repo_update_index_if_able`
ignores `write_locked_index`'s return value (`read-cache.c:2754`).

#### D1.3 git's ordering: refresh first, then lock, then verify

`builtin/commit.c:1629-1658` (v2.55.0):

```c
repo_read_index(the_repository);
refresh_index(the_repository->index, REFRESH_QUIET|REFRESH_UNMERGED|progress_flag, &s.pathspec, NULL, NULL);
if (use_optional_locks())
        fd = repo_hold_locked_index(the_repository, &index_lock, 0);
...
wt_status_collect(&s);
if (0 <= fd)
        repo_update_index_if_able(the_repository, &index_lock);
```

`repo_update_index_if_able` writes only if `repo_verify_index` passes (`read-cache.c:2695-2733`), and
`repo_verify_index` passes only if the trailing hash of the **on-disk** index still equals the hash of the index
that was read. Otherwise it rolls the lock back. So git takes the lock **after** the read and the refresh. It
holds the lock across `wt_status_collect` (the diffs and the untracked scan), and it prevents a lost update
by comparing trailer hashes, not by holding the lock before the read. The 2026-09-10 ruling says "before reading".
This is DC-1.

#### D1.4 Extensions on a refresh-only write

Base: a resolved-and-committed merge conflict (gives `REUC`), `core.untrackedCache=true` + two settled `status`
runs (gives `UNTR`), and an unknown optional extension `ZZZZ` appended with `idx --add-ext ZZZZ:deadbeef`.

| # | Probe | Result |
|---|---|---|
| — | any git read of the index with `ZZZZ` | stderr `ignoring ZZZZ extension`, exit 0 |
| E1 | `touch b; g status` | rewritten; `TREE[77]#8b6d51d8` and `REUC[83]#a6f5f4d9` identical, **`ZZZZ` dropped** |
| E6 | `touch b; g update-index --refresh` | same: `TREE`/`REUC` identical, `ZZZZ` dropped |
| E2 | `core.untrackedCache=true`, first `status` | `UNTR[425]` **created** (git builds the untracked cache in status. tsgit has no untracked cache, see §Out of scope) |
| E3 / E4 | settled / `touch b` with `UNTR` present | not rewritten / rewritten with `UNTR` identical |
| U1 | `core.untrackedCache=false`, `touch b; g status` | rewritten, **`UNTR` dropped** (`tweak_untracked_cache`, `read-cache.c:1908-1916`) |
| U2 | `core.untrackedCache` unset, new untracked dir, `touch b; g status` | rewritten with **`UNTR` updated** (337 → 392 bytes) |
| R3 | `REUC` present, `touch b; g status` | `REUC[83]` identical |
| S1 | `--object-format=sha256`, `touch b; g status` | `TREE[75]` (32-byte oids) identical |
| I1 | `index.recordEndOfIndexEntries=true`, `index.recordOffsetTable=true`, `index.threads=2`, `add` | `IEOT[20]`, `TREE`, `EOIE[24]`, in that order. A later refresh write regenerates them from config |

On-disk order observed in every write: `IEOT`?, `TREE`, `REUC`, `UNTR`, `EOIE`?.

#### D1.5 Extensions per writer class

Each row: a fresh repo built **in place** (the `UNTR` ident embeds the worktree path, so a `cp -R` copy resets it)
with `TREE` + `REUC` + `UNTR` + `ZZZZ`, settled, then one writer. Columns compare each extension with its
pre-writer bytes. `TREE` decoding uses the §Pinning harness notation; base `TREE`:
`<root>:5/2:445d5a6 d:2/1:4c23338 e:1/0:393df4a x:1/0:43756b7`.

| Writer (git) | TREE | REUC | UNTR | ZZZZ | TREE after |
|---|---|---|---|---|---|
| `status` (touch b) / `update-index --refresh` | same | same | same | dropped | unchanged |
| `add d/c` (modified) | chain invalidated | same | same | dropped | `<root>:-1 d:-1 e:valid x:valid` |
| `add d/e/n` (new) | chain invalidated | same | changed | dropped | `<root>:-1 d:-1 e:-1 x:valid` |
| `add b` (unchanged, stat unchanged) | — no write — | | | same | |
| `touch b; add b` (stat moved, same oid) | **root invalidated** | same | same | dropped | `<root>:-1`, rest valid |
| `add -A` (adds `d/untracked`) | chain | same | changed | dropped | |
| `add -N d/i` | chain; **v3** | same | changed | dropped | |
| `add --renormalize .` | every dir invalidated | same | same | dropped | |
| `rm d/c` | chain | same | changed | dropped | |
| `rm --cached x/y` | chain | same | changed | dropped | |
| `mv b d/b2` | chain (root, d) | same | changed | dropped | |
| `reset` (mixed, same HEAD) | same | same | same | dropped | |
| `reset HEAD~1` (mixed) | chain of the changed path | same | same | dropped | |
| `reset --soft HEAD~1` | — no write — | | | same | |
| `reset --hard` | same | **dropped** | same | dropped | |
| `reset --hard HEAD~1` | **fully valid, new oids** | dropped | changed | dropped | `<root>:5/2:ac6022d …` |
| `reset -- x/y` | chain | same | same | dropped | |
| `checkout other` | **fully valid, new oids** (incl. new `z`) | dropped | changed | dropped | `<root>:6/3:be042a9 … z:1/0:ca0e761` |
| `checkout -- x/y` | same | same | same | dropped | |
| `checkout other -- x/y` | chain | same | same | dropped | |
| `merge other` (clean) / `cherry-pick` / `rebase` (clean) | fully valid | dropped | changed | dropped | |
| `merge` (conflicted) / `revert` (conflicted) | chain of conflicted paths, rest valid | dropped | changed | dropped | `<root>:-1/3 … x:-1/0 z:1/0:ca0e761` |
| `stash push` / `stash push -u` | same (reset --hard) | dropped | same | dropped | |
| `stash apply` / `stash pop --index` | chain / fully valid | dropped | changed | dropped | |
| `sparse-checkout set` | same (v3) | same | same | dropped | |
| `commit` (after add) | fully valid (recomputed) | same | same | dropped | |
| `read-tree HEAD` | fully valid | dropped | **dropped** | dropped | |
| `clone`, `worktree add` (fresh index) | fully valid | — | — | — | `TREE[51]` |

Reading of the table:
- git drops unknown extensions on **every** write.
- `TREE` is changed in exactly two ways. Writers that touch entries in place invalidate the ancestor chain of
  every entry they replace, even when its oid did not change (`cache_tree_invalidate_path`). Writers that go
  through `unpack_trees` or `commit` recompute it fully (`cache_tree_update`).
- `REUC` is dropped by every `unpack_trees`-class writer (`resolve_undo_clear`) and kept by in-place writers.
  git also *adds* `REUC` records when `add`/`rm` resolves a conflicted path (the base row above). tsgit does not
  record resolve-undo today (§Out of scope).
- `UNTR` is invalidated per directory whenever the tracked-path set changes.

#### D1.6 Index version

| # | Probe | Result |
|---|---|---|
| V1 | `update-index --index-version 4`, then refresh write, then `add` | stays **v4** (tsgit cannot read v4: `index-parser.ts:63`, unchanged by this design) |
| V2 | `update-index --index-version 3` with no extended entry | written as **v2** |
| V3 | skip-worktree set (v3) then cleared | **v2** |
| V4 | `index.version=4` config on an existing v2 index, refresh write and `add` | stays **v2** (config applies to a newly created index only) |
| V5 | `feature.manyFiles=true`, `add` on an existing v2 index | stays v2, **`UNTR` created** |

tsgit's writer rule ("v3 iff an extended entry, else v2", `index-writer.ts:75-80`) already matches V2/V3/V4 for
the versions tsgit reads.

#### D1.7 Path order

```sh
printf a > "$(printf '\xf0\x9f\x98\x80').txt"   # U+1F600, UTF-16 D83D DE00
printf b > "$(printf '\xef\xbf\xbd').txt"       # U+FFFD,  UTF-16 FFFD
g add . && g ls-files -s                         # git order: U+FFFD.txt first (EF < F0)
```

tsgit's `compareEntryPath` puts `😀.txt` first (`0xD83D < 0xFFFD`). With the two entries swapped into tsgit's order
(trailer re-hashed):

| Command | Exit | Effect |
|---|---|---|
| `g fsck` | **128** | `fatal: unordered stage entries in index` |
| `g ls-files`, `g status`, `g write-tree`, `g update-index --refresh`, `g read-tree HEAD` | 0 | `write-tree` = HEAD's tree |
| `g add -A` on the misordered index | 0 | the index now holds **3 entries: `😀.txt` twice** |

#### D1.8 Internal `status` consumers

| Probe | Rewritten |
|---|---|
| `touch b; g describe --dirty` | **yes** |
| `touch b; g describe` | no |
| superproject `g status` with a touched file in a submodule | the **submodule's** index is rewritten |
| `g submodule status` | child index not rewritten |
| `g worktree remove` | the worktree and its index are deleted (rewrite unobservable) |

### D2. (a) `status` refresh write-back

#### D2.1 Refresh verdict in the comparator

`git refresh_cache_ent` updates an entry's stat data when `ie_match_stat` reports a change and the content still
matches. A dirty, mode-changed, type-changed, intent-to-add, skip-worktree or assume-valid entry is never
refreshed. tsgit computes this verdict where the stat and the hash already meet:

```ts
// src/application/primitives/compare-working-tree-entry.ts
export interface RefreshedComparison {
  readonly delta: WorkingTreeDelta;
  /** Present iff the verdict is `unchanged` and the stat fields moved: the entry with fresh stat data. */
  readonly refreshed?: IndexEntry;
}
export const compareAndRefresh = (
  ctx: Context, entry: IndexEntry, provider: AttributeProvider | undefined, indexMtime: IndexMtime | undefined,
): Promise<RefreshedComparison>;
```

- It reuses `compareWorkingTreeDelta`'s body, factored so the `FileStat` it already holds is visible. It makes no
  second `lstat` and no extra read. `compareWorkingTreeDelta` becomes `(await compareAndRefresh(…)).delta`.
- `refreshed` = `withStatData(entry, stat)`: a new helper in `internal/index-entry-from-stat.ts` that copies
  ctime/mtime (s+ns)/dev/ino/uid/gid/size from the stat and keeps `id`, `mode`, `flags`, `path`.
  `indexEntryFromStat` is refactored to call it.
- `refreshed` is set only when `delta.status === 'unchanged'`, `!matchesContentStat(entry, stat)`, and the entry
  is not `assumeValid`, not `skipWorktree`, not `intentToAdd`, not a gitlink, and stage 0. `skipWorktree` is
  already filtered in `status`. Gitlinks are excluded: their dir stat is what git stores, and tsgit has not pinned
  how a gitlink's stat is refreshed (prove with: touch a submodule dir's mtime, then compare `ls-files --debug` before and after `g status`).
- The miss path does not change: `readThresholdBeforeHashing`, `readWorkingBytes`, `convertedWorktreeBytes`,
  `serializeAndHash`.

#### D2.2 Write trigger

```ts
// src/application/primitives/internal/is-entry-stat-clean.ts
/** git's `has_racy_timestamp` as built by default (no USE_NSEC): second granularity, gitlinks excluded. */
export const hasRacyTimestamp = (entries: ReadonlyArray<IndexEntry>, indexMtime: IndexMtime): boolean;
```

Write iff `refreshed.length > 0 || hasRacyTimestamp(index.entries, index.indexMtime)` (DC-2). With no index file
(`indexMtime` undefined) nothing is racy and there is nothing to refresh.

#### D2.3 Lock lifecycle (DC-1, recommended option shown)

```
statusInScope
  gate, readHeadRaw, readIndex (entries + trailerSha + indexMtime)
  scanStatusTree        ── tracked pass = git's refresh_index (collects refreshed entries)
  optional lock         ── acquireOptionalIndexLock(ctx): IndexLock | undefined   (only when refresh enabled)
  reportStatus + untracked pass  (= wt_status_collect; the lock is held)
  if lock: updateIndexIfAble(lock, index, refreshed)   ── always releases or commits
  return result
```

- New in `index-lock.ts`:
  `acquireOptionalIndexLock(ctx): Promise<IndexLock | undefined>`. One `writeExclusive`. It **never breaks a
  stale lock**: git's optional acquisition uses timeout 0 and no stale break. On any degrade-class error
  (§D2.4) it returns `undefined`. Any other error propagates.
- `updateIndexIfAble`: if the trigger (§D2.2) is false → `release`. Otherwise →
  `lock.commitRefresh(index, refreshed)` (§D4.1). It reads the on-disk index once (the read the smudge and carry
  need anyway; the session cache serves it when the stat is unchanged). If that index's `trailerSha` differs from
  `index.trailerSha`, or the file is gone, it releases and writes nothing (git's `verify_index_from`). Otherwise it
  copies **only the stat fields** of each refreshed entry onto the matching `(path, stage)` entry of `index.entries`
  and writes. No path, id, mode, stage or flag can change on this path, by construction, so the `refresh` carry
  rules (`TREE` verbatim) are always sound.
- `scanStatusTree` today runs the tracked and the untracked pass together (`status.ts:181-192`). It splits so the
  optional lock is taken between them (P17).
- The lock is released in a `finally` on every path, a throwing report included.
- Racy smudge: `commit` → `smudgeRacilyClean` reads the on-disk index for its carried-over set. Refreshed entries
  have new stat data, so they are not "carried over" and are never smudged. This matches git, where refreshed
  entries are `CE_UPTODATE`.

#### D2.4 Degradation

The degrade predicate is a pure function on the thrown value:

| Origin | Code | Degrade? |
|---|---|---|
| lock exists (`FILE_EXISTS` from `writeExclusive`) | mapped to "no lock" before any `RESOURCE_LOCKED` is built | yes |
| Node `EACCES` / `EPERM` | `PERMISSION_DENIED` | yes |
| Node `EROFS` | `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'EROFS' }` | yes |
| Browser OPFS `DOMException` (`NoModificationAllowedError`, `NotAllowedError`) | unmapped today | DC-3 |
| anything else (`ENOSPC`, `EIO`, …) at acquisition or commit | — | DC-3 |

On a degrade at **commit** time (write or rename fails after the lock was taken), `release` runs and status returns
its result. This is git's ignored `write_locked_index` return.

#### D2.5 Options and env

```ts
export interface StatusOptions {
  /** Refresh stale stat data into the index under git's optional lock (default true).
   *  `false` is `git --no-optional-locks status`: the index is never written. */
  readonly refresh?: boolean;
}
export const status = (ctx: Context, opts: StatusOptions = {}): Promise<StatusResult>;
```

- The facade `repository.ts:970-973` forwards `opts`. Update `reports/api.json` in the same commit (public TSDoc).
- `GIT_OPTIONAL_LOCKS` (DC-4, recommended (a)): read through `ctx.env?.get` with git's boolean grammar (reuse the
  config boolean parser). `false` → refresh off, **even with `refresh: true`**, as git's env wins over its
  default. An invalid value refuses status with structured data `{ variable: 'GIT_OPTIONAL_LOCKS', value }`,
  mirroring P9's exit 128. The planning phase checks whether an existing error code fits or a new one is needed.
- Internal callers (§D1.8): `describe` `computeDirty` → default (git rewrites). `worktreeRemove` → default (unobservable).
  `submodule` `assertSubmoduleClean` → default (git's superproject status rewrites the child index).

#### D2.6 Attribute memo (pre-decided intent; realisation is DC-9)

The per-file cost on the miss path is `resolveConversion → resolveFilterDriver(…, { eagerSectionValidation: true })`.
`status` already computes `configuresFilterDriver(ctx)` once (`status.ts:271-274`). Recommended realisation: thread
that verdict into the comparator scope. With no `[filter "<d>"]` section, `resolveConversion` skips the
filter-driver resolution and eager validation (there is nothing to validate), and only the `text`/`eol`/`ident`
attribute lookups remain. They are served by the provider's existing per-directory cache. `readEolSettings` is
already memoised per config object.

### D3. (b) Stat cache everywhere, `stash` pooled

#### D3.1 Threading `indexMtime`

`compareWorkingTreeEntry(ctx, entry, provider?, indexMtime?)` gains the same optional fourth argument as
`compareWorkingTreeDelta` (ADR-511's shape). The sites:

| Site | Index source | Change |
|---|---|---|
| `rm.ts` `classifyEntries` (line 165) | `readIndex` under the lock (line 78) | pass `index.indexMtime` (thread through `classifyEntries`) |
| `stash.ts` `classifyTracked` (line 234) | `findLocalChanges` → `readIndex` (line 288) | pass `index.indexMtime` |
| `find-would-overwrite.ts` `findWouldOverwrite` (line 119) | `currentIndex: GitIndex` | pass `currentIndex.indexMtime` |
| `apply-merge-to-worktree.ts` (line 481) | `input.currentIndex` | callers must keep `indexMtime` when they synthesise a stage-0 index (`rebase-merges-steps.ts:148` passes `readIndex` directly; `stash.ts:753` passes `trees.currentIndex`, so check it carries `indexMtime`). A synthesised index without it falls back to read + hash, so behaviour stays correct |
| `merge.ts:1656` | `currentIndex` | same |
| `commands/internal/clean-work-tree.ts` (line 64) | `readIndex` at lines 71/86/95 | pass `indexMtime` |

**Safety**: the racy guard compares each entry with the mtime of the index file the entries were read from. An
entry synthesised in memory carries stat data from a later `lstat`, so it is racy (mtime ≥ index mtime) and is
re-hashed. An entry with zeroed stat data never matches. Arming therefore only adds hits that git would also
take. The size-only `modified` verdict (`statOnlyVerdict`) is git's `ie_modified` and also applies once armed. It
is already pinned for `status` (the `[filter *].required` case).

Unlike `status`, these sites do not write refreshed stat data back. git's `rm` refreshes in memory and writes as
part of its own index write. Carrying refreshed entries into `rm`'s write is not needed for R5 and is left out
(§Out of scope, one line).

#### D3.2 `stash` pooling

`classifyTracked`, `projectWorkingTree` and `hashUntracked` become `boundedMapFor(ctx, 'ioBound', …)` passes.
`classifyTracked` runs a clean driver through the comparator, so it uses status's ordering rule: with a
`[filter]` section configured, it runs under `withCleanOrder` with every stage-0 path enlisted (`status.ts`
`inIndexOrder`, lines 276-285). That helper moves to `primitives/internal/clean-order.ts` so both commands share it.
Results stay in input order, which `boundedMap` already guarantees by index. Hashing that writes objects runs
inside `withCleanOrder(ctx, …, span)` with `span = scope.settings.safeCrlf === true ? 'write' : 'clean'`,
exactly as `add.ts:332` does. The `eolNotices` are collected in input order from the ordered results. The first
refusal in index order wins (ADR-954): the `stagedOutcomes` pattern (`add.ts:365-372`, settle everything, then
throw the earliest failure).

### D4. (d-i) Extension carry

#### D4.1 Commit API

```ts
// src/application/primitives/internal/index-lock.ts
/** What the write did to the index, which decides what each extension may keep (git's per-writer classes, §D1.5). */
export type IndexWriteKind = Exclude<CarryKind, 'refresh'>;  // CarryKind: src/domain/git-index/carry-extensions.ts
/*  | 'update'    // entries replaced in place (add, rm, mv, mixed reset, checkout <paths>, sparse-checkout, submodule add)
    | 'replace'   index rebuilt from a tree or a merge (checkout <branch>, reset --hard, merge family, stash, pull, clone) */
export interface IndexLock {
  readonly release: () => Promise<void>;
  readonly commit: (entries: ReadonlyArray<IndexEntry>, kind: IndexWriteKind) => Promise<void>;
  /** status only: stat data of `refreshed` copied onto `read.entries`; writes nothing and releases when the
   *  on-disk trailer no longer equals `read.trailerSha`. Resolves whether it wrote. */
  readonly commitRefresh: (read: GitIndex, refreshed: ReadonlyArray<IndexEntry>) => Promise<boolean>;
}
```

The `refresh` column of §D4.2 is reachable only through `commitRefresh`.

`commit` reads the previous on-disk index once (`readIndexAt`, which the session cache serves when nothing changed)
and gives the result both to `smudgeRacilyClean` (its `carriedOver` set) and to `carryExtensions`. An absent or
corrupt previous index → no extensions. This is what `entriesAsRead` already does for the smudge.

#### D4.2 Policy (pure, `src/domain/git-index/carry-extensions.ts`)

```ts
/** Domain-owned (the application layer imports it): `refresh` is reachable only through `commitRefresh`. */
export type CarryKind = 'refresh' | 'update' | 'replace';
export interface IndexChange {
  readonly changedPaths: ReadonlyArray<FilePath>;   // (path, stage) added, removed, or with a different id/mode
  readonly trackedSetChanged: boolean;               // a path appeared or disappeared
  readonly resolvedUnmerged: boolean;                // a path had stage > 0 before and only stage 0 after
}
export const diffIndexEntries = (before: ReadonlyArray<IndexEntry>, after: ReadonlyArray<IndexEntry>): IndexChange;
export const carryExtensions = (
  previous: ReadonlyArray<IndexExtension>, change: IndexChange, kind: CarryKind,
  settings: { readonly untrackedCache: boolean | undefined; readonly digestLength: 20 | 32 },
): ReadonlyArray<IndexExtension>;
```

| Extension | `refresh` | `update` | `replace` |
|---|---|---|---|
| `TREE` | verbatim | `invalidateCacheTree(changedPaths)` (DC-6) | `invalidateCacheTree(changedPaths)` (DC-6; git recomputes here, §D1.5) |
| `REUC` | verbatim | verbatim, **dropped if `resolvedUnmerged`** (tsgit cannot record the new resolution) | dropped |
| `UNTR` | verbatim; dropped if `core.untrackedCache=false` | verbatim iff `!trackedSetChanged` and the config is not false, else dropped | same rule as `update` |
| `EOIE`, `IEOT`, `FSMN` | dropped (tsgit writes none; git regenerates them from config) | dropped | dropped |
| any other optional | dropped (git, §D1.4–§D1.5) — DC-5 | dropped | dropped |
| mandatory (`link`, `sdir`, …) | unreachable: the parser refuses the read (R11) | | |

Why a forwarded `UNTR` stays sound: the rule forwards it only when no path moved between tracked and untracked.
In that case the write itself leaves the untracked set unchanged, so the forwarded cache is exactly as valid as it
was before the write. Changes to the worktree are git's own stat-based revalidation's job, as they are for an
index nobody rewrote.

Output order: `TREE`, `REUC`, `UNTR` (§D1.4). `diffIndexEntries` runs only for `update`/`replace`. It first
sorts copies of both lists by `(comparePaths, stage)` (bytewise, precomputed keys as `sortByPath` does). An index
written by an older tsgit is in UTF-16 order, and caller entry lists arrive unsorted, so a join over unsorted input
could miss a changed path and break the §D4.3 invariant. After the sort it is an O(n) merge-join with no Map. `diffIndexEntries` ignores flags, so a sparse-checkout
flag flip is not a change (§D1.5 row `sparse-checkout`: `TREE` same).

#### D4.3 Cache-tree invalidation (`src/domain/git-index/cache-tree.ts`)

```ts
export const serializeCacheTree = (root: CacheTreeEntry, digestLength: 20 | 32): Uint8Array;  // inverse of parseCacheTree
export const invalidateCacheTree = (root: CacheTreeEntry, paths: ReadonlyArray<FilePath>): CacheTreeEntry;
```

- `invalidateCacheTree` transcribes `do_invalidate_path` (`cache-tree.c`). For each path, every node on the
  directory chain from the root to the path's parent gets `entryCount = -1` and no `id`. When the path's last
  component names an existing subtree (a directory replaced by a file or deleted), that subtree is removed and
  `subtreeCount` is decremented. Untouched subtrees keep the same object (`toBe`), so their bytes are unchanged.
- The **invariant** that ADR-623 needs: after invalidation, a node with `entryCount >= 0` covers no changed path.
  Only oids git wrote, or that tsgit carried unchanged, survive.
- A parse failure of a carried `TREE` (a corrupt payload git wrote) drops `TREE` and does not refuse the write.
  This matches the smudge's "a corrupt index carries no stat data over".
- SHA-256: both functions take `digestLength`, the same width as `parseCacheTree`.

#### D4.4 Writer table (every `commit` call site)

| Module : function (line) | git counterpart | Kind |
|---|---|---|
| `commands/status.ts` (new) | `status` | `commitRefresh` |
| `commands/add.ts` ×4 — `addLiteralOnly` (213), `addByPathspec` (450), `addRenormalized` (486), `addAll` (669) | `add` | `update` |
| `commands/rm.ts` (112) | `rm` | `update` |
| `commands/mv.ts` (122) | `mv` | `update` |
| `commands/reset.ts` `rebuildIndexFromCommit` (147) | `reset [--mixed] <commit>` | `update` |
| `commands/reset.ts` `hardResetFromCommit` (201) | `reset --hard` | `replace` |
| `commands/checkout.ts` `switchBranch` (265) | `checkout <branch>` | `replace` |
| `commands/checkout.ts` `materializePathRestoreLocked` (419) | `checkout [<tree>] -- <paths>` | `update` |
| `commands/internal/apply-sparse-checkout.ts` (218) | `sparse-checkout set/reapply` | `update` |
| `commands/submodule.ts` `stageSubmodule` (633) | `submodule add` | `update` |
| `commands/merge.ts` `materialiseAndApply` (1008), `underIndexLock` (1672) | `merge` | `replace` |
| `commands/pull.ts` `fastForwardWorkTree` (446), `internal/pull-into-void.ts` (51) | `pull` (ff / into unborn) | `replace` |
| `commands/cherry-pick.ts` (257), `commands/revert.ts` `applyOneRevert` (147) | `cherry-pick`, `revert` | `replace` |
| `commands/internal/replay-sequence.ts` (183, 245), `internal/rebase-merges-steps.ts` (154, 157) | `rebase` picks | `replace` |
| `commands/stash.ts` `resetAfterPush` (520), `reinstateIndex` (634), apply (716) | `stash push` / `apply` / `pop` | `replace` |
| `commands/internal/reset-worktree.ts` (38) | `reset --hard` (internal) | `replace` |
| `primitives/materialize-worktree-from-head.ts` (27), `commands/worktree.ts` (212) | `clone` / `worktree add` checkout | `replace` (usually no previous index → nothing to carry) |

That is 18 modules and 28 `commit` sites, plus the new `status` site. Each site is a one-word change. The type
system makes the migration total, because `kind` is required.

### D5. Path order (only if DC-8 = fix in run 1)

The problem is `compareEntryPath` (`index-writer.ts:42-47`). UTF-16 code-unit order equals UTF-8 byte order except
when a surrogate (`D800–DFFF`) is compared with `E000–FFFF`. The fix compares code units and, at the first
difference, maps units `≥ 0xD800` with the usual fix-up (`c >= 0xE000 ? c - 0x800 : c + 0x2000`). It needs no
allocation and stays O(1) per comparison, so the hot sort keeps its cost. The same comparator replaces the three
in-memory pre-sorts that feed the writer: `build-index-from-tree.ts:133`, `materialize-tree.ts:170`,
`apply-merge-to-worktree.ts:293`. `materialize-tree.ts:193` already uses `compareEntryPath`. Size: one function,
four call sites, one property test (`sign(compareEntryPath)` = `sign(compareBytes(utf8))` over
`fc.fullUnicodeString`), and one interop twin.

### D6. Benches

- `status.bench.ts`: `status` now writes, so the shared tier cache (`fixture-scratch.ts` header: "anything that
  rewrites the index must copy first") can no longer be its target. Each tier copies with `copyFixtureToScratch`.
  Two scenarios per tier:
  - **settled**: copy, one unmeasured `status()` (the refresh write), then measure `status()`. This is the new
    meaning of the CI row: stat-valid after refresh.
  - **stat-invalid**: copy (ino/ctime moved, like the CI `actions/cache` tar restore), then measure
    `status({ refresh: false })`. It stays stat-invalid on every iteration and reproduces today's
    450 ms / 20 005 reads.
  - The isomorphic-git baseline is unchanged on both.
- `stash.bench.ts` (new): a small-repo scratch (`write-scratch.ts`, new `buildStashScratch(modified, untracked)`).
  It measures `stashPush({ includeUntracked: true })` + `stashPop()` as one round trip, because vitest bench
  hooks do not run (project memory) and every iteration must start dirty. No isomorphic-git baseline (no stash).
- `status-dirty.bench.ts` already uses its own mutable repo. It is unchanged; its index is written by `add`
  (stat-valid).
- **PR note (must appear in the PR body):** the nightly `status` row changes meaning from "CI tar-restored
  fixture, stat-invalid, every call re-hashes" to "settled, stat-valid". The stat-invalid figure moves to the new
  `stat-invalid` row.

### D7. Edge checklist

- No index file (fresh/unborn) → nothing to refresh, nothing racy. Under DC-1 (a) the optional lock is still taken
  and released, as git does. Nothing is written.
- Unmerged entries: not refreshed (stage > 0). A racy stage-0 entry next to them still triggers the write.
- A corrupt on-disk index is refused at read, as today (git errors too).
- `refresh: false` + racy entries → no write (Q3).
- Lock acquired, report throws → lock released (`finally`), error propagates (the report error is not a degrade).
- Trailer mismatch (concurrent writer committed between read and lock) → released, no write, result returned.
- Second-resolution adapters (memory, browser): `mtimeNs` undefined → ns 0. An entry written in the same second as
  the index is racy, so `status` rewrites until the clock moves on. This is git's behaviour on a
  second-resolution filesystem (Q2, Q4).
- SHA-256: the trailer guard compares `trailerSha` values parsed at `digestLength`. `TREE` serialiser width = `digestLength`. `REUC`/`UNTR`
  are opaque.
- `assumeValid` entries are not refreshed (`isEntryStatClean` already trusts them).

### D8. Implementation parts (pre-chewed)

Every part is TDD: GWT titles, AAA, `sut`, its own test file. Run `npm run validate` before each commit.

| Part | Files | Context |
|---|---|---|
| P1 `withStatData` | `src/application/primitives/internal/index-entry-from-stat.ts`; test `test/unit/application/primitives/internal/index-entry-from-stat.test.ts` (create if absent) | Copy the stat fields, keep id/mode/flags/path; `indexEntryFromStat` delegates. `nanosecondsOf` already there. |
| P2 `hasRacyTimestamp` | `internal/is-entry-stat-clean.ts`; tests `is-entry-stat-clean.test.ts` + `.properties.test.ts` | Second granularity, gitlinks excluded (DC-2). Same-second smaller-ns entry → racy (Q4 row as an example test). |
| P3 `compareAndRefresh` | `compare-working-tree-entry.ts`; test `test/unit/application/primitives/compare-working-tree-entry.test.ts` | Factor the body so `stat` is visible; `refreshed` rules §D2.1; `compareWorkingTreeDelta` delegates. Assert the miss path still calls conversion (spy on `convertToGit`). |
| P4 `compareWorkingTreeEntry(…, indexMtime?)` | same file + test | Forwarding only. |
| P5 byte-order comparator (DC-8) | `src/domain/git-index/index-writer.ts` `compareEntryPath`; tests `index-writer.test.ts` + new `index-writer.properties.test.ts` | §D5; the property uses `compareBytes` from `src/domain/objects`. |
| P6 align pre-sorts (DC-8) | `build-index-from-tree.ts:133`, `materialize-tree.ts:170`, `apply-merge-to-worktree.ts:293`; their tests | Use `compareEntryPath`. Keep the stage tiebreak at `apply-merge-to-worktree.ts:296`. |
| P7 `serializeCacheTree` | `src/domain/git-index/cache-tree.ts` (new), export via `index.ts`; tests `cache-tree.test.ts` + `cache-tree.properties.test.ts` | Grammar = `parseCacheTree` (`index-parser.ts:248-365`); property `parseCacheTree(serializeCacheTree(t, w), w)` deep-equals `t` for w ∈ {20, 32} (reuse `test/unit/domain/git-index/arbitraries.ts`). |
| P8 `invalidateCacheTree` | same module; tests | §D4.3; properties: invariant (no valid node covers a changed path), untouched subtrees `toBe`, idempotent. Examples = §D1.5 rows (`add d/c` → `<root>:-1 d:-1 e:valid x:valid`). |
| P9 `diffIndexEntries` | `src/domain/git-index/diff-index-entries.ts`; tests + properties | Merge-join over `(comparePaths, stage)`; `trackedSetChanged`, `resolvedUnmerged`. |
| P10 `carryExtensions` | `src/domain/git-index/carry-extensions.ts`; tests | §D4.2 table cell by cell; order TREE, REUC, UNTR; unknown/EOIE/IEOT/FSMN dropped. |
| P11 `commit(entries, kind)` + `commitRefresh` | `internal/index-lock.ts`; test `test/unit/application/primitives/internal/index-lock.test.ts` (new) | `commitRefresh`: trailer guard, stat-only copy (§D2.3). One previous-index read shared with `smudgeRacilyClean` (change it to accept the previous entries, keeping its own read as the fallback for direct callers). Read `core.untrackedCache` through `readConfig` (check whether `ParsedConfig.core` has it; add the field if absent). |
| P12 callers: in-place writers | add, rm, mv, reset (path), checkout (paths), apply-sparse-checkout, submodule | §D4.4 `update`; extend each command's unit test with a memory-adapter index carrying TREE+REUC+UNTR+ZZZZ, asserting carried bytes. |
| P13 callers: replace writers I | checkout (switch), reset (hard), reset-worktree, materialize-worktree-from-head, worktree | `replace`. |
| P14 callers: replace writers II | merge ×2, pull, pull-into-void, cherry-pick, revert, replay-sequence ×2, rebase-merges-steps ×2 | `replace`. |
| P15 callers: stash ×3 | `stash.ts` 520/634/716 | `replace`. |
| P16 optional lock | `index-lock.ts` `acquireOptionalIndexLock`, degrade predicate | §D2.3–§D2.4; fake fs throwing each mapped code; never breaks a stale lock (set `ctx.config.breakStaleLockMs`, assert the old lock survives). |
| P17 status refresh | `status.ts`; tests `test/unit/application/commands/status.test.ts` + new `status-refresh.test.ts` | §D2.3 lifecycle; split `scanStatusTree` (tracked pass → lock → untracked pass); trailer guard (rewrite the index between read and lock via an fs proxy); `finally` release. |
| P18 options + env | `status.ts`, `repository.ts:970`, `reports/api.json` | §D2.5; env through `ctx.env`; invalid value refusal (DC-4). |
| P19 attribute memo | `status.ts` → comparator scope; `resolve-conversion.ts` | DC-9. Spy: no `resolveFilterDriver` call without `[filter]` config. |
| P20 internal callers | `describe.ts` `computeDirty`, `worktree.ts` `worktreeRemove`, `submodule.ts` `assertSubmoduleClean` | Default refresh (§D1.8); unit test that `describe --dirty` rewrites a stat-moved index. |
| P21 arm rm + clean-work-tree | `rm.ts` `classifyEntries`; `commands/internal/clean-work-tree.ts` | §D3.1. Test: a stat-matching entry is not read (fs read spy). |
| P22 arm would-overwrite | `find-would-overwrite.ts`, `merge.ts:1656`, `apply-merge-to-worktree.ts:481` + `indexMtime` carried by synthesised indexes | §D3.1; extend `find-would-overwrite.test.ts`. |
| P23 stash arm + pool | `stash.ts` `classifyTracked`, `projectWorkingTree`, `hashUntracked`; `internal/clean-order.ts` (move `inIndexOrder`) | §D3.2; reuse the `add-clean-order.test.ts` slow-lstat proxy pattern for `'write'` span ordering under `safeCrlf: true`. |
| P24 interop: status refresh | `test/integration/status-refresh-interop.test.ts` | §Test strategy. |
| P25 interop: extensions | `test/integration/index-extensions-interop.test.ts` | §Test strategy. |
| P26 interop: path order (DC-8) | extend `test/integration/index-interop.test.ts` | §D1.7 twin. |
| P27 benches | `test/bench/status.bench.ts`, new `test/bench/stash.bench.ts`, `support/write-scratch.ts` | §D6; confirm with `tooling/bench-ab.ts` after the commit. |

## Decision candidates

**PD-0 — pre-decided by the user on 2026-09-10 (record only, not re-opened).** `status` becomes an occasional
writer, as git is by default. It takes git's optional `index.lock` (`hold_locked_index(&lock, 0)`), refreshes,
writes only when an entry moved, and degrades silently to a read-only status on `RESOURCE_LOCKED`, `EROFS` or
`EACCES`, never throwing. It holds the lock while refreshing. `refresh?: boolean` (default true) on
`StatusOptions` is the structured `--no-optional-locks`. The write goes through the index-lock commit path, so the
session index cache is invalidated. The "no `.gitattributes` anywhere" verdict is memoised once per status. The
pins refine three clauses of this ruling: the lock's position (DC-1), the write trigger (DC-2) and the memo's
realisation (DC-9). Each is raised below, not folded in.

Adopted under ADR-226 without a candidate (git settles them, pinned in §D1): status refresh rules (§D2.1, P3 /
P11 rows); `GIT_OPTIONAL_LOCKS=0` and `--no-optional-locks` suppress the write (P4/P5/Q3); a lock that already
exists means no write and no error (P6); refresh-only writes keep `TREE`/`REUC`/`UNTR` (E1/E4/R3); `UNTR` is
dropped under `core.untrackedCache=false` (U1); `REUC` keep/drop per writer class (§D1.5); writer version rule
v2/v3 (V2/V3); internal `status` callers refresh (§D1.8); `stash` pooling under ADR-954's span; `indexMtime`
threading under ADR-511.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | When `status` takes the optional lock (the ruling says before the read; git 2.55 takes it after the refresh, §D1.3) | (a) git's order: read → tracked scan (refresh) → optional lock → report + untracked scan → verify on-disk trailer = trailer read → write or roll back; (b) the ruling as written: lock before `readIndex`, held across the whole status; (c) git's order, but the lock is taken only when the trigger already holds after the tracked scan (no lock on a clean repo) | (a) | (a) is git byte for byte, and git uses the trailer check to make a lost update impossible. tsgit already parses `trailerSha`, and `commitRefresh` re-reads the on-disk index anyway. (b) also prevents a lost update, but holds the lock across the expensive phase: a concurrent `git add` during a 450 ms stat-invalid `tsgit status` fails with "index.lock exists" where git's status would not block it. (c) shortens the window further but no longer matches the window in which git holds the lock. |
| DC-2 | Write trigger | (a) git: an entry was refreshed **or** any entry is racy at second granularity (`has_racy_timestamp`, default build without `USE_NSEC`, Q2/Q4); (b) the ruling's wording: only when an entry's stat moved; (c) (a) with tsgit's nanosecond `isRacy` | (a) | Q2 shows git rewrites a racy-only index, which makes those entries non-racy, so the next status trusts them. (b) leaves just-added entries racy until something else writes, so every status re-hashes them. (c) disagrees with Q4 (same second, smaller ns: git rewrites). The interop test for this row uses an entry mtime with ns ≥ the index's, so it passes under either `USE_NSEC` build. |
| DC-3 | Which failures degrade, beyond the ruled three | (a) only the ruled set: `FILE_EXISTS` at the optional acquisition, `PERMISSION_DENIED`, `UNSUPPORTED_OPERATION{reason:'EROFS'}`, at acquisition and at commit; everything else propagates; (b) git: any failure to acquire or write degrades (flags 0, ignored return), reported through `ctx.logger?.warn?.(…, { code, path })` so nothing is swallowed; (c) (a) plus mapping the browser adapter's OPFS `NoModificationAllowedError`/`NotAllowedError` to `PERMISSION_DENIED` | (a) | It is the user's ruling and keeps "no swallowed errors". The divergence from git is limited to `ENOSPC`/`EIO`-class faults, where surfacing is arguably the better data. The browser adapter currently lets every OPFS `DOMException` through unmapped, so a browser status on a locked OPFS handle would throw: (c) fixes that but is adapter work no measured case needs yet. |
| DC-4 | `GIT_OPTIONAL_LOCKS` | (a) honour it through `ctx.env` with git's boolean grammar; false wins over `refresh: true`; an invalid value refuses status with structured data (git exits 128, P9); (b) ignore the env, the option only; (c) honour it, treat an invalid value as unset | (a) | The env is git's documented switch, and tsgit already honours `GIT_NOTES_REF` through the same port. (b) means a tsgit embedded under `GIT_OPTIONAL_LOCKS=0` (IDE integrations set it) writes where git would not. (c) diverges from P9. |
| DC-5 | Unknown optional extensions | (a) drop on every write, as git does (§D1.4, every §D1.5 row); (b) forward verbatim (the backlog's starting point); (c) forward on `refresh` writes only | (a) | git never forwards what it does not understand, and a forwarded stale `EOIE`/`IEOT`/`FSMN` would describe entries that no longer exist. (b) and (c) produce indexes git itself never writes. |
| DC-6 | `TREE` on content-changing writes (`update` / `replace`) | (a) drop `TREE` (today's behaviour for every writer); (b) generic ancestor-chain invalidation from `diffIndexEntries` in the commit path, the same for every writer; (c) per-writer transcription of git: chain invalidation for in-place writers plus full recomputation (`cache_tree_update`, reading the target tree's subtree oids) for the `unpack_trees` class | (b) | (b) keeps git's cache-tree useful after `tsgit add`/`rm`/`mv`/`reset <paths>`, which is the faithfulness complaint in the backlog. It is correct by construction (§D4.3 invariant) and lives in one place. Where git recomputes (`checkout <branch>`, `merge`, `reset --hard`), (b) leaves only the changed chains invalid: equal under readback but not byte-identical. (c) is the byte-exact form and needs tree-object reads per writer, which belongs with (d-ii)'s O(change) `TREE` in 31.10. (a) is no regression but keeps the defect. |
| DC-7 | Shape of the carry API | (a) every writer declares `IndexWriteKind` (`update`/`replace`), `status` alone uses `commitRefresh` (stat-only by construction), and generic rules derive `REUC`/`UNTR` from it and the entry diff (§D4.2); (b) drop `REUC` and `UNTR` on every non-refresh write (simplest); (c) each of the 18 writers passes an explicit extension list | (a) | Three classes reproduce every §D1.5 `REUC`/`UNTR` column. (b) drops `REUC` where git keeps it (add/rm/mv/reset mixed/checkout paths). (c) spreads the policy over 29 sites. |
| DC-8 | UTF-16 vs bytewise entry order (`compareEntryPath`, `index-writer.ts:42-47`) | (a) fix in run 1: an allocation-free surrogate-aware comparator plus the three pre-sorts (§D5), pinned by a non-BMP vs U+FFFD interop twin; (b) file it as its own backlog line | (a) | §D1.7: an index tsgit writes with such a pair makes `git fsck` exit 128 ("unordered stage entries in index"), and `git add -A` on it duplicates the entry. Run 1 already opens the writer. The fix is one function and four call sites (P5, P6, P26). |
| DC-9 | How to realise "memoise the no-`.gitattributes` verdict" | (a) thread status's existing `configuresFilterDriver` verdict into the comparator scope and skip filter-driver resolution and eager validation when no `[filter]` section exists; per-directory attribute lookups stay on the provider's cache; (b) a literal once-per-call "no `.gitattributes` anywhere" verdict from the index, `info/attributes` and a worktree pre-walk; (c) leave the memo out of run 1 | (a) | An untracked nested `.gitattributes` engages check-in conversion (ADR-951), so (b) cannot be decided once without walking the worktree before the tracked scan. That walk costs more than the lookups it saves. (a) removes the per-file cost the backlog names (`resolveFilterDriver(…,{eagerSectionValidation:true})`) and cannot change a verdict. After (a), the miss path itself is rare. |

## Test strategy

**Unit** (`test/unit/**`, GWT, AAA, `sut`): per part, §D8. Mutation-resistant data assertions: the carried
extension bytes are compared with `toEqual` on `Uint8Array`, and refusal data is read field by field.

**Property siblings** (`.claude/workflow/property-testing.md`):
- `cache-tree.properties.test.ts`: round trip at both widths; the invalidation invariant; untouched subtrees identical.
- `diff-index-entries.properties.test.ts`: `changedPaths` is empty iff the two lists agree on (path, stage, id, mode); symmetry of `trackedSetChanged`.
- `index-writer.properties.test.ts` (DC-8): comparator sign = UTF-8 byte comparison sign (`fc.fullUnicodeString`, 200 runs).
- `is-entry-stat-clean.properties.test.ts` (extend): `hasRacyTimestamp` is true iff some non-gitlink entry has `mtimeSeconds >= index.seconds`.

**Interop** (`runGit`/`git`/`makePeerPair` from `test/integration/interop-helpers.ts`, scrubbed env, signing off):
- `status-refresh-interop.test.ts`:
  - The tar-copy shape (copy the repo with `fs.cp`, which moves ino/ctime): tsgit `status` rewrites the index
    (new inode). Afterwards `git ls-files --debug` shows the refreshed ctime/mtime/ino, and git's own `status`
    does not rewrite (settled).
  - `touch` → rewrite; content change only → no rewrite; racy-only (entry mtime ns ≥ index ns) → rewrite.
  - `refresh: false` and `GIT_OPTIONAL_LOCKS=0` (through the context's env) → no rewrite; `index.lock` present →
    no rewrite, lock bytes untouched, result equal to git's porcelain v2 reconstructed from the fields;
    `chmod a-w .git` (POSIX, non-root) → no rewrite, no throw.
  - A refreshed index written by tsgit, read by git: `git status --porcelain=v2` equals tsgit's result, and
    `git fsck` exits 0.
- `index-extensions-interop.test.ts`: a git-built index with `TREE` + `REUC` + `UNTR` + `ZZZZ`, then each tsgit
  writer of §D4.4 that has a git counterpart in §D1.5. Assert the `REUC`/`UNTR` presence and bytes columns. For
  `TREE`: under `update`, the valid nodes equal git's valid nodes. Under `replace`, every node tsgit marks valid
  carries git's oid for that directory (`git ls-tree -d` / `rev-parse HEAD:<dir>`), `ZZZZ` is absent, and
  `git fsck` exits 0. SHA-256 twin for `status` refresh and `add`.
- `index-interop.test.ts` (DC-8): `😀.txt` + `U+FFFD.txt` added by tsgit; `git ls-files -s` order equals git's own
  add of the same files; `git fsck` exit 0.
- Existing suites stay green unchanged: `status-racy-clean-interop`, `index-racy-smudge-interop`, `stash-interop`,
  `rm-interop`, `add-interop`.

**Benches**: §D6. Quote absolute wall-clock main-vs-branch through `tooling/bench-ab.ts`, run after the commit.

## Risks

- **Concurrent writers.** With DC-1 (a), the window between `readIndex` and the optional lock is covered by the
  trailer check, and the window after it by the lock. A writer that rewrites the index with identical bytes
  between read and lock passes the check. That is harmless (same content) and it is git's own behaviour. Under
  DC-1 (b), every concurrent tsgit or git writer gets `RESOURCE_LOCKED` for the whole status.
- **Writers now carrying extensions.** Today every write drops all extensions, which is safe by omission. The
  §D4.3 invariant is what makes carrying safe. P8's property test and the interop `git fsck` assertions guard it
  (ADR-623 bit 8).
- **SHA-256.** `TREE` oid width and the trailer width come from `ctx.hashConfig.digestLength` at every new site
  (`serializeCacheTree`, `invalidateCacheTree`, the `commitRefresh` trailer guard). The SHA-256 interop twin pins both.
- **Second-resolution adapters.** Memory/browser stat has no `mtimeNs`, so a same-second entry is racy and
  `status` rewrites on each call within that second (§D7). Unit tests that freeze the memory clock will see writes
  where they saw none. Tests that assert "no write" must advance the clock.
- **Error mapping per adapter.** Node: `EACCES`/`EPERM` → `PERMISSION_DENIED`, `EROFS` →
  `UNSUPPORTED_OPERATION{reason:'EROFS'}` (`node-file-system.ts:301-330`). Memory: no read-only mode, so tests
  inject a throwing fs. Browser: OPFS errors are unmapped (DC-3 (c)). Windows: the read-only `.git` interop row is
  POSIX-only (`chmod`). On Windows, the Node adapter's lock-exists path is the one covered.
- **Bench fixture cache.** `status` writing into the shared tier cache would change every later reader of that
  fixture. P27 moves the bench to a scratch copy, and any other bench that calls `status()` on a shared fixture
  must do the same (grep for `.status(` under `test/bench` in P27).

## Out of scope

- 31.10 candidates: (d-ii) `commit` maintaining `TREE` at O(change) (git's `cache_tree_update`, including priming
  after `unpack_trees`-class writers, DC-6 (c)); `writeObject` probe-before-deflate and the per-write fanout
  `mkdir`; recording `REUC` when `add`/`rm` resolves a conflict.
- 31.11 candidates: (e) checkout's 8-syscall write path and `mode` on `FileSystem.write`; (f) literal-path `add`'s
  triple `lstat`, the merge-join of status / index-diff / changeset (and `computeChangeset`'s UTF-16 sort), matcher
  allocations, `ancestorsOf` O(depth²).
- The untracked cache itself (building/updating `UNTR`, E2/U2/V5). Index v4 read/write (V1) and `index.version` /
  `feature.manyFiles` for new indexes. Writing `EOIE`/`IEOT` (I1) and `FSMN`.
- Write-back of refreshed stat data by `rm`/`stash`/merge (git refreshes in memory before its own write).
  Equal under readback.
- tsgit `add` writing the index when nothing changed (git: no write, §D1.5 `add b` row). Equal under readback.
- #316 follow-ups near these seams, noted only: `.gitmodules` symlink validator stricter than git's `add -A`;
  `checkout -f HEAD` not restoring a deleted tracked file; `run-filter-driver` `%f`; `archive` of a tag-of-tree;
  a required-clean-filter failure under `safecrlf` warn/false letting later paths reach the driver; UTF-16 index
  order (DC-8 if not taken in run 1).
