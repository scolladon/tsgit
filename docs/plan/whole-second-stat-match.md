<!-- cspell:ignore backticked handback racily smudger smudges chmod chmodded lstat utimes gitlink gitlinks ignorecase trustctime checkstat uptodate oneway twoway munge statinfo nsec NSEC STDEV ifdef fsmonitor mktemp pgrep uptime -->
# Plan — whole-second-stat-match

> Source: design doc `docs/design/whole-second-stat-match.md` · ADRs 1261, 1262, 1263, 1264, 1265, 1266, 1267 and DOCTRINE D-2, D-5, D-6, D-7 (every candidate settled)
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Overview and ordering argument

Seven parts, one commit each, every commit green and data-safe on its own:

| # | Part | Behaviour it lands | Interop rows |
|---|---|---|---|
| 1 | Comparison scope carries `StatCheck` | assume-unchanged judge reads the scan's policy (G-f) | none (unit RED by outcome) |
| 2 | Whole-second racy test, B3, whole-second smudger | ADR-1262 (minus the zero guard), ADR-1263, R3 | E3 red; A7r guard |
| 3 | Status and add judge in whole seconds | ADR-1261 + ADR-1264 for `statOnlyVerdict`, `shouldRefresh`, `restagesAsIs` | A5r, A5s, C2s, C3s, L2, A6s red; C1s, L1, E1, F1 guards |
| 4 | `CachedStat` carries `StatCheck` | plumbing only (ADR-1265) | none |
| 5 | Cached-stat judges in whole seconds, zero guard | ADR-1261 for `matchesCachedStat`, ADR-1262 zero guard, R7 deletions | A1r, A1s, A2r, A4r, C2, C3, O1, O2 red; A3, C1, E2, F2 guards |
| 6 | Stash and clean scans read the policy once; racy-window bench | R5 tail, R10 (ADR-1267) | O3 guard |
| 7 | Docs | R9 ledger half | — |

**Ordering argument.** Part 2 lands the whole-second racy test, git's racily-smudged branch (B3)
and the smudger's whole-second compare together, before any reader drops a nanosecond (Parts 3
and 5): from Part 2 on, a reader that still compares nanoseconds is only stricter than git, and
a smudger that judges as git does smudges every same-second edit git smudges, so no later read
can find a same-size edit clean. The readers then drop nanoseconds in two groups (Part 3: the
`compareAndRefresh` / `add` judges; Part 5: the `matchesCachedStat` judges), each group in the
same part as the E and F guards of its consumers.

Why the smudger may not lag the readers (proof for the reviewer): with a nanosecond smudger and
whole-second readers, `abc` at T.0, add at T.1, same-size `xyz` at T.2, an unrelated index write
at T+1.0 (smudger: racy, nanosecond mtime differs → not smudged; new index at T+1), then any read
at T+2 sees a non-racy entry whose whole-second stat matches → `xyz` read clean. git smudges at
the T+1 write (B3 then catches it). Hence Part 2 before Part 3.

