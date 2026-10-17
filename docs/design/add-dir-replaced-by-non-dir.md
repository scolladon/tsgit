# Design — `add` of a non-directory that replaced a tracked directory

> Brief: `add <path>` naming a symlink or regular file that replaced a tracked directory keeps the
> index entries beneath it: tracked `a/b`, `real/b`; dir `a` replaced by `a -> real`; git 2.55
> `add a` leaves `a` (120000) + `real/b`, tsgit's literal fast path (`dispatchPathspec` →
> `allLiteralsAreFiles` → `addLiteralOnly`, `removed: []`) keeps `a/b` next to `a`, an index
> `git write-tree` refuses. Pin the matrix against git 2.55, fix it (fast path or walk), and measure
> the clean `add <file>` fast path before and after. Backlog 32.24 (data integrity).
> Status: draft → self-reviewed ×3 → revised against ADR-990 … ADR-996 (O1 folded, mirror and
> `NOT_A_DIRECTORY` folded) → self-reviewed ×3

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
| Memory hint (index-write review) | Every index-write change below is checked against unmerged stages (§D1 rows R10, R12, R15, R16, M5, §D1.3) and file↔directory states (all rows). |
| ADR-990 | Same-stage D/F insertion rule on the fast path, `addByPathspec` and `addAll`, plus reported removals on the fast path (§D2-§D4). |
| ADR-991 | The mirror case (rows M1-M6) is in scope (§D5, Part 7). |
| ADR-992 | The rule lives in `src/domain/git-index/directory-file-conflict.ts`, pure, not in the public barrel (§D2.1, Part 2). |
| ADR-993 | `NOT_A_DIRECTORY` counts as missing in the fast-path probe only (R13, R14, Part 8). |
| ADR-994 | `removed` holds git's reported removals only; silent drops stay out of it. |
| ADR-995 | Bench: existing scenario + two 10 000-entry scenarios, committed first; bound +10 % (§D6, Part 1). |
| ADR-996 | `add` keeps every stage of the unmerged paths it does not stage; staging a path collapses its stages to stage 0 (§D1.3, §D2.2, Part 3). |

### What exists today (verified in the tree, `cc53141c`; `src/` unchanged since `0f8d0b16`)

| Asset | File : symbol | Status for this feature |
|---|---|---|
| Dispatch | `src/application/commands/add.ts` — `dispatchPathspec` (206): `resolvePathspec` → `assertNoSymlinkedLeadingPath` → `!hasGlob && allLiteralsAreFiles` → `addLiteralOnly`, else `addByPathspec` | **Change**: passes the matcher to the fast path (§D3); probe change (ADR-993) |
| Fast path | `addLiteralOnly(ctx, validated, scope)` (220) — returns `removed: []`; `trackedFirst` (251); `stageLiterals(staging, validated)` (263) builds `newEntries` from `existing`, knows `previous` per path; `commitIfChanged` (301); `changesIndex` (295); `wasRestaged` (312) | **Change** (§D2.2, §D3) |
| Fast-path probe | `allLiteralsAreFiles(ctx, literals)` (315) — false for missing, real directory, `namesDirectoryOnly`; a symlink to a directory passes. `lstatOrMissing` (335) maps only `FILE_NOT_FOUND` to `undefined` | **Change** (probe only, ADR-993) |
| Walk path | `addByPathspec(ctx, resolved, scope)` (460): `stageIgnoredWalk` (620) → `stageWalkedEntries` (365) → `walkedTrackedFirst` (390) → `processWalkEntry` (805) → `tallyWalkOutcomes` (673) + `restagedPathsOf` (664) → `collectMatchedRemovals` (500, stage 0 + matcher only) → `remaining` map | **Change** (§D2.2, §D4) |
| Bulk path | `addAll(ctx, ignoreOverride?, givenScope?)` (702): walk → `collectRemovedEntries` (789, one entry per path) | **Change** (§D2.2, §D4) |
| Renormalize | `addRenormalized` (521) reads `readIndexOrEmpty` (861) as an array, re-cleans stage 0 only, writes the array back | Unchanged: already keeps every stage (§D1.3 rows U14, U15) |
| Index-CRLF rule | `indexRuleBlob(indexRules, previous)` (1030): stage 0 → `previous`, else `indexRules` (stage 2) | Unchanged: needs `previous` to be *some* stage of an unmerged path (§D2.2) |
| Removal pass | `collectRemovedEntries(ctx, existing, seen)` (789) — skips `seen`, skip-worktree; lossy → removed; else `presentOnDisk` (765: leading symlink → gone, `NOT_A_DIRECTORY` → gone, else `lstatOrMissing !== undefined`) | Reused (§D3). `presentOnDisk` **Change** (§D5) |
| Index read | `readExistingEntries(ctx)` (849) → `ExistingIndexState { entries: Map<IndexPathKey, IndexEntry>, indexMtime, indexRules }` (843). `out.set(indexPathKey(entry), entry)` (854) keys by path only: an unmerged path keeps its **last** stage, the others are lost. The array from `readIndexOrEmpty` (861) is discarded | **Change**: also returns the array, every unmerged stage and the entry count (§D2.2) |
| Cache-tree diff | `IndexLock.commit` → `diffIndexEntries(previous, entries)` (`src/domain/git-index/diff-index-entries.ts:116`), compares by path **then stage** | Unchanged. Kept stages no longer show as changed paths |
| Index order | `src/domain/git-index/index-writer.ts` — `compareEntryPath(a: IndexPath, b: IndexPath)` (59, byte order, no encode for UTF-8 paths); `serializeIndex` always writes sorted | Reused for the binary search |
| Keys | `src/domain/git-index/index-path-key.ts` — `IndexPath`, `indexPathKey`, `keyOfPath`, `escapedPathOf`, `pathBytesOf`, `isLossy` | Reused |
| Matcher | `src/domain/pathspec/matching-path.ts` — `matchesIndexPath(spec, entry)` (escaped view) | Reused |
| D/F rule | none: no `has_file_name` / `has_dir_name` equivalent anywhere in `src/` | **New** (§D2) |
| Interop | `test/integration/add-interop.test.ts` (`writeBoth`, `snapshot`, precedent "Given a tracked directory replaced by a symlink…" at 163) + `interop-helpers.ts` (`makePeerPair`, `runGit`, `lsStage`, `writeTreeOf`, `GIT_AVAILABLE`). `writeTreeOf` throws on an unmerged index, so rows that keep stages compare `lsStage` only | Extended |
| Unit | `test/unit/application/commands/add.test.ts` (memory adapter; symlink precedent 196-262, `seedRepo`/`seedFreshRepo` (53); unmerged precedent `seedUnmergedBlobs` (3736, stages 1-3 of `f.txt`, `fileSize: 0` keeps the stat shortcut out), `seedUnmergedPaths` (3794), `serializeIndexFixtureAsync`); `test/unit/domain/git-index/arbitraries.ts` (`arbIndexEntry`) | Extended |
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

