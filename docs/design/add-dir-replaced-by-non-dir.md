# Design — `add` of a non-directory that replaced a tracked directory

> Brief: `add <path>` naming a symlink or regular file that replaced a tracked directory keeps the
> index entries beneath it: tracked `a/b`, `real/b`; dir `a` replaced by `a -> real`; git 2.55
> `add a` leaves `a` (120000) + `real/b`, tsgit's literal fast path (`dispatchPathspec` →
> `allLiteralsAreFiles` → `addLiteralOnly`, `removed: []`) keeps `a/b` next to `a`, an index
> `git write-tree` refuses. Pin the matrix against git 2.55, fix it (fast path or walk), and measure
> the clean `add <file>` fast path before and after. Backlog 32.24 (data integrity).
> Status: draft → self-reviewed ×3

<!-- cspell:ignore lstat lstats unmerged skipwt ENOTDIR esbuild realx -->

## Context

### Binding constraints

| Source | Constraint on this design |
|---|---|
| ADR-226 / CLAUDE.md (git-faithfulness) | Every rule below comes from the pinned matrix (§D1), not from memory or from reading git's source. |
| ADR-249 (structured data only) | `AddResult` stays `{ added, modified, removed, eolNotices }`. No display string, no new option. `removed` lists what git's `add -v` reports as `remove '<path>'`. |
| ADR-038 (pathspec exclusion) | tsgit spells git's `:!x` as `!x`. The reported-removal step honours negations through the compiled matcher. |
| ADR-973 / ADR-980 / ADR-981 | A lossy entry is never stat'd (it reads as gone). Pathspecs match it through its escaped view. Map keys are escaped paths (`indexPathKey`). |
| Memory hint (add dispatch order) | Tracked-first staging order (`trackedFirst`, `walkedTrackedFirst`) is unchanged. Removals touch no clean driver, so they never reorder it. |
| Memory hint (index-write review) | Every index-write change below is checked against unmerged stages (§D1 rows R10, R12, R15, R16) and file↔directory states (all rows). |

### What exists today (verified in the tree, `0f8d0b16`)

| Asset | File : symbol | Status for this feature |
|---|---|---|
| Dispatch | `src/application/commands/add.ts` — `dispatchPathspec` (206): `resolvePathspec` → `assertNoSymlinkedLeadingPath` → `!hasGlob && allLiteralsAreFiles` → `addLiteralOnly`, else `addByPathspec` | **Change**: passes the matcher to the fast path (§D3). [DC4] probe change |
| Fast path | `addLiteralOnly(ctx, validated, scope)` (220) — returns `removed: []`; `stageLiterals(staging, validated)` (263) builds `newEntries` from `existing`, knows `previous` per path; `commitIfChanged` (301); `changesIndex` (295); `wasRestaged` (312) | **Change** (§D3) |
| Fast-path probe | `allLiteralsAreFiles(ctx, literals)` (315) — false for missing, real directory, `namesDirectoryOnly`; a symlink to a directory passes. `lstatOrMissing` (335) maps only `FILE_NOT_FOUND` to `undefined` | [DC4] **Change** |
| Walk path | `addByPathspec(ctx, resolved, scope)` (460): `stageIgnoredWalk` → `tallyWalkOutcomes` (673) → `collectMatchedRemovals` (500, stage 0 + matcher only) → `remaining` map | **Change** (§D4) |
| Bulk path | `addAll(ctx, ignoreOverride?, givenScope?)` (702): walk → `collectRemovedEntries` (789, every stage) | **Change** (§D4) |
| Removal pass | `collectRemovedEntries(ctx, existing, seen)` (789) — skips `seen`, skip-worktree; lossy → removed; else `presentOnDisk` (765: leading symlink → gone, `NOT_A_DIRECTORY` → gone, else `lstatOrMissing !== undefined`) | Reused (§D3). [DC1] `presentOnDisk` **Change** |
| Index read | `readExistingEntries(ctx)` (849) → `ExistingIndexState { entries: Map<IndexPathKey, IndexEntry>, indexMtime, indexRules }`; the sorted `entries` array from `readIndexOrEmpty` (861) is discarded | **Change**: also returns the sorted array (§D2) |
| Index order | `src/domain/git-index/index-writer.ts` — `compareEntryPath(a: IndexPath, b: IndexPath)` (59, byte order, no encode for UTF-8 paths); `serializeIndex` always writes sorted | Reused for the binary search |
| Keys | `src/domain/git-index/index-path-key.ts` — `IndexPath`, `indexPathKey`, `keyOfPath`, `escapedPathOf`, `pathBytesOf`, `isLossy` | Reused |
| Matcher | `src/domain/pathspec/matching-path.ts` — `matchesIndexPath(spec, entry)` (escaped view) | Reused |
| D/F rule | none: no `has_file_name` / `has_dir_name` equivalent anywhere in `src/` | **New** (§D2) |
| Interop | `test/integration/add-interop.test.ts` (`writeBoth`, `snapshot`, precedent "Given a tracked directory replaced by a symlink…" at 163) + `interop-helpers.ts` (`makePeerPair`, `runGit`, `lsStage`, `writeTreeOf`, `GIT_AVAILABLE`) | Extended |
| Unit | `test/unit/application/commands/add.test.ts` (memory adapter; symlink precedent 196-262, `seedRepo`/`seedFreshRepo`); `test/unit/domain/git-index/arbitraries.ts` (`arbIndexEntry`) | Extended |
| Bench | `test/bench/add.bench.ts` — "Given a scratch repo whose committed file is unchanged on disk / When add() re-stages the unchanged file" (1-entry index, `buildCommitScratch`); `test/bench/support/write-scratch.ts` — `buildManyLooseObjectsScratch(fileCount)`; `tooling/bench-ab.ts` (`npm run bench:ab -- <base> [head] [rounds]`), threshold `REGRESSION_THRESHOLD`, default `DEFAULT_THRESHOLD_PCT = 10` (`tooling/bench-check.ts:19`) | Extended (§D6) |