Why files recur across parts (plan-lint's locality warnings): the six-file ceiling, not the
design, splits the seam. is-entry-stat-clean.ts and its unit file change in Parts 2–5 because
each part moves one group of its functions (racy test and B3; `isEntryStatClean`; the
`CachedStat` type; `matchesCachedStat`); compare-working-tree-entry.ts changes in Part 1 (scope
plumbing), Part 2 (one import rename) and Part 3 (`statOnlyVerdict`, `shouldRefresh`); its unit
file gets the G-f row in Part 1 and the design's compare rows in Part 6, the first part after
Part 3 with room. Each part starts from the previous part's committed tree.

Why Part 4 is plumbing only: the `CachedStat` type change forces `is-entry-stat-clean.ts`, its
four constructors and the unit file holding `CachedStat` literals into one commit — six files,
no room for the interop file that the behaviour change needs red-first. Part 4 therefore adds
the field and threads it, and Part 5 (three source/test files plus the interop file) reads it.
Between the two commits the field is carried and not read (PC-2).

## Planning facts (read once; every part relies on them)

- **Implementers have no MCP tools.** Every symbol below is named with its file and current
  signature; use Read/Grep/Edit. The harness LSP is rooted at the main checkout and reports false
  `Cannot find module` errors: `npm run check:types` is the only type oracle.
- **One RED per function, run it red before writing its code.** Never batch REDs across
  functions, never write GREEN first. A row that already passes at its step is a GUARD. Interop
  rows a part turns green are written red in that part, after the probe that pins git.
- **Test shape** (CLAUDE.md): `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA
  comments, the system under test is `sut`. Under the ignorecase twin
  `describe.each(['false', 'true'])('Given core.ignorecase is %s')` the rows are When/Then only
  (lesson 045). Error assertions use try/catch and assert `.data`. No call-count spies to prove
  "read once" (lesson 011): prove it by outcome, on a config the scope contradicts.
- **No suppression directives, no provenance refs** (ADR/part/backlog numbers, matrix IDs such
  as "A5r") in src or test code. Matrix IDs live only in this plan and the design. The existing
  `// Stryker disable next-line` in `restagesAsIs` (src/application/commands/add.ts) stays
  verbatim; never add one.
- **vitest binary.** The part gate below is the manifest's verbatim. If the rtk hook widens
  `npx vitest run <files>` into a whole-suite run, run the same arguments through
  `./node_modules/.bin/vitest run`. Any command whose output may exceed ~100 lines writes to a
  file under the session scratchpad; read back only the lines that matter. vitest swallows
  `console.log` in this repo: a probe that must print writes to a file.
- **Never write git state in the worktree.** Interop rows build repos with `makePeerPair` /
  `initBothRepos` (test/integration/interop-helpers.ts, read-only) under the OS temp dir. Probes
  follow .claude/workflow/probes.md and .claude/workflow/faithfulness.md: `set -euo pipefail`,
  `d=$(mktemp -d)`, scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
  `git config core.ignorecase <v>` in every repo, each git outcome run twice, script run with
  `bash /abs/script.sh`.
- **Rows whose git side comes from source only (O1, O2, O3, A6s, A7r).** The part that adds one
  first pins it against real git in a throwaway probe, on the same fixture the row builds. If git
  disagrees with the design's stated outcome, STOP: hand back through the blocker protocol
  `{ unit, reason, ≤3 options }`. Never fit the row or the code to the probe.
- **GUARD rows the design expects green (lesson 005).** A GUARD is a proven pass, not a claim:
  run it on the part's starting code and see it pass, then prove it can go red with the named
  half-fix check — an uncommitted, temporary edit that re-introduces the old behaviour, run once,
  reverted before the gate (`git diff --no-ext-diff` shows only the part's real edits). Write the
  observed red/green into the handback.
- **Size caps.** Parts never touch `.size-limit.json`. A part whose only red is a size cap
  reports it in its handback (the session raises caps once after review).
- **Public surface.** Every symbol this plan adds or renames is **internal**:
  `isRacyTimestamp`, `matchesStatData`, the module-private `isEmptyBlobOid` / `isRacilySmudged`
  (src/application/primitives/internal/is-entry-stat-clean.ts), `ComparisonScope.statCheck`,
  `CachedStat.statCheck`, `StatJudge.statCheck`, `Judgement.statCheck`,
  `ConversionScope.statCheck` (add.ts and stash.ts), `DirtyProbe.statCheck`,
  `SnapshotScope.statCheck`. None is re-exported by src/index.ts, src/public-types.ts,
  src/application/primitives/index.ts or src/domain/index.ts; reports/api.json holds none of
  them (checked: `ComparisonScope`, `CachedStat`, `StatCheck`, `matchesStatFields`,
  `isEntryStatClean`, `hasRacyTimestamp` are absent). `IndexMtime`, `compareWorkingTreeDelta`,
  `compareWorkingTreeEntry` keep their signatures, so reports/api.json does not move (R8). Do
  NOT add `isEmptyBlobOid` to src/domain/objects/object-id.ts: that module is re-exported through
  src/domain/objects/index.ts → src/domain/index.ts and `export type *` in src/public-types.ts,
  and `emptyBlobOid` already appears in reports/api.json — a new export there would move it
  (PC-1).
- **Breaking mark.** None (D-6). Part commits use plain `fix`/`perf`/`refactor`/`docs`.
- **src/application/commands/status.ts is not edited.** The design's code map lists it among
  the scope builders; its only `executableBit` holder is `buildUnmergedEntries`'s
  `WorktreeProbe`, which derives a conflicted file's mode and never compares stat data. The
  status scan's scope is built in src/application/primitives/internal/scan-tracked-entries.ts
  (Part 1). `updateIndexIfAble` keeps `hasRacyTimestamp`.
- **Measured before planning** (patched throwaway copy of this branch, full `test/unit/application`
  project, then the whole `integration` project): the final compare semantics turn red only
  is-entry-stat-clean.test.ts ("differing nanosecond mtime", "differing nanosecond ctime",
  "recorded second equals the index mtime second but whose nanosecond strictly precedes it"),
  is-entry-stat-clean.properties.test.ts ("exactly one compared stat field is mutated"), and —
  through the zero guard only — occupant-clash.test.ts "When the entry is racy and the reached
  content differs at the same size" and sparse-left-dirty.test.ts "Given a racy stat-matching
  entry with different content". No other unit or integration suite moves (the 4 integration
  files that also failed there test the built `dist` and bundle verification, outside the stat
  compare; they were not re-run without the patch). Each part
  below names the ones it flips.

### git's rule, condensed (design §"ie_match_stat — the ordered decision list")

`ie_match_stat`: skip-worktree / assume-valid / intent-to-add arms → B1 kind and mode (gitlink
returns before any stat field) → S1 `sd_mtime.sec != st_mtime` → S2 `trust_ctime && check_stat
&& sd_ctime.sec != st_ctime` → S4/S5 `check_stat` and uid, gid or 32-bit inode differ → S7 32-bit
size differs, always → **B3** `sd_size == 0` and the oid is not the empty blob → changed → **R**
nothing changed and `is_racy_timestamp` (not a gitlink, `istate->timestamp.sec != 0`,
`timestamp.sec <= sd_mtime.sec`) → content decides. No nanosecond is ever compared (git is built
without `USE_NSEC`); the index still records them. `refresh_cache_ent` keeps an entry
byte-identical when the compare passes; `ce_smudge_racily_clean_entry` runs B1, S1–S7, B3 with
the same `StatCheck`, then content. `StatCheck` = `{ ctime: trustCtime && !minimal,
ownerAndInode: !minimal }` (src/application/primitives/read-stat-check.ts `readStatCheck`).

### Interop file and fixtures (created in Part 2, extended in Parts 3, 5, 6)

`test/integration/whole-second-stat-match-interop.test.ts`. Model it on the session probe the
design cites (a vitest file under test/integration that used `makePeerPair`, `initBothRepos`,
`git` from ./interop-helpers.js, `createNodeContext` from ../../src/adapters/node/index.js, and
the commands from ../../src/application/commands/*.js). Layout:

- `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')('whole-second stat match against git', …)`
  (precedent: test/integration/add-skip-worktree-interop.test.ts — Windows has no POSIX mode bits
  and its ctime is a creation time). Inside it
  `describe.each(['false', 'true'])('Given core.ignorecase is %s', (ignorecase) => …)`, rows as
  When/Then. Every repo runs `git config core.ignorecase <v>` before either tool reads it.
- `seed(repo, ignorecase)`: `core.ignorecase`, write `f` = `one\n`, `git add f`, commit `base`,
  `git branch other`, on `other` add `g` and commit, back to `main`. Both twins are built by git,
  so the index bytes are git's.
- Named constants: `SECOND_START_OFFSET_MS = 50`, `MAX_FIXTURE_ATTEMPTS = 5`,
  `SETTLE_GAP_SECONDS = 2`, `PAST_SECOND_MS = 1_100`, `SHAPE_STEP_MS = 100`.
- `class FixturePremiseError extends Error` with `name = 'FixturePremiseError'`; every shape
  helper throws it (with the shape name and attempts in the message) when its premise is never
  met. Never loosen an assertion to absorb timing (lessons 012, 052).
- `toNextSecondStart()`: sleep until `SECOND_START_OFFSET_MS` after the next wall-clock second.
- `entryDebug(repo, path)`: `git ls-files --debug -- <path>` trimmed lines (ctime, mtime, dev/ino,
  uid/gid, size, flags), and `debugSize(repo, path)` parsing `size:`. Asserting stat kept =
  `entryDebug` identical before and after the act, in each tool's twin. Both twins read through
  git's `ls-files --debug` (ADR-249: structured fields, never a rendered tsgit string).
- `armIndexTime(repo, seconds)`: `utimes` on the repo's .git/index file ONLY (a work file's
  `utimes` would move its ctime). Racy = the entry's mtime second; settled = that second +
  `SETTLE_GAP_SECONDS` (precedent: test/integration/status-refresh-interop.test.ts "shares the
  index second but precedes it in nanoseconds").
- Shape A `sameSecondChmod(repo)`: up to `MAX_FIXTURE_ATTEMPTS` times: `toNextSecondStart()`,
  rewrite `f` with its same bytes, `git add f`, sleep `SHAPE_STEP_MS`, `chmod 0o664`; accept when
  `lstat(f, { bigint: true })` ctime second equals the entry's ctime second from `entryDebug`,
  the ctime nanoseconds differ, and the entry's mtime second equals the .git/index mtime second.
  Returns the inode before the act. Assertion of A rows: same inode and mode `0664` after the
  act, both tools (untouched) — or `entryDebug` identical (status, add).
- Shape C `chmodSecondsLater(repo)` (Part 3): sleep `PAST_SECOND_MS`, `git status` (git writes
  the index a second later, so `f` is not racy), sleep `PAST_SECOND_MS`, `chmod 0o664`; assert the
  lstat ctime second is greater than the entry's. Config variants set `core.trustCtime false` or
  `core.checkStat minimal` before the shape.
- Shape E `sameSecondSameSizeEdit(repo)` (Part 2): `toNextSecondStart()`, write `abc\n`, sleep
  `SHAPE_STEP_MS`, `git add f`, sleep `SHAPE_STEP_MS`, write `xyz\n` (same size, same inode);
  premise from `entryDebug` + lstat of .git/index: entry mtime second == index mtime second, entry
  mtime nanoseconds < index mtime nanoseconds. Readers act one second later (E1, E2); E3 acts in
  the same second (write `g`, then `git add g` / `add(ctx, ['g'])`).
- Shape F `smudgedTruncation(repo)` (Part 3): within second T write `abc\n`, `git add f`, write
  `xyz\n`, `git update-index --add g` (premise: `debugSize(f) === 0`), truncate `f` to 0 bytes in
  place (same inode); at T+1 `git update-index --add h` (premise: index second > entry second);
  act at T+2.
- Shape L `sameSizeEditNewInode(repo)` (Part 3): settled entry (sleep `PAST_SECOND_MS`,
  `git update-index -q --really-refresh`, `armIndexTime(settled)`), write a sibling temp file with
  same-size different content, copy `f`'s atime/mtime onto it with `utimes`, rename it over `f`
  (new inode, same mtime second).
- Every row gets the default 120 s timeout (vitest.config.ts `testTimeout`); no row may sleep
  without a premise check after it.

## Decision candidates

Choices the design and ADRs leave open. The plan follows each recommendation; the session
ratifies or overrides before Part 1 spawns.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| PC-1 | Where `isEmptyBlobOid` lives (ADR-1266 rules its test, not its module; the design's code map says object-id.ts) | A: module-private in src/application/primitives/internal/is-entry-stat-clean.ts over `emptyBlobOid(SHA1_CONFIG)` and `emptyBlobOid(SHA256_CONFIG)` · B: exported from object-id.ts, plus `npm run docs:json` and a committed reports/api.json · C: a new non-barrelled module src/domain/objects/empty-blob-oid.ts with its own eponymous suite | A | R8 says reports/api.json does not move; object-id.ts is re-exported publicly (domain barrel and `export type *`), so B breaks R8. C costs two more files in a part already at the six-file ceiling. A keeps one caller, one module, one eponymous suite for Stryker, and kills both constants' mutants through the two B3 rows |
| PC-2 | How the `CachedStat` field lands under the six-file ceiling | A: Part 4 threads `statCheck` (type, four constructors, unit literals) without reading it; Part 5 reads it and carries the interop rows · B: one part of nine files · C: a transitional `EVERY_STAT_FIELD` constant read by `matchesCachedStat` until the plumbing lands | A | B fails plan-lint. C changes behaviour in the part that cannot hold the interop file, so C2/C3 could never be written red first. A's unread field lives one commit and every intermediate commit stays green |
| PC-3 | Per-consumer unit rows the design's Test strategy lists (rm, stash-pool, clean-work-tree, status-refresh, add, apply-changeset, find-would-overwrite, materialize-tree suites) | A: one A-shape and one C2-shape unit row per distinct judge function (`isEntryStatClean`, `compareAndRefresh`, `matchesCachedStat`/`upgradeStaleNoops`, `verdictOf`, `classifyThroughLink`, the smudger) plus an interop pin per consumer · B: add a row to every consumer suite (each part over the ceiling; the rows could only be GUARDs) | A | The consumers share four judge functions; a row per judge kills the mutants Stryker scores, and D-2's per-consumer pin is the interop row. Measured: no consumer suite needs a fixture change |
| PC-4 | When the zero-timestamp guard of `isRacyTimestamp` lands | A: Part 5, beside the two unit files whose racy fixtures use index mtime 0 · B: Part 2 | A | The guard alone flips the two fixtures (measured); Part 2 is at the ceiling. Index mtime 0 never occurs outside tests, and `hasRacyTimestamp` keeps its own zero guard until then |

## Part 1 — The comparison scope carries the stat-check policy (G-f, R5; ADR-1265)

### Context

Files this part edits:
- `src/application/primitives/compare-working-tree-entry.ts`
- `test/unit/application/primitives/compare-working-tree-entry.test.ts`
- `src/application/primitives/apply-changeset.ts`
- `src/application/primitives/internal/scan-tracked-entries.ts`
- `src/application/primitives/find-would-overwrite.ts`
- `src/application/commands/rm.ts`

Behaviour: none changes except that the assume-unchanged drift check stops reading the config per
entry (G-f). Compare semantics stay as on main.

compare-working-tree-entry.ts today:
- `ComparisonScope { provider?; indexMtime?; filterDriversConfigured?; scanner?; executableBit?: ExecutableBitTrust; ignoreAssumeValid?: true }`.
  Add `readonly statCheck?: StatCheck` beside `executableBit` (doc: "core.trustCtime /
  core.checkStat, resolved once per scan; a comparison outside a scan reads it").
  `StatCheck` is imported as a type from ../../domain/git-index/stat-check.js.
- `type ResolvedScope = ComparisonScope & { readonly executableBit: ExecutableBitTrust }` →
  also `readonly statCheck: StatCheck`.
- `isResolved(scope)` checks `executableBit !== undefined` → both fields defined.
- `resolveScope(ctx, scope)` reads `readExecutableBitTrust(ctx)` when unresolved → fills each
  missing field only (`scope.executableBit ?? await readExecutableBitTrust(ctx)`,
  `scope.statCheck ?? await readStatCheck(ctx)`); a fully resolved scope is returned as is
  (no copy). Keep it under 20 lines; split a helper if needed.
- `isStaleAssumedEntry(ctx, entry, stat): Promise<boolean>` (exported; today
  `entry.flags.assumeValid && !matchesStatFields(entry, stat, await readStatCheck(ctx))`) →
  `isStaleAssumedEntry(entry: IndexEntry, stat: FileStat, check: StatCheck): boolean`, sync, no
  ctx. Update its doc ("The config is read only for such an entry" goes).
- `staleAssumedStatDelta(ctx, entry, stat, scope)` → sync, `(entry, stat, scope)`, passes
  `scope.statCheck`; `compareJudgedByStat` drops the `await` on it.
- `racyContentMatcher(ctx)`: builds a scope `{ ...scopeOf(await provider()), executableBit }`
  for `compareFile` (which takes `ResolvedScope`) → add `const statCheck = lazily(() => readStatCheck(ctx))`
  beside `executableBit` and pass `statCheck: await statCheck()`.
- Imports: `readStatCheck` (./read-stat-check.js) is already imported; `lazily` too.

apply-changeset.ts (the only external caller of `isStaleAssumedEntry`):
- `interface DirtyProbe { provider; settings; executableBit }` and `buildDirtyProbe(ctx)` (read
  lazily through `const probe = lazily(() => buildDirtyProbe(ctx))` in the evaluator) → add
  `readonly statCheck: StatCheck`, filled with `await readStatCheck(ctx)` (import from
  ./read-stat-check.js).
- `staleAssumedEntry(ctx, scope: ClashScope, path, stat)` → takes the check from the probe:
  `staleAssumedEntry(scope, path, stat, check)` (ctx no longer needed — remove it, biome would
  flag nothing but it is dead); `changedBeforeContent(ctx, probe, entry, stat, scope)` passes
  `probe.statCheck`. Keep every function under 20 lines.

scan-tracked-entries.ts (status / `refreshedIndex` scan):
- `scanEntry(ctx, entry, provider, indexMtime, filterDriversConfigured, scanner, executableBit)`
  has seven positional parameters. Build the comparison scope ONCE in `scanWorkingTree`
  (`{ provider, ...(indexMtime !== undefined && { indexMtime }), filterDriversConfigured, scanner, executableBit, statCheck }`,
  with `const statCheck = await readStatCheck(ctx)` beside the existing
  `readExecutableBitTrust(ctx)`, import from ../read-stat-check.js) and pass it:
  `scanEntry(ctx, entry, scope)`.

find-would-overwrite.ts `findWouldOverwrite`: its scope
`{ ...scopeOf(provider, currentIndex.indexMtime, scanner), ignoreAssumeValid: true, executableBit: await readExecutableBitTrust(ctx) }`
gains `statCheck: await readStatCheck(ctx)` (import from ./read-stat-check.js). This is the scope
whose `ignoreAssumeValid` routes into `compareJudgedByStat` → `isStaleAssumedEntry`.

rm.ts: `interface ValveDeps { scanner; provider; indexMtime; childStatus; executableBit }` →
add `readonly statCheck: StatCheck`; `classifyEntries` reads it once beside
`readExecutableBitTrust(ctx)` (import from ../primitives/read-stat-check.js);
`localModificationOf` adds it to its scope literal.

Builders NOT touched here (they keep working: `resolveScope` fills a missing `statCheck` per
call, a temporary per-entry config read closed in Part 2 for the smudger and Part 6 for stash
and clean-work-tree): src/application/primitives/internal/smudge-racily-clean.ts,
src/application/commands/stash.ts, src/application/commands/internal/clean-work-tree.ts.

Test model (read-only for shape): the `describe('compareAndRefresh')` block of the test file
(`stagedThenRewritten`, `seedFile`, `work`, `SEED_MS`, fake `Date`). Config is set by writing
`[core]` to `${ctx.layout.gitDir}/config` and calling `invalidateConfigCache(ctx)` from
src/application/primitives/config-read.js (precedent: test/unit/application/primitives/internal/stale-entries.test.ts
"with core.filemode = false").

### TDD steps

1. RED (`isStaleAssumedEntry`, by outcome, lesson 011) in compare-working-tree-entry.test.ts,
   new `describe('Given an assume-unchanged entry whose ctime moved by a second, and core.trustCtime left true')`
   > `describe('When compared for an overwrite with a scope whose stat policy ignores ctime')` >
   `it('Then the scope's policy decides and the entry is not a change')`: seed a file, build the
   entry with `flags.assumeValid: true` and `ctimeSeconds` one less than the file's, call
   `compareAndRefresh(ctx, entry, { indexMtime, ignoreAssumeValid: true, executableBit: 'trusted', statCheck: { ctime: false, ownerAndInode: true } })`;
   expect `delta.status` `'unchanged'`. Fails today: `ComparisonScope` has no `statCheck` (type
   error), and once it type-checks the per-entry `readStatCheck` reads the repo's default
   `trustCtime = true`, so the entry is stale → `'modified'`.
2. GREEN: the `ComparisonScope` / `ResolvedScope` / `isResolved` / `resolveScope` /
   `isStaleAssumedEntry` / `staleAssumedStatDelta` / `racyContentMatcher` edits above, then
   apply-changeset.ts (`DirtyProbe.statCheck`), then the three builders.
3. GUARD (sibling row, same describe family): the same entry and scope with
   `statCheck: { ctime: true, ownerAndInode: true }` → `'modified'` (passes on main and after:
   the drift counts when the policy counts ctime). It isolates the `check` argument.
4. GUARD: a bare `compareAndRefresh(ctx, entry)` (no `executableBit`, no `statCheck`) still
   resolves both — the existing rows of the file pass unchanged.
5. GUARD runs (to files, read only the summary): `./node_modules/.bin/vitest run --project unit test/unit/application`
   (every consumer suite of the compare: rm, apply-changeset, find-would-overwrite, status,
   stash, checkout, merge); then the families whose shared path changed (lesson 015):
   `./node_modules/.bin/vitest run --project integration assume rm- overwrite status` — all
   green, no fixture change.
6. REFACTOR: every touched function under 20 lines, no new parameter beyond four, no boolean
   parameter.

### Gate

`npx vitest run test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/status.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/compare-working-tree-entry.test.ts src/application/primitives/apply-changeset.ts src/application/primitives/internal/scan-tracked-entries.ts src/application/primitives/find-would-overwrite.ts src/application/commands/rm.ts && npm run check:spelling`

### Commit

`refactor(compare): judge an assume-unchanged entry by the scan's stat-check policy`

## Part 2 — Whole-second racy test, git's racily-smudged branch, whole-second smudger (ADR-1262, ADR-1263, ADR-1266, R2, R3)

### Context

Files this part edits or creates:
- `src/application/primitives/internal/is-entry-stat-clean.ts`
- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts`
- `src/application/primitives/internal/smudge-racily-clean.ts`
- `test/unit/application/primitives/internal/smudge-racily-clean.test.ts`
- `src/application/primitives/compare-working-tree-entry.ts` (import rename only)
- `test/integration/whole-second-stat-match-interop.test.ts` (new; see "Interop file and fixtures")

is-entry-stat-clean.ts today (module-level, top to bottom): `IndexMtime { seconds; nanoseconds }`
(public, unchanged), `NS_PER_SECOND = 1_000_000_000n`, `truncate32`,
`isRacy(entry, indexMtime): boolean` (seconds then `entry.mtimeNanoseconds >= indexMtime.nanoseconds`),
`hasRacyTimestamp(entries, indexMtime)` (`indexMtime.seconds !== 0 && entries.some(non-gitlink && entry.mtimeSeconds >= indexMtime.seconds)`),
`MS_PER_SECOND`, `wholeSecond(ms)`, `matchesMtime`, `matchesCtime`, `matchesContentStat(entry, stat)`
(nanosecond mtime/ctime + uid + gid + ino + size), `matchesStatFields(entry, stat, check)`
(whole seconds, `check`-gated ctime and owner/inode, size), `isEntryStatClean(entry, stat, indexMtime)`
(assume-valid → true; `isRacy` → false; `matchesContentStat`), `CachedStat`, `TrackedStat`,
`RacyContentCheck`, `UNREACHABLE`, `lstatBeyondLink`, `matchesCachedStat({ entry, indexMtime, executableBit }, absPath, stat, contentMatches)`
(mode, `matchesContentStat`, then `indexMtime !== undefined && !isRacy` → true, else content).

Target after this part:
- `isRacy` → `export const isRacyTimestamp = (entry, indexMtime): boolean => entry.mode !== FILE_MODE.GITLINK && indexMtime.seconds <= entry.mtimeSeconds;`
  (the zero guard joins in Part 5, PC-4). Doc: git's `is_racy_timestamp` built without
  `USE_NSEC`. `isEntryStatClean` and `matchesCachedStat` call it. `hasRacyTimestamp` becomes
  `indexMtime.seconds !== 0 && entries.some((entry) => isRacyTimestamp(entry, indexMtime))`.
- `matchesStatFields` → renamed `matchesStatData` (git's `match_stat_data` + B3), adding
  `&& !isRacilySmudged(entry)`; module-private
  `const isRacilySmudged = (entry: IndexEntry): boolean => entry.fileSize === 0 && !isEmptyBlobOid(entry.id);`
  and `isEmptyBlobOid` (PC-1): a module-level
  `ReadonlySet<ObjectId>` of `emptyBlobOid(SHA1_CONFIG)` and `emptyBlobOid(SHA256_CONFIG)`
  (`emptyBlobOid` from ../../../domain/objects/object-id.js, the configs from
  ../../../domain/objects/hash-config.js) and `const isEmptyBlobOid = (id: ObjectId): boolean => …has(id)`.
  Not exported. If `matchesStatData` passes 20 lines, extract `ownerAndInodeMatch(entry, stat)`.
- `matchesContentStat`, `matchesMtime`, `matchesCtime`, `NS_PER_SECOND` STAY (still used by
  `isEntryStatClean`, `matchesCachedStat` and `shouldRefresh`); their last callers go in Parts 3
  and 5.
- compare-working-tree-entry.ts: the `matchesStatFields` import and its one call (in
  `isStaleAssumedEntry`, made sync in Part 1) become `matchesStatData`. No other change.

smudge-racily-clean.ts today: local `isRacyTimestamp(entry, indexMtime)` (gitlink guard over the
shared `isRacy`), `statDataKey` (identity key — stays as is, R1 note), `readPreviousIndex`,
`carriedOver`, `filterConcurrently`,
`statStillMatches(ctx, workDir, entry, executableBit)` (lstat, mode test, `matchesContentStat`),
`interface RacilyClean { clean; executableBit }`,
`racilyClean(ctx, workDir, entries, previous, indexMtime, verified)` (filters racy, reads
`readExecutableBitTrust(ctx)` only when one is racy), and `smudgeRacilyClean(ctx, entries, previous, verified)`
which builds `{ ...scopeOf(provider, undefined, createLeadingPathScanner(ctx)), executableBit }`
for `compareAndRefresh`. Target:
- delete the local `isRacyTimestamp`; import the shared one;
- `statStillMatches` takes the two policies as ONE argument (no fifth positional):
  `statStillMatches(ctx, workDir, entry, policy: Pick<RacilyClean, 'executableBit' | 'statCheck'>)`,
  body `indexModeFromStat(stat, entry.mode, policy.executableBit) === entry.mode && matchesStatData(entry, stat, policy.statCheck)`;
- `RacilyClean` gains `statCheck: StatCheck`, read in `racilyClean` with `readStatCheck(ctx)`
  (from ../read-stat-check.js) under the same "only when racy entries exist" condition, beside
  `executableBit`;
- `smudgeRacilyClean`'s compare scope adds `statCheck` (closes the Part-1 per-entry read).

Unit test models (read-only): smudge-racily-clean.test.ts `trackedRepo()` (memory context,
`init`, `f.txt` = `m1\n`, `add`), `TICK_MS`, `SAME_SIZE_REWRITE`, fake `Date`,
`readPreviousIndex`, `entriesAsRead`. The memory adapter derives mtime/ctime from the faked
`Date`, so a rewrite later in the same faked second moves only the sub-second part.

Suites this part flips by design: is-entry-stat-clean.test.ts `isEntryStatClean` > "Given an
entry whose recorded second equals the index mtime second but whose nanosecond strictly
precedes it" (now racy → not clean; rewrite its title and expectation). Nothing else moves
(measured).

### TDD steps

1. RED (`isRacyTimestamp`) in is-entry-stat-clean.test.ts, new `describe('isRacyTimestamp')`:
   (a) same second, entry nanoseconds before the index's → racy; (b) entry second one below the
   index second → not racy; (c) entry second equal, entry nanoseconds 0 and index nanoseconds
   999 999 999 → racy ((a) and (c) are the rows that kill `<=` → `<`); (d) a gitlink entry in the index's
   second → not racy. (a)/(c) fail today (nanosecond tie-break says not racy); the import of
   `isRacyTimestamp` fails to resolve first. GREEN: rename + whole-second body + gitlink guard;
   `hasRacyTimestamp` over it; flip the one existing row named above; smudge-racily-clean.ts
   imports the shared function and deletes its local one. GUARD: the `hasRacyTimestamp` rows and
   smudge-racily-clean.test.ts pass unchanged.
2. RED (`matchesStatData`, B3) in the renamed `describe('matchesStatData')` table (rename the
   `matchesStatFields` import and describe; keep every existing row): (a) entry `fileSize: 0`,
   id `'a'.repeat(40)`, stat size 0 → `false`; (b) entry `fileSize: 0`, id = the SHA-1 empty blob
   `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`, stat size 0 → `true`; (c) the same with the
   SHA-256 empty blob `473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813` →
   `true`; (d) entry `fileSize: 7` with a non-empty id and stat size 7 → `true` (isolates the
   size conjunct of B3). (a) fails: no B3 today. GREEN: `isRacilySmudged`, `isEmptyBlobOid`,
   the rename, compare-working-tree-entry.ts import.
3. RED (`statStillMatches`, whole seconds — E at the writer) in smudge-racily-clean.test.ts:
   `Given a carried-over entry staged earlier in the index's second whose file was rewritten
   later in that second with the same size` > `When the index is written` > `Then the entry is
   smudged to size 0`: write `f.txt` at `TICK_MS`, advance the faked clock 200 ms, `add` (the
   index is written after the entry's mtime in the same second), advance 300 ms, write
   `SAME_SIZE_REWRITE`; `smudgeRacilyClean(ctx, entries, await readPreviousIndex(ctx))` →
   `[{ ...entries[0], fileSize: 0 }]`. Fails after step 1: the entry is now racy, but
   `statStillMatches` compares mtime nanoseconds and skips it.
   Interop RED, same function — E3 (`ce_smudge_racily_clean_entry` on an unrelated index write):
   create the interop file with the fixtures section's `seed`, `entryDebug`, `debugSize`,
   `toNextSecondStart`, `FixturePremiseError` and Shape E; row `When an unrelated path is added
   in the second of a same-size edit` > `Then both tools smudge the edited entry to size 0`:
   Shape E in both twins, then still in second T write `g` and run `git add g` (peer) /
   `add(createNodeContext({ workDir }), ['g'])` (ours); assert `debugSize(repo, 'f') === 0` in
   both (git 2.56.1: `size: 0`; tsgit: `size: 4` today). Retry the whole shape on a missed second
   (premise check), never the assertion.
   GREEN: `statStillMatches` over `matchesStatData` with the policy object; `RacilyClean.statCheck`
   read in `racilyClean`; the compare scope of `smudgeRacilyClean` carries it.
4. RED (`racilyClean` reads the policy) in smudge-racily-clean.test.ts:
   `Given core.checkStat = minimal and a racy carried-over entry whose recorded inode differs
   from its rewritten file` > `Then the entry is still smudged`: write `[core]\n\tcheckStat = minimal\n`
   to the config, `invalidateConfigCache(ctx)`, rewrite same size in the same second, pass
   entries whose `ino` is `+1` and a previous index carrying the same entries (so
   `carriedOver` keeps them). Fails if `racilyClean` passed a full policy (inode counted → not
   matched → not smudged). If step 3's GREEN already reads `readStatCheck`, this row is a GUARD
   — prove it can go red by temporarily passing `{ ctime: true, ownerAndInode: true }`.
5. GUARD rows:
   - smudge unit: `Given a carried-over entry already smudged to size 0 and a 0-byte file` >
     `Then it is left as is` (same outcome on main; B3 now skips it without a content read);
   - interop A7r (probe git first: source-derived) — `When an unrelated path is added after a
     same-second chmod of unchanged content` > `Then neither tool smudges the entry`: Shape A in
     both twins, write `g`, `git add g` / `add(['g'])`, `debugSize(f)` unchanged in both. Half-fix
     check: temporarily make `smudgeRacilyClean` smudge every entry in `clean` without the content
     compare → A7r goes red; revert.
6. GUARD runs: `./node_modules/.bin/vitest run --project unit test/unit/application` and the
   index-writing families (lesson 015): `./node_modules/.bin/vitest run --project integration status add- commit index-interop racy`.
7. REFACTOR: functions under 20 lines; no magic numbers in the interop file (named constants of
   the fixtures section); `npm run check:test-pyramid`.

### Gate

`npx vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts src/application/primitives/internal/smudge-racily-clean.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts src/application/primitives/compare-working-tree-entry.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:spelling`

### Commit

`fix(index): smudge and judge racy entries by whole seconds as git does`

## Part 3 — Status and add judge stat data in whole seconds under the config's policy (ADR-1261, ADR-1264, R1, R4)

### Context

Files this part edits:
- `src/application/primitives/internal/is-entry-stat-clean.ts`
- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts`
- `test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts`
- `src/application/primitives/compare-working-tree-entry.ts`
- `src/application/commands/add.ts`
- `test/integration/whole-second-stat-match-interop.test.ts`

Starting point: Parts 1–2 landed (`ResolvedScope.statCheck`, `isRacyTimestamp`,
`matchesStatData` with B3, whole-second smudger).

Edits:
- is-entry-stat-clean.ts: `isEntryStatClean(entry, stat, indexMtime)` →
  `isEntryStatClean(entry, stat, indexMtime, check: StatCheck)`: assume-valid → true;
  `isRacyTimestamp` → false; then `matchesStatData(entry, stat, check)`. Update its doc (no
  "exactly" field set; whole seconds and the policy).
- compare-working-tree-entry.ts:
  - `statOnlyVerdict(entry, stat, worktreeMode, indexMtime)` →
    `statOnlyVerdict(entry, stat, worktreeMode, scope: ResolvedScope)` reading `scope.indexMtime`
    and `scope.statCheck` (four parameters, no more); `compareFile` passes `scope`. The size rule
    (`entry.fileSize !== 0 && …`) is untouched: it already is `ie_modified`'s `sd_size != 0`
    clause, so a B3 entry falls through to content.
  - `shouldRefresh(entry, stat)` → `shouldRefresh(entry, stat, check: StatCheck)`, last conjunct
    `!matchesStatData(entry, stat, check)`; `compareAndRefresh` passes `resolved.statCheck`.
  - drop the `matchesContentStat` import.
- add.ts:
  - `interface ConversionScope { provider; settings; executableBit; exclusion }` → add
    `readonly statCheck: StatCheck`; `buildConversionScope(ctx)` reads `await readStatCheck(ctx)`
    (import from ../primitives/read-stat-check.js). `StagingScope extends ConversionScope`, and
    the spreads at the `{ ...scope, indexRules, modeDonors }` sites carry it for free.
  - `restagesAsIs(previous, fresh, indexMtime, executableBit)` →
    `restagesAsIs(previous, fresh, indexMtime, policy: Pick<ConversionScope, 'executableBit' | 'statCheck'>)`
    (no fifth positional): `indexModeFromStat(fresh, previous.mode, policy.executableBit)` and
    `isEntryStatClean(previous, fresh, indexMtime, policy.statCheck)`. Its one call site
    (`restagesAsIs(previous, fresh, indexMtime, scope.executableBit)` near the `donorOf` call)
    passes `scope`. Keep the existing Stryker comment line verbatim above its conjunct.
- `matchesContentStat` keeps exactly one caller after this part (`matchesCachedStat`); do not
  delete it here.

Suites this part flips by design (rewrite, do not delete): is-entry-stat-clean.test.ts
`isEntryStatClean` > "Given a differing nanosecond mtime while both sides carry ns precision" and
"… ctime …" (now clean); every `isEntryStatClean(…)` call in that file and in the properties
file gains a `StatCheck` (hoist `ALL`, `NO_CTIME`, `MINIMAL` from the `matchesStatData` describe
to module level). is-entry-stat-clean.properties.test.ts "When exactly one compared stat field
is mutated" goes red under the GREEN because its mutation set includes nanosecond fields: the
mutation set becomes the whole-second fields (mtime second, ctime second, uid, gid, ino, size) under
`ALL`. Property file layout and budget: .claude/workflow/property-testing.md (100 runs for
invariant properties); its `arbSeed`, `NS_PER_SECOND`, `U32_MODULUS` helpers stay.

Interop shapes added here: C (`chmodSecondsLater`), L (`sameSizeEditNewInode`), F
(`smudgedTruncation`); A and E exist from Part 2. tsgit acts: `status(ctx)` (from
../../src/application/commands/status.js; `result.clean`, `result.changes[].unstaged`) and
`add(ctx, ['f'])`. git acts: `git status --porcelain` (compare `' M f'` against
`changes.find(c => c.path === 'f')?.unstaged === 'modified'`, ADR-249) and `git add f`.

### TDD steps

1. RED (`isEntryStatClean` and its two callers; one function, its consumer pins written first):
   - interop L2 (`ie_modified`, S4/S5 gated) — `When status runs under core.checkStat minimal
     after a same-size edit that changed only the inode` > `Then both tools report the file
     clean`: Shape L with `core.checkStat minimal`; git clean, tsgit reports `f` modified today.
   - interop A6s (`add_to_index` keeps the alias; probe git first) — `When the same-second
     chmodded file is added again with the index settled` > `Then both tools keep its recorded
     stat`: Shape A, `armIndexTime(settled)`, `git add f` / `add(['f'])`, `entryDebug(f)`
     identical before and after in both. tsgit re-stages with the chmod's ctime today.
   - unit, is-entry-stat-clean.test.ts `isEntryStatClean`: (a) flip the two nanosecond rows to
     clean; (b) ctime one second later with `NO_CTIME` → clean, with `ALL` → not clean; (c) inode
     drift with `MINIMAL` → clean; (d) B3: `fileSize: 0`, non-empty id, stat size 0, non-racy →
     not clean.
   - properties RED: `Given a non-racy (entry, stat) pair that agrees on every whole second` >
     `When any nanosecond field of either side changes` > `Then isEntryStatClean does not change`
     (numRuns 100). Fails today: nanoseconds are compared.
   GREEN: `isEntryStatClean(…, check)`, `statOnlyVerdict(…, scope)`, `restagesAsIs(…, policy)`,
   `ConversionScope.statCheck`; rewrite the properties "exactly one compared stat field" set.
2. RED (`shouldRefresh`, ADR-1264; `refresh_cache_ent` keeps on a match):
   - interop A5r and A5s — `When status runs after a same-second chmod, with the index racy`
     (`armIndexTime(racy)`) / `… with the index settled` (`armIndexTime(settled)`) > `Then both
     tools report it clean and keep its recorded stat`: Shape A; `entryDebug(f)` identical before
     and after in both, both clean. tsgit rewrites the ctime today.
   - interop C2s (`core.trustCtime false`) and C3s (`core.checkStat minimal`) — `When status
     runs after a chmod a second later` > `Then both tools keep its recorded stat`: Shape C;
     tsgit refreshes today.
   GREEN: `shouldRefresh(…, check)` and its call.
3. GUARD rows (prove each can go red with the named half-fix, then revert):
   - C1s, default config, Shape C → both clean AND `entryDebug(f)` changed in both (git
     refreshes; S2 seconds differ). Half-fix: pass `{ ctime: false, ownerAndInode: true }` from
     `compareAndRefresh` to `shouldRefresh` → red.
   - L1, default config, Shape L → both report `f` modified (S5 inode). Half-fix: force
     `ownerAndInode: false` in `statOnlyVerdict` → red.
   - E1, Shape E, act one second later → both report `f` modified (R → content). Half-fix:
     restore the nanosecond tie-break in `isRacyTimestamp` → red.
   - F1, Shape F, act at T+2 → both report `f` modified (B3 → `ie_modified` content). Half-fix:
     drop `&& !isRacilySmudged(entry)` from `matchesStatData` → red.
4. GUARD properties (pass after step 1; each proven red by the named half-fix):
   `matchesStatData` invariant under `mtimeNs` / `ctimeNs` and the entry's
   `mtimeNanoseconds` / `ctimeNanoseconds` (half-fix: compare `mtimeNs`); with
   `{ ctime: false, ownerAndInode: false }` invariant under ctime, uid, gid, ino (half-fix: ignore
   `check.ownerAndInode`); `isRacyTimestamp` depends only on whole seconds — invariant under both
   nanosecond fields (half-fix: the old tie-break). Keep the existing `hasRacyTimestamp`
   properties.
5. GUARD runs: `./node_modules/.bin/vitest run --project unit test/unit/application`; the status
   and add families (lesson 015): `./node_modules/.bin/vitest run --project integration status add-`
   (includes the three timing-fragile rows the design re-checked: their premises are untouched,
   and they must stay green with no fixture change).
6. REFACTOR: functions under 20 lines; `npm run check:test-pyramid`.

### Gate

`npx vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/status.test.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts src/application/primitives/compare-working-tree-entry.ts src/application/commands/add.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:spelling`

### Commit

`fix(status): compare stat data in whole seconds under core.trustCtime and core.checkStat as git does`

## Part 4 — The cached-stat judges carry the stat-check policy (ADR-1265; plumbing, PC-2)

### Context

Files this part edits:
- `src/application/primitives/internal/is-entry-stat-clean.ts`
- `src/application/primitives/internal/stale-entries.ts`
- `src/application/primitives/internal/sparse-left-dirty.ts`
- `src/application/primitives/internal/occupant-clash.ts`
- `src/application/primitives/materialize-tree.ts`
- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts`

No behaviour changes: `matchesCachedStat` does not read the new field until Part 5.

Edits:
- is-entry-stat-clean.ts: `CachedStat { entry; indexMtime; executableBit }` gains
  `readonly statCheck: StatCheck`; `TrackedStat = Omit<CachedStat, 'executableBit'>` →
  `Omit<CachedStat, 'executableBit' | 'statCheck'>` (doc: "before the stat policies are
  attached"). `matchesCachedStat` is untouched.
- stale-entries.ts: `interface StatJudge { contentMatches; executableBit: () => Promise<ExecutableBitTrust> }`
  gains `readonly statCheck: () => Promise<StatCheck>`; `upgradeStaleNoops` fills it with
  `lazily(() => readStatCheck(ctx))` (import from ../read-stat-check.js);
  `isUpToDate(ctx, cached, indexMtime, absPath, judge)` builds
  `{ entry: cached, indexMtime, executableBit, statCheck: await judge.statCheck() }` (only after
  the gitlink early return, as `executableBit` is read today).
- sparse-left-dirty.ts: `interface Judgement { ctx; isDirty; scanner; executableBit: () => Promise<…>; hasSymlinks; indexMtime }`
  gains `readonly statCheck: () => Promise<StatCheck>`; `judgeMovers` fills it with
  `lazily(() => readStatCheck(ctx))`; `verdictOf` passes it into the `matchesCachedStat` literal
  next to `executableBit` (keep `verdictOf` under 20 lines — extract the stat-clean test into a
  helper if needed).
- materialize-tree.ts: `obstructionMayGo(ctx, workdir, index, entry, contentMatches, executableBit)`
  already has six parameters; bundle `contentMatches`, `executableBit` and the new lazy
  `statCheck` into one local `interface ObstructionJudge { contentMatches: RacyContentCheck; executableBit: () => Promise<ExecutableBitTrust>; statCheck: () => Promise<StatCheck> }`
  built once in `clearedObstructions` (`lazily(() => readStatCheck(ctx))`, import from
  ./read-stat-check.js) → `obstructionMayGo(ctx, workdir, index, entry, judge)`.
- occupant-clash.ts `classifyThroughLink(ctx, path, scope)`: beside
  `const executableBit = await readExecutableBitTrust(ctx);` read
  `const statCheck = await readStatCheck(ctx);` (rare path, as the design rules) and pass
  `{ ...tracked, executableBit, statCheck }`.
- is-entry-stat-clean.test.ts: every `CachedStat` literal in the `matchesCachedStat` describe
  gains `statCheck: ALL` (module-level since Part 3).

### TDD steps

1. GUARD (the compiler is the RED): add the `CachedStat.statCheck` field first and run
   `npm run check:types` — it lists exactly the four constructors and the unit literals; fix each.
2. GREEN: the edits above.
3. GUARD runs: `./node_modules/.bin/vitest run --project unit test/unit/application` (stale-entries,
   sparse-left-dirty, occupant-clash, materialize-tree*, checkout, reset, sparse-checkout, stash,
   merge suites unchanged and green).
4. REFACTOR: no function over 20 lines, no parameter list over the count it had.

### Gate

`npx vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/stale-entries.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/materialize-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts src/application/primitives/internal/stale-entries.ts src/application/primitives/internal/sparse-left-dirty.ts src/application/primitives/internal/occupant-clash.ts src/application/primitives/materialize-tree.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts && npm run check:spelling`

### Commit

`refactor(checkout): carry the stat-check policy to the cached-stat judges`

## Part 5 — The cached-stat judges compare whole seconds; a zero index time is never racy (ADR-1261, ADR-1262, R1, R2, R7)

### Context

Files this part edits:
- `src/application/primitives/internal/is-entry-stat-clean.ts`
- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts`
- `test/unit/application/primitives/internal/stale-entries.test.ts`
- `test/unit/application/primitives/internal/occupant-clash.test.ts`
- `test/unit/application/primitives/internal/sparse-left-dirty.test.ts`
- `test/integration/whole-second-stat-match-interop.test.ts`

Edits to is-entry-stat-clean.ts:
- `isRacyTimestamp` gains the zero guard: `entry.mode !== FILE_MODE.GITLINK && indexMtime.seconds !== 0 && indexMtime.seconds <= entry.mtimeSeconds`;
  `hasRacyTimestamp` becomes `entries.some((entry) => isRacyTimestamp(entry, indexMtime))`.
- `matchesCachedStat({ entry, indexMtime, executableBit, statCheck }, absPath, stat, contentMatches)`:
  `!matchesContentStat(entry, stat)` → `!matchesStatData(entry, stat, statCheck)`.
- Delete `matchesContentStat`, `matchesMtime`, `matchesCtime`, `NS_PER_SECOND` (their last caller
  goes here; R7). `wholeSecond`, `MS_PER_SECOND`, `truncate32` stay. Grep src/ and test/ for the
  four names: zero hits left.

Fixture rebase (the zero guard flips these, measured): occupant-clash.test.ts rows under "Given a
path reached through a symlinked directory" build `const racy: IndexMtime = { seconds: 0, nanoseconds: 0 }`
three times; sparse-left-dirty.test.ts has `const OLDER_THAN_ANY_ENTRY = { seconds: 0, nanoseconds: 0 }`.
Both mean "an index older than the entry" → use `{ seconds: 1, nanoseconds: 0 }` (still older
than every entry, no longer the "no timestamp" sentinel). Do this BEFORE the zero-guard GREEN.

Unit test models (read-only shapes): stale-entries.test.ts `seed`, `judge(ctx, entries, indexMtime)`,
`NON_RACY`, `FROZEN_NOW`, fake `Date`, the "with core.filemode = false" row's config write +
`invalidateConfigCache`. occupant-clash.test.ts `arrangeTracked(ctx, { indexMtime, cachedFrom })`,
`INDEX_WRITTEN_AFTER_ENTRY`. sparse-left-dirty.test.ts `NEWER_THAN_ANY_ENTRY` and its "notUpToDate
stat short-circuit" describe.

Interop acts (tsgit; git twin in brackets): A1 `checkout(ctx, { paths: ['f'] })` [`git checkout -- f`];
A2 `checkout(ctx, { rev: 'other', force: true })` [`git checkout -q -f other`]; A3
`checkout(ctx, { rev: 'other' })` [`git checkout -q other`]; A4
`reset(ctx, { mode: 'hard', rev: 'HEAD' })` [`git reset -q --hard HEAD`]. O1: a change beneath a
symlinked leading directory (l -> d, d/f tracked, l/f reached through the link; checkout
of a commit touching a path under `l`). O2: `core.ignorecase true`, `checkout` of a commit that
adds a case variant of the chmodded tracked file (the `false` twin asserts git's own refusal). O1
and O2 are source-derived: pin each against git first (probe), and the fixture details follow the
probe; if git does not proceed as the design states, STOP (blocker protocol).

### TDD steps

1. Fixture rebase (GUARD: both suites still green on the starting code), then RED (`isRacyTimestamp`
   zero guard) in is-entry-stat-clean.test.ts: `Given an index mtime of second 0` > `When an
   entry of any second is checked` > `Then it is not racy`. GREEN: the guard;
   `hasRacyTimestamp` simplification. GUARD: the `hasRacyTimestamp` "index mtime of second 0"
   row still passes (it now exercises the shared guard).
2. RED (`matchesCachedStat`), written in this order before the GREEN:
   - unit, is-entry-stat-clean.test.ts `matchesCachedStat`: (a) a matching stat whose ctime
     nanoseconds differ, non-racy → `true` without calling `contentMatches` (assert by result;
     `contentMatches` returns `false` so a call would flip it); (b) ctime one second later with
     `NO_CTIME` → `true`; (c) inode drift with `MINIMAL` → `true`; (d) B3: `fileSize: 0`,
     non-empty id, stat size 0, non-racy → `false`.
   - unit, stale-entries.test.ts (`upgradeStaleNoops`, the `checkout_entry`/`oneway_merge`
     judge): `Given an entry whose ctime moved within its second` > `Then it stays a noop`
     (entry `{ ...seeded, ctimeNanoseconds: seeded.ctimeNanoseconds + 1 }`, `NON_RACY`); and
     `Given core.trustCtime = false and an entry whose ctime moved by a second` > `Then it stays a
     noop`.
   - unit, occupant-clash.test.ts (`classifyThroughLink` via `classifyOccupant`) and
     sparse-left-dirty.test.ts (`verdictOf` via `judgeMovers`): one row each, an entry whose
     ctime nanoseconds moved, non-racy, content unchanged → clear / not reported. (If either
     already passes because the judge falls back to content, it is a GUARD: say so; the design
     expects that for `verdictOf`.)
   - interop RED: A1r and A1s (`checkout_entry`, racy / settled), A2r (`oneway_merge`, forced
     switch), A4r (`oneway_merge`, `reset --hard`), C2 (`core.trustCtime false`, Shape C,
     `checkout -- f` → untouched, mode 0664), C3 (`core.checkStat minimal`, same), O1, O2 —
     each: same inode and mode 0664 after the act in both twins (O1/O2: the act proceeds as git's
     does). tsgit rewrites (new inode, 0644) or refuses today.
   GREEN: `matchesCachedStat` over `matchesStatData`; delete the four dead symbols.
3. GUARD rows (prove each can go red with the named half-fix, then revert):
   - A3 (`twoway_merge` keeps an identical entry): untouched in both. Red-capability probe:
     temporarily make `isUpToDate` (stale-entries.ts) return `false`; if A3 stays green, record
     that the unforced switch never consults the compare (it is the per-consumer pin D-2 asks for).
   - C1 (default config, Shape C, `checkout -- f`): both rewrite — new inode, mode 0644. Half-fix:
     pass `{ ctime: false, ownerAndInode: true }` in `isUpToDate` → red.
   - E2 (Shape E, `checkout -- f` one second later): both restore `abc\n`. Half-fix: the old
     nanosecond tie-break in `isRacyTimestamp` → red.
   - F2 (Shape F, `checkout -- f` at T+2): both restore `abc\n`. Half-fix: drop the B3 conjunct
     → red.
4. GUARD runs: `./node_modules/.bin/vitest run --project unit test/unit/application`; the
   families whose shared path changed (lesson 015): `./node_modules/.bin/vitest run --project integration checkout reset sparse stash merge cherry revert rebase overwrite occupant`
   (to a file; read only the summary and any failure).
5. REFACTOR: functions under 20 lines; `npm run check:test-pyramid`.

### Gate

`npx vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/stale-entries.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/stale-entries.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): leave a same-second chmodded file in place as git does`

## Part 6 — Stash and clean scans read the policy once; compare guards; racy-window bench (R5, R10; ADR-1265, ADR-1267, D-7)

### Context

Files this part edits or creates:
- `src/application/commands/stash.ts`
- `src/application/commands/internal/clean-work-tree.ts`
- `test/unit/application/primitives/compare-working-tree-entry.test.ts`
- `test/integration/whole-second-stat-match-interop.test.ts`
- `test/bench/status-racy-window.bench.ts` (new)
- `docs/design/whole-second-stat-match.md` (§6: the measured ratio)

Why the bench rides here and not with Part 3: R10 measures `status` on the fixed code. The status
path is final only after Part 2 (whole-second smudge pass on the index write), Part 3 (whole-second
judge) and Part 1 (the policy read once per scan, not per entry); this is the first part after all
three that has room, and Part 7 is docs-only.

Edits:
- stash.ts: its own `interface ConversionScope { provider; settings; executableBit }` and
  `buildConversionScope(ctx)` gain `statCheck` (`await readStatCheck(ctx)`, import from
  ../primitives/read-stat-check.js); `interface SnapshotScope { head; provider; indexMtime; scanner; executableBit }`
  gains `readonly statCheck: StatCheck`, filled where the snapshot scope is built from
  `{ provider, executableBit }: ConversionScope` (destructure `statCheck` too); `classifyEntry`'s
  `comparisonScope` adds `statCheck: scope.statCheck`.
- clean-work-tree.ts `unstagedDirty`: the scope
  `{ ...scopeOf(provider, indexMtime, createLeadingPathScanner(ctx)), executableBit: await readExecutableBitTrust(ctx) }`
  adds `statCheck: await readStatCheck(ctx)` (import from ../../primitives/read-stat-check.js).
- After this part no `compareAndRefresh` caller relies on `resolveScope` filling `statCheck`
  per entry (grep: every scope literal holding `executableBit` also holds `statCheck`).

Bench (model, read-only: test/bench/status-sparse.bench.ts and `benchScenario(given, whenThen, build)`
in test/bench/support/bench-dsl.ts; vitest bench hooks do not run here, so each scenario re-arms
its window inside `sut`, and `teardown` releases the fixture; `removeSync` from
test/bench/support/fixture-scratch.ts):
- One fixture per scenario, built in a `mkdtemp` directory by the `build` function: init, 5 000
  files of 2 KiB in 50 directories, every file's mtime set with `utimes` to one instant inside
  second T before the add, add, commit (tsgit `openRepository`, as status-sparse does).
- Scenario 1 `Given 5000 tracked files whose mtimes share the index's second` /
  `When status() runs in the racy window, Then measure tsgit alone`: `sut` sets the fixture's
  .git/index times to T.000 with `utimes` (every entry racy again — each `status` writes the index
  back and closes the window), then `await repo.status()`.
- Scenario 2 `Given 5000 tracked files in a settled index` /
  `When status() runs and every tracked file is read and hashed, Then measure tsgit alone`:
  `sut` sets .git/index to T+5 with `utimes` (settled), `await repo.status()`, then reads every
  tracked file and hashes it with `createHash('sha1')` from node:crypto (keep the digest in a
  local accumulator so the work is not dead).
- Both scenarios in one file = one process (D-7). Titles stay stable. No baseline library.
  Not registered in docs/perf/hot-paths.json.

### TDD steps

1. GUARD (compare unit rows the design lists, landed in Part 3; each proven red by the named
   half-fix, then reverted) in compare-working-tree-entry.test.ts `describe('compareAndRefresh')`:
   - `Given a staged file whose entry ctime moved within its second` > `Then the delta is
     unchanged and nothing is refreshed` (entry `ctimeNanoseconds + 1`, non-racy `indexMtime`,
     resolved scope with `ALL`). Half-fix: `shouldRefresh` back to a nanosecond compare → red.
   - ctime one second earlier on the entry: with `{ ctime: true, … }` → `refreshed` defined; with
     `{ ctime: false, … }` → `refreshed` undefined (half-fix: ignore `check` in `shouldRefresh`).
   - B3: entry `fileSize: 0`, non-empty id, a 0-byte file → `delta.status` `'modified'` (content
     decides; half-fix: drop the B3 conjunct → `'unchanged'`).
2. GUARD interop O3 (`verify_uptodate` for sparse movers; source-derived — probe git first;
   expected green on main because `verdictOf` falls back to content): Shape A on `a/f`, then
   `sparseCheckoutSet` excluding `a/` [`git sparse-checkout set <other dir>`] → `a/f` removed in
   both. Red-capability probe: temporarily make `verdictOf` return `'dirty'` for a stat-clean
   entry → red.
3. stash and clean-work-tree builders (behaviour-preserving; GUARD runs):
   `./node_modules/.bin/vitest run --project unit test/unit/application/commands` and
   `./node_modules/.bin/vitest run --project integration stash cherry revert rebase pull`.
4. Bench: write it; check `./node_modules/.bin/vitest bench --run --config vitest.bench.config.ts test/bench/status-racy-window.bench.ts`
   completes with both rows reporting a mean. Then, on a quiet machine (`uptime` load below the
   core count and no foreign `stryker`/`vitest` process: `pgrep -fl stryker`), run it three times
   to a scratch file each; ratio = racy mean / twin mean per run. Gate (ADR-1267): every ratio
   ≤ 1.5. Above 1.5 → STOP and hand back through the blocker protocol (never tune the fixture
   toward the gate). Write the three ratios, the machine, git and Node versions into design §6
   ("Measurement to record") in this part's commit.
5. REFACTOR: bench functions under 20 lines, named constants (`FILE_COUNT`, `FILE_BYTES`,
   `DIRECTORY_COUNT`, `SETTLED_OFFSET_SECONDS`).

### Gate

`npx vitest run test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/integration/whole-second-stat-match-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/whole-second-stat-match-interop.test.ts test/bench/status-racy-window.bench.ts && npm run check:spelling`

### Commit

`perf(status): read the stat-check policy once per stash and clean scan and bench the racy window`

## Part 7 — Docs: whole-second stat matching, the stat-check policy, ledger row 32.90 (R9 ledger half)

### Context

Files this part edits (docs only, no `src/` delta):
- `docs/known-divergences.md`
- `docs/use/primitives/internals.md`
- `docs/use/commands/status.md`
- `docs/use/primitives/read-index.md`
- `docs/use/commands/checkout.md`

Edits (house tone: present tense, git routine named, no backlog or ADR numbers in user pages;
.claude/workflow/docs-drift.md is the drift checklist):
- known-divergences.md: remove the row for `core.checkStat=minimal` ignored by the plain
  stat-clean check (it reads "Resolved by 32.87"); on the assume-unchanged merge-refusal row add
  one line: the nanosecond half of its mechanism is gone (stat data is compared in whole seconds);
  the racy half still needs the merge path read, so the row stays.
- internals.md: the `matchesCachedStat · lstatBeyondLink` entry names `matchesStatData` (git's
  `match_stat_data` plus the racily-smudged test: a recorded size 0 on a non-empty blob never
  matches), whole seconds only, ctime gated by `core.trustCtime` and `core.checkStat`, owner and
  inode by `core.checkStat`; mention `isRacyTimestamp` (gitlinks and a zero index time never
  racy, whole seconds) beside `hasRacyTimestamp`.
- status.md "Refresh write-back": an entry whose stat matches (whole seconds, the fields the
  config lets count) is kept byte-identical; only a mismatching entry whose content is unchanged
  is rewritten; `core.trustCtime = false` and `core.checkStat = minimal` are honoured.
- read-index.md: the racy reference sentence — an entry is racy when its mtime second is not
  older than the index file's second.
- checkout.md: one behaviour bullet — a file whose stat still matches in whole seconds (a
  same-second `chmod`, or a ctime change the config tells git to ignore) is left in place, as
  `git checkout -- <path>`, a forced switch and `reset --hard` leave it.
- Not edited: docs/understand/caching.md (its "mtime[ns]" is the index-file resolver's cache
  check, not the entry stat compare). docs/BACKLOG.md and its Release order table belong to the
  documentation phase; do not touch them.

### TDD steps

1. Grep `docs/use` and `docs/understand` for `matchesContentStat`, `matchesStatFields`,
   `isRacy`, `nanosecond`, `trustCtime`, `checkStat`, `racy`; every hit is either updated or
   recorded as unrelated in the handback.
2. Edit the five pages. GUARD: `npm run check:doc-links` and `npm run check:doc-coverage` green.
3. `npx cspell --no-progress` on each edited page.

### Gate

`npm run check:types && npm run check:spelling && npm run check:doc-links && npm run check:doc-coverage` (no test or source file is touched, so the manifest gate's vitest and biome halves resolve to nothing; precedent: the docs part of docs/plan/wildmatch-bracket-class.md)

### Commit

`docs: describe whole-second stat matching and the stat-check policy`