O1 rows (§D1.3) use a real merge, not `update-index`: in `<tmp>/g`, commit `f` `h` `top` `d/e`;
branch `side` changes `f` and `h`; `main` changes them differently; `G -c merge.conflictStyle=merge
merge side` (exit 1). Modify/delete shapes delete `f` on one side instead. Then `top` and `d/e` are
rewritten on disk, `sleep 1`, `cp -Rp` to `<tmp>/t`, and `G add -v` runs in g while the bundle
(built from `src/` at `cc53141c`) runs in t. Unmerged D/F rows (R10, R12, R15, R16, M5) seed the
stages with `G update-index --index-info` after the base commit. Every row was pinned on
2026-10-17; the divergent O1 rows were repeated once and gave the same result.

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
- **R7** A tracked file or symlink `p` replaced by a directory is dropped:
  silently for `add p/…` (row M1), reported as `remove 'p'` for `add p`, `add .` and `add -A`
  (rows M2-M4). An unmerged `p` keeps every stage when `p/…` is inserted (row M5); an unmerged
  `p` now a directory is removed, every stage, by `add -A` (row M7a).
- **R8** `add p/x` (and `add p p/x`) where `p` is now a regular file stages
  the deletion of `p/x` instead of refusing with `NOT_A_DIRECTORY` (rows R13, R14).
- **R9** `add` keeps every stage (1, 2, 3, or the two a modify/delete conflict leaves) of each
  unmerged path it neither stages nor removes, on every route (§D1.3 rows U1-U8, U11; M5).
  Staging an unmerged path replaces all its stages with one stage-0 entry (U6, U7, U9, U10);
  removing it (gone from disk, or beneath an inserted path) drops all its stages and reports it
  once (U12, R10, R12, R15, R16). `--renormalize` already complies (U14, U15). An index with no
  unmerged entry is written exactly as today.
- **R10** [conditional, DC8 = fold] Staging an unmerged path lists it in `modified` whatever its
  content, as git prints `add '<path>'` for it (rows U6 MD12/MD13, U10 MD12/MD13).

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
| R10 | `a/b` unmerged (stages 1, 2, 3), symlink `a`; `add a` | `remove 'a/b'`, `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; index `a`(120000) `real/b` `top`: every stage of `a/b` gone | `added:[a] removed:[]`; index `a` `a/b`@3 `a/c` `a/x/y` `real/b` `top` (stages 1, 2 of `a/b` lost to O1) | **corrupt index** |
| R12 | `a/b` unmerged (1, 2, 3), file `a`; `add a ':!a/b'` | `remove 'a/b'` **reported despite the exclusion**, `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; index `a`(100644) `real/b` `top` | `added:[a] removed:[]`; `a/b`@3 `a/c` `a/x/y` kept | **corrupt index** |
| R15 | `a/b` unmerged (1, 2, 3), symlink `a`; `add -A` | as R10 | `added:[a] removed:[a/b, a/c, a/x/y]`; index = git's | match |
| R16 | as R15; `add .` | as R10 | `added:[a] removed:[a/c, a/x/y]`; `a/b`@3 kept | **corrupt index** (walk) |
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
| R13 | file `a`; `add a a/b` | as R2 | throws `NOT_A_DIRECTORY` | wrong refusal |
| R14 | file `a`; `add a/b` | `remove 'a/b'`; exit 0 | throws `NOT_A_DIRECTORY` | wrong refusal |

Mirror rows. Fixture: tracked `a` (file), `real/b`, `top`. Mutation: `a` replaced by directory `a/b`.

| # | Command | git 2.55 | tsgit today | Class |
|---|---|---|---|---|
| M1 | `add a/b` | `add 'a/b'` only: **`a` dropped silently** | `added:[a/b]`; `a` kept next to `a/b` | **corrupt index** |
| M2 | `add a` | `remove 'a'`, `add 'a/b'` | `a` kept | **corrupt index** |
| M3 | `add .` | `remove 'a'`, `add 'a/b'` | `a` kept | **corrupt index** |
| M4 | `add -A` | `remove 'a'`, `add 'a/b'` (orchestrator pin) | `a` kept | **corrupt index** (walk) |
| M6 | symlink `a` → directory; `add a/b`, `add a`, `add .`, `add -A` | as M1-M4 (orchestrator pin) | `a` kept | **corrupt index** |
| M5 | `a` unmerged (1, 2, 3); `add a/b` | `add 'a/b'`; index `a`@1 `a`@2 `a`@3 `a/b`@0 `real/b` `top`: **stages 1-3 of `a` kept** next to `a/b` | `added:[a/b]`; `a`@3 `a/b`@0: stages 1, 2 lost (O1) | **lost stages** (O1); same-stage rule pin |
| M7a | as M5; `add -A` | `remove 'a'`, `add 'a/b'`; **every stage of `a` gone**; index `a/b` `real/b` `top` | `added:[a/b] removed:[]`; `a`@3 kept | **corrupt index** (walk) |
| M7b | as M5; `add .` | as M7a | as M7a | **corrupt index**; stays divergent (O2) |
| M7c | as M5; `add a` | as M7a | as M7a | **corrupt index**; stays divergent (O2) |

Mechanism rows (experimental bundle, see harness):

| # | Edit | Row | tsgit result | Proves |
|---|---|---|---|---|
| X1 | `NOT_A_DIRECTORY` → missing in the probe | R14 | `removed:[a/b]`, index = git's | ADR-993 is a one-arm change: the walk already handles it |
| X2 | same | R13 | `added:[a] removed:[a/b, a/c, a/x/y]`, index = git's | same |
| X3 | every literal routed to the walk | R1 | `removed:[a/b, a/c, a/x/y]`, index = git's | route-to-walk fixes R1… |
| X4 | same | R7 | `a/b` kept, `write-tree` fails | …but not the silent drops: a D/F rule is needed whatever the route |