### Platform note

`test/integration/*.test.ts` (outside `posix-only/` and `win-only/`) runs in the `integration` CI job,
`ubuntu-latest` only (`.github/workflows/ci.yml` `integration:`). Real symlinks are safe there, as
the existing symlink interop test shows. Unit tests run on Windows too, but use the memory
adapter (`ctx.fs.symlink`), so they need no OS symlink support. No new `posix-only/` file.

### Pinning harness

```sh
G()  { env -i PATH="<git-2.55.0>/bin:/usr/bin:/bin" HOME=<tmp>/home GIT_CONFIG_NOSYSTEM=1 \
         GIT_CEILING_DIRECTORIES=<tmp> \
         git -c user.name=t -c user.email=t@t -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }
TS() { node <scratch>/ts.mjs <repo> lit <paths…> | all; }   # esbuild bundle of src/ at 0f8d0b16:
                                                            # repo.add(paths) or add([], { all })
# each row: seed + `G add -A` + `G commit` + mutate, in <tmp>/g; `cp -Rp` to <tmp>/t;
# `G add -v …` in g, TS in t; compare `G ls-files -s` and `G write-tree`.
$ G version
git version 2.55.0
```

Every probe ran in a `mktemp -d` throwaway. Rows X1-X4 ran a second bundle built from a
throwaway copy of `src/` with two experimental edits (`lstatOrMissing` maps `NOT_A_DIRECTORY` to
missing; `allLiteralsAreFiles` forced false). Their only purpose is to show which mechanism fixes
which row.

## Requirements

- **R1** `add <p>` where `p` is now a symlink or regular file and the index tracks entries beneath
  `p/` drops every one of them. The index lists exactly what git 2.55 lists, and `git write-tree`
  succeeds with git's tree oid. Covers top-level and nested `p`, `./p` spelling, `p` among other
  literals, and lossy entries beneath `p` (rows R1-R5, R10, L1).
- **R2** `removed` lists, sorted, the beneath entries git reports with `remove '<path>'`: stage-0
  entries the pathspec matches that are not skip-worktree, plus unmerged entries (once per path).
  It omits the ones git drops silently: a stage-0 entry the pathspec excludes, or a skip-worktree
  entry (rows R6, R7, R12).
- **R3** The same drop holds on the walk paths (`add <glob|dir|.>`, `add({ all })`), where today
  skip-worktree, excluded and unmerged beneath entries survive (rows R8, R9, R16). `removed`
  stays as it is for every row that already matches.
- **R4** The drop fires only when `p` gets a new stage-0 entry (no stage-0 entry at `p` before the
  add). Re-staging a tracked path, clean or modified, never drops entries (rows C1, C2).
- **R5** Rows that match today still match: `add a/` (symlink: `PATHSPEC_BEYOND_SYMLINK`; file:
  removals, `a` not staged), `add a/b` beyond a symlink, `add -A` with a symlink, `--renormalize`
  under a non-directory (N1, N2).
- **R6** Clean `add <file>`: re-staging a tracked file does no extra index work beyond one branch
  per literal. Adding one new file costs one binary search over the prior index. Measured by §D6
  within its bound.
