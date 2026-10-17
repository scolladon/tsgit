# Design — `add` of a non-directory that replaced a tracked directory

> Brief: `add <path>` naming a symlink or regular file that replaced a tracked directory keeps the
> index entries beneath it: tracked `a/b`, `real/b`; dir `a` replaced by `a -> real`; git 2.55
> `add a` leaves `a` (120000) + `real/b`, tsgit's literal fast path (`dispatchPathspec` →
> `allLiteralsAreFiles` → `addLiteralOnly`, `removed: []`) keeps `a/b` next to `a`, an index
> `git write-tree` refuses. Pin the matrix against git 2.55, fix it (fast path or walk), and measure
> the clean `add <file>` fast path before and after. Backlog 32.24 (data integrity).
> Status: draft → self-reviewed ×3 → revised against ADR-990 … ADR-996 (O1 folded, mirror and
> `NOT_A_DIRECTORY` folded) → self-reviewed ×3 → revised against ADR-997 … ADR-999 (DC8 folded,
> DC9 folded with its pinned matrix §D1.5, O5 folded for `add` with its byte-level pin §D1.6) →
> self-reviewed ×3

<!-- cspell:ignore lstat lstats unmerged skipwt ENOTDIR esbuild realx REUC strtoul strcmp -->

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
| ADR-991 | The mirror case (rows M1-M6) is in scope (§D5, Part 9). |
| ADR-992 | The rule lives in `src/domain/git-index/directory-file-conflict.ts`, pure, not in the public barrel (§D2.1, Part 2). |
| ADR-993 | `NOT_A_DIRECTORY` counts as missing in the fast-path probe only (R13, R14, Part 10). |
| ADR-994 | `removed` holds git's reported removals only; silent drops stay out of it. |
| ADR-995 | Bench: existing scenario + two 10 000-entry scenarios, committed first; bound +10 % (§D6, Part 1). |
| ADR-996 | `add` keeps every stage of the unmerged paths it does not stage; staging a path collapses its stages to stage 0 (§D1.3, §D2.2, Part 4). |
| ADR-997 | A staged path whose prior entry is unmerged is reported in `modified`, whatever its content, on every route (R10, Part 5). |
| ADR-998 | An exclusion does not shield an unmerged path that a positive pathspec covers. The pinned matrix (§D1.5) bounds *which* exclusions: see DC10 (§D9, Part 11). |
| ADR-999 | When `add` collapses or removes an unmerged path it records the path's prior stages in `REUC`, keeping the other records, as git does (§D1.6, §D8, Parts 3 and 6). `rm`, `update-index`, `checkout -m` are unchanged. |
| ADR-965 | Extension carry policy lives in `carryExtensions` (domain), driven by the write kind; writers pass data through `CommitOptions` (precedent: `restagedPaths`). The `REUC` record merge follows the same route (§D8.2). |
| ADR-038 | tsgit's pathspec is last-match-wins and an all-negation pathspec matches nothing. Rows that only differ through those rules (D3, re-inclusion order) are not DC9 rows. |

### What exists today (verified in the tree, `7c3d7f2f`; `src/` unchanged since `0f8d0b16`)

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
| Walk leaf filter | `withPathspec(ignore, matcher)` (`add.ts:643`): a leaf is kept iff `matchesPathspec(matcher, path)`; built in `addByPathspec` (466) **before** the index is read (`stageIgnoredWalk`, 620) | **Change** (§D9) |
| Pathspec | `src/domain/pathspec/compile-pathspec.ts` — `PathspecEntry { pattern, body, negated, isLiteral, compiled }`, `compilePathspec`; `match-pathspec.ts` — `matchesPathspec(spec, path)` (last match wins, ADR-038); bodies arrive collapsed (`./f` → `f`, `resolve-pathspec.ts:57`) | Reused; **new** sibling predicate (§D9) |
| Resolve-undo codec | `src/domain/git-index/resolve-undo.ts` — `ResolveUndoStage { stage, mode: number, id }`, `ResolveUndoRecord { path: string, stages }`, `parseResolveUndo(data, digestLength)` (`undefined` = malformed, git drops the whole extension). Path decoded with a BOM-stripping `TextDecoder`; no serializer. Only consumer: `fsck/roots.ts:354` (reads `stages`, never `path`). Not in the `git-index` barrel, not in `reports/api.json` | **Change** (§D8.1) |
| Extension carry | `src/domain/git-index/carry-extensions.ts` — `carryExtensions(previous, change, kind, settings)`; `carryUnmerged` (51-58): `REUC` dropped on `replace`, dropped on `update` when `change.resolvedUnmerged`, else verbatim | **Change** (§D8.2) |
| Index write | `src/application/primitives/internal/index-lock.ts` — `CommitOptions { restagedPaths? }` (38); `IndexLock.commit(entries, kind, options)` → `commitLocked` (333) → `carriedExtensions(ctx, previous, entries, kind, options)` (188-200; early `[]` when the previous index has no extension) → `stageLock` → `serializeIndex` | **Change** (§D8.2) |
| Resolve-undo `resolvedUnmerged` | `src/domain/git-index/diff-index-entries.ts` — `hasResolvedUnmerged` (97): true when an unmerged path now has a stage-0 entry only (a removal does not count) | Unchanged |
| Extension tests | `test/unit/domain/git-index/{resolve-undo,resolve-undo.properties,carry-extensions,carry-extensions.properties}.test.ts` (the properties file's local `encode` is git's `resolve_undo_write` layout); `test/unit/application/primitives/helpers/index-extensions.ts` (`resolveUndoExtension`, `withIndexExtensions`, `indexExtensionsOf`); `test/unit/application/commands/index-carry-update-writers.test.ts` (`add carries index extensions`, 106); `test/integration/index-extensions-interop.test.ts` (`extensionsOf(dir, format)`, 147) | Extended |
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

DC9 rows (§D1.5) reuse the O1 merge with the conflicted path at `f`, `d/f` or `f.txt`; `RM` rows
delete it from disk before the add. Each row runs `G add -v <git spelling>` (in the subdirectory
named, for `:/` and relative exclusions) and the bundle with tsgit's spelling (`!x` for `:!x`). D/F
rows with exclusions (R12, R12g, R12h, R12d, R12gd, R12hd) reuse the `update-index --index-info`
seed. Resolve-undo rows (§D1.6) run git only (tsgit writes no `REUC`) and decode the `REUC`
extension straight from `.git/index` with a throwaway reader (entries skipped, then each extension's
signature, size and bytes; records split as `path NUL mode NUL mode NUL mode NUL` + one digest per
non-zero mode). Whole-index comparison (W1) masks the per-copy stat fields of each entry (ctime,
mtime, dev, ino: the first 24 bytes) and compares the header, the masked entries and each
extension's bytes. The malformed-`REUC` rows rewrite one mode byte to `9` and recompute the
SHA-1 trailer. All pinned on 2026-10-17 against `src/` at `0f8d0b16`.

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
  entries the pathspec matches that are not skip-worktree, plus the unmerged entries the pathspec
  selects (once per path; "selects" bounded by R11).
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
  removing it (gone from disk, or beneath an inserted path the pathspec selects it under) drops
  all its stages and reports it once (U12, R10, R12, R15, R16); an unmerged path beneath an
  inserted path that the pathspec does not select keeps every stage (rows R12h, R12hd). `--renormalize` already complies (U14, U15). An index with no
  unmerged entry is written exactly as today.
