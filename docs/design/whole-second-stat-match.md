<!-- cspell:ignore NSEC STDEV nsec ignorecase racily uptodate fsmonitor oneway munge chmod chmodded lstat utimes lutimes smudger gitlink gitlinks trustctime checkstat smudges unforced statinfo ctimes ifdef twoway -->
# Design — whole-second-stat-match

> Brief: backlog 32.87. tsgit judges an index entry's stat to the nanosecond; git, built without
> `USE_NSEC`, judges whole seconds and lets the racy check settle a same-second entry by content.
> A same-second `chmod` therefore makes `checkout -- f`, a forced switch and `reset --hard`
> rewrite a clean file (new inode, permission bits reset) where git leaves it, and makes `status`
> rewrite the entry's stat where git keeps it. The fix routes every stat judge through one
> whole-second compare whose fields `core.trustCtime` / `core.checkStat` choose, and moves the
> racy test and the smudger to whole seconds with it. Folded in the same seam:
> - `core.trustCtime = false` and `core.checkStat = minimal` are ignored by every judge but the
>   assume-unchanged one (ledger row 32.90 is removed);
> - git's "racily smudged" branch (cached size 0, non-empty blob) must join the compare, or the
>   whole-second compare reads a truncated file clean (F rows);
> - the smudger's nanosecond racy test skips an entry git smudges on an unrelated index write
>   (row E3, divergent on main).
>
> Status: settled 2026-11-25 (rulings ADR-1261 to ADR-1267, DOCTRINE D-7)

## Context

### The backlog statement, re-pinned

Re-pinned on main f4b098b3 (2026-11-25) against git 2.56.1 (Homebrew, arm64, macOS APFS). Probes
ran with `GIT_*` scrubbed, an isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, and `core.ignorecase` set
explicitly to `false` and `true` in every repository (lesson 042). Every row gives the same result
under both values, and each git row was run twice. The tsgit verdicts come from
`checkout({ paths })`, `checkout({ rev, force })`, `reset({ mode: 'hard' })`, `status()` on main.

- **Confirmed:** every row of the backlog entry, and the backlog's claim that the local binary is
  built without `USE_NSEC` (row A1: a nanosecond-only ctime drift is no drift for git).
- **Widened:** the same seam ignores `core.trustCtime` and `core.checkStat` (rows C2, C3) on
  every judge except the assume-unchanged path, and `status` rewrites an entry's stat that git
  keeps (rows A5, C2s, C3s).
- **Widened (writer):** row E3. The smudger on main misses an entry git smudges.
- **Regression guards:** rows E1, E2 and F pass on main only *because* of the nanosecond compare.
  Dropping nanoseconds without also moving `isRacy` (E) and adding git's smudged-entry branch (F)
  would turn both into data-integrity failures: a modified file read clean, and `checkout -- f`
  leaving a truncated file in place.

### git's rule (v2.56.1 source: `statinfo.c`, `read-cache.c`, `entry.c`, `unpack-trees.c`, `diff-lib.c`, `preload-index.c`, `Makefile`)

#### Build flags