- **R7** [conditional, DC1 = fold] A tracked file or symlink `p` replaced by a directory is dropped:
  silently for `add p/…` (row M1), reported as `remove 'p'` for `add p`, `add .` and `add -A`
  (rows M2-M4). An unmerged `p` is kept when `p/…` is inserted (row M5).
- **R8** [conditional, DC4 = fold] `add p/x` (and `add p p/x`) where `p` is now a regular file stages
  the deletion of `p/x` instead of refusing with `NOT_A_DIRECTORY` (rows R13, R14).

## Design

### D1. Pinned behaviour (git 2.55.0 vs tsgit `0f8d0b16`)

#### D1.1 Matrix

Fixture unless stated: tracked `a/b`, `a/c`, `a/x/y`, `real/b`, `top`; mutation on the second
column. "git" is the `add -v` output then the final index; "tsgit" is `AddResult` + index.

| # | Mutation, command | git 2.55 | tsgit today | Class |
|---|---|---|---|---|
| R1 | dir `a` → `a -> real`; `add a` | `remove 'a/b'`, `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; index `a`(120000) `real/b` `top`; exit 0 | `added:[a] removed:[]`; `a/b` `a/c` `a/x/y` kept; `write-tree` fails | **corrupt index** |
| R2 | dir `a` → regular file; `add a` | same removes; `a`(100644) | keeps `a/*` | **corrupt index** |
| R3 | symlink `a`; `add ./a` | as R1 (orchestrator pin) | as R1 | **corrupt index** |
| R4 | symlink `a`; `add top a` | as R1 | as R1 | **corrupt index** |
| R5 | dir `a/x` → `a/x -> ../real`; `add a/x` | `remove 'a/x/y'`, `add 'a/x'`; `a/b` `a/c` kept | keeps `a/x/y` | **corrupt index** |
| R6 | file `a`; `add a ':!a/b'` (tsgit `!a/b`) | `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; **`a/b` dropped silently**; index `a` `real/b` `top` | keeps `a/*` | **corrupt index** |
| R7 | symlink `a`, `a/b` skip-worktree; `add a` | `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; **`a/b` dropped silently** | keeps `a/*` | **corrupt index** |
| R8 | as R7; `add -A` | as R7 | `removed:[a/c, a/x/y]`; `a/b` kept | **corrupt index** (walk) |
| R9 | file `a`; `add . ':!a/b'` | as R6 | `removed:[a/c, a/x/y]`; `a/b` kept | **corrupt index** (walk) |
| R10 | `a/b` unmerged (stages 1, 2, 3), symlink `a`; `add a` | `remove 'a/b'` … `add 'a'`; every stage of `a/b` gone | keeps `a/b` stage 3 (see §Out of scope O1) + `a/c` `a/x/y` | **corrupt index** |
| R12 | `a/b` unmerged, file `a`; `add a ':!a/b'` | `remove 'a/b'` **reported despite the exclusion**, `remove 'a/c'`, `remove 'a/x/y'`; all stages gone | keeps `a/*` | **corrupt index** |
| R15 | `a/b` unmerged, symlink `a`; `add -A` | `remove 'a/b'`, `'a/c'`, `'a/x/y'` | `removed:[a/b, a/c, a/x/y]`; matches | match |
| R16 | as R15; `add .` | as R15 | `removed:[a/c, a/x/y]`; `a/b` stage 3 kept | **corrupt index** (walk) |
| L1 | `a/b` + lossy `a/\377` tracked, symlink `a`; `add a` | `remove 'a/b'`, `remove 'a/\377'`, `add 'a'` | keeps both | **corrupt index** |
| C1 | index already holds `a`(120000) **and** `a/*` (written by tsgit R1); `add a` (stat-clean) | no output; index unchanged (`a` + `a/*` kept); `status`: `A a`, ` D a/b`… | — | pin (git does not repair) |
| C2 | as C1, then `a` retargeted to `realx`; `add a` | `add 'a'` only; `a/*` **kept** | — | pin (no D/F drop when `a` already has a stage-0 entry) |
| — | symlink `a`; `add a/` | `fatal: pathspec 'a/' is beyond a symbolic link` (128) | `PATHSPEC_BEYOND_SYMLINK` | match |
| — | file `a`; `add a/` | removes `a/*`, `a` not staged | same | match |
| X5 | symlink `a`; `add a/b` | `fatal: pathspec 'a/b' is beyond a symbolic link` (128) | `PATHSPEC_BEYOND_SYMLINK` | match |
| — | symlink `a`; `add -A` / `add .` | `remove 'a/b'`… | matches (interop test at `add-interop.test.ts:163`) | match |
| — | `add --dry-run a` | prints the same lines, index untouched | not expressible: `AddOptions` has no dry-run, and none is added | n/a |
| N1 | file `a`; `add --renormalize a/b` | `fatal: unable to stat 'a/b': Not a directory` (128) | `NOT_A_DIRECTORY` | match |
| N2 | file `a`; `add --renormalize a` | same fatal | `NOT_A_DIRECTORY` | match |
| E1 | dir `a` turned into a nested repository (`a/.git`, `a/b` still tracked); `add -A` | no output; index unchanged (no gitlink inserted) | matches | match (no insertion, so the rule never fires) |
| R13 | file `a`; `add a a/b` | as R2 | throws `NOT_A_DIRECTORY` | [DC4] wrong refusal |
| R14 | file `a`; `add a/b` | `remove 'a/b'`; exit 0 | throws `NOT_A_DIRECTORY` | [DC4] wrong refusal |

Mirror rows. Fixture: tracked `a` (file), `real/b`, `top`. Mutation: `a` replaced by directory `a/b`.

| # | Command | git 2.55 | tsgit today | Class |
|---|---|---|---|---|
| M1 | `add a/b` | `add 'a/b'` only: **`a` dropped silently** | `added:[a/b]`; `a` kept next to `a/b` | [DC1] **corrupt index** |
| M2 | `add a` | `remove 'a'`, `add 'a/b'` | `a` kept | [DC1] **corrupt index** |
| M3 | `add .` | `remove 'a'`, `add 'a/b'` | `a` kept | [DC1] **corrupt index** |
| M4 | `add -A` | `remove 'a'`, `add 'a/b'` (orchestrator pin) | `a` kept | [DC1] **corrupt index** (walk) |
| M6 | symlink `a` → directory; `add a/b`, `add a`, `add .`, `add -A` | as M1-M4 (orchestrator pin) | `a` kept | [DC1] **corrupt index** |
| M5 | `a` unmerged (1, 2, 3); `add a/b` | `add 'a/b'`; **stages 1-3 of `a` kept** next to `a/b` | — | pin (same-stage rule) |

Mechanism rows (experimental bundle, see harness):

| # | Edit | Row | tsgit result | Proves |
|---|---|---|---|---|
| X1 | `NOT_A_DIRECTORY` → missing in the probe | R14 | `removed:[a/b]`, index = git's | DC4 is a one-arm change: the walk already handles it |
| X2 | same | R13 | `added:[a] removed:[a/b, a/c, a/x/y]`, index = git's | same |
| X3 | every literal routed to the walk | R1 | `removed:[a/b, a/c, a/x/y]`, index = git's | route-to-walk fixes R1… |
| X4 | same | R7 | `a/b` kept, `write-tree` fails | …but not the silent drops: a D/F rule is needed whatever the route |

#### D1.2 Classification

| Gap | Rows | Mechanism in git (inferred from the rows, not from source) | Impact |
|---|---|---|---|
| G1: no reported removal on the fast path | R1-R5, R10, R12, L1 | the tracked-path update pass: pathspec-matched tracked entries now gone from disk → `remove` | Any `add <p>` after a dir→link/file swap writes an index git cannot turn into a tree. `commit` then records a tree with both `a` and `a/b`, or fails. |
| G2: no silent same-stage D/F drop at insertion | R6, R7, R8, R9 (and M1 in the mirror) | inserting a **new** stage-0 entry drops same-stage entries beneath it (and at its leading directories); a path that already has a stage-0 entry is replaced in place with no check (C1, C2); other stages survive (M5) | Same corruption, on every route including `add -A`. |
| G3: unmerged beneath entries not removed on the pathspec walk | R16 | as G1, every stage | Same. |
| G4: [DC1] a directory at a tracked non-gitlink path reads as present | M2-M4, M6 | the update pass sees `a` (file/link in the index, directory on disk) as deleted | Mirror corruption on the walk paths. |
| G5: [DC4] `NOT_A_DIRECTORY` escapes the fast-path probe | R13, R14 | — | Wrong refusal; no corruption. |

### D2. The D/F rule: a pure domain module

New file `src/domain/git-index/directory-file-conflict.ts`:

```ts
/**
 * The entries git drops, without reporting them, when it inserts a new stage-0
 * entry at `path`: same-stage entries beneath `path/`. `sorted` is in index order.
 */