#### D1.2 Classification

| Gap | Rows | Mechanism in git (inferred from the rows, not from source) | Impact |
|---|---|---|---|
| G1: no reported removal on the fast path | R1-R5, R10, R12, L1 | the tracked-path update pass: pathspec-matched tracked entries now gone from disk → `remove` | Any `add <p>` after a dir→link/file swap writes an index git cannot turn into a tree. `commit` then records a tree with both `a` and `a/b`, or fails. |
| G2: no silent same-stage D/F drop at insertion | R6, R7, R8, R9 (and M1 in the mirror) | inserting a **new** stage-0 entry drops same-stage entries beneath it (and at its leading directories); a path that already has a stage-0 entry is replaced in place with no check (C1, C2); other stages survive (M5) | Same corruption, on every route including `add -A`. |
| G3: unmerged beneath entries not removed on the pathspec walk | R16 | as G1, every stage | Same. |
| G4: a directory at a tracked non-gitlink path reads as present | M2-M4, M6 | the update pass sees `a` (file/link in the index, directory on disk) as deleted | Mirror corruption on the walk paths. |
| G5: `NOT_A_DIRECTORY` escapes the fast-path probe | R13, R14 | — | Wrong refusal; no corruption. |
| G6: unmerged stages lost on rewrite (O1) | U1-U8, U11, M5 | git rewrites only the entries it touches; the other stages of an unmerged path stay | **Data loss**: the conflict's base/ours/theirs blobs vanish from the index; `checkout --ours/--theirs`, `merge-file`, `ls-files -u` lose them. |
| G7: [DC8] staging an unmerged path is not reported when its content equals the last stage | U6, U10 (MD12, MD13) | git prints `add '<path>'` for every unmerged path it stages | Reconstructed `add -v` misses a line. No index impact. |
| G8: [DC9] an exclusion does not shield an unmerged path from a positive pathspec that covers it | U13, U13b | git stages `f` for `add . ':!f'` when `f` is unmerged (as it reports `a/b` in R12) | Conflict left unresolved where git resolves it. No data loss (after G6 is fixed). |

#### D1.3 O1 matrix: unmerged paths on every route (git 2.55.0 vs tsgit `cc53141c`)

Shapes (§Pinning harness): **CC** content conflict, `f` and `h` at stages 1, 2, 3, `f` on disk
with conflict markers. **MD12** `f` modified by us, deleted by them: stages 1, 2, `f` on disk =
ours. **MD13** `f` deleted by us, modified by them: stages 1, 3, `f` on disk = theirs. In every
shape `h` holds stages 1, 2, 3, and `top`, `d/e` (stage 0) are rewritten on disk. `f@123` means
stages 1, 2, 3 of `f`. "git" is `add -v` output, then the stages of `f` and `h` after the add;
"tsgit" is `AddResult` (`added` was `[]` on every row) and the same stages.

| # | Route | Command (shapes) | git 2.55 | tsgit today | Class |
|---|---|---|---|---|---|
| U1 | fast | `add top` (CC, MD12, MD13) | `add 'top'`; `f` and `h` keep every stage | `modified:[top]`; `f@3` (CC), `f@2` (MD12), `f@3` (MD13), `h@3` | **lost stages** |
| U2 | fast | `add top`, `top` and `d/e` not rewritten (CC) | no output; every stage kept | `modified:[]`, yet the index is rewritten (`top` restaged with unchanged content: no path was added or removed, so only a restage commits): `f@3` `h@3` | **lost stages** |
| U3 | fast | `add top`, `f` deleted from disk (CC) | `add 'top'`; `f@123` kept | `f@3` `h@3` | **lost stages** |
| U4 | fast | `add top ':!f'` (CC; tsgit `!f`) | `add 'top'`; every stage kept | `f@3` `h@3` | **lost stages** |
| U5 | walk | `add d` (CC, MD12, MD13) | `add 'd/e'`; every stage kept | `modified:[d/e]`; last stage only | **lost stages** |
| U6 | fast | `add f` (CC, MD12, MD13) | `add 'f'`; `f@0`, `h@123` kept | `f@0`, `h@3`; `modified:[f]` (CC), `modified:[]` (MD12, MD13) | **lost stages** (`h`); report gap MD (G7) |
| U7 | fast | `add top f` (CC) | `add 'f'`, `add 'top'`; `f@0`, `h@123` | `modified:[f, top]`; `f@0`, `h@3` | **lost stages** |
| U8 | walk | `add 't*'` (CC) | `add 'top'`; every stage kept | `f@3` `h@3` | **lost stages** |
| U9 | walk | `add .` (CC) | `add 'd/e'`, `add 'f'`, `add 'h'`, `add 'top'`; `f@0` `h@0` | `modified:[d/e, f, h, top]`; same index | match |
| U10 | bulk | `add -A` (CC, MD12, MD13) | as U9 | index = git's; `modified:[d/e, f, h, top]` (CC), `modified:[d/e, h, top]` (MD12, MD13) | index match; report gap MD (G7) |
| U11 | walk | `add d ':!f'` (CC) | `add 'd/e'`; every stage kept | `f@3` `h@3` | **lost stages** |
| U12 | bulk | `add -A`, `f` deleted from disk (CC, MD12) | `add 'd/e'`, `remove 'f'`, `add 'h'`, `add 'top'`; every stage of `f` gone, `h@0` | `removed:[f]`, `modified:[d/e, h, top]`; index = git's | match |
| U13 | walk | `add . ':!f'` (CC, MD13) | `add 'd/e'`, **`add 'f'`**, `add 'h'`, `add 'top'`; `f@0` `h@0` | `modified:[d/e, h, top]`; `f` last stage, `h@0` | diverge (G8) |
| U13b | walk | `add . ':!f' ':!h'` (CC, MD12, MD13) | `add 'f'` and `add 'h'` despite both exclusions; `f@0` `h@0` | `modified:[d/e, top]`; `f`, `h` last stage | diverge (G8) |
| U14 | renormalize | `add --renormalize .` (CC, MD12, MD13) | `add 'd/e'`, `add 'top'`; every stage kept | `modified:[d/e, top]`; every stage kept | match |
| U15 | renormalize | `add --renormalize top` (CC, MD12, MD13) | `add 'top'`; every stage kept | `modified:[top]`; every stage kept | match |