- `Makefile`: `USE_NSEC` is opt-in ("Define USE_NSEC below if you want git to care about
  sub-second file mtimes and ctimes"). No platform block in `config.mak.uname` turns it on; eight
  platforms set `NO_NSEC`. Row A1 confirms the local build is without it.
- `USE_STDEV` is opt-in as well, so `st_dev` is never compared.
- `statinfo.c` `fill_stat_data` records `sd_ctime.nsec` and `sd_mtime.nsec` whatever
  `USE_NSEC` says. The index keeps nanoseconds, and only the comparison drops them. tsgit's writer
  (`index-entry-from-stat.ts` `withStatData`, `nanosecondsOf`) already records them, and it stays
  as it is.

#### `ie_match_stat` — the ordered decision list (`read-cache.c`)

| ID | Branch (in source order) | Result |
|---|---|---|
| M1 | `ce_skip_worktree(ce)` unless `CE_MATCH_IGNORE_SKIP_WORKTREE` | 0 (clean) |
| M2 | `CE_VALID` (assume-unchanged) unless `CE_MATCH_IGNORE_VALID` | 0 |
| M3 | `CE_FSMONITOR_VALID` | 0 (tsgit has no fsmonitor) |
| M4 | `ce_intent_to_add(ce)` | changed |
| B1 | `ce_match_stat_basic`: `CE_REMOVE`; kind/mode switch: a regular file needs `S_ISREG`, and its owner-x bit counts only under `core.fileMode`; a symlink needs `S_ISLNK` unless `core.symlinks=false` and a regular file stands; a gitlink compares the checked-out HEAD and **returns before any stat field** | TYPE / MODE / DATA |
| S1 | `match_stat_data`: `sd_mtime.sec != st_mtime` | MTIME_CHANGED |
| S2 | `trust_ctime && check_stat && sd_ctime.sec != st_ctime` | CTIME_CHANGED |
| S3 | `#ifdef USE_NSEC` nanosecond mtime/ctime (also gated by `check_stat`) | not compiled |
| S4 | `check_stat` and uid or gid differ | OWNER_CHANGED |
| S5 | `check_stat` and `sd_ino != st_ino` (32-bit) | INODE_CHANGED |
| S6 | `#ifdef USE_STDEV` device | not compiled |
| S7 | `sd_size != munge_st_size(st_size)` (32-bit), always | DATA_CHANGED |
| B3 | "Racily smudged entry?": `sd_size == 0` and the oid is not the empty blob | DATA_CHANGED |
| R | if nothing changed and `is_racy_timestamp`: not a gitlink, `istate->timestamp.sec != 0`, and `timestamp.sec <= sd_mtime.sec` (whole seconds without `USE_NSEC`) | → R1 / R2 |
| R1 | `CE_MATCH_RACY_IS_DIRTY` (`add_to_index`, `preload_index`) | DATA_CHANGED |
| R2 | otherwise `ce_modified_check_fs`: hash or readlink the work file and compare | content decides |

`trust_ctime` is `core.trustCtime` (default true). `check_stat` is 0 under
`core.checkStat=minimal` and 1 otherwise. This is exactly tsgit's `StatCheck`: `ctime` =
S2's gate, `ownerAndInode` = S4/S5's gate.

#### What the callers do with the verdict

- `ie_modified` (status, diff-files, refresh): it calls `ie_match_stat`. A MODE/TYPE change is
  returned as is. DATA_CHANGED with `sd_size != 0` (or a gitlink) is trusted as modified.
  Anything else goes to content (`ce_modified_check_fs`). tsgit's `statOnlyVerdict` size rule
  already matches this.
- `refresh_cache_ent` (`status`, `update-index --refresh`, stash's refresh): when
  `ie_match_stat` returns 0, the entry is kept **as read** and marked `CE_UPTODATE`, so no stat
  field is rewritten. Only when it reports a change that `ie_modified` then clears does
  `fill_stat_cache_info` rewrite the stat. That is why git keeps the ctime nanoseconds in row A5.
- `checkout_entry` (`entry.c`, `checkout -- f`): calls `ie_match_stat(…, IGNORE_VALID |
  IGNORE_SKIP_WORKTREE)`. If nothing changed it returns 0 and the file is untouched. Otherwise,
  under `force`, it unlinks and rewrites the file (new inode, mode from the umask).
- `verify_uptodate_1` (`unpack-trees.c`, unforced switch, merge) and `icase_exists` use the same
  options. In `oneway_merge` (`reset --hard`, forced switch), an entry not yet `CE_UPTODATE` is
  updated when `lstat` fails or `ie_match_stat` reports a change.
- `ce_smudge_racily_clean_entry` (index write, for `!ce_uptodate && is_racy_timestamp`): `lstat`,
  then `ce_match_stat_basic` (B1, S1–S7, B3). On any change it returns. Otherwise it reads the
  content, and a differing content sets `sd_size = 0`.
- `add_to_index`: an existing stage-0 alias that `ie_match_stat(…, IGNORE_VALID |
  IGNORE_SKIP_WORKTREE | RACY_IS_DIRTY)` finds unchanged is kept as is, stat and all.

### Pinned matrix (git 2.56.1; tsgit main f4b098b3; both `core.ignorecase` values identical; git rows twice)

Shapes:
- **A**: commit `f`; then, within one wall-clock second, rewrite `f` with the same bytes,
  `git add f`, `chmod 664 f`. The ctime nanoseconds move while the seconds do not. The entry's
  mtime second equals the index's, so the entry is racy. Every row was confirmed same-second by
  `lstat`.
- **C**: commit `f`; wait 1.1 s; `git status` (writes the index one second later, so `f` is no
  longer racy); wait 1.1 s; `chmod 664 f` (ctime moves by **seconds**).
- **E**: at a second's start, write `abc`, wait 0.1 s, `git add f`, wait 0.1 s, write `xyz` (same
  size, same inode). The entry mtime is T.0x and the index mtime T.1x, so the entry is racy by
  whole seconds but not by nanoseconds. Act one second later.
- **F**: within one second T, write `abc`, `git add f`, write `xyz`, `git update-index --add g`
  (the write smudges `f`: `ls-files --debug` shows `size: 0`), then `: > f` (0 bytes, same inode,
  mtime/ctime still T). At T+1, `git update-index --add h` (index timestamp T+1, so `f` is no
  longer racy). Act at T+2.

| Row | Shape / config | Act | git 2.56.1 | tsgit main | Branch |
|---|---|---|---|---|---|
| A1 | A | `checkout -- f` / `checkout({ paths: ['f'] })` | untouched: same inode, 0664 | **rewritten**: new inode, 0644 | S2 seconds equal, R2 content |
| A2 | A | `checkout -f other` (f identical in both) / `checkout({ rev, force: true })` | untouched | **rewritten** | same, `oneway_merge` |
| A3 | A | `checkout other` unforced | untouched | untouched | `verify_uptodate`, f not updated |
| A4 | A | `reset --hard HEAD` | untouched | **rewritten** | same, `oneway_merge` |
| A5 | A | `status` | clean; `ls-files --debug f` identical | clean; entry ctime **rewritten** to the chmod's | `refresh_cache_ent` keeps on 0 |
| C1 | C, default | `checkout -- f` | **rewritten**: new inode, 0644 | rewritten | S2 seconds differ |
| C1s | C, default | `status` | clean; stat rewritten | clean; stat rewritten | `ie_modified` → refresh |
| C2 | C, `core.trustCtime=false` | `checkout -- f` | untouched, 0664 | **rewritten**, 0644 | S2 gated off |
| C2s | C, `core.trustCtime=false` | `status` | clean; stat kept | clean; stat **rewritten** | S2 gated off |
| C3 | C, `core.checkStat=minimal` | `checkout -- f` | untouched, 0664 | **rewritten**, 0644 | S2/S4/S5 gated off |
| C3s | C, `core.checkStat=minimal` | `status` | clean; stat kept | clean; stat **rewritten** | same |
| L1 | settled entry; same-size edit through `mv g f` (new inode), mtime restored with `touch -r`; default | `status` | ` M f` | modified | S5 inode |
| L2 | L1 under `core.checkStat=minimal` | `status` | clean | **modified** (ledger 32.90) | S4/S5 gated off |
| E1 | E | `status` | ` M f` | modified | R by whole seconds → R2 |
| E2 | E | `checkout -- f` | restored `abc` | restored `abc` | R → R2 → rewrite |
| E3 | E, then (still in T) write `g` | `git add g` / `add(['g'])` (an unrelated index write) | `f` smudged: `ls-files --debug` `size: 0` | **not smudged**: `size: 4` | smudge: `is_racy_timestamp` whole seconds |
| F1 | F | `status` | ` M f` | modified | B3 → `ie_modified` content |
| F2 | F | `checkout -- f` | restored `abc` | restored `abc` | B3 → rewrite |

The session pinned A1–A5, L1 and L2. The designer pinned C, E and F (git: a bash probe in a
`mktemp -d` throwaway; tsgit: a temporary integration probe, deleted before the commit). E3 is a
designer probe as well, run twice per `core.ignorecase` value, with git and tsgit identical
across runs. It is a divergence that already exists on main: tsgit's smudger uses the
nanosecond `isRacy`, so an entry earlier in the index's second is never re-checked, and the
same-size edit stays recorded with its old stat. Every later read of the file then depends on
the nanosecond compare alone to see the edit.

**Why E and F are green on main and would go red under a half fix.**
- E: main's `isRacy` compares nanoseconds, so the entry (T.0x) is not racy under the index
  (T.1x). Main's field compare catches the T.2 edit by its mtime nanoseconds. Drop the
  nanoseconds from the compare only, and every whole-second field matches while `isRacy` still
  says "not racy": `status` reports `f` clean and `checkout -- f` leaves `xyz` in place.
- F: main catches the truncation by its mtime nanoseconds. A whole-second compare without B3
  matches every field (size 0 = 0, mtime T, ctime T, same inode): `status` reports `f` clean and
  `checkout -- f` leaves the empty file in place.

Both are data integrity under ADR-1170 rule 3. The F2 failure would strand an empty file where
git restores the content.

### Gaps in the same seam (verdicts under Doctrine)

| Gap | Proof | Locus | Verdict |
|---|---|---|---|
| G-a Nanosecond mtime/ctime compare (the brief) | A1, A2, A4, A5 | `is-entry-stat-clean.ts` `matchesMtime`, `matchesCtime`, `matchesContentStat` | **Fold** (the brief) |
| G-b `core.trustCtime` / `core.checkStat` ignored outside the assume-unchanged path | C2, C2s, C3, C3s, L2 | `matchesContentStat` has no `StatCheck` | **Fold** (D-2: the brief's own fix direction routes through `matchesStatFields`; D-5: same function). Removes ledger row 32.90 |
| G-c `isRacy` compares nanoseconds and has no zero-timestamp guard | E3 (diverges on main: the smudger skips an entry git smudges); E1, E2 (red under a half fix); source R | `isRacy`; `smudge-racily-clean.ts` `isRacyTimestamp` | **Fold** (D-5: the readers and the smudger must move together, or E goes red) |
| G-d No B3 (racily smudged entry) branch in tsgit's compare | F1, F2 (red under a half fix); source B3 | `matchesCachedStat`, `isEntryStatClean`, `statStillMatches`, `shouldRefresh`, `isStaleAssumedEntry` | **Fold** (D-5: the edited compare) |
| G-e `status` rewrites an entry's stat that git keeps | A5, C2s, C3s | `compare-working-tree-entry.ts` `shouldRefresh` | **Fold** (D-2: a consumer of the compare) |
| G-f `isStaleAssumedEntry` reads the config once per assume-valid entry | source: `await readStatCheck(ctx)` inside the per-entry predicate | `compare-working-tree-entry.ts` | **Fold** (D-5: same function. It takes the scan's `StatCheck` instead; no behaviour change) |

Ledger row 32.89 (assume-unchanged merge refusal) is not settled by this source reading. The
nanosecond half of its mechanism goes away with this change. The racy half depends on whether
git's pre-merge refresh writes the index into a later second before `verify_uptodate`, and
`builtin/merge.c` / `merge-ort.c` were not read. The row stays out of scope and stays in the
ledger.

### Code map (names, not line numbers)

| Where | Symbol (current signature) | Role today → after |
|---|---|---|
| `src/application/primitives/internal/is-entry-stat-clean.ts` | `isRacy(entry: IndexEntry, indexMtime: IndexMtime): boolean` | `USE_NSEC` variant, no zero guard → git's whole-second `is_racy_timestamp` (gitlink excluded, zero guard). Renamed `isRacyTimestamp` |
| same | `hasRacyTimestamp(entries, indexMtime)` | already whole-second → `indexMtime.seconds !== 0 && entries.some(isRacyTimestamp)` |
| same | `matchesMtime`, `matchesCtime`, `matchesContentStat(entry, stat)`, `NS_PER_SECOND` | **deleted** |
| same | `matchesStatFields(entry, stat, check: StatCheck)` | gains B3. It is the one compare. Renamed `matchesStatData` (git's `match_stat_data` + B3) |
| same | `isEntryStatClean(entry, stat, indexMtime)` | gains `check: StatCheck` |
| same | `CachedStat { entry; indexMtime; executableBit }`, `TrackedStat = Omit<CachedStat, 'executableBit'>`, `matchesCachedStat(cached, absPath, stat, contentMatches)` | `CachedStat` gains `statCheck: StatCheck`; `TrackedStat` omits it too |
| `src/domain/git-index/stat-check.ts` | `StatCheck { ctime; ownerAndInode }` | unchanged |
| `src/application/primitives/read-stat-check.ts` | `readStatCheck(ctx): Promise<StatCheck>` | unchanged; called once per scan (DC-A) |
| `src/domain/objects/object-id.ts` | `emptyBlobOid(config: HashConfig)`, `EMPTY_BLOB_OID_SHA1`, `EMPTY_BLOB_OID_SHA256` | unchanged. `isEmptyBlobOid(id: ObjectId): boolean` (DC-B) is private to `is-entry-stat-clean.ts` and reads `emptyBlobOid` for both algorithms: this module is re-exported by the package entry, and R8 adds no public symbol |
| `src/application/primitives/compare-working-tree-entry.ts` | `statOnlyVerdict(entry, stat, worktreeMode, indexMtime)`, `shouldRefresh(entry, stat)`, `ComparisonScope`, `ResolvedScope`, `isResolved`, `resolveScope`, `isStaleAssumedEntry(ctx, entry, stat)`, `staleAssumedStatDelta`, `compareFile`, `compareAndRefresh`, `racyContentMatcher` | `ResolvedScope` gains `statCheck`. `resolveScope` fills each missing one. `statOnlyVerdict`, `shouldRefresh`, `isStaleAssumedEntry` take the scope's `statCheck`. Public `compareWorkingTreeDelta` / `compareWorkingTreeEntry` keep their signatures |
| `src/application/primitives/internal/smudge-racily-clean.ts` | `isRacyTimestamp` (local), `statStillMatches(ctx, workDir, entry, executableBit)`, `racilyClean`, `RacilyClean` | local racy helper deleted (imports the shared one). `statStillMatches` uses `matchesStatData` with a `StatCheck` read once in `racilyClean` beside `executableBit`. `statDataKey` stays: it compares entry to entry, not stat to file |
| `src/application/primitives/internal/stale-entries.ts` | `StatJudge { contentMatches; executableBit }`, `isUpToDate`, `upgradeStaleNoops` | `StatJudge` gains a lazy `statCheck` (A1, A2, A4) |
| `src/application/primitives/internal/sparse-left-dirty.ts` | `Judgement { …; executableBit; … }`, `verdictOf`, `judgeMovers` | `Judgement` gains a lazy `statCheck` |
| `src/application/primitives/internal/occupant-clash.ts` | `classifyThroughLink(ctx, path, scope)` | reads `readStatCheck` beside `readExecutableBitTrust` |
| `src/application/primitives/materialize-tree.ts` | `obstructionMayGo(…, executableBit)`, `clearedObstructions` | gains a lazy `statCheck` beside `executableBit` |
| `src/application/commands/add.ts` | `ConversionScope { provider; settings; executableBit; exclusion }`, `buildConversionScope`, `restagesAsIs(previous, fresh, indexMtime, executableBit)` | `ConversionScope` gains `statCheck`. `restagesAsIs` takes the scope's two policies as one argument (no fifth positional) |
| `src/application/primitives/internal/scan-tracked-entries.ts` | `scanEntry(…, executableBit)`, `scanWorkingTree` | reads `statCheck` once per scan, passes it in the scope |
| callers that build a `ResolvedScope` with `executableBit` | `commands/rm.ts`, `commands/stash.ts` (two scopes), `commands/internal/clean-work-tree.ts`, `primitives/apply-changeset.ts`, `primitives/find-would-overwrite.ts` | add `statCheck` where they add `executableBit` (DC-A). `commands/status.ts` builds no comparison scope: its scan's scope comes from `scan-tracked-entries.ts` |
| `src/application/commands/status.ts` | `updateIndexIfAble` | unchanged (`hasRacyTimestamp`) |
| `src/application/primitives/internal/index-entry-from-stat.ts` | `withStatData`, `nanosecondsOf` | unchanged: the index keeps recording nanoseconds, as `fill_stat_data` does |
| `src/ports/file-system.ts` | `FileStat.mtimeNs`, `ctimeNs` | unchanged: still read by `withStatData`, `read-index.ts`, `head-file.ts`, the snapshot resolvers |

### Constraining ADRs, doctrine, lessons

- ADR-226 (prime directive), ADR-249 (structured output: rows compare structured status fields
  and git's `ls-files --debug`, never rendered text), ADR-1170 (filing bar: this run closes one
  entry, so it may file at most one; it files none).
- The assume-unchanged precedent: `matchesStatFields` + `readStatCheck` already serve
  `isStaleAssumedEntry`. The `core.fileMode` precedent (32.74, ADRs 1229–1235) resolves a stat
  policy once per scan and threads it beside the entry.
- DOCTRINE: D-2 (G-b, G-e: consumers of the shared compare, interop pin per consumer). D-5 (G-c,
  G-d, G-f: edited seams). D-6 (no signature or type change on the public surface, so a plain
  `fix(…)`). D-3 is not triggered: no returning method starts throwing. D-4 is not triggered: no
  skip or error path destroys data. The C1 rewrite (git resets the mode of a file chmodded a
  second later) is git's normal `checkout_entry` behaviour, copied as is.
- Lessons: 033 (re-pinned above), 042/045 (both `core.ignorecase` twins), 046 (one interop row
  per branch of the list above), 051 (the list comes from source, and the probes vary each input
  it reads: mtime, ctime, size, inode, the two config keys, the index timestamp, B3's size/oid),
  052/018/012 (deterministic fixtures, drift a stat before a writes-nothing pin), 019 (each row
  names git's routine: `checkout_entry`, `oneway_merge`, `verify_uptodate`, `refresh_cache_ent`,
  `add_to_index`, smudge), 050 (perf gate against git's floor: a same-process floor twin, D-7,
  ADR-1267), 038 (consumers are listed
  from the primitive, `matchesCachedStat` / `isEntryStatClean` / `matchesContentStat` / `isRacy`,
  not from a wrapper).

## Requirements

- **R1** Every stat judge compares S1, S2, S4, S5 and S7 in whole seconds, with S2/S4/S5 gated by
  the repository's `StatCheck`, then B3. No nanosecond field is read when an entry's stat is
  compared with a work-tree `lstat`. (`smudge-racily-clean.ts` `statDataKey` compares an entry
  with the same entry as read. That is identity, not a stat match, and it keeps its fields.)
- **R2** The racy test is git's whole-second `is_racy_timestamp`: gitlinks excluded, a zero index
  timestamp never racy, `indexMtime.seconds <= entry.mtimeSeconds`. Every reader and the smudger
  use the same function: E3 turns green, and E1 and E2 stay green.
- **R3** The smudger's "basic still matches" test is the R1 compare plus the mode test, with the
  same `StatCheck` (G-c, G-d).
- **R4** A refresh (every `compareAndRefresh` consumer that writes `refreshed`: `status`,
  `refreshedIndex`) rewrites an entry's stat only when the R1
  compare fails and content proves the entry unchanged. When the compare passes, the entry stays
  byte-identical (A5, C2s, C3s).
- **R5** `StatCheck` is resolved at most once per scan or command, and lazily where the branch
  that needs it may not run. No per-entry config read remains (`isStaleAssumedEntry` included).
- **R6** Rows A1–A5, C1–C3s, L1, L2, E1–E3, F1, F2 match git under both `core.ignorecase`
  values, plus one headline row per remaining consumer (Test strategy).
- **R7** `matchesMtime`, `matchesCtime`, `matchesContentStat`, the module's `NS_PER_SECOND` and
  smudge's local `isRacyTimestamp` are deleted. No other caller of them remains, and no port
  field is removed.
- **R8** Public signatures (`compareWorkingTreeDelta`, `compareWorkingTreeEntry`, `IndexMtime`)
  are unchanged. `reports/api.json` does not move.
- **R9** Ledger row 32.90 is removed from `docs/known-divergences.md` and backlog 32.87 is ticked
  (documentation phase).
- **R10** `status` in the racy window costs at most 1.5 times its floor twin in the same process
  (a settled `status` plus a bare read and SHA-1 of every tracked file), measured on the fixed
  code, three runs, and the ratio recorded in this design (ADR-1267).

## Design

### 1. One compare: `matchesStatData` (git's `match_stat_data` + B3)

```ts
// is-entry-stat-clean.ts — sketch
export const matchesStatData = (entry: IndexEntry, stat: FileStat, check: StatCheck): boolean =>
  entry.mtimeSeconds === wholeSecond(stat.mtimeMs) &&
  (!check.ctime || entry.ctimeSeconds === wholeSecond(stat.ctimeMs)) &&
  (!check.ownerAndInode || ownerAndInodeMatch(entry, stat)) &&
  truncate32(entry.fileSize) === truncate32(stat.size) &&
  !isRacilySmudged(entry);

// B3: a recorded size of 0 on a non-empty blob was written by the racy smudge (or never stat-ed).
const isRacilySmudged = (entry: IndexEntry): boolean =>
  entry.fileSize === 0 && !isEmptyBlobOid(entry.id);
```

- `matchesStatFields` is renamed (and gains B3). `matchesContentStat`, `matchesMtime` and
  `matchesCtime` go. The assume-unchanged path (`isStaleAssumedEntry`) gets B3 as well, as git's
  `verify_uptodate` does for a `CE_VALID` entry (`ce_match_stat_basic` holds B3 for every
  caller).
- `statOnlyVerdict`'s size rule already skips the size trust at `fileSize === 0`, so a B3 entry
  falls through to content: `ie_modified`'s `sd_size != 0` clause. F1 reports modified by
  content.
- Gitlinks never reach the compare (B1 returns first in git, and every tsgit caller branches on
  `FILE_MODE.GITLINK` before it). This is unchanged.

### 2. One racy test: `isRacyTimestamp`

```ts
export const isRacyTimestamp = (entry: IndexEntry, indexMtime: IndexMtime): boolean =>
  entry.mode !== FILE_MODE.GITLINK &&
  indexMtime.seconds !== 0 &&
  indexMtime.seconds <= entry.mtimeSeconds;

export const hasRacyTimestamp = (entries: ReadonlyArray<IndexEntry>, indexMtime: IndexMtime) =>
  entries.some((entry) => isRacyTimestamp(entry, indexMtime));
```

`IndexMtime.nanoseconds` stays in the type: it is public (`reports/api.json`) and `readIndex`
fills it. No compare reads it any more. Deleting the field would be a type change (D-6 → `!`)
for no faithfulness gain, so it stays.

### 3. Where `StatCheck` comes from (DC-A)

`StatCheck` sits next to `ExecutableBitTrust` wherever that policy already travels. Both are
read once per scan, the same way:

| Judge | Holder today | After |
|---|---|---|
| `compareAndRefresh` / `compareFile` / `statOnlyVerdict` / `shouldRefresh` / `isStaleAssumedEntry` | `ResolvedScope.executableBit` | `+ statCheck`. `resolveScope` reads only the missing ones, so a bare public call still works |
| `scanTrackedEntries` (status, `refreshedIndex`) | `executableBit` read once | `+ readStatCheck` once |
| rm, stash ×2, clean-work-tree, apply-changeset, find-would-overwrite | build a scope with `executableBit` | `+ statCheck` beside it |
| `upgradeStaleNoops` (`StatJudge`), `judgeMovers` (`Judgement`), `clearedObstructions` | `lazily(readExecutableBitTrust)` | `+ lazily(readStatCheck)` |
| `classifyThroughLink` | `await readExecutableBitTrust` | `+ await readStatCheck` (rare path) |
| `smudgeRacilyClean` → `racilyClean` | reads `executableBit` only when racy entries exist | `+ statCheck`, same condition |
| `add` → `buildConversionScope` → `restagesAsIs` | `executableBit` in `ConversionScope` | `+ statCheck` |

`isEntryStatClean(entry, stat, indexMtime, check)` keeps its assume-valid arm (M2: add and status
call it without `IGNORE_VALID` semantics today, and this change does not alter that). After it
come `isRacyTimestamp`, then `matchesStatData`. `matchesCachedStat` reads `cached.statCheck`.

### 4. Refresh (R4)

```ts
const shouldRefresh = (entry: IndexEntry, stat: FileStat, check: StatCheck): boolean =>
  /* unchanged flag guards */ && !matchesStatData(entry, stat, check);
```

`compareAndRefresh` passes `resolved.statCheck`. A racy entry whose fields match and whose
content matches is left byte-identical. That is git's `refresh_cache_ent` returning `ce` on
`!changed`. A B3 entry whose content matches is refreshed, which is git's
`fill_stat_cache_info` after `ie_modified` clears it. `status` still rewrites the index when
`hasRacyTimestamp` holds (A5: git writes too, its timestamp moves, and `f`'s stat is kept).

### 5. Smudger (R3)

`statStillMatches` becomes
`indexModeFromStat(...) === entry.mode && matchesStatData(entry, stat, statCheck)`. With B3
inside, an already smudged entry is skipped, as git skips it. The result is the same as main's
re-smudge (size 0 stays 0), with one less content read. `racilyClean` filters with the shared
`isRacyTimestamp`.

### 6. Performance

- The hot path (`statOnlyVerdict`, per entry, per status) loses two `bigint` modulo operations
  and a `Number` conversion per entry, and stays synchronous: `StatCheck` is read before the
  scan.
- Whole-second racy hashes every entry whose mtime shares the index's second, where main hashed
  only those at or after the index's nanosecond. git does the same work. The window closes after
  one write: `status` writes the index back on `hasRacyTimestamp`. The cost appears on the first
  command after a same-second checkout, add or commit (the common "commit, then status" loop on a
  small tree). ADR-1267 gates it (R10): a bench pair in `test/bench/status-racy-window.bench.ts`,
  `status` in the racy window against a floor twin in the same process made of a settled `status`
  plus a bare read and SHA-1 of every tracked file; racy ≤ 1.5 × twin. Main is no yardstick: it
  skips the hashing git does. The proposed floor of `readIndex` plus one hash per file, gated at
  1.25, was refused by measurement: it omits the walk, the index compare against `HEAD` and the
  index write that every `status` pays, so main's own racy path already reads 1.36 to 1.60 over
  an `lstat`, read and hash of every file (ADR-1267 Context). A second hash of every entry (reader, then smudge pass) would read
  about 1.8 against the twin, so 1.5 guards it.
- Window arming, as measured: every tracked file's mtime is set to one instant inside second T
  with `utimes` before the add; before each measured call `.git/index` is set to T.000 with
  `utimes`, so every entry is racy again (each `status` in the window writes the index back and
  closes it). The settled half of the twin sets `.git/index` to T+5.
- Measured (implementation, `test/bench/status-racy-window.bench.ts`, ten samples per row, ratio
  = racy mean / floor-twin mean, gate 1.5): 129.80 ms / 121.31 ms = 1.07; 133.88 ms / 118.01 ms
  = 1.13; 130.05 ms / 118.88 ms = 1.09. Quiet machine (load 3.6 to 3.9 on 11 cores, no foreign
  vitest or stryker), macOS arm64 (Darwin 27.2), Node v22.22.3, git 2.56.1.
- The floor twin reads each file once, synchronously, and hashes it as a blob. The first twin
  awaited one asynchronous read per file: it took 305 ms, more than the scan it floors, and read
  0.40 to 0.41, a ratio no defect could push past the gate. A second hash of every entry would
  now read about 1.8 (one more 90 ms pass over the 120 ms twin).
- Benches that could move: `test/bench/status.bench.ts` (settled and stat-invalid shapes; its
  copy leaves the index's second on purpose, so no movement is expected),
  `status-dirty.bench.ts`, `status-sparse.bench.ts`, `checkout.bench.ts`, `add.bench.ts`. Judge
  with `npm run bench:ab` after the commit (house practice) and `bench:check` on the existing
  baselines. `npm run test:perf` holds no stat-compare row.

### 7. Public API and breaking classification

No exported signature or type changes (R8). The change only alters verdicts and on-disk results,
so D-6 settles it as `fix(checkout): …` without `!`.

### 8. Size note

The bundle caps sit within ~100 B of the measurement.
- Deleted: `matchesMtime`, `matchesCtime`, `matchesContentStat`, `NS_PER_SECOND`, smudge's local
  `isRacyTimestamp`, and the nanosecond branch of `isRacy`.
- Added: `isRacilySmudged`, `isEmptyBlobOid`, and one `statCheck` field plus one
  `readStatCheck` call at about 12 sites.
- Expected net: within ±0.3 kB, more likely up than down, because the plumbing outweighs the
  deleted comparators.

Raise the caps once, after review, on a clean build (`rm -rf dist .wireit`), in a `chore(size)`
commit.

### 9. Docs to update (documentation phase)

- Remove ledger row 32.90 from `docs/known-divergences.md` ("resolved by 32.87").
- Tick 32.87 in `docs/BACKLOG.md` and update the Release order table.
- Row 32.89 stays, with one line naming the nanosecond half as gone.

### Timing-fragile rows named in the brief

- `skip-worktree-present-files-status-interop.test.ts` "Given an unsettled index and a present
  file": **premise not touched**. The write it needs comes from `hasRacyTimestamp`, which was
  already whole-second and keeps its result. Its entries carry their writer's exact stat, so no
  refresh fires under either compare.
- same file, "Given a settled index and a present file": **premise not touched**. Its premise is
  "no racy entry and nothing refreshed". This change can only shrink tsgit's refresh set
  (`shouldRefresh` stops firing on nanosecond-only drift), never grow it, and `settle` leaves no
  drift of any kind. No fixture change.
- `stash-push-reset-interop.test.ts` "a symlink swapped for a directory": **premise not
  touched**. `settleIndex` backdates every tracked file 10 s and refreshes, so no entry is racy
  and every field matches exactly. The only changed path, `l`, is a kind change (a directory),
  decided before any stat field is read.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-A | How `StatCheck` reaches each judge | A: a `statCheck` field beside every `executableBit` (scope, `CachedStat`, `StatJudge`, `Judgement`, `ConversionScope`), read once per scan, lazily where the branch may not run · B: replace `executableBit` with one `StatPolicy { executableBit, statCheck }` from a new `readStatPolicy(ctx)` · C: a per-session memo inside `readStatCheck`, called from the predicates | A | Follows the `core.fileMode` precedent; each site gains one line and stays sync on the hot path. B is the cleaner end state, but its diff renames `executableBit` at about 30 sites and in many unit fixtures, which this fix does not need. C hides state in a primitive, keeps an `await` per entry in `statOnlyVerdict`'s caller chain, and needs an invalidation rule for a config write mid-command |
| DC-B | How B3 recognises "the empty blob" | A: `isEmptyBlobOid(id)`: equal to the SHA-1 **or** SHA-256 constant (ids are algorithm-length, so they cannot collide) · B: carry the repository's `HashConfig` into the compare (via `StatCheck` resolution) and use `emptyBlobOid(config)` | A | Pure, sync, no plumbing. B adds a second policy to every holder in §3 for a check A answers exactly |
| DC-C | Perf gate for the whole-second racy window (lesson 050) | A: a new `status` bench row on a tree whose every entry shares the index's second (index mtime pinned with `utimes`), gated against a floor of `readIndex` + hash of every file in the same process at ≤ 1.25 · B: existing benches + `bench:ab` only · C: A gated as a percentage over main | A (as proposed: 1.25 over `readIndex` + hash) — **refused by measurement**; ratified instead: a floor twin (settled `status` + bare read and SHA-1 of every tracked file), gate 1.5 (ADR-1267) | Main skips the hashing git does, so main is no yardstick (lesson 050). The other benches run settled trees and will not see the window. C would fail on git's own work. The proposed floor omits the walk, the `HEAD` compare and the index write every `status` pays: unreachable by correct code |

### Settled (2026-11-25)

- ADR-1261: one whole-second compare `matchesStatData` with the `StatCheck` gates, used by every judge (G-a, G-b; D-2, D-5).
- ADR-1262: one whole-second `isRacyTimestamp` for every reader, `hasRacyTimestamp` and the smudge pass (G-c; D-5).
- ADR-1263: B3 inside the shared compare (G-d; D-5).
- ADR-1264: `shouldRefresh` uses the shared compare with the scan's `StatCheck` (G-e; D-2).
- ADR-1265: DC-A adopted as option A on ADR-1230's precedent; covers G-f.
- ADR-1266: DC-B adopted as option A (`isEmptyBlobOid`), no trade-off.
- ADR-1267: DC-C user-ratified as the floor-twin bench pair, gate 1.5 (R10).
- DOCTRINE D-7 added: a perf gate on work git itself does is a bench pair against a same-process floor twin.

### Settled by doctrine, not candidates

| Point | Settled by |
|---|---|
| Fold `core.trustCtime` / `core.checkStat` into every judge (G-b) and remove ledger row 32.90 | D-2 (the brief's fix direction is the shared compare), D-5 |
| Whole-second `isRacy` and the smudger moving with the readers (G-c) | D-5. Without it, E1/E2 go red |
| B3 in the shared compare (G-d) | D-5. Without it, F1/F2 go red |
| `status` stops rewriting a matching entry's stat (G-e) | D-2: a consumer of the compare |
| `isStaleAssumedEntry` takes the scan's `StatCheck` (G-f) | D-5 |
| Interop pin per consumer of the shared compare | D-2 |
| Commit type `fix(…)`, no `!` | D-6 (no signature or type change, nothing starts throwing) |
| Copy git's C1 rewrite (mode reset on a chmod one second later) | prime directive. D-4 does not apply: no data is destroyed |

## Test strategy

### Unit (red first)

- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts`. Flip: "differing
  nanosecond mtime/ctime" (now clean), "recorded second equals the index second but nanoseconds
  precede" (now racy). Add:
  - one row per S-branch × `StatCheck` value: ctime second drift with `ctime: false`; inode or
    uid drift with `ownerAndInode: false`; size drift always counts;
  - B3: size 0 + non-empty oid vs a 0-byte stat is not clean; size 0 + the empty-blob oid (both
    algorithms) is clean;
  - `isRacyTimestamp`: zero index seconds is never racy; a gitlink is never racy; same second
    with earlier nanoseconds is racy;
  - `hasRacyTimestamp` rows kept.
- `is-entry-stat-clean.properties.test.ts`. Lens 2 invariants:
  - `matchesStatData` is invariant under any change of `mtimeNs` / `ctimeNs` /
    `{mtime,ctime}Nanoseconds`;
  - with `StatCheck` all false, it is invariant under ctime, uid, gid and ino;
  - `isRacyTimestamp` depends only on whole seconds.
  Keep the existing `hasRacyTimestamp` properties.
- `isEmptyBlobOid` is private: the B3 rows of `matchesStatData` cover both constants and one
  non-empty id.
- `compare-working-tree-entry.test.ts`:
  - A-shape at unit level: a same-second ctime nanosecond drift settles by content and returns
    no `refreshed`;
  - a ctime second drift returns `refreshed`; under `ctime: false` it returns none;
  - B3 goes to content;
  - `isStaleAssumedEntry` reads the scope's `StatCheck`, with no config read per entry (assert
    by outcome on a config the scope contradicts; lesson 011 bans call-count spies).
  The 11 racy rows are re-checked, and "an assume-valid entry whose nanoseconds differ in the
  same second" stays green.
- `smudge-racily-clean.test.ts`. Its 11 racy rows are re-based on whole-second racy. Add:
  - an entry earlier in the index's second (by nanoseconds) whose same-size rewrite is smudged
    (E at the writer);
  - an already smudged entry against a 0-byte file is left as is (B3);
  - `core.checkStat=minimal`: an inode-only drift still smudges.
- `stale-entries.test.ts`, `sparse-left-dirty.test.ts`, `occupant-clash.test.ts`,
  `materialize-tree*.test.ts`, `find-would-overwrite.test.ts`, `rm.test.ts`, `stash-pool.test.ts`,
  `clean-work-tree.test.ts`, `status-refresh.test.ts`, `add.test.ts`, `apply-changeset.test.ts`:
  each "stat-clean, non-racy" fixture gains `statCheck`. Add one A-shape row per judge (the
  verdict flips from rewrite/dirty to clean) and one C2-shape row (`ctime: false`).
- Fixture builders to extend: `test/unit/application/primitives/fixtures.ts`,
  `test/unit/application/commands/add-index-fixtures.ts`,
  `test/unit/domain/git-index/arbitraries.ts` (index-entry generator; no change to recorded
  nanoseconds).

### Interop (new `test/integration/whole-second-stat-match-interop.test.ts`)

Outer `describe.each(['false', 'true'])('Given core.ignorecase is %s')` (lesson 045). Each repo
runs `git config core.ignorecase <v>` before either tool reads it.

**Deterministic fixtures** (lesson 052/012; never loosen an assertion):
- `sameSecondChmod(repo)`: start 50 ms after a second boundary; write, `git add f`, `chmod 664`;
  then verify by `lstat` + `ls-files --debug` that the entry's ctime second equals the file's
  and the nanoseconds differ. Retry up to 5 times, and throw a named fixture error if the premise
  is never met. The session's probe helper is the template.
- Branch choice by the index timestamp, set with `utimes` on `.git/index` only (a file's
  `utimes` would move its ctime): racy = the index mtime set to the entry's mtime second; settled
  = the entry's second + 2. This is the precedent of `status-refresh-interop.test.ts` "shares the
  index second but precedes it in nanoseconds".
- Shape C: the ctime second moves by waiting past the index write, then `chmod`. The rows assert
  that the `lstat` ctime second is greater than the entry's.
- Shapes E and F: built by `git` in both twins (the index bytes are git's). Each premise is
  asserted from `ls-files --debug` (E: entry mtime second == index second; F: `size: 0`,
  index second > entry second).

**Rows** (git's routine named per row, lesson 019):

| Row | Branch | Consumer / routine | tsgit call | Assert |
|---|---|---|---|---|
| A1r / A1s | S2 equal, racy (R2) / settled | `checkout_entry` | `checkout({ paths: ['f'] })` | same inode, mode 0664, both tools |
| A2r | S2 equal, racy | `oneway_merge` (forced switch) | `checkout({ rev: 'other', force: true })` | same |
| A3 | S2 equal, racy | `twoway_merge` keeps the entry (f identical in both commits) | `checkout({ rev: 'other' })` | same (regression guard) |
| A4r | S2 equal, racy | `oneway_merge` (`reset --hard`) | `reset({ mode: 'hard', rev: 'HEAD' })` | same |
| A5r / A5s | S2 equal | `refresh_cache_ent` | `status()` | clean; `ls-files --debug f` identical before/after, both tools |
| A6s | S2 equal, settled | `add_to_index` keeps the alias | `add(['f'])` | `ls-files --debug f` identical to git's (stat kept) |
| E3 | R whole-second at the writer | `ce_smudge_racily_clean_entry` on an unrelated index write | `add(['g'])` | `f`'s `ls-files --debug` `size: 0`, both tools |
| A7r | S2 equal, racy, content same | smudge skips a clean racy entry | `add(['g'])` | `f`'s `size:` unchanged, both tools |
| C1 / C1s | S2 seconds differ | `checkout_entry` / refresh | as A1 / A5 | rewritten, 0644 / stat rewritten |
| C2 / C2s | S2 gated (`trustCtime=false`) | as C1 | as C1 | untouched / stat kept |
| C3 / C3s | S2+S4+S5 gated (`checkStat=minimal`) | as C1 | as C1 | untouched / stat kept |
| L1 / L2 | S5 inode, default / `minimal` | `ie_modified` | `status()` | ` M f` / clean |
| E1 / E2 | R whole-second | `ie_modified` / `checkout_entry` | `status()` / `checkout({ paths })` | modified / `abc` restored |
| F1 / F2 | B3 | `ie_modified` / `checkout_entry` | `status()` / `checkout({ paths })` | modified / `abc` restored |
| O1 | S2 equal, racy | `verify_uptodate` through a symlinked leading directory | the occupant-clash path (`checkout` of a change beneath `l -> d`) | proceeds as git does |
| O2 | S2 equal, racy | `icase_exists` | `checkout` adding a case variant under `core.ignorecase=true` (twin `false` asserts git's refusal) | obstruction cleared as git clears it |
| O3 | S2 equal, racy | `verify_uptodate` for sparse movers | `sparseCheckoutSet` excluding `a/` with `a/f` chmodded | `a/f` removed as git removes it |

The git column of O1–O3, A6s and A7r comes from source (the routines above all call
`ie_match_stat` / `ce_match_stat_basic` with the compare this change fixes). They are pinned
against git at implementation, red first on main where main diverges. O3 is expected green on
main, because `verdictOf` falls back to content. It stays as the per-consumer pin D-2 asks for.

### Perf

ADR-1267 (R10): `test/bench/status-racy-window.bench.ts` holds the pair, in one process:
- racy: `status` with every entry in the window. Every tracked file's mtime is set to one instant
  inside second T with `utimes` before the add; before each measured call `.git/index` is set to
  T.000 with `utimes`, so every entry is racy again (each `status` in the window writes the index
  back and closes it);
- floor twin: a settled `status` (`.git/index` set to T+5) plus a bare read and SHA-1 of every
  tracked file.

Gate: racy ≤ 1.5 × floor twin. Record the ratio on the fixed code, three runs, in Design §6.

### Mutation

Run scoped Stryker on `is-entry-stat-clean.ts`, `compare-working-tree-entry.ts` and
`smudge-racily-clean.ts` with their eponymous suites
(`.claude/workflow/mutation.md`). Each `StatCheck` gate and each conjunct of `matchesStatData` /
`isRacyTimestamp` needs its own isolated row: the zero guard, the gitlink guard, `<=` vs `<`,
B3's two conjuncts.

## Out of scope

- Ledger row 32.89 (assume-unchanged merge): its racy half needs `builtin/merge.c` /
  `merge-ort.c`, which this reading did not cover. It stays in the ledger.
- `USE_NSEC` / `USE_STDEV` builds: no platform default enables them, and the local binary is
  built without `USE_NSEC` (A1).
- fsmonitor (M3): tsgit has none.
- `IndexMtime.nanoseconds` removal: it is a public type field, still filled by `readIndex`, and
  removing it brings no faithfulness gain.
- `isEntryStatClean`'s assume-valid arm on `add`'s path. git's `add_to_index` passes
  `CE_MATCH_IGNORE_VALID`, but only `add_files_to_cache`, which honours `CE_VALID`, reaches it
  for a tracked path. This is a hunch only. To prove it: `update-index --assume-unchanged f`, a
  same-size edit in a later second, then `git add f` vs `add(['f'])`, and compare `ls-files -s`.