- **R10** (ADR-997) Staging an unmerged path lists it in `modified` whatever its content, as git
  prints `add '<path>'` for it (rows U6 MD12/MD13, U10 MD12/MD13).
- **R11** (ADR-998) On the walk paths, an unmerged path with two or more stages that a positive
  pathspec element covers is staged (or, beneath an inserted path, reported removed) despite an
  exclusion that names it *exactly*; a glob or leading-directory exclusion still shields it, and so
  does an exact exclusion when the only covering positive also names it exactly, or when the path
  holds a single stage (§D1.5 leak rows D0, D1, D4, D7, D8, D16, E1, E8, E10; shield rows D5, D6,
  E3, E4, E7, S1, D10, D11; rows R12, R12d, R12h, R12hd).
- **R12** (ADR-999) Every unmerged path `add` collapses to stage 0 or removes gets a `REUC` record
  holding its prior stages (missing stages as mode `0`, no digest). An existing record for the same
  path is updated stage by stage, records for other paths are kept, records are sorted by path
  bytes, and a malformed `REUC` is replaced by the new records alone. An `add` that resolves
  nothing leaves `REUC` exactly as today. The index file equals git's byte for byte outside the
  per-copy stat fields (§D1.6 rows V1-V14, W1).

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
| R12 | `a/b` unmerged (1, 2, 3), file `a`; `add a ':!a/b'` | `remove 'a/b'` **reported despite the exclusion**, `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; index `a`(100644) `real/b` `top` | `added:[a] removed:[]`; `a/b`@3 `a/c` `a/x/y` kept | **corrupt index**; the exact-exclusion leak (§D1.5) |
| R12g | as R12; `add a ':!a/*'` | `add 'a'` only; index `a`@0 **`a/b`@1 @2 @3 kept**, `a/c` `a/x/y` dropped silently | `a/b`@3 `a/c` `a/x/y` kept | **corrupt index**; not asserted (O7: tsgit's `a/*` does not reach `a/x/y`) |
| R12h | as R12; `add a ':!a/b*'` | `remove 'a/c'`, `remove 'a/x/y'`, `add 'a'`; index `a`@0 `a/b`@1 @2 @3 `real/b` `top` | `added:[a] removed:[]`; `a/b`@3 `a/c` `a/x/y` kept | **corrupt index**: a glob exclusion shields the unmerged `a/b` |
| R12d | as R12; `add . ':!a/b'` | as R12 | `removed:[a/c, a/x/y]`; `a/b`@3 kept | **corrupt index** (walk) |
| R12hd | as R12; `add . ':!a/b*'` | as R12h | `removed:[a/c, a/x/y]`; `a/b`@3 kept | lost stages (walk) |
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
| G7: staging an unmerged path is not reported when its content equals the last stage (ADR-997) | U6, U10 (MD12, MD13) | git prints `add '<path>'` for every unmerged path it stages | Reconstructed `add -v` misses a line. No index impact. |
| G8: an exact exclusion does not shield a multi-stage unmerged path a non-exact positive covers (ADR-998) | §D1.5; R12, R12d | inferred from §D1.5, not from source: the path's first stage is matched normally, the next stage is matched again with every element that matched the path *exactly* skipped, so an exact exclusion (and an exact positive) drops out while a glob or leading-directory element still applies | Conflict left unresolved where git resolves it (walk); with D/F, an unmerged beneath path kept where git removes it. |
| G9: no resolve-undo recorded, and an existing `REUC` dropped, when `add` resolves (ADR-999) | §D1.6 | `add` records each collapsed or removed unmerged path's stages in `REUC`, merging with the records already there | `git ls-files --resolve-undo` and `git checkout -m <path>` (re-create the conflict) find nothing after a tsgit `add`; worse, tsgit **drops** records git or an earlier `rm` left for other paths (V9). |

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

#### D1.5 DC9 matrix: exclusions and unmerged paths (git 2.55.0 vs tsgit `0f8d0b16`)

CC shape unless stated (§D1.3), conflicted path `F` at stages 1, 2, 3, `h` too, `top` and `d/e`
rewritten. "git" is the `add -v` lines for `F` and its stages after; every other path behaves as
U9 (`h` staged when covered). tsgit today lists only the last stage (O1) and stages nothing
excluded. "Leak" = git stages (or removes) `F` although an exclusion names it.

| # | `F` | Command (git spelling; tsgit spelling where it differs) | git 2.55 for `F` | Leak? |
|---|---|---|---|---|
| D0 | `f` | `add . ':!f'` | `add 'f'`, `f`@0 | **yes** |
| D1 | `f` (MD12) | `add . ':!f'` | `add 'f'`, `f`@0 | **yes** (two stages suffice) |
| D2 | `f` | `cd d; add :/ ':!f'` | `add 'f'`, `f`@0 | not a leak: from `d`, `:!f` names `d/f` (a merged modified `g` is staged by `cd d; add :/ ':!g'` the same way) |
| D16 | `f` | `add . ':(exclude)f'` | as D0 | **yes** |
| E8 | `f` | `add . ':!./f'` (tsgit `!f`) | as D0 | **yes** (normalised body) |
| E10 | `f.txt` | `add . ':(exclude,literal)f.txt'` (tsgit `!f.txt`) | `add 'f.txt'`, `f.txt`@0 | **yes** |
| E9 | `d/f` | `cd d; add . ':!f'` (tsgit `d`, `!d/f`: D4) | `add 'd/f'`, `d/f`@0 | **yes** |
| D4 | `d/f` | `add d ':!d/f'` | `add 'd/f'`, `d/f`@0 | **yes** |
| D7 | `f.txt` | `add '*.txt' ':!f.txt'` | `add 'f.txt'`, `f.txt`@0 | **yes** (glob positive) |
| D8 | `f` | `add 'f*' ':!f'` | `add 'f'`, `f`@0 | **yes** |
| E1 | `f` | `add f . ':!f'` | `add 'f'`, `f`@0 | **yes** (`.` still covers) |
| E5 | `f` | `add -A . ':!f'` | `add 'f'`, `f`@0 | **yes** (tsgit's `all` takes no pathspec: not a tsgit row) |
| D5 | `d/f` | `add . ':!d'` | nothing; `d/f`@1 @2 @3 kept | no (leading-directory exclusion) |
| E4 | `d/f` | `add . ':!d/'` | as D5 | no |
| D6 | `f.txt` | `add . ':!*.txt'` | nothing; every stage kept | no (glob exclusion) |
| E3 | `f` | `add . ':!f*'` | nothing; every stage kept | no |
| E7 | `f` | `add . ':!f' ':!f*'` | nothing; every stage kept | no (the glob still excludes) |
| D9 | `f` (CC, MD13) | `add f ':!f'` | nothing; every stage kept | no (the exact positive drops out too) |
| E6 | `f` | `add f ':!f*'` | nothing; every stage kept | no |
| D10 | `f` | `add top ':!f'` | nothing (U4) | no (no positive covers `f`) |
| D11 | `f` | `add d ':!f'` | nothing (U11) | no |
| S1 | `f` at stage 3 only, `f` modified | `add . ':!f'` | nothing; `f`@3 kept | no (one stage) |
| D3 | `f` | `add ':!f'` | as D0 (git: an all-exclusion pathspec means `.`) | n/a: tsgit matches nothing (ADR-038) |
| D12 | `f`, deleted (CC, MD12) | `add . ':!f'` | `remove 'f'`, every stage gone | **yes**: O2 (tsgit names no unmerged removal on the walk, D14) |
| D13 | `d/f`, deleted | `add d ':!d/f'` | `remove 'd/f'` | **yes**: O2 |
| D14 | `f`, deleted | `add .` (no exclusion) | `remove 'f'` | — : O2 itself |
| D15 | `f`, deleted | `add f ':!f'` | nothing, exit 0 | no; tsgit throws `PATHSPEC_NO_MATCH` (O3: the literal is routed as a positive) |

D/F rows (§D1.1): R12 and R12d leak (exact `:!a/b`); R12h and R12hd do not (glob `:!a/b*`): `a/b`
keeps stages 1, 2, 3 next to the new stage-0 `a`, the same-stage rule (M5) applied from the other
side.

**Rule (inferred from the rows, not from git's source).** For a path `P` with `n` index entries:

```
selected(P) = matches(spec, P)
           || (n ≥ 2 && matches(spec without the literal elements whose body is exactly P, P))
```

`matches` is the ordinary pathspec verdict. Each row checks out: D0 drops `!f` and keeps `.`; D9
drops both `f` and `!f`, leaving no positive; D5, D6, E3, E4, E7 keep their glob or
leading-directory exclusion; S1 has `n = 1`; D10, D11 have no covering positive.

**Headline.** The ADR-998 wording ("whatever the exclusions say") holds only for *exact*
exclusions of a path with two or more stages. Glob and leading-directory exclusions still shield
(D5, D6, E3, E4, E7, R12h), and so does an exact exclusion when an exact positive is the only one
covering the path (D9, E6), or when the path has one stage (S1). The design follows the pinned rule
(DC10, §D9).

**Routes.** Every leaking row a tsgit route can host is a **walk** row: a covering positive that is
not the exact path is a directory, `.` or a glob, and each of those sends `dispatchPathspec` to
`addByPathspec`. The fast path takes only positive literals that each name an existing file, so
an unmerged path it covers is covered *exactly*: the leak never applies there (D9, E6 in rule
form), and those rows diverge today only because the fast path ignores negations (O3). DC9 needs
no fast-path change except the D/F beneath predicate (row R12, §D3), so **O3 does not fall out and
stays out of scope**. The removal leak (D12, D13) lives in `collectMatchedRemovals`' stage-0
filter (O2, `add.ts:508`); the walk leaf filter never sees a path that is gone, so fixing DC9 does
not touch it: **O2 stays out of scope**, and D12, D13 stay divergent.

#### D1.6 Resolve-undo (`REUC`) matrix (git 2.55.0)

`REUC` data, as git writes it: per record, `path NUL`, then the three stage modes as octal ASCII
each followed by `NUL` (`0` for a missing stage), then one raw digest per non-zero mode in stage
order. Records are sorted by path bytes. Hex below is the extension data (after the 8-byte
`REUC` + size header); oids abbreviated in the decoded column.

| # | Sequence (CC shape unless stated) | `REUC` after (decoded) | Extensions |
|---|---|---|---|
| V1 | `add f` | `f` `100644,100644,100644` `df967b9,b19a1e9,950b81b`; data `66 00 313030363434 00 313030363434 00 313030363434 00` + 3 × 20 bytes (83 bytes) | `TREE[32] REUC[83]` |
| V2 | V1, then `add h` | `f` (as V1) then `h` `6e9f0da,b19a1e9,950b81b` (166 bytes) | `TREE REUC[166]` |
| V3 | `add h`, then `add f` | `f` before `h`: **sorted by path**, not insertion | `REUC[166]` |
| V4 | MD12, `add f` | `f` `100644,100644,0` `df967b9,b19a1e9,-`: data `…00 30 00` + 2 digests (58 bytes) | `REUC[58]` |
| V5 | MD13, `add f` | `f` `100644,0,100644` `df967b9,-,950b81b` | `REUC[58]` |
| V6 | add/add (stages 2, 3), `add f` | `f` `0,100644,100644` `-,b19a1e9,950b81b` | `REUC[58]` |
| V7 | `f` deleted, `add -A` (U12) / MD13 `f` deleted, `add .` | `f` recorded (all its stages) **for a removal** as for a staging; `h` recorded | `REUC[166]` / `REUC[141]` |
| V8 | D/F: row R10 (`add a`), row R12 (`add a ':!a/b'`) | `a/b` `5626abf,f719efd,2bdf67a` (removed beneath the inserted `a`) | `TREE[35] REUC[85]` |
| V8b | rows R12g, M5 (stages kept) | none | `TREE` only |
| V8c | mirror M7a (`add -A`) | `a` `5626abf,f719efd,2bdf67a` | `REUC[83]` |
| V8d | S1 (`f` at stage 3 only), `add f` / `add .` | `f` `0,0,100644` `-,-,2bdf67a` (33 bytes) | `REUC[33]` |
| V9 | `rm --cached h` (git records `h`), then `add f` | `f` and `h`: **existing record kept**, new one inserted | `REUC[166]` |
| V10 | V1, then `update-index --index-info` re-creates `f` at stage 1 (`9e35a1c`, 100644) and stage 2 (`d735d34`, **100755**), then `add f` | `f` `100644,100755,100644` `9e35a1c,d735d34,950b81b`: **stages 1, 2 overwritten, stale stage 3 kept** (per-stage update, not replace). `update-index` itself left the record untouched | `REUC[83]` |
| V11 | V1, then `checkout -m f` (re-creates the conflict), then `add f` | after `checkout -m`: **empty `REUC[0]`**; after `add f`: `f` as V1 | `REUC[0]` → `REUC[83]` |
| V12 | V1, then `add f` again (stage 0, record exists), `add .`, `add -A`, `commit`, `add f` | `f` record **unchanged** by every non-resolving step (`add .` adds `h` because it resolves `h`); `commit` keeps `REUC` | `REUC` kept |
| V13 | `add top`, `add d/e` (nothing resolved) | no `REUC` created | `TREE` only |
| V14 | V1, `REUC` corrupted (mode `900644`), then `add h` | git warns `Index records invalid resolve-undo information`; `REUC` = `h` **only** (the malformed extension is dropped whole, then the new record is written) | `REUC[83]` |
| V15 | as V14, then `add top` (nothing resolved) | **no `REUC`** (dropped) | `TREE` only |
| W1 | `add f h` (CC), git vs tsgit, stat-masked | header, entries and `TREE` **identical**; git has `REUC[166]`, tsgit none | — |
| — | DC9 D0 (`add . ':!f'`), `add -A` | `f` and `h` recorded | `REUC[166]` |

tsgit today: no `REUC` in V1-V8d, V10-V13 (nothing written); V9 and every row that resolves a path
with a `REUC` already present **drop the whole extension** (`carryUnmerged`, `carry-extensions.ts:57`:
`update` + `resolvedUnmerged`), e.g. `rm --cached h` then tsgit `add f` leaves `TREE[32]` only;
non-resolving writes keep it verbatim (`add top` after V1: identical `REUC[83]`, matches V12);
V15 keeps the malformed bytes verbatim (O6).

**Headline.** Format, ordering and merge rules are pinned at byte level: path, three octal-ASCII
modes (`0` for absent), digests of present stages only, records sorted by path bytes, a record
updated stage by stage, other records kept, a malformed extension replaced by the new records.
The record content is exactly the stages the index held, whether the path is staged (V1-V6) or
removed (V7, V8, V8c). Apart from per-copy stat data, W1 shows `REUC` is the only byte
difference after `add` resolves a conflict; §D8 closes it, and the interop rows check it.

#### D1.4 Consumers of the path-keyed map

Every reader of `ExistingIndexState.entries` (or of a `Map` copied from it) assumed one entry per
path. The design (§D2.2) keeps that map and its meaning, so each consumer below keeps its code.

| Consumer (`add.ts`) | Reads | Assumption today | After §D2.2 |
|---|---|---|---|
| `trackedFirst` (251) | `existing.has(keyOfPath(path))` | an unmerged path counts as tracked | unchanged (same map) |
| `stageLiterals` (263) | `previous = existing.get(...)`; `newEntries.set(...)` | `previous` = last stage; `set` replaces the one stage | unchanged; `set` of a stage-0 entry now collapses **every** stage at write, an untouched unmerged value expands to every stage (§D2.2). `modified` also when `previous.flags.stage !== 0` (ADR-997, Part 5) |
| `indexRuleBlob` (1030) | `previous.flags.stage` | any non-zero stage sends it to `indexRules` | unchanged |
| `walkedTrackedFirst` (390) | `existing.keys()` | one key per path, index order | unchanged |
| `processWalkEntry` (805) | `existing.get(...)` twice | `previous` = last stage | same `modified` disjunct (ADR-997, Part 5) |
| `restagedPathsOf` (664), `wasRestaged` (312) | `existing.get(...)`; `entry !== previous` | a collapsed unmerged path is restaged (new entry object) | unchanged |
| `tallyWalkOutcomes` (673), `addAll` (702) | `new Map(existing)` + `set` | — | unchanged |
| `collectMatchedRemovals` (500) | `[...existing]`, `stage === 0` | unmerged paths never named (O2) | unchanged (O2 stays out, §D1.5) |
| `collectRemovedEntries` (789) | iterates `existing` | one candidate per path, so an unmerged path is reported once | unchanged; deleting its key now drops **every** stage (§D2.2) |
| `changesIndex` (295) via `commitIfChanged` | `existingCount = existing.size` vs written `entries.length` | both count paths | **change**: both count entries. `existing.size` would make an untouched unmerged index look changed (5 paths, 7 entries written) and write it for nothing |
| `indexRules` (`readExistingEntries`, 855-857) | the `unmerged` array | built from the array, not the map | unchanged |
| `addRenormalized` (521) | the array | never used the map | unchanged; resolves nothing, so records no `REUC` |
| resolve-undo records (new, §D8.3) | `unmergedStages` vs the route's final working map | — | a key whose final value is absent or stage 0 was resolved |

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
is one `delete` per path, and the path is reported once (R10, R12, R16). An unmerged beneath path
the pathspec does not select keeps its key, so every stage is written (R12h, §D3).

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
- `commitIfChanged(lock, existingCount, entries, restagedPaths)` keeps its signature here (Part 4;
  Part 6 swaps `restagedPaths` for a `CommitOptions`, §D8.3); the three routes pass `sorted.length` (the entries read) instead of `existing.size` (the paths), and
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
   stageLiterals(...)                         // + the ADR-997 disjunct: newEntries, added, modified, restagedPaths
   inserted   = literals whose previous has no stage-0 entry
   beneath    = ∪ entriesBeneath(state.sorted, p)  for p ∈ inserted     // every stage; empty in the clean case
   beneathMap = existing's entry for each beneath key (one per path, §D2.2)
   reported   = collectMatchedRemovals(ctx, beneathMap, inserted, resolved.matcher)       // G1, stage 0 only
              ∪ beneathMap values with stage ≠ 0 the pathspec selects                    // R10, R12: once per path
   silent     = beneathMap stage-0 values not in reported                                 // G2: excluded, skip-worktree
   silent    ∪= entriesAtLeadingDirectories(existing, p) for p ∈ inserted                // M1 (§D5)
   newEntries −= keys of reported ∪ silent                                               // every stage of an unmerged key goes
                                                                                          // an unselected unmerged beneath path stays (R12h)
   final      = withEveryStage(newEntries, state.unmergedStages)
   commitIfChanged(lock, state.sorted.length, final,
                   { restagedPaths, resolveUndo: resolvedRecords(state.unmergedStages, newEntries) })   // §D8.3
   return { added, modified, removed: reported paths sorted, eolNotices }
```

- `collectMatchedRemovals` (`add.ts:500`) is reused unchanged on the small `beneathMap`. It
  applies stage 0, `matchesIndexPath` (honours `!` exclusions, R6), and skip-worktree
  (R7, via `collectRemovedEntries`). It treats lossy entries as gone (L1, ADR-973). It checks
  `presentOnDisk`: the leading symlink → gone (R1), `NOT_A_DIRECTORY` → gone (R2).
- An unmerged beneath path is reported when the pathspec *selects* it, and otherwise kept with
  every stage: git's same-stage rule never drops stages 1-3 for a stage-0 insertion (rows R12h,
  R12g, M5). "Selects" is `matchesIndexPath(matcher, entry)` from Part 7, then the §D9 predicate
  (exact-exclusion leak) from Part 11. The rule checks the stage before skip-worktree; an unmerged
  skip-worktree entry beneath an inserted path was not pinned and is not a tested row.
  `beneathMap` holds one entry per path, so the path is reported once; deleting its key removes
  stages 1, 2 and 3 at write (§D2.2) and gives it a `REUC` record (§D8.3, V8). R10:
  `entriesBeneath(sorted, 'a')` = `a/b`@1, `a/b`@2, `a/b`@3, `a/c`, `a/x/y` → `beneathMap` =
  `a/b`@3, `a/c`, `a/x/y` → `removed:[a/b, a/c, a/x/y]`, index `a` `real/b` `top`, `REUC` `a/b`,
  as git. R12h (`!a/b*`): `a/b` not selected → kept at stages 1-3; `a/c`, `a/x/y` matched and gone
  (`NOT_A_DIRECTORY` → gone) → `removed:[a/c, a/x/y]`, no `REUC`, as git. R12 (`!a/b`) matches
  git only once Part 11 lands: the exact exclusion leaks, so `a/b` is selected and reported.
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
- `addByPathspec`: unmerged beneath paths the pathspec selects (§D3) → appended to
  `removedEntries` (reported, G3); the others stay at every stage (R12hd).
  `collectMatchedRemovals` never names an unmerged path (stage-0 filter), so none is reported
  twice. Stage-0 beneath entries not already in `removedEntries` → deleted from `remaining`
  (silent, R9). Leading-directory stage-0 entries → deleted silently (§D5). R16 with every stage
  present: the walk inserts `a` (symlink, kind `added`); `collectMatchedRemovals` reports `a/c`,
  `a/x/y`; the rule adds `a/b` (unmerged) → `removed:[a/b, a/c, a/x/y]`; the three keys leave
  `remaining`, so `withEveryStage` writes no stage of `a/b`. Index `a` `real/b` `top`, as git.
- `addAll`: `collectRemovedEntries` already reports unmerged and stage-0 entries it finds gone,
  one per path; deleting the key now drops every stage (R15 still matches, U12). Only the silent
  drop is new: skip-worktree beneath entries (R8), and the leading-directory drop (§D5).
- Both routes write `withEveryStage(<map>, unmergedStages)` against `sorted.length` (§D2.2), with
  `resolveUndo: resolvedRecords(unmergedStages, <map>)` (§D8.3).
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

Resolve-undo (§D8.3) and the DC9 predicate (§D9) add, on a merged index, one iteration over an
empty map per write and one lookup in an empty map per *unmatched* walked leaf; the fast-path
scenarios touch neither. No scenario is added for them.

### D7. Parts

Each part is one atomic commit, TDD (red → green → refactor), compiling and green on its own.
Interop rows live in `test/integration/add-interop.test.ts` (ubuntu `integration` job only: real
symlinks, lossy names). Unit rows use the memory adapter in
`test/unit/application/commands/add.test.ts` and run on every OS. Order follows the dependencies:

```
1 bench ─────────────────────────────────────────────────────────── bench:ab base
2 D/F domain module ──────────────┐
3 REUC codec (domain) ──────┐     │
4 O1 multi-stage map ───────┼─────┼──▶ every unmerged row below asserts every stage
5 ADR-997 modified          │     │
6 REUC write in add ◀───────┘(3,4)│  ──▶ every later resolution gets its record for free
7 fast path D/F ◀─────────────────┘(2,4,6)
8 walks D/F ◀── (2,4,6,7: shares the beneath predicate)
9 mirror ◀── (2,7,8: the three insertion sites)
10 NOT_A_DIRECTORY probe (independent of 2-9: the walk already handles R13, R14, X1, X2)
11 DC9 leak ◀── (4,5,6,7,8: swaps the predicate Parts 7-8 introduced, stages through 4-6)
```

Interop rows that resolve or remove an unmerged path also compare the `REUC` extension bytes of
both indexes (from Part 6 on): `readIndex(ctx).extensions` on ours, the same read of the peer's
`.git/index` through a node context, as `index-extensions-interop.test.ts:147` (`extensionsOf`)
does, plus `git ls-files --resolve-undo` on both.

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
`numRuns` 100. Gate note: until Part 7 the module's only importers are its tests. `knip`
(`check:dead-code`, `knip.json`, vitest plugin) counts test files as entries, so this should pass;
if it reports the exports as unused, Part 2 is squashed into Part 7 (first production caller)
rather than suppressed.

**Part 3: resolve-undo codec (ADR-999, §D8.1).** Commit `feat(index): …`.
Context: `src/domain/git-index/resolve-undo.ts`: `ResolveUndoRecord` becomes `IndexPath & {
stages }`; `readRecord` builds the path with `indexPathOfBytes` (`index-path-key.ts`) instead of
`DECODER.decode`; new `serializeResolveUndo(records, digestLength)`, `recordResolveUndo(records,
resolved)`, `resolveUndoRecordOf(stages)`. Helpers: `pathBytesOf`, `indexPathKey`,
`compareEntryPath` (`index-writer.ts:59`), `hexToBytes` (`src/domain/objects/encoding.js`),
`IndexEntry` (`index-entry.ts`, `mode: FileMode` octal string, `flags.stage`). Consumer to keep
green: `src/application/commands/internal/fsck/roots.ts:354` (reads `stages` only). Tests:
`test/unit/domain/git-index/resolve-undo.test.ts` (examples: V1, V4, V5, V6, V8d bytes written
literally as hex from §D1.6; a lossy path round-trips its bytes; a path starting with U+FEFF keeps
it; merge: same path stage-wise update with a stale stage kept (V10), insert before/after
(V3), other records kept (V9), empty prior; `resolveUndoRecordOf` for a symlink stage → mode
`0o120000`). `resolve-undo.properties.test.ts`: move the local `arbRecord`/`encode` to
`test/unit/domain/git-index/arbitraries.ts` (path from `arbPathBytes`/`arbRawPathBytes` through
`indexPathOfBytes`); lens 1 `parseResolveUndo(serializeResolveUndo(r)) ≡ r` (`numRuns` 200);
lens 4 `serializeResolveUndo(parseResolveUndo(encode(r))) ≡ encode(r)` against the independent
`encode`; lens 2 for `recordResolveUndo`: output sorted and key-unique, every resolved stage
present, every untouched prior record unchanged, idempotent on re-applying `resolved`
(`numRuns` 100). Same knip gate note as Part 2 (first production caller: Part 6).

**Part 4: O1, every stage of untouched unmerged paths survives (R9).** Commit `fix(add): …`.
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

**Part 5: report a collapsed unmerged path in `modified` (ADR-997, R10).** Commit `fix(add): …`.
Context: `stageLiterals` (263, the `else if` at 289) and `processWalkEntry` (805, the `if` at
837): a previous entry with `flags.stage !== 0` counts as modified whatever the id. Unit
(memory adapter, the Part 4 seeding helper) + interop rows U6 and U10 for MD12 and MD13; one-sided
guard tests: unmerged previous with equal id → modified; stage-0 previous with equal id and mode →
not modified.

**Part 6: record resolve-undo on `add` (ADR-999, R12, §D8.2-§D8.3).** Commit `fix(add): …`.
Context: `src/application/primitives/internal/index-lock.ts`: `CommitOptions` (38) gains
`resolveUndo`; `carriedExtensions` (188-200, the early-return guard) passes
`options.resolveUndo ?? []`; `src/domain/git-index/carry-extensions.ts`: `carryExtensions`
gains the `resolved` parameter, `carryUnmerged` (51-58) the merge branch (Part 3 codec);
`add.ts`: new private `resolvedRecords` next to `withEveryStage` (Part 4); `commitIfChanged`
(301) / `changesIndex` (295) take `CommitOptions`; call sites `addLiteralOnly` (234),
`addByPathspec` (482-487), `addAll` (742-747). Tests: `carry-extensions.test.ts` (each cell: no
prior + records → fresh `REUC`; prior + records → merged; malformed prior + records → records
only (V14); empty `REUC[0]` prior (V11); no records → today's three cells unchanged;
`replace` + records → dropped) and `carry-extensions.properties.test.ts` if its invariants
cover the new parameter; `test/unit/application/primitives/internal/index-lock.test.ts` (an
extension-less previous index + records writes `REUC`); `index-carry-update-writers.test.ts`
(`add carries index extensions`, 106: seeded `REUC` for `m` + a conflicted path staged → both
records, sorted). `add.test.ts` (memory adapter): V1, V2, V4, V5, V6, V7, V9, V10, V12, V13
asserting the decoded records through `parseResolveUndo` on `indexExtensionsOf(ctx)` (helper:
`test/unit/application/primitives/helpers/index-extensions.ts`); a merged-index add passes no
record (V13). Interop (`add-interop.test.ts`, the Part 4 merge describe): V1, V2/V3, V4, V5, V6
(add/add: both branches add `f`), V7 (`add -A` only: the `add .` variant is O2), V9 (`rm --cached h` by `runGit` on both sides), V10
(`update-index --index-info` by `runGit` on both), V12, V14 (corrupt by rewriting one byte and the
trailer with the tsgit hash port on both sides), W1: `REUC` and `TREE` bytes equal, `lsStage`
equal, `git ls-files --resolve-undo` equal.

**Part 7: fast path (G1, G2, unmerged beneath).** Commit `fix(add): …`.
Context: `dispatchPathspec` (206, pass `resolved`); `addLiteralOnly` (220, signature
`(ctx, resolved: ResolvedPathspec, scope)`, reads `resolved.literalMustMatch`); `stageLiterals`
(263, return the inserted paths or let the caller derive them from `previous`);
`collectMatchedRemovals` (500, reused unchanged on `beneathMap`); `entriesBeneath` (Part 2);
`withEveryStage` (Part 4); `resolvedRecords` (Part 6); unmerged beneath selected by
`matchesIndexPath(resolved.matcher, entry)` (`src/domain/pathspec/matching-path.ts`), a private
`selectsUnmergedBeneath` so Part 11 swaps one call. Unit: one describe per row R1, R2, R4, R5, R6,
R7, R10, R12h, L1, C2
(seed with `seedRepo`, remove the directory, `ctx.fs.symlink`; precedent `add.test.ts:196-222`),
asserting `removed` exactly and every index entry including stages. Guard tests: `previous`
absent / unmerged / stage 0; matched vs excluded; skip-worktree vs not; stage 0 vs unmerged;
lossy vs not; unmerged beneath selected vs not (R10 vs R12h). Interop: rows R1, R2, R4, R5, R6,
R7, R10 (+ `REUC` `a/b`, V8), R12h (no `REUC`), L1 (`snapshot` equality + `removed`; R10, R12h
seed `a/b` stages with `update-index --index-info` on both sides; L1 seeds `a/\377` the same
way). Row R12 is not asserted here (needs Part 11).

**Part 8: walk paths (G2, G3 on `addByPathspec`, `addAll`).** Commit `fix(add): …`.
Context: `addByPathspec` (460-497: `removedEntries`, `remaining`), `addAll` (702-751:
`removedEntries`, `newEntries`), `tallyWalkOutcomes` (673, `added` outcomes are the inserted
paths, plus outcomes whose `previous` is unmerged: read `staged.existing`), Part 2 module, the
Part 7 `selectsUnmergedBeneath`. Unit + interop rows R8, R9, R16 (+ `REUC` `a/b`), R12hd, R15
(regression, + `REUC` `a/b`).

**Part 9: mirror (ADR-991).** Commit `fix(add): …`.
Context: `entriesAtLeadingDirectories` (Part 2) wired into the three insertion sites of Parts 7-8;
`presentOnDisk` (765) takes the entry: a non-symlink directory at a non-`FILE_MODE.GITLINK` entry
is gone; `collectRemovedEntries` (789) passes the entry. Unit + interop rows M1-M6, M5 (all three
stages of `a` kept, no `REUC`, V8b), M7a (+ `REUC` `a`, V8c). Gitlink exemption unit test: a
tracked gitlink whose directory is present is not removed. M7b, M7c are not asserted (O2).

**Part 10: `NOT_A_DIRECTORY` in the fast-path probe (ADR-993).** Commit `fix(add): …`.
Context: `allLiteralsAreFiles` (315): catch `NOT_A_DIRECTORY` around its `lstatOrMissing` (335)
call and return `false`; no change to `lstatOrMissing`. Unit + interop rows R13, R14; N1, N2 as
regressions (still refuse). A unit test pins that another error code (e.g. `PERMISSION_DENIED`)
still propagates from the probe.

**Part 11: exact exclusions do not shield a multi-stage unmerged path (ADR-998, R11, §D9).**
Commit `fix(add): …`.
Context: `src/domain/pathspec/match-pathspec.ts` (new `matchesUnmergedPath` + private
`withoutExactly`; `PathspecEntry.isLiteral`/`body` from `compile-pathspec.ts`);
`src/domain/pathspec/matching-path.ts` (new `matchesUnmergedIndexPath`, escaped view); not added
to `src/domain/pathspec/index.ts`. `add.ts`: `withPathspec` (643) gains the unmerged lookup;
`stageIgnoredWalk` (620) reads the index before building the filter, `addByPathspec` (466) passes
`repoIgnore` + `matcher` instead of the combined predicate; `selectsUnmergedBeneath` (Part 7)
calls `matchesUnmergedIndexPath` with `unmergedStages.get(key).length`. Tests: extend the
existing `test/unit/domain/pathspec/match-pathspec.test.ts`: one case per §D1.5 rule row (D0, D4,
D5, D6, D7, D9, E1, E3, E7, S1, D10) on the pure function; `matching-path.test.ts` +
`matching-path.properties.test.ts` for the escaped-view variant (a lossy path); the existing
`match-pathspec.properties.test.ts` (lens 2, arbitraries in `test/unit/domain/pathspec/arbitraries.ts`): `entryCount = 1` ⇒ equals
`matchesPathspec`; `matchesPathspec` true ⇒ true; appending a glob exclusion that matches the path
⇒ false; for `entryCount ≥ 2`, appending an exact exclusion to a spec that covers the path through
a non-exact positive keeps it true (`numRuns` 100). `add.test.ts` + interop (Part 4 merge
describe): D0, D1, D4, D7, D8, D16 (tsgit `!f`), E1, E8 (tsgit `!f`), E10 (tsgit `!f.txt`) as
leaks with `modified` and `REUC`; D5, D6, E3, E4, E7, S1 as shields (every stage kept, no
`REUC`); D/F rows R12, R12d (leak, `REUC` `a/b`). Not asserted: D2, E9 (`:/` and subdirectory
spelling are not tsgit inputs; D2 is no leak, E9 resolves to D4), D3 (ADR-038), E5 (no
pathspec on `all`), D9, E6, D15 (O3), D12, D13 (O2), R12g, R12gd (O7).

**Measure (not a commit).** After Part 11: `npm run bench:ab -- <part-1-sha> HEAD 5` per §D6;
the table goes in the PR body.

### D8. Resolve-undo on `add` (ADR-999)

#### D8.1 Domain codec (`src/domain/git-index/resolve-undo.ts`)

```ts
/** One `REUC` record: a resolved path, byte-exact, and the conflicted stages it had. */
export interface ResolveUndoRecord extends IndexPath {          // was { path: string; stages }
  readonly stages: ReadonlyArray<ResolveUndoStage>;              // stage order, present stages only
}