Headline: every route that rewrites the index from the path-keyed map loses stages 1-2 (or the
non-last stage of a modify/delete pair) of each unmerged path the add does not itself stage or
remove: the fast path (U1-U4, U6, U7) and the pathspec walk (U5, U8, U11). `add .` and `add -A`
match only because they stage or remove every unmerged path (U9, U10, U12). `--renormalize`
matches because it never builds the map (U14, U15). The R10, R12, R16 and M5 rows lose stages the
same way (§D1.1). U13 is a separate gap (G8): fixing O1 turns tsgit's `f@3` into `f@123`, still
not git's `f@0`.

#### D1.4 Consumers of the path-keyed map

Every reader of `ExistingIndexState.entries` (or of a `Map` copied from it) assumed one entry per
path. The design (§D2.2) keeps that map and its meaning, so each consumer below keeps its code.

| Consumer (`add.ts`) | Reads | Assumption today | After §D2.2 |
|---|---|---|---|
| `trackedFirst` (251) | `existing.has(keyOfPath(path))` | an unmerged path counts as tracked | unchanged (same map) |
| `stageLiterals` (263) | `previous = existing.get(...)`; `newEntries.set(...)` | `previous` = last stage; `set` replaces the one stage | unchanged; `set` of a stage-0 entry now collapses **every** stage at write, an untouched unmerged value expands to every stage (§D2.2). [DC8] `modified` also when `previous.flags.stage !== 0` |
| `indexRuleBlob` (1030) | `previous.flags.stage` | any non-zero stage sends it to `indexRules` | unchanged |
| `walkedTrackedFirst` (390) | `existing.keys()` | one key per path, index order | unchanged |
| `processWalkEntry` (805) | `existing.get(...)` twice | `previous` = last stage | unchanged. [DC8] same `modified` conjunct |
| `restagedPathsOf` (664), `wasRestaged` (312) | `existing.get(...)`; `entry !== previous` | a collapsed unmerged path is restaged (new entry object) | unchanged |
| `tallyWalkOutcomes` (673), `addAll` (702) | `new Map(existing)` + `set` | — | unchanged |
| `collectMatchedRemovals` (500) | `[...existing]`, `stage === 0` | unmerged paths never named (O2) | unchanged |
| `collectRemovedEntries` (789) | iterates `existing` | one candidate per path, so an unmerged path is reported once | unchanged; deleting its key now drops **every** stage (§D2.2) |
| `changesIndex` (295) via `commitIfChanged` | `existingCount = existing.size` vs written `entries.length` | both count paths | **change**: both count entries. `existing.size` would make an untouched unmerged index look changed (5 paths, 7 entries written) and write it for nothing |
| `indexRules` (`readExistingEntries`, 855-857) | the `unmerged` array | built from the array, not the map | unchanged |
| `addRenormalized` (521) | the array | never used the map | unchanged |

### D2. Index state and the D/F rule

#### D2.1 The D/F rule: a pure domain module (ADR-992)

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

/** Stage-0 entries at a leading directory of `path` (`a` and `a/x` for `a/x/y`). */
export const entriesAtLeadingDirectories = (
  byKey: ReadonlyMap<IndexPathKey, IndexEntry>,
  path: FilePath,
): ReadonlyArray<IndexEntry>;
```

Both functions take `IndexPath`-bearing entries and are exported from the module file only
(`add.ts` imports it directly, as it imports `index-path-key.js`), so `reports/api.json` is
unchanged.

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
  O(depth). The map holds one entry per path (§D2.2), so an unmerged leading directory shows a
  non-zero stage and is skipped: it returns stage-0 entries only, and every stage of an unmerged
  `a` survives (M5).
- Why domain: ADR-992. The rule is a pure index invariant over entries with no I/O, testable with
  `arbIndexEntry`, next to `compareEntryPath`; `add.ts` is already 1063 lines.

**Inserted paths.** A staged path `p` is *inserted* when the prior index has no stage-0 entry at
`p`: `previous === undefined || previous.flags.stage !== 0`, where `previous` is the map's entry
for `p` (§D2.2). C1 and C2 pin that git runs no D/F check when `p` already has a stage-0 entry.
Re-staging a tracked file, the clean `add <file>` case, therefore never reaches the rule (R4, R6).

**Unmerged beneath entries.** `entriesBeneath` returns every stage. A caller turns them into
paths (one `IndexPathKey` per path) and deletes each key from its working map; §D2.2's write step
then emits no stage for that path. So "remove every stage of an unmerged beneath path git reports"
is one `delete` per path, and the path is reported once (R10, R12, R16).

**Disjointness.** On disk, `p` and a path beneath `p/` cannot both exist. So no add inserts both
`p` and an entry beneath it, and the prior index alone answers "what is beneath / above".

#### D2.2 Multi-stage index state (O1, ADR-996)

Root cause: `readExistingEntries` (`add.ts:849`) builds `Map<IndexPathKey, IndexEntry>` with
`out.set(indexPathKey(entry), entry)` (854). For an unmerged path the last stage in index order
wins, and every route writes `Array.from(<map>.values())`, so the other stages are gone.

Design: keep the path-keyed map as the working set, with an explicit meaning, and carry the full
stages beside it.

```ts
interface ExistingIndexState {
  /** One entry per path: the stage-0 entry, or the last stage of an unmerged path. */
  readonly entries: ReadonlyMap<IndexPathKey, IndexEntry>;
  /** Every stage of every unmerged path, in index order; empty for a merged index. */
  readonly unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>;
  /** The entries as read, in index order (the D/F rule's binary search, §D2.1). */
  readonly sorted: ReadonlyArray<IndexEntry>;
  readonly indexMtime: IndexMtime | undefined;
  readonly indexRules: ReadonlyMap<FilePath, IndexEntry>;
}
```

- `readExistingEntries` builds `unmergedStages` from the `unmerged` array its loop already
  collects (855): no extra pass over the index, no work at all when `unmerged` is empty.
- A route's working map (`newEntries`, `remaining`) changes exactly as today: staging a path
  `set`s a stage-0 entry, removing a path `delete`s its key. The write step expands it:

```ts
/** The index to write: a path still holding an unmerged entry keeps every stage it was read with. */
const withEveryStage = (
  entries: ReadonlyMap<IndexPathKey, IndexEntry>,
  unmergedStages: ExistingIndexState['unmergedStages'],
): IndexEntry[] =>
  unmergedStages.size === 0
    ? Array.from(entries.values())
    : Array.from(entries.values()).flatMap((entry) => stagesOf(entry, unmergedStages));