export const entriesBeneath = (
  sorted: ReadonlyArray<IndexEntry>,
  path: FilePath,
): ReadonlyArray<IndexEntry>;

/** [DC1] Same-stage entries at a leading directory of `path` (`a` and `a/x` for `a/x/y`). */
export const entriesAtLeadingDirectories = (
  byKey: ReadonlyMap<IndexPathKey, IndexEntry>,
  path: FilePath,
): ReadonlyArray<IndexEntry>;
```

- `entriesBeneath` binary-searches the lower bound of `{ path: \`${path}/\` }` with `compareEntryPath`
  (byte order, no encoding for UTF-8 paths, bytes for lossy entries). It then takes entries while
  their bytes start with the bytes of `path/`: `escapedPathOf(entry).startsWith(prefix)` for a
  non-lossy entry, `pathBytesOf` prefix compare for a lossy one. Entries under a prefix are
  contiguous in byte order, so the scan stops at the first miss. It returns every stage; callers
  split by stage (§D3). Cost: O(log n + k), k = entries beneath.
- Sortedness: `readIndex` returns on-disk order. `serializeIndex` always sorts, and git's index is
  sorted (git's own lookups binary-search it). `collectRemovedEntries`'s existing Stryker note
  already relies on this.
- `entriesAtLeadingDirectories` walks `path`'s `/` positions and looks up each prefix in the map:
  O(depth). It returns stage-0 entries only (M5).
- Why domain: the rule is a pure index invariant over entries. It has no I/O, and it is testable
  with `arbIndexEntry`. It belongs next to `compareEntryPath`, not inside `add.ts`, which is
  already 1063 lines. That is DC3.

`readExistingEntries` (`add.ts:849`) also returns the array it already reads:
`ExistingIndexState.sorted: ReadonlyArray<IndexEntry>`. This costs no copy.

**Inserted paths.** A staged path `p` is *inserted* when the prior index has no stage-0 entry at
`p`: `previous === undefined || previous.flags.stage !== 0`. The `existing` map holds one entry per
path (see O1). C1 and C2 pin that git runs no D/F check when `p` already has a stage-0 entry.
Re-staging a tracked file, the clean `add <file>` case, therefore never reaches the rule (R4, R6).

**Disjointness.** On disk, `p` and a path beneath `p/` cannot both exist. So no add inserts both
`p` and an entry beneath it, and the prior index alone answers "what is beneath / above".

### D3. Fast path (`addLiteralOnly`)

```
dispatchPathspec ── fast path ──▶ addLiteralOnly(ctx, resolved, scope)   // was (ctx, validated, scope)
   stageLiterals(...)                         // unchanged: newEntries, added, modified, restagedPaths
   inserted   = literals whose previous has no stage-0 entry
   beneath    = ∪ entriesBeneath(state.sorted, p)  for p ∈ inserted     // empty in the clean case
   reported   = collectMatchedRemovals(ctx, mapOf(beneath), inserted, resolved.matcher)   // G1
              ∪ beneath with stage ≠ 0 (once per path)                                      // R10, R12
   silent     = beneath stage-0 entries not in reported                                     // G2
   [DC1] silent ∪= entriesAtLeadingDirectories(existing, p) for p ∈ inserted                // M1
   newEntries −= reported ∪ silent
   commitIfChanged(...)                        // count/restaged check already sees the drop
   return { added, modified, removed: reported paths sorted, eolNotices }
```

- `collectMatchedRemovals` (`add.ts:500`) is reused unchanged on the small `beneath` map. It
  applies stage 0, `matchesIndexPath` (honours `!` exclusions, R6), and skip-worktree
  (R7, via `collectRemovedEntries`). It treats lossy entries as gone (L1, ADR-973). It checks
  `presentOnDisk`: the leading symlink → gone (R1), `NOT_A_DIRECTORY` → gone (R2).
- Unmerged beneath entries are reported whatever the matcher says (R12 pins git reporting an
  excluded unmerged path). With O1 unfixed, the map holds one stage. Deleting its key gives git's
  final index, and reports the path once.
- `removed` is sorted with the same `.sort()` the walk path uses (`addByPathspec`, 491). A lossy
  entry is reported by its public U+FFFD view (`entry.path`, ADR-982), as `collectRemovedEntries`
  callers already do.
- The `paths.length === 0` / renormalize / `all` branches are untouched.
- `changesIndex`: an inserted literal is always restaged (`wasRestaged`: its entry is never `previous`), so the
  commit fires even when the count is unchanged (one removed, one added).
- Cache-tree: removals reach `IndexLock.commit` as entries missing from the new list.
  `diffIndexEntries` already reports them as changed paths, and invalidates `a` and its ancestors.
  The interop test checks this through `git write-tree`.

### D4. Walk paths (`addByPathspec`, `addAll`)

After the existing removal pass, both paths apply the same rule to their walked outcomes:

- `inserted` = outcomes whose `previous` has no stage-0 entry (kind `added`, or a previous unmerged
  entry).
- `addByPathspec`: unmerged beneath entries not already removed → appended to `removedEntries`
  (reported, G3, R16). Stage-0 beneath entries not already removed → deleted from `remaining`
  (silent, R9). [DC1] leading-directory stage-0 entries → deleted silently.
- `addAll`: `collectRemovedEntries` already reports unmerged and stage-0 entries it finds gone
  (R15 matches). Only the silent drop is new: skip-worktree beneath entries (R8). [DC1] same
  leading-directory drop.
- Cost: one binary search per inserted path, against the prior index. A first `add -A` into an
  empty index searches an empty array. A steady-state `add -A` inserts few paths.

### D5. [conditional, DC1 = fold] Mirror: directory replaced a tracked file or symlink

- **Silent** (M1, M6 `add a/b`): `entriesAtLeadingDirectories` on every inserted path, on all three
  routes (§D3, §D4).
- **Reported** (M2-M4, M6): `presentOnDisk(ctx, scanner, path)` (`add.ts:765`) becomes
  `presentOnDisk(ctx, scanner, entry)`. A path whose `lstat` is a non-symlink directory counts as
  gone unless `entry.mode === FILE_MODE.GITLINK`; a submodule's checkout is a directory by
  design. `collectRemovedEntries` passes the entry. This reaches `add a` and `add .` through
  `collectMatchedRemovals`, and `add -A` through `addAll`.
- M5: `entriesAtLeadingDirectories` returns stage 0 only, so an unmerged `a` survives as in git.

If DC1 = leave out: skip §D5, R7, Part 5. Backlog entry: "tracked file/symlink `a` replaced by
directory `a/b`: tsgit keeps `a` in every add mode (rows M1-M6)".

### D6. Performance: bench and acceptance bound

| Scenario (`test/bench/add.bench.ts`) | Covers | Change expected |
|---|---|---|
| existing "Given a scratch repo whose committed file is unchanged on disk / When add() re-stages the unchanged file" | clean `add <file>` fast path, 1-entry index, re-hash (mtime bump) | none: `previous` is stage 0 → rule skipped |
| **new** "Given a scratch repo with 10 000 committed files / When add() re-stages one modified tracked file" | same path against a realistic index (Map build + lookup at scale) | none |
| **new** "Given a scratch repo with 10 000 committed files / When add() stages one new file" | inserted path → one `entriesBeneath` binary search over 10 000 entries | +O(log n) compares (~14), below noise |

The new scenarios build `buildManyLooseObjectsScratch(10_000)` once in the factory, outside `sut`.
The new-file `sut` writes `new-<counter>.txt` per iteration (the index grows by one per iteration,
which is negligible against 10 000).

Procedure: Part 1 commits the new scenarios **before** any fix, so both refs share them, because
`bench:ab` compares only files present on both sides. After the fix commit:
`npm run bench:ab -- <part-1-sha> HEAD 5` on a quiet machine (`uptime` plus no foreign Stryker run).

**Acceptance bound:** for each of the three scenarios, the head median is within
`+10 %` of base (`DEFAULT_THRESHOLD_PCT`, the CI regression threshold). A breach is re-run once
and, if confirmed, profiled before merge. It is not waived.

### D7. Parts

Each part is one TDD unit (red → green → refactor) with its own interop rows. Each compiles on its
own commit.

**Part 1: bench scenarios (no behaviour change).**
Context: `test/bench/add.bench.ts` (existing `benchScenario` shape at the "re-stages the unchanged
file" block), `test/bench/support/write-scratch.ts` `buildManyLooseObjectsScratch(fileCount)`,
`SCRATCH_AUTHOR`. Commit: `test(bench): …`. Its sha is the `bench:ab` base.

**Part 2: `entriesBeneath` (domain).**
Context: new `src/domain/git-index/directory-file-conflict.ts`; `compareEntryPath`
(`index-writer.ts:59`); `escapedPathOf`, `pathBytesOf`, `isLossy` (`index-path-key.ts`).
Export through `src/domain/git-index/index.ts` only if `add.ts` imports from the barrel; the
current `add.ts` imports `index-path-key.js` directly, so a direct import keeps `reports/api.json`
unchanged. Tests: new `test/unit/domain/git-index/directory-file-conflict.test.ts`. Cases: empty
index; no match; prefix sibling `a.txt` and `ab` not beneath `a` (`.` 0x2E and `b` sort around
`/` 0x2F); nested; all stages returned; lossy entry beneath; `a` itself not returned. Plus
`directory-file-conflict.properties.test.ts`: lens 2, an aggregator over entries. Property:
over a sorted `arbIndexEntry` list, `entriesBeneath(sorted, p)` equals the independent linear
filter on prefix bytes, and every returned entry's bytes start with `p/`. `numRuns` 100.

**Part 3: fast path (G1, G2, unmerged).**
Context: `add.ts` `dispatchPathspec` (206, pass `resolved` / `matcher`), `addLiteralOnly` (220),
`stageLiterals` (263, expose `inserted` or derive it from `previous`), `collectMatchedRemovals`
(500), `readExistingEntries` (849) + `ExistingIndexState` (843, add `sorted`), `commitIfChanged`
(301). Unit: `add.test.ts`, new describes per R1, R2, R4, R5, R6, R7, R10, R12, L1, C2 (memory
adapter: `seedRepo`, then remove the dir and `ctx.fs.symlink`, precedent 196-222). Assert
`removed` exactly (sorted) and the index read back via `readIndex`. Interop: rows R1, R2, R4, R5,
R6, R7, R10, L1, nested, in `add-interop.test.ts` (both sides mutated identically, `snapshot`
equality + `added.removed`). Unmerged rows seed the peer with `git update-index --index-info`
and copy the index to ours (or stage it identically through `runGit` on both).

**Part 4: walk paths (R8, R9, R16).**
Context: `addByPathspec` (460-497), `addAll` (702-751), `tallyWalkOutcomes` (673), Part 2's
module. Unit + interop rows R8, R9, R15 (regression), R16.

**Part 5: [DC1] mirror.**
Context: `entriesAtLeadingDirectories` (Part 2 module), `presentOnDisk` (765),
`collectRemovedEntries` (789), the three insertion sites from Parts 3-4, `FILE_MODE.GITLINK`.
Unit + interop rows M1-M6. The gitlink exemption gets a unit test: a tracked gitlink with its
directory present is not removed.

**Part 6: [DC4] `NOT_A_DIRECTORY` in the fast-path probe.**
Context: `allLiteralsAreFiles` (315). Map `NOT_A_DIRECTORY` to "not a file" in the probe only,
so the literal routes to the walk (X1, X2). Leave `lstatOrMissing`'s other callers alone:
`renormalizeOne` must keep refusing (N1, N2). Unit + interop rows R13, R14, N1 (regression).

**Part 7: measure.** `bench:ab` per §D6 after the last fix commit; record the table in the PR
body.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC1 | Scope: fold the mirror case (tracked file/symlink `a` replaced by directory `a/b`, rows M1-M6) into this PR? | A. Fold (§D5, Part 5: ~20 src lines in `presentOnDisk` + `entriesAtLeadingDirectories`, ~8 unit + 6 interop tests, ≈ +30 % of the change). B. Leave out; new backlog entry with rows M1-M6. | **A** | Same corruption class and the same insertion point, and it is git's other half of the one D/F check. Pinned and proven on every route, `add -A` included. Leaving it out ships a half rule. |
| DC2 | Fix mechanism | A. Fast-path-only fix: report removals in `addLiteralOnly`; walk untouched. B. Route a literal naming a non-dir over tracked entries to `addByPathspec`. C. Same-stage D/F insertion rule on all three routes + fast-path reported removals (§D2-§D4). | **C** | X3/X4: the walk fixes R1 but keeps the silent rows (R7). A misses R8, R9 and R16. B also needs an index read before dispatch, and the walk does not prune directories (`withPathspec`), so a 1-file add walks the whole tree. C fixes every pinned row, and the clean re-stage costs one branch. |
| DC3 | Where the D/F rule lives | A. `src/domain/git-index/directory-file-conflict.ts`, pure, imported by `add.ts`. B. Private helpers inside `add.ts`. | **A** | It is a pure index invariant next to `compareEntryPath`, and it gets a property test. `add.ts` is already 1063 lines. It does not join the public barrel, so `api.json` is unchanged. |
| DC4 | Scope: fold `add a/b` / `add a a/b` with `a` now a regular file (R13, R14: `NOT_A_DIRECTORY` instead of git's removal)? | A. Fold (Part 6: one catch arm in the probe, 4 tests). B. Leave out; backlog entry. | **A** | Same dir→file swap, a one-arm change proven by X1/X2. It is a wrong refusal, not corruption, so B is defensible if scope is strict. |
| DC5 | Report silent D/F drops in `removed`? | A. No: `removed` = git's `remove` lines only (R6, R7, M1). B. Yes: list every dropped entry. | **A** | ADR-226. `removed` mirrors git's report, and a consumer reconstructing `add -v` from it would print lines git does not. |
| DC6 | Bench coverage for R6 | A. Existing 1-entry scenario + two 10 000-entry scenarios (§D6), committed first. B. Existing scenario only. | **A** | The only new cost scales with index size (binary search). A 1-entry index cannot show it, and the clean-path Map build is invisible at n = 1. |
| DC7 | The unmerged-stage collapse (O1) | A. Separate backlog entry and design. B. Fold here. | **A** | Different root cause (`readExistingEntries` keys without stage, `add.ts:854`). It touches every add route and the conflict flow, and needs its own pinned matrix. This design only removes whatever entry the map holds, which already gives git's final index for R10, R12 and R16. |

## Test strategy

- **Interop (faithfulness proof):** `test/integration/add-interop.test.ts`, one describe per row
  group (Given the mutation / When `repo.add(...)` like `git add …` / Then index and tree match
  git). Every row asserts `snapshot(ours) == snapshot(peer)` (`ls-files --stage` + `write-tree`)
  and `added.removed` exactly. That reconstructs git's `remove` lines from the structured field
  (ADR-249). Rows: R1, R2, R4, R5, R6, R7, R8, R9, R10, R12, R15, R16, L1, C2, R13 and R14 [DC4],
  M1-M6 [DC1], plus the `add a/` regressions already covered. Lossy L1 seeds `a/\377` with
  `update-index --index-info` on both sides (no working-tree file on APFS/Windows; the job is
  Linux). Runs only in the ubuntu `integration` job.
- **Unit:** `add.test.ts` (memory adapter, all OSes) mirrors each row's index outcome and
  `removed`. It adds isolated tests per guard for mutation resistance: inserted vs re-staged
  (`previous` absent / unmerged / stage 0), matcher-excluded vs matched, skip-worktree vs not,
  stage 0 vs unmerged, lossy vs not. Stryker StringLiteral and ConditionalExpression mutants on the
  `stage !== 0` and `previous === undefined` conjuncts each need a one-sided test.
- **Domain:** `directory-file-conflict.test.ts` (examples) + `.properties.test.ts` (lens 2,
  linear-filter oracle, which is independent of the binary search and not a copy of it).
- **Mutation:** scoped Stryker on `add.ts` and the new module (narrowed vitest include per the
  repo's mutation procedure). Target 0 survivors.
- **Coverage:** 100 % on the new module and every changed branch.
- **Bench:** §D6.

## Out of scope

- `add --dry-run`: tsgit's `add` has no dry-run (`AddOptions` = force/all/renormalize). The row
  is not expressible and no option is added (ADR-249: no rendering-only options).
- C1 recovery: an index already corrupted by today's tsgit (`a` + `a/b`) is not repaired by
  `add a`. git does not repair it either (C1, C2).
- `add --renormalize` under a non-directory: already matches (N1, N2).

Proven out-of-scope findings (not acted on):

- **O1:** `add <any path>` during a conflict drops stages 1 and 2 of every *other* unmerged path.
  Real merge conflict on `f`, then `add top`: git keeps `f` stages 1-3, tsgit keeps only stage 3.
  Faulty line: `src/application/commands/add.ts:854` (`out.set(indexPathKey(entry), entry)`, a
  key without the stage, so the last stage wins). Data integrity; see DC7.
- **O2:** `add <pathspec>` never stages the deletion of an unmerged path gone from disk outside
  the D/F case. `a/b` unmerged and deleted, `a/c` modified, `add .`: git reports
  `remove 'a/b'`, tsgit keeps `a/b` stage 3. `add.ts:508`: `collectMatchedRemovals` filters
  `stage === 0`.
- **O3:** the fast path ignores negations: `add top '!top'` stages `top`, where git's
  `add top ':!top'` stages nothing. `add.ts:214`: the fast-path condition checks only `hasGlob`.
- **O4:** tracked dir `a` turned into a nested repository (`a/b` still tracked); `add a`: git
  exits 0 with no change, tsgit throws `PATHSPEC_NO_MATCH`. The walk skips the embedded
  repository and `a/b` is present, so nothing matches. `add.ts:479`: `enforceLiteralMustMatch`
  ignores tracked index entries under the literal.