/** git's `resolve_undo_write` layout for `records`, in the order given. */
export function serializeResolveUndo(
  records: ReadonlyArray<ResolveUndoRecord>,
  digestLength: 20 | 32,
): Uint8Array;

/** git's `record_resolve_undo` over a list: each resolved record updates its path's record
 *  stage by stage, or is inserted; the result is sorted by path bytes. */
export function recordResolveUndo(
  records: ReadonlyArray<ResolveUndoRecord>,
  resolved: ReadonlyArray<ResolveUndoRecord>,
): ReadonlyArray<ResolveUndoRecord>;

/** The record of one unmerged path's index entries (stages 1-3, index order). */
export function resolveUndoRecordOf(stages: ReadonlyArray<IndexEntry>): ResolveUndoRecord;
```

- **Path bytes.** `parseResolveUndo` builds each record's path with `indexPathOfBytes`
  (`index-path-key.ts`), so a path that does not decode losslessly keeps `pathBytes`. Without it,
  merging (V9, V10) would rewrite another record's non-UTF-8 path as U+FFFD bytes: a byte-level
  divergence (ADR-226). It also stops the BOM-stripping `TextDecoder` from altering a path that
  starts with U+FEFF. `fsck/roots.ts:354` reads only `stages`, so fsck is unaffected. Existing
  `resolve-undo` tests that build records from plain strings need a `FilePath` cast.
- **`serializeResolveUndo`** writes, per record: `pathBytesOf(record)`, `NUL`; for stages 1, 2, 3
  the mode as octal ASCII (`mode.toString(8)`) or `0` when absent, each followed by `NUL`; then
  `hexToBytes(id)` for each present stage in stage order (V1, V4-V6, V8d). It inverts
  `parseResolveUndo` on canonical bytes (a mode field `parseResolveUndo` accepts in a
  non-canonical `strtoul` spelling comes back canonical) and does no sorting of its own.
- **`recordResolveUndo`** keys records by `indexPathKey`. A resolved record whose key exists takes
  stage `s` from the resolved record when present, else keeps the existing stage `s` (V10: stale
  stage 3 kept). A new key is inserted. Output order is `compareEntryPath` (byte order: git's
  `strcmp` on NUL-free paths) (V3).
- **`resolveUndoRecordOf`** maps each entry to `{ stage, mode: Number.parseInt(entry.mode, 8), id }`;
  `FileMode` is the octal string (`'100644'`), `ResolveUndoStage.mode` the number git reads with
  `strtoul(…, 8)`. The stage is narrowed by type: the caller only passes `unmergedStages` values,
  which hold stages 1-3 (§D2.2).

#### D8.2 Carry (`carry-extensions.ts`, `index-lock.ts`)

ADR-965 keeps the extension policy in `carryExtensions`; `add` hands its records down the same way
it already hands `restagedPaths`:

```ts
export interface CommitOptions {
  readonly restagedPaths?: ReadonlyArray<IndexPath>;
  /** The unmerged paths this write resolved, as resolve-undo records; honoured for 'update' only. */
  readonly resolveUndo?: ReadonlyArray<ResolveUndoRecord>;
}