```

  `stagesOf` returns `[entry]` for a stage-0 entry and the read stages of the entry's key
  otherwise. A non-zero-stage value in the working map can only be one read from the index
  (staging always produces stage 0, `indexEntryFromStat`), so its key is always in
  `unmergedStages`; the implementation expresses that without a dead fallback branch (for
  example by iterating `unmergedStages` for the keys whose working value still has a non-zero
  stage, and the working map for its stage-0 values).
- Outcomes, per R9: untouched unmerged path → map value still the last stage → every stage
  written (U1-U5, U8, U11, M5). Staged path → value is stage 0 → one entry (U6, U7). Removed path
  → key absent → no stage (U12, R10, R12, R15, R16). `serializeIndex` sorts, so emission order
  does not matter.
- `commitIfChanged(lock, existingCount, entries, restagedPaths)` keeps its signature; the three
  routes pass `sorted.length` (the entries read) instead of `existing.size` (the paths), and
  `withEveryStage(...)` instead of `Array.from(map.values())`. `changesIndex`'s rule ("a
  re-staged, added or removed path is a change") still holds: collapsing an unmerged path is a
  restage (`wasRestaged`), and a removal shrinks the entry count. `addRenormalized` already passes
  `entries.length`.
- Every consumer in §D1.4 keeps its code: `previous`, `trackedFirst`, `walkedTrackedFirst`,
  `restagedPathsOf`, `collectRemovedEntries` and `indexRuleBlob` all read the same one-per-path
  map with the same meaning.

Why this shape and not another (no decision candidate: it is the only option that leaves both
the clean path and every §D1.4 consumer's code unchanged):

| Option | Clean path (no unmerged entry) | Consumers touched |
|---|---|---|
| **Chosen**: path-keyed map + `unmergedStages`, expanded at write | one `size === 0` test per write | `readExistingEntries`, the three `commitIfChanged` call sites |
| Key by path + stage | builds a composite key per entry on every read (10 000 string concatenations on the ADR-995 index), and every `get(keyOfPath(path))` (§D1.4, 7 sites) needs a second path → entries lookup | all of §D1.4; `collectRemovedEntries` must also dedupe its reports |
| Merge the read array with a change set at write | one O(n) merge per write in place of `Array.from`: about neutral | rewrites how all three routes tally `newEntries` / `remaining`, and every consumer that reads them |

**Clean-path cost:** the read loop is unchanged (the `stage !== 0` test and `unmerged` array
already exist); the write pays one `unmergedStages.size === 0` test and passes `sorted.length`
(already in hand). Nothing per entry. The ADR-995 bench covers it (§D6); nothing new is measured.

### D3. Fast path (`addLiteralOnly`)

```
dispatchPathspec ── fast path ──▶ addLiteralOnly(ctx, resolved, scope)   // was (ctx, validated, scope)
   stageLiterals(...)                         // unchanged (DC8 adds one disjunct): newEntries, added, modified, restagedPaths
   inserted   = literals whose previous has no stage-0 entry
   beneath    = ∪ entriesBeneath(state.sorted, p)  for p ∈ inserted     // every stage; empty in the clean case
   beneathMap = existing's entry for each beneath key (one per path, §D2.2)
   reported   = collectMatchedRemovals(ctx, beneathMap, inserted, resolved.matcher)       // G1, stage 0 only
              ∪ beneathMap values with stage ≠ 0                                         // R10, R12: once per path
   silent     = beneathMap stage-0 values not in reported                                 // G2: excluded, skip-worktree
   silent    ∪= entriesAtLeadingDirectories(existing, p) for p ∈ inserted                // M1 (§D5)
   newEntries −= keys of reported ∪ silent                                               // every stage of an unmerged key goes
   commitIfChanged(lock, state.sorted.length, withEveryStage(newEntries, state.unmergedStages), restagedPaths)
   return { added, modified, removed: reported paths sorted, eolNotices }
```

- `collectMatchedRemovals` (`add.ts:500`) is reused unchanged on the small `beneathMap`. It
  applies stage 0, `matchesIndexPath` (honours `!` exclusions, R6), and skip-worktree
  (R7, via `collectRemovedEntries`). It treats lossy entries as gone (L1, ADR-973). It checks
  `presentOnDisk`: the leading symlink → gone (R1), `NOT_A_DIRECTORY` → gone (R2).
- Unmerged beneath entries are reported whatever the matcher says (R12 pins git reporting an
  excluded unmerged path). The rule checks the stage before skip-worktree; an unmerged
  skip-worktree entry beneath an inserted path was not pinned and is not a tested row.
  `beneathMap` holds one entry per path, so the path is reported once; deleting its key removes stages 1, 2 and 3 at write
  (§D2.2). R10: `entriesBeneath(sorted, 'a')` = `a/b`@1, `a/b`@2, `a/b`@3, `a/c`, `a/x/y` →
  `beneathMap` = `a/b`@3, `a/c`, `a/x/y` → `removed:[a/b, a/c, a/x/y]`, index `a` `real/b` `top`,
  as git. R12: the same with `a` a regular file and `!a/b`: `a/b` reported (unmerged), `a/c`,
  `a/x/y` matched and gone (`NOT_A_DIRECTORY` → gone) → same `removed`, as git.
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
- Beneath entries are taken one per path from `staged.existing` / `existing`, as on the fast path.
- `addByPathspec`: unmerged beneath paths → appended to `removedEntries` (reported, G3).
  `collectMatchedRemovals` never names an unmerged path (stage-0 filter), so none is reported
  twice. Stage-0 beneath entries not already in `removedEntries` → deleted from `remaining`
  (silent, R9). Leading-directory stage-0 entries → deleted silently (§D5). R16 with every stage
  present: the walk inserts `a` (symlink, kind `added`); `collectMatchedRemovals` reports `a/c`,
  `a/x/y`; the rule adds `a/b` (unmerged) → `removed:[a/b, a/c, a/x/y]`; the three keys leave
  `remaining`, so `withEveryStage` writes no stage of `a/b`. Index `a` `real/b` `top`, as git.
- `addAll`: `collectRemovedEntries` already reports unmerged and stage-0 entries it finds gone,
  one per path; deleting the key now drops every stage (R15 still matches, U12). Only the silent
  drop is new: skip-worktree beneath entries (R8), and the leading-directory drop (§D5).
- Both routes write `withEveryStage(<map>, unmergedStages)` against `sorted.length` (§D2.2).
- Cost: one binary search per inserted path, against the prior index. A first `add -A` into an
  empty index searches an empty array. A steady-state `add -A` inserts few paths.

### D5. Mirror: directory replaced a tracked file or symlink (ADR-991)

- **Silent** (M1, M6 `add a/b`): `entriesAtLeadingDirectories` on every inserted path, on all three
  routes (§D3, §D4).
- **Reported** (M2-M4, M6): `presentOnDisk(ctx, scanner, path)` (`add.ts:765`) becomes
  `presentOnDisk(ctx, scanner, entry)`. A path whose `lstat` is a non-symlink directory counts as
  gone unless `entry.mode === FILE_MODE.GITLINK`; a submodule's checkout is a directory by
  design. `collectRemovedEntries` passes the entry. This reaches `add a` and `add .` through
  `collectMatchedRemovals`, and `add -A` through `addAll`.
- M5: `entriesAtLeadingDirectories` sees `a`@3 (the map's one entry, §D2.2), a non-zero stage, so
  it returns nothing for `a`; `withEveryStage` writes `a`@1, `a`@2, `a`@3 next to `a/b`@0, as git.
  Without §D2.2 this row keeps only `a`@3 (§D1.1).
- An unmerged `a` that is now a directory is removed with every stage by git when the pathspec
  names it (M7a-c). `add -A` gets it from this section: `collectRemovedEntries` passes the
  representative `a`@3 to `presentOnDisk`, which now reads a directory as gone, so `a` is
  reported once and its key leaves `newEntries` (§D2.2 drops all three stages). `add .` and
  `add a` do not: `collectMatchedRemovals` names stage-0 entries only, the O2 gap, which stays out
  of scope; M7b and M7c remain divergent and are not tested as matches.

### D5b. `NOT_A_DIRECTORY` in the fast-path probe (ADR-993)

`allLiteralsAreFiles` (`add.ts:315`) calls `lstatOrMissing` (335), which throws `NOT_A_DIRECTORY`
for `a/b` when `a` is a regular file. The probe treats that code as "not a file" (returns `false`),
so the literal routes to `addByPathspec`, which already stages the removal (X1, X2). The change is
local to the probe: `lstatOrMissing` keeps its contract for its other callers (`stageOne`,
`literalsOnDisk`, `renormalizeOne`), so `--renormalize` keeps refusing (N1, N2). Every other
error code still propagates.

### D6. Performance: bench and acceptance bound

| Scenario (`test/bench/add.bench.ts`) | Covers | Change expected |
|---|---|---|
| existing "Given a scratch repo whose committed file is unchanged on disk / When add() re-stages the unchanged file" (`add.bench.ts:105`) | clean `add <file>` fast path, 1-entry index, re-hash (mtime bump) | none: `previous` is stage 0 → rule skipped; merged index → `withEveryStage` returns the map's values after one `size` test (§D2.2) |
| **new** "Given a scratch repo with 10 000 committed files / When add() re-stages one modified tracked file" | same path against a realistic index (Map build + lookup at scale; `unmergedStages` stays empty) | none |
| **new** "Given a scratch repo with 10 000 committed files / When add() stages one new file" | inserted path → one `entriesBeneath` binary search over 10 000 entries | +O(log n) compares (~14), below noise |

The new scenarios build `buildManyLooseObjectsScratch(10_000)` (`write-scratch.ts:71`, files
`f000000.txt` … `f009999.txt`) once in the factory, outside `sut`. The re-stage `sut` rewrites
`f005000.txt` with a per-iteration payload, so every iteration re-hashes it.
The new-file `sut` writes `new-<counter>.txt` per iteration (the index grows by one per iteration,
which is negligible against 10 000).

Procedure: Part 1 commits the new scenarios **before** any fix, so both refs share them, because
`bench:ab` compares only files present on both sides. After the fix commit:
`npm run bench:ab -- <part-1-sha> HEAD 5` on a quiet machine (`uptime` plus no foreign Stryker run).

**Acceptance bound (ADR-995):** for each of the three scenarios, the head median is within
`+10 %` of base (`DEFAULT_THRESHOLD_PCT`, the CI regression threshold). A breach is re-run once
and, if confirmed, profiled before merge. It is not waived. The O1 change (§D2.2) adds no
scenario: on a merged index it costs one `size` test per write, inside these three scenarios. An
unmerged index pays one `flatMap` over the written entries; no bench measures that shape, and none
is added (a conflict-time add is not a hot path).

### D7. Parts

Each part is one atomic commit, TDD (red → green → refactor), compiling and green on its own.
Interop rows live in `test/integration/add-interop.test.ts` (ubuntu `integration` job only: real
symlinks, lossy names). Unit rows use the memory adapter in
`test/unit/application/commands/add.test.ts` and run on every OS. Order matters: Part 1 is the
`bench:ab` base; Part 3 lands before Parts 4-7 because their unmerged rows (R10, R12, R16, M5,
M7a) assert every stage and need `withEveryStage`.

**Part 1: bench scenarios (no behaviour change).** Commit `test(bench): …`; its sha is the
`bench:ab` base.
Context: `test/bench/add.bench.ts` (shape: the `benchScenario(given, when, factory)` block at 105,
factory returns `{ teardown, sut }`); `test/bench/support/write-scratch.ts`
`buildManyLooseObjectsScratch(fileCount)` (71, files `f%06d.txt`, one commit), `ScratchRepo`
(`cwd`, `repo`, `disposeSync`). Two scenarios per §D6. No test file: bench files are not unit
tested; `npm run validate` must stay green.

**Part 2: domain module.** Commit `feat(index): …`.
Context: new `src/domain/git-index/directory-file-conflict.ts` exporting `entriesBeneath(sorted,
path)` and `entriesAtLeadingDirectories(byKey, path)` (§D2.1); `compareEntryPath`
(`src/domain/git-index/index-writer.ts:59`); `IndexPath`, `IndexPathKey`, `indexPathKey`,
`keyOfPath`, `escapedPathOf`, `pathBytesOf`, `isLossy` (`src/domain/git-index/index-path-key.ts`).
Not re-exported from `src/domain/git-index/index.ts` (ADR-992). Tests: new
`test/unit/domain/git-index/directory-file-conflict.test.ts`: empty index; no match; prefix
siblings `a.txt` and `ab` not beneath `a` (`.` 0x2E, `b` 0x62 sort around `/` 0x2F); nested;
every stage returned; lossy entry beneath; `a` itself not returned; leading directories `a`,
`a/x` for `a/x/y`; a non-zero-stage leading directory skipped. Plus
`directory-file-conflict.properties.test.ts` (lens 2, aggregator; `arbIndexEntry` from
`test/unit/domain/git-index/arbitraries.ts`, sorted with `compareEntryPath`): `entriesBeneath`
equals an independent linear prefix-bytes filter, and every result's bytes start with `p/`;
`numRuns` 100. Gate note: until Part 5 the module's only importers are its tests. `knip`
(`check:dead-code`, `knip.json`, vitest plugin) counts test files as entries, so this should pass;
if it reports the exports as unused, Part 2 is squashed into Part 5 (first production caller)
rather than suppressed.

**Part 3: O1, every stage of untouched unmerged paths survives (R9).** Commit `fix(add): …`.
Context: `add.ts` `ExistingIndexState` (843) gains `unmergedStages` and `sorted`;
`readExistingEntries` (849, build `unmergedStages` from the `unmerged` array filled at 855); new private
`withEveryStage` next to it (§D2.2); call sites `addLiteralOnly` (234), `addByPathspec`
(`commitIfChanged` at 482-487), `addAll` (`commitIfChanged` at 742-747): pass `sorted.length` and
`withEveryStage(...)`; `stageIgnoredWalk` (620) returns the extra fields to `addByPathspec`.
`commitIfChanged` / `changesIndex` signatures unchanged. Unit (memory adapter): generalise the
`seedUnmergedBlobs` precedent (`add.test.ts:3736`) into a helper that writes an index with
stage-0 entries plus an unmerged path at stages {1,2,3}, {1,2} or {1,3} (`fileSize: 0` keeps the
stat shortcut out); assert every entry (path, stage, id) read back with `readIndex`. Rows: U1
(each shape), U5, U6, U7, U8, U11, U12, U14 (U2 is U1's mechanism); one test per guard:
merged index writes the map as-is; untouched unmerged path keeps all stages; staged one collapses to stage 0; removed
one loses every stage and is reported once; an untouched unmerged index with nothing restaged is
not rewritten (count check). Interop: a new describe "Given a merge conflict on f and h" builds
the conflict with identical `runGit` commands on peer and ours (`commit`, `checkout -b side`,
`commit`, `checkout main`, `commit`, `-c merge.conflictStyle=merge merge side`, exit 1 expected
via `tryRunGit`), then `repo.add(...)` vs `git add …`; compare `lsStage` (not `writeTreeOf`: an
unmerged index has no tree) and `AddResult`. Rows U1 (CC, MD12, MD13), U3, U5, U6, U7, U8, U11,
U12; U9, U10, U14 as regression matches.

**Part 4: [DC8 = fold] report a collapsed unmerged path in `modified`.** Commit `fix(add): …`.
Context: `stageLiterals` (263, the `else if` at 289) and `processWalkEntry` (805, the `if` at
837): a previous entry with `flags.stage !== 0` counts as modified whatever the id. Unit + interop
rows U6 and U10 for MD12 and MD13. If DC8 = leave out, this part is dropped and the rows keep
today's `modified`.

**Part 5: fast path (G1, G2, unmerged beneath).** Commit `fix(add): …`.
Context: `dispatchPathspec` (206, pass `resolved`); `addLiteralOnly` (220, signature
`(ctx, resolved: ResolvedPathspec, scope)`, reads `resolved.literalMustMatch`); `stageLiterals`
(263, return the inserted paths or let the caller derive them from `previous`);
`collectMatchedRemovals` (500, reused unchanged on `beneathMap`); `entriesBeneath` (Part 2);
`withEveryStage` (Part 3). Unit: one describe per row R1, R2, R4, R5, R6, R7, R10, R12, L1, C2
(seed with `seedRepo`, remove the directory, `ctx.fs.symlink`; precedent `add.test.ts:196-222`),
asserting `removed` exactly and every index entry including stages. Guard tests: `previous`
absent / unmerged / stage 0; matched vs excluded; skip-worktree vs not; stage 0 vs unmerged;
lossy vs not. Interop: rows R1, R2, R4, R5, R6, R7, R10, R12, L1 (`snapshot` equality +
`removed`; R10, R12 seed `a/b` stages with `update-index --index-info` on both sides; L1 seeds
`a/\377` the same way).

**Part 6: walk paths (G2, G3 on `addByPathspec`, `addAll`).** Commit `fix(add): …`.
Context: `addByPathspec` (460-497: `removedEntries`, `remaining`), `addAll` (702-751:
`removedEntries`, `newEntries`), `tallyWalkOutcomes` (673, `added` outcomes are the inserted
paths, plus outcomes whose `previous` is unmerged: read `staged.existing`), Part 2 module. Unit +
interop rows R8, R9, R16, R15 (regression).

**Part 7: mirror (ADR-991).** Commit `fix(add): …`.
Context: `entriesAtLeadingDirectories` (Part 2) wired into the three insertion sites of Parts 5-6;
`presentOnDisk` (765) takes the entry: a non-symlink directory at a non-`FILE_MODE.GITLINK` entry
is gone; `collectRemovedEntries` (789) passes the entry. Unit + interop rows M1-M6, M5 (all three
stages of `a` kept), M7a. Gitlink exemption unit test: a tracked gitlink whose directory is present
is not removed. M7b, M7c are not asserted (O2).

**Part 8: `NOT_A_DIRECTORY` in the fast-path probe (ADR-993).** Commit `fix(add): …`.
Context: `allLiteralsAreFiles` (315): catch `NOT_A_DIRECTORY` around its `lstatOrMissing` (335)
call and return `false`; no change to `lstatOrMissing`. Unit + interop rows R13, R14; N1, N2 as
regressions (still refuse). A unit test pins that another error code (e.g. `PERMISSION_DENIED`)
still propagates from the probe.

**Measure (not a commit).** After Part 8: `npm run bench:ab -- <part-1-sha> HEAD 5` per §D6;
the table goes in the PR body.

## Decision candidates

Settled:

| # | Choice | Outcome |
|---|---|---|
| DC1 | Fold the mirror case (M1-M6) | Folded: ADR-991 (§D5, Part 7) |
| DC2 | Fix mechanism | Option C, D/F insertion rule on all three routes + fast-path reported removals: ADR-990 |
| DC3 | Where the rule lives | `src/domain/git-index/directory-file-conflict.ts`, pure, off the barrel: ADR-992 |
| DC4 | Fold R13, R14 (`NOT_A_DIRECTORY`) | Folded, probe-only: ADR-993 (§D5b, Part 8) |
| DC5 | Silent drops in `removed` | No: git's reported removals only: ADR-994 |
| DC6 | Bench coverage | Existing + two 10 000-entry scenarios, committed first, +10 %: ADR-995 |
| DC7 | O1 (unmerged stages lost) | Folded, against the first draft's recommendation: ADR-996 (§D1.3, §D2.2, Part 3) |

Open:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC8 | Report a staged unmerged path in `modified` when its content equals the last stage (G7: U6, U10 for MD12/MD13; git prints `add 'f'`, tsgit lists nothing) | A. Fold (Part 4: one `previous.flags.stage !== 0` disjunct in `stageLiterals` and `processWalkEntry`, ~4 unit + 2 interop tests). B. Leave out; backlog entry. | **A** | Same `previous` lookup ADR-996 already reworks, and the conflict-resolution flow ADR-996 puts under test. `AddResult` is the structured source for git's `add -v` (ADR-249, ADR-994); today a resolution that keeps "ours" reconstructs no line. No index impact, so B is defensible under strict scope. |
| DC9 | An exclusion does not shield an unmerged path from a positive pathspec that covers it (G8: U13, U13b; git stages `f` for `add . ':!f'`) | A. Fold: the walk's leaf filter (`withPathspec`, `add.ts:643`) lets an unmerged tracked path matched by the positive pathspec through; a new part after Part 6. B. Leave out; backlog entry next to O2 and O3. | **B** | Not data loss once O1 is fixed (tsgit keeps the conflict, `f@123`, where git resolves it). It is pathspec-exclusion semantics for unmerged entries, the same family as O2 (unmerged removals) and O3 (fast-path negations) that were kept out; folding one of three splits that family. The mechanism needs its own pin (does it hold for globs, and for the fast path, where O3 already ignores negations?) beyond this change. |

## Test strategy

- **Interop (faithfulness proof):** `test/integration/add-interop.test.ts`, one describe per row
  group (Given the mutation / When `repo.add(...)` like `git add …` / Then index and tree match
  git). Every row asserts `snapshot(ours) == snapshot(peer)` (`ls-files --stage` + `write-tree`)
  and `added.removed` exactly. That reconstructs git's `remove` lines from the structured field
  (ADR-249). Rows: R1, R2, R4, R5, R6, R7, R8, R9, R10, R12, R15, R16, L1, C2, R13, R14, M1-M7a,
  plus the `add a/` regressions already covered. Lossy L1 seeds `a/\377` with
  `update-index --index-info` on both sides (no working-tree file on APFS/Windows; the job is
  Linux). O1 rows (§D1.3: U1, U3, U5-U12, U14; U6/U10 report rows under DC8) build a real merge
  conflict with identical `runGit` commands on both sides and compare `lsStage` plus `AddResult`;
  `write-tree` is asserted only where the add leaves no unmerged entry (U9, U10, U12). Runs only
  in the ubuntu `integration` job. U2 and U13 are not interop rows: U2 depends on same-second
  timestamps and is the same mechanism as U1 (any index write); U13 is DC9.
- **Unit:** `add.test.ts` (memory adapter, all OSes) mirrors each row's index outcome and
  `removed`. It adds isolated tests per guard for mutation resistance: inserted vs re-staged
  (`previous` absent / unmerged / stage 0), matcher-excluded vs matched, skip-worktree vs not,
  stage 0 vs unmerged, lossy vs not. Stryker StringLiteral and ConditionalExpression mutants on the
  `stage !== 0` and `previous === undefined` conjuncts each need a one-sided test. O1: per shape
  ({1,2,3}, {1,2}, {1,3}) and per route, every index entry (path, stage, id) is asserted, so an
  `EqualityOperator` mutant on `withEveryStage`'s `size === 0` or stage test is killed by a
  merged-index row and an unmerged-index row; the count check gets a row where nothing is
  restaged and the index file must stay untouched (read the index bytes before and after).
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
- `add --renormalize` during a conflict: already keeps every stage (U14, U15).

Proven out-of-scope findings (not acted on):

- **O1:** folded by ADR-996 (§D1.3, §D2.2, Part 3); no longer out of scope.
- **O2:** `add <pathspec>` never stages the deletion of an unmerged path gone from disk outside
  the D/F case. `a/b` unmerged and deleted, `a/c` modified, `add .`: git reports
  `remove 'a/b'`, tsgit keeps `a/b` (every stage once Part 3 lands). `add.ts:508`:
  `collectMatchedRemovals` filters `stage === 0`. Rows M7b, M7c (unmerged `a` now a directory,
  `add .` / `add a`) are the same gap and stay divergent.
- **O3:** the fast path ignores negations: `add top '!top'` stages `top`, where git's
  `add top ':!top'` stages nothing. `add.ts:214`: the fast-path condition checks only `hasGlob`.
- **O4:** tracked dir `a` turned into a nested repository (`a/b` still tracked); `add a`: git
  exits 0 with no change, tsgit throws `PATHSPEC_NO_MATCH`. The walk skips the embedded
  repository and `a/b` is present, so nothing matches. `add.ts:479`: `enforceLiteralMustMatch`
  ignores tracked index entries under the literal.
- **O5:** staging an unmerged path writes no resolve-undo (`REUC`) extension. CC shape,
  `add f`: `git ls-files --resolve-undo` lists `f` stages 1, 2, 3 after git's add and nothing
  after tsgit's (probe, 2026-10-17). `add.ts:234`: `commitIfChanged` → `IndexLock.commit` carries
  no resolve-undo record; tsgit reads `REUC` only in `fsck` (`src/application/commands/internal/fsck/roots.ts:27`).