export const carryExtensions = (previous, change, kind, settings, resolved: ReadonlyArray<ResolveUndoRecord>) => …

const carryUnmerged = (reuc, change, kind, resolved, digestLength): IndexExtension | undefined => {
  if (kind === 'replace') return undefined;
  if (resolved.length > 0) return { signature: REUC_SIGNATURE, data: mergedResolveUndo(reuc, resolved, digestLength) };
  return kind === 'update' && change.resolvedUnmerged ? undefined : reuc;   // unchanged for rm, update-index, checkout -m
};
```

- `mergedResolveUndo` = `serializeResolveUndo(recordResolveUndo(prior, resolved), digestLength)`,
  where `prior` is `[]` for an absent extension and for a malformed one (`parseResolveUndo`
  returns `undefined`): git drops a malformed `REUC` and writes the new records alone (V14). An
  empty `REUC[0]` parses to `[]` (V11).
- No record → today's rule, untouched: an `add` that resolves nothing keeps `REUC` verbatim
  (V12, V13 write none). The `resolvedUnmerged` drop stays for the other writers (ADR-999 scope);
  for `add` it can no longer fire, because every path it resolves yields a record.
- Output order stays `TREE`, `REUC`, `UNTR`: a new `REUC` slots in where a carried one would (V1).
- `carriedExtensions` (`index-lock.ts:188`) returns `[]` early when the previous index has no
  extension; that guard now also requires no record, or a fresh `REUC` on an extension-less index
  would be lost. The guard's line carries an existing Stryker equivalence note: the implementer
  re-proves it for the new condition, or restructures so the note is no longer needed. No new
  suppression.
- `commitRefresh` (status) never resolves anything and passes nothing; `carryExtensions`' other
  callers pass `[]`.

#### D8.3 `add` (`add.ts`)

```ts
/** The unmerged paths this add resolved: staged (now stage 0) or removed (key gone). */
const resolvedRecords = (
  unmergedStages: ExistingIndexState['unmergedStages'],
  working: ReadonlyMap<IndexPathKey, IndexEntry>,
): ReadonlyArray<ResolveUndoRecord> =>
  [...unmergedStages]
    .filter(([key]) => (working.get(key)?.flags.stage ?? 0) === 0)
    .map(([, stages]) => resolveUndoRecordOf(stages));
```

- One pass over `unmergedStages`, empty on a merged index: no cost on the clean path (§D6).
- `commitIfChanged(lock, existingCount, entries, options: CommitOptions)`: the three routes pass
  `{ restagedPaths, resolveUndo: resolvedRecords(unmergedStages, <working map>) }`, and
  `changesIndex` reads `options.restagedPaths`. A resolution is always a restage or a removal, so
  the commit fires whenever there is a record.
- Every later part that stages or removes an unmerged path (D/F beneath removal, mirror, DC9 leak)
  produces its record through this function, with no code of its own: their interop rows assert
  the `REUC` bytes too (V8, V8c, the D0 row).
- `addRenormalized` keeps every stage and passes nothing.

### D9. Exclusions and unmerged paths (ADR-998, DC10)

New in `src/domain/pathspec/match-pathspec.ts`, beside `matchesPathspec` (not added to the
`pathspec` barrel):

```ts
/**
 * git's verdict for a path held at `entryCount` index entries. git matches each entry in turn and,
 * from the second on, skips the elements that already matched the path exactly, so an exclusion
 * naming the path exactly stops applying while a glob or leading-directory one still does.
 */
export const matchesUnmergedPath = (spec: Pathspec, path: FilePath, entryCount: number): boolean =>
  matchesPathspec(spec, path) ||
  (entryCount > 1 && matchesPathspec(withoutExactly(spec, path), path));

/** The elements that do not name `path` exactly (a literal whose collapsed body is `path`). */
const withoutExactly = (spec: Pathspec, path: FilePath): Pathspec =>
  spec.filter((entry) => !(entry.isLiteral && entry.body === path));
```

plus `matchesUnmergedIndexPath(spec, entry, entryCount)` in `matching-path.ts` (escaped view, as
`matchesIndexPath`). Bodies arrive collapsed (`./f` → `f`, E8). A trailing-slash body never equals
a file path, `''` (the whole tree) never equals a path.

Wiring (Part 11):

- **Walk leaf filter.** `withPathspec` (`add.ts:643`) keeps a leaf when
  `matchesPathspec(matcher, path)` (unchanged early return) **or** when the path is unmerged and
  `matchesUnmergedPath(matcher, path, stages.length)` holds. It needs the index first:
  `stageIgnoredWalk` (620) reads `readExistingEntries` and then builds the filter, instead of
  `addByPathspec` building it before (466). A matched leaf pays nothing; an unmatched one pays one
  lookup in `unmergedStages` (empty on a merged index). The leaked path then goes through
  `processWalkEntry` as any unmerged path: staged at stage 0, reported in `modified` (ADR-997),
  recorded in `REUC` (§D8.3). Rows D0, D1, D4, D7, D8, D16, E1, E8, E10 become matches;
  D5, D6, E3, E4, E7, S1 stay matches (shielded, every stage kept).
- **D/F beneath predicate** (fast path §D3, `addByPathspec` §D4): the selected test becomes
  `matchesUnmergedIndexPath(matcher, entry, stages.length)`. Rows R12 and R12d become matches;
  R12h, R12hd stay matches.
- **Not touched:** the fast path's own staging (O3: D9, D15 and `add f top ':!f'` keep ignoring
  the exclusion, as today), `collectMatchedRemovals` (O2: D12, D13 stay divergent), `addAll` (no
  pathspec).

If DC10 = B (ADR-998 as worded), `matchesUnmergedPath` becomes "some positive element matches"
for any unmerged path, and rows D5, D6, E3, E4, E7, S1, R12h, R12hd flip to divergent (tsgit would
resolve or remove conflicts git keeps).

## Decision candidates

Settled:

| # | Choice | Outcome |
|---|---|---|
| DC1 | Fold the mirror case (M1-M6) | Folded: ADR-991 (§D5, Part 9) |
| DC2 | Fix mechanism | Option C, D/F insertion rule on all three routes + fast-path reported removals: ADR-990 |
| DC3 | Where the rule lives | `src/domain/git-index/directory-file-conflict.ts`, pure, off the barrel: ADR-992 |
| DC4 | Fold R13, R14 (`NOT_A_DIRECTORY`) | Folded, probe-only: ADR-993 (§D5b, Part 10) |
| DC5 | Silent drops in `removed` | No: git's reported removals only: ADR-994 |
| DC6 | Bench coverage | Existing + two 10 000-entry scenarios, committed first, +10 %: ADR-995 |
| DC7 | O1 (unmerged stages lost) | Folded, against the first draft's recommendation: ADR-996 (§D1.3, §D2.2, Part 4) |
| DC8 | Report a staged unmerged path in `modified` whatever its content | Folded: ADR-997 (R10, Part 5) |
| DC9 | An exclusion does not shield an unmerged path a positive covers | Folded, against the recommendation: ADR-998 (§D1.5, §D9, Part 11); its bound is DC10 |
| O5 | Record resolve-undo when `add` resolves a conflict | Folded for `add` only, against the recommendation: ADR-999 (§D1.6, §D8, Parts 3 and 6) |

Open:

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC10 | Which exclusions stop shielding an unmerged path (ADR-998 says "whatever the exclusions say"; §D1.5 pins that only an *exact* exclusion of a path with ≥ 2 stages leaks, and not when an exact positive is the only cover) | A. Follow the pinned rule (§D9 `matchesUnmergedPath`): every §D1.5 row a tsgit route hosts matches; ADR-998 gets a refining ADR stating the bound. B. ADR-998 as worded: any covering positive stages an unmerged path; one simpler predicate, but D5, D6, E3, E4, E7, S1, R12h, R12hd diverge (tsgit resolves or removes conflicts git keeps, which `add .` after a `:!*.lock`-style exclusion would hit). C. Fold only the D/F rows (R12, R12d) and leave the walk leaf filter as today: smallest change, D0-class rows stay divergent against ADR-998. | **A** | ADR-226: the ADR's intent is git's behaviour, and the pin shows its wording over-reaches. A costs the same predicate as B plus one `filter` over the pathspec for unmerged paths only; B trades a shorter predicate for 8 pinned divergences, each one resolving a conflict the user excluded. C contradicts ADR-998. |

## Test strategy

- **Interop (faithfulness proof):** `test/integration/add-interop.test.ts`, one describe per row
  group (Given the mutation / When `repo.add(...)` like `git add …` / Then index and tree match
  git). Every row asserts `snapshot(ours) == snapshot(peer)` (`ls-files --stage` + `write-tree`)
  and `added.removed` exactly. That reconstructs git's `remove` lines from the structured field
  (ADR-249). Rows: R1, R2, R4, R5, R6, R7, R8, R9, R10, R12, R12d, R12h, R12hd, R15, R16, L1,
  C2, R13, R14, M1-M7a, plus the `add a/` regressions already covered. Lossy L1 seeds `a/\377` with
  `update-index --index-info` on both sides (no working-tree file on APFS/Windows; the job is
  Linux). O1 rows (§D1.3: U1, U3, U5-U12, U14; U6/U10 MD12/MD13 as `modified` rows) build a real merge
  conflict with identical `runGit` commands on both sides and compare `lsStage` plus `AddResult`;
  `write-tree` is asserted only where the add leaves no unmerged entry (U9, U10, U12). Runs only
  in the ubuntu `integration` job. U2 and U13 are not interop rows: U2 depends on same-second
  timestamps and is the same mechanism as U1 (any index write); U13 and U13b are covered by the
  §D1.5 rows D0 and D16/E7 (Part 11). DC9 rows (§D1.5) and resolve-undo rows (§D1.6) use the same
  merge fixture; every row that resolves or removes an unmerged path also compares the `REUC`
  extension bytes and `git ls-files --resolve-undo` on both sides (W1 shows the index then
  matches outside per-copy stat data).
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
  `resolve-undo.test.ts` (literal §D1.6 bytes) + `resolve-undo.properties.test.ts` (lens 1
  round-trip, lens 4 against the independent `encode`, lens 2 on `recordResolveUndo`).
  `carry-extensions.test.ts` (one test per `carryUnmerged` cell). `match-pathspec` examples +
  properties (lens 2) for `matchesUnmergedPath`.
- **Mutation:** scoped Stryker on `add.ts`, `directory-file-conflict.ts`, `resolve-undo.ts`,
  `carry-extensions.ts`, `index-lock.ts` and `match-pathspec.ts`/`matching-path.ts` (narrowed
  vitest include per the repo's mutation procedure). Target 0 survivors. One-sided tests the
  mutants need: `entryCount > 1` (S1 vs D0), `isLiteral && body === path` (D6 glob vs D0 exact;
  D5 prefix vs D4 exact), `resolved.length > 0` (V13 vs V1), stage-wise merge (V10), the
  `?? 0` stage test in `resolvedRecords` (staged vs removed vs untouched).
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

- **O1:** folded by ADR-996 (§D1.3, §D2.2, Part 4); no longer out of scope.
- **O2:** `add <pathspec>` never stages the deletion of an unmerged path gone from disk outside
  the D/F case. `a/b` unmerged and deleted, `a/c` modified, `add .`: git reports
  `remove 'a/b'`, tsgit keeps `a/b` (every stage once Part 4 lands). `add.ts:508`:
  `collectMatchedRemovals` filters `stage === 0`. Rows M7b, M7c (unmerged `a` now a directory,
  `add .` / `add a`), D12, D13 (an exact exclusion leaking onto a deleted unmerged path, §D1.5) and
  D14 are the same gap and stay divergent. DC9 does not fix it: the walk leaf filter never sees a
  path that is gone, so the fix needs its own branch in `collectMatchedRemovals`.
- **O3:** the fast path ignores negations: `add top '!top'` stages `top`, where git's
  `add top ':!top'` stages nothing. `add.ts:214`: the fast-path condition checks only `hasGlob`.
  The unmerged rows D9, E6 (`add f ':!f'`, `add f ':!f*'`: git keeps every stage, tsgit stages
  `f`) and D15 (`f` deleted: git exits 0, tsgit `PATHSPEC_NO_MATCH`) are this gap, not DC9: no DC9
  row needs the fast path to honour exclusions (§D1.5 Routes), so it does not fall out.
- **O4:** tracked dir `a` turned into a nested repository (`a/b` still tracked); `add a`: git
  exits 0 with no change, tsgit throws `PATHSPEC_NO_MATCH`. The walk skips the embedded
  repository and `a/b` is present, so nothing matches. `add.ts:479`: `enforceLiteralMustMatch`
  ignores tracked index entries under the literal.
- **O5:** folded for `add` by ADR-999 (§D1.6, §D8, Parts 3 and 6). `rm`, `update-index` and
  `checkout -m` keep dropping `REUC` on resolution (`carry-extensions.ts:57`), per ADR-999.
- **O6:** a malformed `REUC` survives tsgit's non-resolving index writes. V14 then `add top`
  (V15): git drops the extension (`TREE[32]` only), tsgit writes the corrupt `REUC[83]` back
  verbatim (probe, 2026-10-17). `carry-extensions.ts:57`: `carryUnmerged` returns the opaque bytes
  without parsing them. Not fixed by §D8: a non-resolving `add` passes no record, so the merge
  branch (which does drop it, V14) never runs; folding it would parse `REUC` on every write.
- **O7:** tsgit's pathspec `*` does not cross `/`, git's does (no `:(glob)` magic). Tracked
  `a/x/y` and `top` modified, `add . ':!a/*'`: git stages `top` only, tsgit stages `a/x/y` and
  `top` (probe, 2026-10-17). `src/domain/pathspec/compile-glob.ts:145`: the star step refuses
  `/`. It is why rows R12g, R12gd are not asserted.
