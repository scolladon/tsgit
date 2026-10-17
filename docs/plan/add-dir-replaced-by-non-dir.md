# Plan — `add` of a non-directory that replaced a tracked directory

> Source: design doc `docs/design/add-dir-replaced-by-non-dir.md` (at `af0bb702`) · ADRs 990, 991,
> 992, 993, 994, 995, 996, 997, 998, 999, 1000
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

<!-- cspell:ignore backticked lstat unmerged skipwt REUC renormalize restaged restage restages lossy xff realx subarray wildmatch fnmatch -->

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

## Shared knowledge (read once, applies to every part)

### Part map (design §D7 → this plan)

| Plan part | Design part | Size | Concern |
|---|---|---|---|
| 1 | 1 | S | bench scenarios (test-infra only, the `bench:ab` base) |
| 2 | 2 | S | D/F domain module `directory-file-conflict.ts` |
| 3 | 3 | M | resolve-undo codec (byte-exact path, serializer, merge) |
| 4 | 4 | L | O1: every stage of an untouched unmerged path survives |
| 5 | 5 | S | a staged unmerged path is reported in `modified` |
| 6 | 6 (domain + lock half) | M | carry: merge resolve-undo records into `REUC` |
| 7 | 6 (`add` half) | L | `add` records resolve-undo |
| 8 | 11 (domain half) | M | pathspec predicates `matchesUnmergedPath`, `withoutExactly` |
| 9 | 7 | L | fast path: D/F removals, silent drops, unmerged beneath |
| 10 | 8 | M | walk paths: D/F on `addByPathspec`, `addAll` |
| 11 | 9 | M | mirror: a directory replaced a tracked file or symlink |
| 12 | 10 | S | `NOT_A_DIRECTORY` in the fast-path probe |
| 13 | 11 (wiring half) | M | walk leaf filter: exact exclusions leak onto unmerged paths |

Two deliberate re-cuts against §D7, both from the file ceiling: design Part 6 splits into 6 (domain +
`index-lock.ts`) and 7 (`add.ts`); design Part 11 splits into 8 (pure pathspec predicates) and 13
(leaf filter wiring). Part 8 moves **before** the fast path so Parts 9-10 call
`matchesUnmergedIndexPath` directly: the D/F rows R12 and R12d land in Parts 9 and 10 instead of
waiting for a predicate swap, and there is no `selectsUnmergedBeneath` swap step later. The end
state is the design's.

Line numbers below are at `af0bb702`; every part shifts `add.ts`. Find code by symbol name.
plan-lint warns that `add.ts` (8 parts) and `add-interop.test.ts` (4 parts) are shared: this is
intentional. The parts are sequential, single-concern slices of one command on one working tree,
each building on the previous commit.

### Plan-time pins (git 2.55.0, 2026-10-17, `mktemp -d` throwaways, design §Pinning harness)

These rows were pinned while writing the plan. They decide behaviour the design did not cover;
they are bound by DC-P1 (§Decision candidates). The plan implements the recommendation.

Fixture P: tracked `a/b`, `a/c`, `real/b`, `d/e`, `top`; then `update-index --index-info` adds
`a` at stages 1, 2, 3 (so the index holds `a`@1 @2 @3 **and** `a/b`@0 `a/c`@0, the shape a D/F
merge conflict leaves); then directory `a` is removed and `a` becomes a regular file (or a symlink
to `real`); `d/e` rewritten.

| # | Command | git 2.55 `add -v` | Final index |
|---|---|---|---|
| P1 | `add a` (file, and symlink) | `add 'a'` only: `a/b`, `a/c` dropped **silently** | `a`@0 `d/e` `real/b` `top`; `REUC` `a` |
| P1b | `add a top` | `add 'a'`, `add 'top'`: silent | same |
| P1c | `add a d` | `add 'a'`, `add 'd/e'`: silent | same |
| P1d | `add a/b a` | `add 'a'`, `remove 'a/b'`: `a/c` silent | same |
| P2 | `add .`, `add a .` | `add 'a'`, `remove 'a/b'`, `remove 'a/c'`, `add 'd/e'` | same |
| P3 | `add -A` | as P2 | same |
| P4 | `a` at stage 2 only, at stage 3 only, at stages 1+2: `add a` / `add a d` / `add a .` / `add -A` | as P1 / P1c / P2 / P3 | same |
| P5 | nested: `x/a`@1 @2 @3 + `x/a/b`@0, `x/a` now a file: `add x` | `add 'x/a'`, `remove 'x/a/b'` | — |
| P6 | as P5: `add x/a` | `add 'x/a'` only (silent) | — |

Contrast (pinned the same day, `a` **not** in the index, design row R1 family): `add a`, `add a d`,
`add a real`, `add a top d`, `add a .` all report `remove 'a/b'`, `remove 'a/c'`.

Rule that fits every row (inferred, not from source; it is the same "an element that names the
path exactly drops out" shape as ADR-1000): when the inserted path `P` had an **unmerged** prior
entry, a stage-0 entry beneath `P/` is reported iff `matchesIndexPath(withoutExactly(matcher, P),
entry)`; the others are dropped silently. When `P` had **no** prior entry the design's rule holds
(reported iff matched, R1-R7). `add -A` has no pathspec and reports every gone entry (P3).
On the fast path (every literal names an existing file) no other literal can cover an entry
beneath a non-directory, so P1/P1b/P4 are always silent there.

Mirror rows on the walk routes (fixture: tracked file `a`, `real/b`, `top`; `a` replaced by
directory `a/b`):

| # | Command | git 2.55 | Final index |
|---|---|---|---|
| M8 | `add a/` | `add 'a/b'` only: `a` dropped silently | `a/b` `real/b` `top` |
| M9 | `add 'a/*'` | as M8 | same |
| M10 | `a` skip-worktree, `add -A` | as M8 | same |
| M11 | `a` skip-worktree, `add .` | as M8 | same |

### Public surface: nothing new is public

Every new symbol is **internal**: `directory-file-conflict.ts` (not re-exported from
src/domain/git-index/index.ts, ADR-992); `serializeResolveUndo`, `recordResolveUndo`,
`resolveUndoRecordOf` (resolve-undo.ts has no barrel entry; `ResolveUndo*` has 0 hits in
reports/api.json); `withResolveUndo` (carry-extensions.ts, no barrel entry); `CommitOptions` in
index-lock.ts (internal; the `CommitOptions` in reports/api.json is the `commit` command's, from
src/application/commands/commit.ts); `matchesUnmergedPath`, `withoutExactly`,
`matchesUnmergedIndexPath` (not added to src/domain/pathspec/index.ts; `matchesPathspec` has 0
hits in reports/api.json). `AddResult` / `AddOptions` are unchanged (ADR-249). So no barrel,
facade, doc-coverage, browser-surface or README-count gate is tripped. Parts 3, 6 and 8 change
types and still run the api.json check in their gate (expected: no diff; if one appears, commit
it in the same part).

### Conventions every part follows

- Tests: `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA comments
  (`// Arrange`, `// Act`, `// Assert`, or `// Act + Assert`); the unit under test bound as
  `const sut = add;` (a bare reference, never a call result: the test-pyramid
  `detect-sut-binds-result` check flags `const sut = f(…)`). Error assertions read
  `err.data.code` (and data fields), never `toThrow(Class)` alone; the `expectError` helper in
  test/unit/application/commands/add.test.ts:84 is the precedent (copy it into new files).
- **No provenance in source or tests**: test titles and comments describe the scenario ("a
  tracked directory replaced by a symlink"), never a row id (R1, U6, V9, D0, P1…), ADR, part or
  backlog number.
- No suppression comments of any kind. Do not edit the existing `Stryker disable` line in
  `carriedExtensions` (index-lock.ts:195-196); Part 6 is shaped so it stays byte-identical.
- Functions < 20 lines, early returns, no boolean parameters, named constants.
- Unit tests use the memory adapter (`createMemoryContext`, `ctx.fs.symlink(target, path)`,
  `ctx.fs.rm` removes a file or an EMPTY directory: remove `a/b`, `a/c`, `a/x/y`, `a/x`, then `a`).
  They run on Windows CI too and need no OS symlink support.
- Interop tests (real git) run only in the ubuntu `integration` CI job
  (.github/workflows/ci.yml `integration:`), so real symlinks and the raw byte path `a/\xff` are
  safe there; no `posix-only/` file is needed. Run them with
  `npx vitest run --project integration <file>` and git 2.55 first on `PATH`.
- Unmerged interop rows compare `lsStage` only (`writeTreeOf` throws on an unmerged index);
  `writeTreeOf` is asserted only where the add leaves no unmerged entry.
- Interop layout: D/F and mirror rows (index seeded with `update-index`) go in
  test/integration/add-interop.test.ts; merge-conflict rows (O1, `modified`, `REUC`, exclusion
  leaks) go in a new sibling test/integration/add-unmerged-interop.test.ts created by Part 4.
  Unit layout: new test/unit/application/commands/add-unmerged.test.ts (Part 4) and
  test/unit/application/commands/add-directory-file.test.ts (Part 9); add.test.ts (4085 lines) is
  not grown. Both new unit files share the seeding helper
  test/unit/application/commands/add-index-fixtures.ts (Part 4).
- `knip` (`check:dead-code`) counts test files as entries through its vitest plugin: an export
  used only by tests is **not** reported (plan-time probe: a throwaway `src/` export imported only
  from a test file was not flagged). Parts 2, 3, 6 and 8 therefore ship before their first
  production caller without a knip failure.

### Shared fixtures and helpers (exist at HEAD)

- `seedRepo(ctx, { workingTree })` — test/unit/application/commands/fixtures.ts:65 (writes HEAD and
  working files; no commit needed for `add`).
- `seedUnmergedBlobs` (add.test.ts:3736) — precedent for an index with stages 1-3 of `f.txt`,
  `fileSize: 0` so the stat shortcut never fires; `serializeIndexFixtureAsync(index, ctx)` from
  test/unit/application/primitives/fixtures.ts:565 writes a valid index with its checksum.
  `serializeIndex` picks index v3 by itself when an entry is skip-worktree.
- `writeObject(ctx, { type: 'blob', id: '' as ObjectId, content })` stores a blob and returns
  its id (add.test.ts:3732 `putBlobText`).
- `withIndexExtensions(ctx, extensions)` and `indexExtensionsOf(ctx)` —
  test/unit/application/primitives/helpers/index-extensions.ts (rewrite the on-disk extensions;
  read them back by signature). `resolveUndoExtension(path, id, 20)` builds a one-record `REUC`.
- Interop: `makePeerPair`, `runGit`, `tryRunGit` (non-throwing), `runGitEnv`, `lsStage`,
  `writeTreeOf`, `stageRaw(dir, rows)` (feeds `update-index -z --index-info` with raw path bytes),
  `hashBlob(dir, text)` — test/integration/interop-helpers.ts. The commit-identity pattern
  (`COMMIT_ENV` with fixed `GIT_AUTHOR_*` / `GIT_COMMITTER_*`) is in
  test/integration/add-add-content-interop.test.ts:39-47. Reading a peer's index through tsgit:
  `readIndex(createNodeContext({ workDir: dir }))` (test/integration/index-extensions-interop.test.ts:147
  `extensionsOf`).
- Seeding unmerged stages on a real repo: `update-index --index-info` lines
  `<mode> <oid> <stage>\t<path>`; a `0 0000000000000000000000000000000000000000\t<path>` line
  first removes the stage-0 entry. Check `git ls-files -s` once while writing the test.

### Gate commands

`<git-2.55-bin>` is the `bin` directory of the local git 2.55.0 install (the machine's git is
2.56; CI runs 2.55). Every `vitest` run that spawns git puts it first on `PATH`.

Part gate (one `&&` chain, read the exit code; `<tests>` and `<files>` are listed per part):

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run <unit-tests> \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration <interop-tests> \
  && npm run check:types && ./node_modules/.bin/biome check <files> && npm run check:spelling
```

wireit may serve `check:types` / `check:spelling` from cache: the bypasses are
`npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <files>`. The api.json check
(Parts 3, 6, 8): `npx typedoc --json reports/api.json --disableSources --out reports/api-tmp && rm
-rf reports/api-tmp && git diff --no-ext-diff --stat -- reports/api.json` (expected empty).
Phase gate after Part 13: `PATH=<git-2.55-bin>:$PATH npm run validate`, then
`npm run bench:ab -- <part-1-sha> HEAD 5` on a quiet machine (`uptime`, no foreign Stryker run);
each of the three `add` scenarios within +10 % of base (ADR-995). The table goes in the PR body.

### Mutation-resistance map (every guard conjunct gets an isolated one-sided test)

| Conjunct | Killing pair | Part |
|---|---|---|
| inserted: `previous === undefined` | R1 (reported) vs C2 (stage-0 previous: no drop) | 9 |
| inserted: `previous.flags.stage !== 0` | P1 (unmerged previous: silent) vs C2 | 9 |
| reported vs silent by matcher | R1 vs R6 (`!a/b`) | 9 |
| skip-worktree beneath | R7 vs R1 | 9 |
| stage 0 vs unmerged beneath | R1 vs R10 | 9 |
| unmerged beneath selected vs not | R10/R12 vs R12h | 9 |
| lossy beneath | L1 vs R1 | 9 |
| `entryCount > 1` | D0 vs S1 (domain) | 8 |
| `isLiteral && body === path` | D0 vs D6 (glob), D4 vs D5 (prefix) | 8 |
| `withEveryStage` `size === 0` / stage test | merged-index row vs unmerged-index row | 4 |
| count switch to `sorted.length` | untouched unmerged index not rewritten | 4 |
| `resolvedRecords` `?? 0` | staged (V1) vs removed (V7) vs untouched (U1, no record) | 7 |
| `withResolveUndo` `resolved.length === 0` | V13 (no record) vs V1 | 6 |
| stage-wise merge | V10 | 3 |
| `presentOnDisk` directory vs gitlink | M2 vs gitlink directory kept | 11 |
| probe `NOT_A_DIRECTORY` vs other codes | R14 vs `PERMISSION_DENIED` | 12 |

## Part 1 — Bench scenarios for a 10 000-entry index

### Context

Test-infra only, no `src/` delta: a legitimate standalone part. Its commit sha is the `bench:ab`
base, so it lands before any fix and both refs share the scenarios (`bench:ab` compares only files
present on both sides, ADR-995).

- Edit `test/bench/add.bench.ts`. Shape to copy: the last scenario, "Given a scratch repo whose
  committed file is unchanged on disk" / "When add() re-stages the unchanged file, Then measure
  tsgit" (line 105): `benchScenario(given, when, async () => ({ teardown, sut }))`, the scratch built
  once in the factory, outside `sut`. Do not change the existing scenarios or their titles.
- Builder (read-only): `buildManyLooseObjectsScratch(fileCount)` in
  test/bench/support/write-scratch.ts:71 — writes `f000000.txt` … `f009999.txt` (`payload <i>\n`),
  `add -A`, one commit; returns `ScratchRepo { cwd, repo, disposeSync }`.
- Add a named constant `LARGE_INDEX_FILE_COUNT = 10_000`.
- Scenario A: "Given a scratch repo with 10 000 committed files" / "When add() re-stages one
  modified tracked file, Then measure tsgit": `sut` writes `f005000.txt` with a per-iteration
  payload (counter) so every iteration re-hashes it, then `repo.add(['f005000.txt'])`.
- Scenario B: "Given a scratch repo with 10 000 committed files" / "When add() stages one new
  file, Then measure tsgit": `sut` writes `new-<counter>.txt` and adds it (the index grows by one
  per iteration, negligible against 10 000).
- Bench files have no unit tests. vitest bench hooks do not run (repo memory): keep setup in the
  factory and disposal in `teardown`.

### TDD steps

1. GUARD — run the bench file once: both new scenarios build, run and tear down (no `src/` change,
   so there is nothing to make fail).
2. REFACTOR — none.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest bench --run --config vitest.bench.config.ts test/bench/add.bench.ts \
  && npm run check:types && ./node_modules/.bin/biome check test/bench/add.bench.ts && npm run check:spelling
```

### Commit

`test(bench): measure add on a 10 000-entry index`

## Part 2 — Directory/file conflict domain module

### Context

- Create `src/domain/git-index/directory-file-conflict.ts` (ADR-992: pure, no I/O, not
  re-exported from the git-index barrel; `add.ts` will import the module file directly):

  ```ts
  /** Entries beneath path/ (every stage), in index order; `sorted` is in index order. */
  export const entriesBeneath = (sorted: ReadonlyArray<IndexEntry>, path: FilePath): ReadonlyArray<IndexEntry>;
  /** Stage-0 entries at a leading directory of `path` (`a` and a/x for a/x/y). */
  export const entriesAtLeadingDirectories = (byKey: ReadonlyMap<IndexPathKey, IndexEntry>, path: FilePath): ReadonlyArray<IndexEntry>;
  ```

- `entriesBeneath`: binary-search the lower bound of `{ path: <path>/ }` with `compareEntryPath`
  (src/domain/git-index/index-writer.ts:59, byte order; byte compare when either side is lossy),
  then take entries while they are beneath and stop at the first miss (beneath entries are
  contiguous in byte order). "Beneath" for an entry: `hasBytePrefix(pathBytesOf(entry),
  encode(path))` (src/domain/git-index/index-path-key.ts:58 — true iff the bytes start with the
  prefix followed by /). Avoid encoding on the non-lossy path if a string test is equivalent
  (`escapedPathOf(entry).startsWith(path + '/')` for an entry without `pathBytes`), and keep the
  search O(log n + k).
- `entriesAtLeadingDirectories`: walk the / positions of `path`, look up `keyOfPath(prefix)` in
  `byKey`, keep entries with `flags.stage === 0` (a non-zero-stage leading entry is the last
  stage of an unmerged path and must survive, row M5).
- Helpers (read-only): `IndexPath`, `IndexPathKey`, `keyOfPath`, `escapedPathOf`, `pathBytesOf`,
  `hasBytePrefix`, `indexPathOfBytes` in src/domain/git-index/index-path-key.ts; `encode` in
  src/domain/objects/encoding.ts; `IndexEntry` in src/domain/git-index/index-entry.ts.
- Create `test/unit/domain/git-index/directory-file-conflict.test.ts` (examples) and
  `test/unit/domain/git-index/directory-file-conflict.properties.test.ts` (lens 2; arbitraries
  `arbIndexEntry`, `arbIndexEntryWithPathBytes`, `arbPathBytes` from
  test/unit/domain/git-index/arbitraries.ts; sort the generated array with `compareEntryPath`).

### TDD steps

1. RED — `entriesBeneath`: Given an empty index / When asked for `a` / Then nothing; Given `a`,
   `a.txt`, `a/b`@1 `a/b`@2 `a/b`@3, `a/c`, `a/x/y`, `ab`, `top` / When asked for `a` / Then
   exactly the five `a/…` entries in index order (`a` itself, `a.txt` (0x2E) and `ab` (0x62) that
   sort around `/` (0x2F) are not returned); nested `a/x` → `a/x/y` only; a lossy `a/\xff` entry
   (built with `indexPathOfBytes`) is returned. Fails: the module does not exist (import error).
2. GREEN — implement `entriesBeneath`.
3. RED — `entriesAtLeadingDirectories`: for `a/x/y` with stage-0 `a` and `a/x` → both; a top-level
   path → nothing; `a` held at stage 3 only → nothing. Fails: not exported yet.
4. GREEN — implement it.
5. RED/GUARD (properties, numRuns 100): for any sorted array and any `p` drawn from the generated
   entries' leading components, `entriesBeneath` equals an independent linear filter "path bytes
   start with bytes of `p` + 0x2F" (the oracle is a plain filter over the whole array, not the
   binary search), and every result's bytes start with `p/`. GUARD: passes once 2 is green.
6. REFACTOR — functions < 20 lines.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/domain/git-index/directory-file-conflict.test.ts test/unit/domain/git-index/directory-file-conflict.properties.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/directory-file-conflict.ts test/unit/domain/git-index/directory-file-conflict.test.ts test/unit/domain/git-index/directory-file-conflict.properties.test.ts \
  && npm run check:spelling
```

### Commit

`feat(index): find index entries beneath a path and at its leading directories`

## Part 3 — Resolve-undo codec: byte-exact paths, serializer and merge

### Context

- Edit `src/domain/git-index/resolve-undo.ts` (design §D8.1):
  - `ResolveUndoRecord` becomes `interface ResolveUndoRecord extends IndexPath { readonly stages:
    ReadonlyArray<ResolveUndoStage> }` (was `{ path: string; stages }`).
  - `readRecord` (line 112) builds the path with `indexPathOfBytes(pathBytes)` instead of
    `DECODER.decode` (keeps raw bytes of a non-UTF-8 path, keeps a leading U+FEFF); drop the
    now-unused `DECODER`.
  - New `serializeResolveUndo(records: ReadonlyArray<ResolveUndoRecord>): Uint8Array` — per record
    `pathBytesOf(record)`, NUL, then for stages 1, 2, 3 the mode as octal ASCII
    (`mode.toString(8)`) or `0` when absent, each followed by NUL, then `hexToBytes(id)` of each
    present stage in stage order. No sorting. The design's signature carries `digestLength`; it
    is not needed (the id's hex length fixes the digest width) and an unused parameter is dead
    code, so it is omitted.
  - New `recordResolveUndo(records, resolved): ReadonlyArray<ResolveUndoRecord>` — keyed by
    `indexPathKey`; for an existing key, stage `s` comes from the resolved record when present,
    else the existing one (V10: stale stage 3 kept); a new key is inserted; output sorted with
    `compareEntryPath`.
  - New `resolveUndoRecordOf(stages: ReadonlyArray<IndexEntry>): ResolveUndoRecord` — path (and
    `pathBytes` only when present) from the first entry; each entry → `{ stage, mode:
    Number.parseInt(entry.mode, 8), id }`; narrow `flags.stage` to `1 | 2 | 3` by type (callers
    pass unmerged stages only), not by a runtime branch.
- Helpers (read-only): `indexPathOfBytes`, `pathBytesOf`, `indexPathKey`, `IndexPath` (index-path-key.ts);
  `compareEntryPath` (index-writer.ts:59); `hexToBytes`, `concatBytes`, `encode`
  (src/domain/objects/encoding.ts). Consumer that must stay green: `resolveUndoIdsOf` in
  src/application/commands/internal/fsck/roots.ts:351 (reads `stages` only).
- Edit `test/unit/domain/git-index/resolve-undo.test.ts` (existing `path: 'f'` literals need
  `as FilePath`) and `test/unit/domain/git-index/resolve-undo.properties.test.ts`; move its local
  `arbRecord` and `encode` (git's `resolve_undo_write` layout, the independent oracle) into
  `test/unit/domain/git-index/arbitraries.ts` as `arbResolveUndoRecord()` /
  `encodeResolveUndo(records)`, with the path drawn from `arbPathBytes()` through
  `indexPathOfBytes` (and `encodeResolveUndo` writing `pathBytesOf`).
- Literal bytes (design §D1.6): V1 `66 00 31 30 30 36 34 34 00` ×3 modes + 3 digests (83 bytes
  with 20-byte digests); V4 modes `100644, 100644, 0` → `… 30 00` + 2 digests (58 bytes); V5
  `100644, 0, 100644`; V6 `0, 100644, 100644`; V8d `0, 0, 100644` (33 bytes). Use fixed test oids
  (`'1'.repeat(40)` …) and write the expected bytes as a hex literal.

### TDD steps

1. RED — Given a record whose path bytes are `a/\xff` (not UTF-8) / When parsed / Then
   `pathBytes` keeps `0xff` and `path` is the U+FFFD view; Given a path starting with U+FEFF /
   Then it is kept. Fails: `readRecord` decodes with a BOM-stripping `TextDecoder` and drops the
   raw bytes.
2. GREEN — `ResolveUndoRecord extends IndexPath`; `indexPathOfBytes` in `readRecord`; fix the
   existing literals' types.
3. RED — `serializeResolveUndo` examples V1, V4, V5, V6, V8d as literal bytes; a lossy path
   writes its raw bytes. Fails: not exported.
4. GREEN — implement `serializeResolveUndo`.
5. RED — `recordResolveUndo`: empty prior → resolved sorted; insert before and after an existing
   path (V3: `h` then `f` → `f`, `h`); other records kept (V9); same path updated stage by stage
   with a stale stage kept (V10); `resolveUndoRecordOf` of a symlink stage → mode `0o120000`, of
   stages 1+3 → two stages. Fails: not exported.
6. GREEN — implement `recordResolveUndo` and `resolveUndoRecordOf`.
7. RED/GUARD (properties) — lens 1: `parseResolveUndo(serializeResolveUndo(r), 20) ≡ r` (numRuns
   200); lens 4: `serializeResolveUndo(parseResolveUndo(encodeResolveUndo(r))) ≡
   encodeResolveUndo(r)`; lens 2 on `recordResolveUndo`: output sorted by `compareEntryPath` and
   key-unique, every resolved stage present, every untouched prior record unchanged, idempotent
   when `resolved` is applied twice (numRuns 100). GUARD once 4 and 6 are green.
8. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/domain/git-index/resolve-undo.test.ts test/unit/domain/git-index/resolve-undo.properties.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck-worktree-reflogs-index.test.ts test/unit/application/commands/maintenance-resolve-undo-roots.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/resolve-undo.ts test/unit/domain/git-index/resolve-undo.test.ts test/unit/domain/git-index/resolve-undo.properties.test.ts test/unit/domain/git-index/arbitraries.ts \
  && npm run check:spelling \
  && npx typedoc --json reports/api.json --disableSources --out reports/api-tmp && rm -rf reports/api-tmp && git diff --no-ext-diff --exit-code --stat -- reports/api.json
```

### Commit

`feat(index): serialize and merge resolve-undo records with byte-exact paths`

## Part 4 — Keep every stage of the unmerged paths `add` does not touch

### Context

- Edit `src/application/commands/add.ts`:
  - `ExistingIndexState` (843) gains `unmergedStages: ReadonlyMap<IndexPathKey,
    ReadonlyArray<IndexEntry>>` (every stage of every unmerged path, index order; empty map for
    a merged index) and `sorted: ReadonlyArray<IndexEntry>` (the entries as read). Doc the
    existing `entries` as "one entry per path: the stage-0 entry, or the last stage of an unmerged
    path".
  - `readExistingEntries` (849): build `unmergedStages` from the `unmerged` array the loop already
    fills (855), no extra pass; return `sorted: entries`.
  - New private `withEveryStage(entries, unmergedStages): IndexEntry[]` beside it: when
    `unmergedStages.size === 0` return `Array.from(entries.values())`; otherwise the stage-0 values
    of `entries` plus, for each `[key, stages]` of `unmergedStages` whose working value is still
    unmerged (`(entries.get(key)?.flags.stage ?? 0) !== 0`), every stage. This shape has no dead
    fallback (design §D2.2). `serializeIndex` sorts, so emission order is irrelevant.
  - Call sites: `addLiteralOnly` (234), `addByPathspec` (482-487), `addAll` (742-747) pass
    `sorted.length` (entries read) instead of `<map>.size` (paths) and `withEveryStage(<map>,
    unmergedStages)` instead of `Array.from(<map>.values())`. `stageIgnoredWalk` (620) also returns
    `unmergedStages` and `sorted`. `commitIfChanged` / `changesIndex` signatures unchanged.
    `addRenormalized` is untouched (already keeps every stage).
  - `Staging` (242) spreads `...state`: drop `unmergedStages` / `sorted` from what it spreads or
    widen the interface; do not leak unused fields.
- Create `test/unit/application/commands/add-index-fixtures.ts` (shared by Parts 4-13):
  `seedIndex(ctx, rows)` where a row is `{ path: string | Uint8Array; text: string; stage?: 0 | 1 |
  2 | 3; mode?: FileMode; skipWorktree?: boolean }` — stores each blob with `writeObject`, builds
  the `IndexEntry` with zeroed stat fields and `fileSize: 0` (so the stat shortcut never fires),
  path via `indexPathOfBytes` for byte rows, writes with `serializeIndexFixtureAsync`; and
  `stagesOf(ctx): Promise<string[]>` returning `'<path>@<stage>:<id>'` for every entry read back
  with `readIndex` (call `invalidateIndexCache(ctx)` first). Follow `seedUnmergedBlobs`
  (add.test.ts:3736).
- Create `test/unit/application/commands/add-unmerged.test.ts` (memory adapter). Fixture CC:
  working tree `top`, d/e, `f`, `h`; index `top`@0, d/e@0, `f`@1 @2 @3, `h`@1 @2 @3 (distinct
  blobs per stage); `top`, d/e rewritten on disk. MD12: `f`@1 @2, `f` on disk = stage-2 text.
  MD13: `f`@1 @3, `f` on disk = stage-3 text.
- Create `test/integration/add-unmerged-interop.test.ts` with a `@proves` header (copy the shape
  of add-interop.test.ts: `surface: add`, `bucket: cross-tool-interop`, a `unique:` line of
  similar length, `interopSurface: add`). Fixture via a real merge, identical `runGit` calls on
  peer and ours (`git init -q -b main`, `config user.*`): commit `f`, `h`, `top`, d/e with
  `COMMIT_ENV`; `checkout -q -b side`, change `f` and `h`, commit; `checkout -q main`, change them
  differently, commit; `tryRunGit(['-C', dir, '-c', 'merge.conflictStyle=merge', 'merge', 'side'])`
  (expected `ok: false`). MD12: `side` runs `git rm -q f`; MD13: `main` deletes `f` instead.
  Then rewrite `top`, d/e on both. Open `openRepository({ cwd: ours })` **after** seeding and
  dispose it in `afterEach`.
- Rows (design §D1.3): U1 (CC, MD12, MD13), U3, U5, U6, U7, U8, U11, U12; U9, U10, U14 regression.
  U6 / U10 for MD12, MD13 differ from git only in `modified` (Part 5): here assert their stages,
  not `modified`.

### TDD steps

1. RED — unit, fast path: Given CC / When `add(['top'])` / Then `f` and `h` keep stages 1, 2, 3
   and `top` is stage 0 (`describe.each` over CC, MD12, MD13: `f`@1 @2, `f`@1 @3); When
   `add(['f'])` / Then `f`@0 and `h`@1 @2 @3; When `add(['top', 'f'])` / Then the same. Interop
   rows U1 (three shapes), U3 (`f` deleted, `add top`), U6, U7: `lsStage` equal. Fail: the
   path-keyed map writes only the last stage (`f`@3 / `f`@2, `h`@3).
2. GUARD — Given CC whose `top` is stat-clean (seed by `add(['top', 'f', 'h'])` first, then
   rewrite the index with `seedIndex`-style stages for `f`, `h` keeping `top`'s entry) / When
   `add(['top'])` / Then the index file bytes are unchanged (read `<gitDir>/index` before and
   after). Passes today: 4 paths in the map (`top`, `d/e`, `f`, `h`), 4 entries written, nothing
   restaged. It pins that step 3 switches the count to `sorted.length` too (otherwise the 8
   entries written against a count of 4 rewrite the index).
3. GREEN — `unmergedStages`, `sorted`, `withEveryStage`; `addLiteralOnly` uses them.
4. RED — walk: `add(['d'])`, `add(['t*'])`, `add(['d', '!f'])` keep every stage of `f` and `h`;
   interop U5, U8, U11. Fail: `addByPathspec` still writes `Array.from(remaining.values())`.
5. GREEN — `stageIgnoredWalk` returns the new fields; `addByPathspec` writes `withEveryStage`
   against `sorted.length`.
6. RED — bulk: `addAll(ctx, ignoreF)` (the exported seam, add.ts:702, with an ignore predicate
   that hides `f`) keeps `f`@1 @2 @3 while staging the rest. Fails: `addAll` writes the map.
7. GREEN — `addAll` writes `withEveryStage` against `sorted.length`.
8. GUARD — `add({ all: true })` on CC (U10 index), `add -A` with `f` deleted (U12: removed `[f]`,
   every stage gone), `add(['.'])` (U9), `add(['.'], { renormalize: true })` (U14): unchanged
   behaviour, unit + interop (`writeTreeOf` equal for U9, U10, U12).
9. REFACTOR — `readExistingEntries` < 20 lines.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-unmerged-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-index-fixtures.ts test/unit/application/commands/add-unmerged.test.ts test/integration/add-unmerged-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): keep every stage of the unmerged paths add does not stage`

## Part 5 — Report a staged unmerged path as modified

### Context

- Edit `src/application/commands/add.ts`: `stageLiterals` (263; the `else if` at 289) and
  `processWalkEntry` (805; the `if` at 837): a previous entry with `flags.stage !== 0` counts as
  modified whatever its id and mode (ADR-997). Extract one predicate, e.g.
  `isModified(previous: IndexEntry, entry: IndexEntry): boolean`, used by both sites.
- Edit `test/unit/application/commands/add-unmerged.test.ts` (Part 4 fixture) and
  `test/integration/add-unmerged-interop.test.ts`: `modified` must equal the paths git prints as
  `add '<path>'` minus `added`.
- Rows: U6 and U10 for MD12 and MD13 (design §D1.3): `f` on disk equals the map's last stage, so
  today the path is staged but not reported.

### TDD steps

1. RED — Given MD12 (and MD13) / When `add(['f'])` / Then `modified` is `['f']`. Interop U6
   MD12, MD13. Fails: `stageLiterals` compares with the last stage, whose id and mode equal the
   new entry, so nothing is reported.
2. GREEN — the `stage !== 0` disjunct in `stageLiterals`.
3. RED — Given MD12 (and MD13) / When `add([], { all: true })` / Then `modified` contains `f`.
   Interop U10 MD12, MD13. Fails: `processWalkEntry` returns `'unchanged'`.
4. GREEN — same disjunct in `processWalkEntry` (shared predicate).
5. GUARD — one-sided pair in add-unmerged.test.ts: Given a merged `top` rewritten with identical
   bytes (mtime bumped, so it is re-hashed) / When `add(['top'])` / Then `modified` is `[]` (stage-0
   previous, equal id and mode); Given CC / When `add(['f'])` / Then `modified` is `['f']` (unmerged
   previous, different id). Both pass before and after the disjunct.
6. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-unmerged-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-unmerged.test.ts test/integration/add-unmerged-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): report a staged unmerged path as modified`

## Part 6 — Merge resolve-undo records into the carried `REUC`

### Context

Implements DC-P2 option A (recommended; see §Decision candidates). If DC-P2 = B, follow design
§D8.2 literally instead (5th `resolved` parameter on `carryExtensions` + its ~24 test call sites).

- Edit `src/domain/git-index/carry-extensions.ts`: new exported
  `withResolveUndo(carried: ReadonlyArray<IndexExtension>, previous: ReadonlyArray<IndexExtension>,
  resolved: ReadonlyArray<ResolveUndoRecord>, digestLength: 20 | 32): ReadonlyArray<IndexExtension>`:
  - `resolved.length === 0` → return `carried` unchanged (today's rule for every writer).
  - else prior = the previous `REUC` parsed with `parseResolveUndo(data, digestLength)`; absent or
    malformed (`undefined`) → `[]` (V14: git drops a malformed `REUC` and writes the new records
    alone); empty data parses to `[]` (V11). New data =
    `serializeResolveUndo(recordResolveUndo(prior, resolved))`.
  - Output order `TREE`, `REUC`, `UNTR` (rebuild from `carried`: its `TREE`, the new `REUC`, its
    `UNTR`; `carried` holds only those three signatures). The prior comes from `previous`, not
    from `carried`, because `carryUnmerged` drops `REUC` on `update` when `resolvedUnmerged`.
  - `carryExtensions` / `carryUnmerged` stay unchanged (rm, update-index, checkout -m keep
    today's rule, ADR-999 scope).
- Edit `src/application/primitives/internal/index-lock.ts`:
  - `CommitOptions` (38) gains `readonly resolveUndo?: ReadonlyArray<ResolveUndoRecord>` (doc:
    "the unmerged paths this write resolved; written into `REUC` merged with the previous
    records").
  - Rename the existing body of `carriedExtensions` (188-200) to an inner function and leave its
    guard and the `Stryker disable` line above it **byte-identical**; `carriedExtensions` becomes
    `withResolveUndo(await <inner>(…), previous.extensions, options.resolveUndo ?? [],
    ctx.hashConfig.digestLength)` behind an `if (previous === undefined) return [];` (no index →
    no unmerged entry → no record). Do not write `previous?.extensions ?? []`: with no previous
    index the records are always empty, so that fallback would be an equivalent mutant. The early
    return is killed both ways (forced false throws on `previous.extensions` in any first-`add`
    test; forced true drops every extension).
- Edit `test/unit/domain/git-index/carry-extensions.test.ts` (helpers at its top:
  `extension(signature, data)`, `previousExtensions(digestLength)`, `settings`) and
  `test/unit/domain/git-index/carry-extensions.properties.test.ts`.
- Edit `test/unit/application/primitives/internal/index-lock.test.ts` (precedents: "Given an index
  carrying TREE, REUC, UNTR and ZZZZ" at 79, `sut.commit(entries, 'update', { restagedPaths })` at
  169).
- Read-only: Part 3 codec (`parseResolveUndo`, `serializeResolveUndo`, `recordResolveUndo`).

### TDD steps

1. RED — `withResolveUndo`: Given no previous `REUC` and a record for `f` / Then the output holds
   `REUC` whose data equals `serializeResolveUndo([f])`, between `TREE` and `UNTR`. Fails: not
   exported.
2. GREEN — fresh-record branch.
3. RED — Given a previous `REUC` for `h` and a resolved `f` → records `f`, `h` (V9); a malformed
   previous `REUC` (a mode byte `9`) + `h` → `h` only (V14); a previous empty `REUC` + `f` → `f`
   (V11); `carried` without `REUC` (dropped by the resolve rule) + previous `REUC` `h` + `f` → `f`,
   `h`; no records → the same `carried` array (V13, `toBe`). Fail: step 2 ignores the prior.
4. GREEN — prior merge through `recordResolveUndo`.
5. RED — index-lock: Given an extension-less index / When `commit(entries, 'update', {
   resolveUndo: [f] })` / Then the written index has a `REUC` decoding to `f`; Given `TREE` +
   `REUC(h)` / Then `REUC` decodes to `f`, `h`. Fails: `CommitOptions` has no `resolveUndo` and
   the extension-less guard returns `[]`.
6. GREEN — wire `withResolveUndo` into `carriedExtensions` as above.
7. GUARD — every existing carry / index-lock test passes unchanged (no records); a `replace`
   commit with records is not a case any writer produces: do not add a branch for it.
8. RED/GUARD (properties, lens 2, numRuns 100): for arbitrary prior records P and resolved R
   (`arbResolveUndoRecord` from Part 3), `parseResolveUndo` of the output `REUC` equals
   `recordResolveUndo(P, R)` (delegates to the independently tested sibling, not a copy), and
   R empty ⇒ output is `carried`. GUARD once 4 is green.
9. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/domain/git-index/carry-extensions.test.ts test/unit/domain/git-index/carry-extensions.properties.test.ts test/unit/domain/git-index/carry-extensions.rethrow.test.ts test/unit/application/primitives/internal/index-lock.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/carry-extensions.ts src/application/primitives/internal/index-lock.ts test/unit/domain/git-index/carry-extensions.test.ts test/unit/domain/git-index/carry-extensions.properties.test.ts test/unit/application/primitives/internal/index-lock.test.ts \
  && npm run check:spelling \
  && npx typedoc --json reports/api.json --disableSources --out reports/api-tmp && rm -rf reports/api-tmp && git diff --no-ext-diff --exit-code --stat -- reports/api.json
```

### Commit

`feat(index): merge resolve-undo records into the carried REUC extension`

## Part 7 — `add` records resolve-undo when it resolves a conflict

### Context

- Edit `src/application/commands/add.ts`:
  - New private `resolvedRecords(unmergedStages, working): ReadonlyArray<ResolveUndoRecord>` next
    to `withEveryStage` (Part 4): keys of `unmergedStages` whose working value is absent
    (removed) or stage 0 (staged) → `resolveUndoRecordOf(stages)` (Part 3). Share the "still
    unmerged" test with `withEveryStage` (one helper, two complementary uses).
  - `commitIfChanged(lock, existingCount, entries, options: CommitOptions)` (301) and
    `changesIndex` (295) read `options.restagedPaths`; the three call sites (`addLiteralOnly`,
    `addByPathspec`, `addAll`) pass `{ restagedPaths, resolveUndo: resolvedRecords(unmergedStages,
    <working map>) }`. `addRenormalized` passes no record. A resolution is always a restage or a
    removal, so a record never exists without a commit.
- Edit `test/unit/application/commands/add-unmerged.test.ts`: decode with
  `parseResolveUndo((await indexExtensionsOf(ctx)).get('REUC'), 20)`.
- Edit `test/unit/application/commands/index-carry-update-writers.test.ts` ("add carries index
  extensions", 106): a seeded `REUC` for `m` (`resolveUndoExtension('m', id, 20)` +
  `withIndexExtensions`) plus a conflicted path staged → both records, sorted.
- Edit `test/integration/interop-helpers.ts`: add `indexExtensionOf(dir: string, signature:
  string): Promise<Uint8Array | undefined>` (reads the index through
  `readIndex(createNodeContext({ workDir: dir }))`, as `extensionsOf` in
  index-extensions-interop.test.ts:147 does) — used by Parts 7, 9, 10, 11, 13.
- Edit `test/integration/add-unmerged-interop.test.ts`: every row that resolves or removes an
  unmerged path compares `indexExtensionOf(ours,'REUC')` with the peer's (bytes) and
  `git ls-files --resolve-undo` on both.
- Rows (design §D1.6): V1, V2/V3, V4, V5, V6 (add/add: both branches add `f` from a root without
  it), V7 (`add -A` with `f` deleted; the `add .` variant is O2, out of scope), V9 (`rm --cached h`
  by `runGit` on both sides first), V10 (`update-index --index-info` re-creating `f` at stage 1
  `100644` and stage 2 `100755` on both, then `add f`), V12, V13, V14 (corrupt: rewrite one mode
  byte of `REUC` to `9` and recompute the SHA-1 trailer with node:crypto on both sides), W1 (`add
  f h`: `REUC` and `TREE` bytes equal, `lsStage` equal).

### TDD steps

1. RED — unit: Given CC / When `add(['f'])` / Then `REUC` decodes to `f` with stages 1, 2, 3
   (ids and modes of the seeded stages); MD12 → stages 1, 2; MD13 → 1, 3; add/add (stages 2, 3) →
   2, 3; `add({ all: true })` with `f` deleted → `f` recorded for the removal; V2 (`add f`, then
   `add h` → `f`, `h`). Interop V1, V2/V3, V4, V5, V6, V7, W1. Fail: `add` passes no record, so
   no `REUC` is written.
2. GREEN — `resolvedRecords` + `CommitOptions` through `commitIfChanged`.
3. GUARD — prior records: seeded `REUC` for `h` + `add(['f'])` → `f`, `h` (V9); seeded `REUC`
   `f` (1, 2, 3) + index `f`@1 @2 re-created with new ids + `add(['f'])` → stages 1, 2 new, stage 3
   stale (V10); a malformed seeded `REUC` + `add(['h'])` → `h` only (V14);
   index-carry-update-writers seeded `m` + staged conflict → both. Interop V9, V10, V14. They pass
   once step 2 hands records down, because Part 6's `withResolveUndo` already merges the prior
   (before step 2 they fail: the resolve rule drops `REUC`).
4. GUARD — V13: `add(['top'])` on a merged index writes no `REUC`; V12: after V1, `add(['f'])`
   again, `add(['.'])` with nothing else resolved, keep the `f` record byte-identical; U1 (`add
   top` on CC): no record (the untouched-path `?? 0` side).
5. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/index-carry-update-writers.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-unmerged-interop.test.ts test/integration/add-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/index-carry-update-writers.test.ts test/integration/interop-helpers.ts test/integration/add-unmerged-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): record resolve-undo for every conflict add resolves`

## Part 8 — Pathspec predicates for unmerged paths

### Context

- Edit `src/domain/pathspec/match-pathspec.ts` (beside `matchesPathspec`; not added to the
  pathspec barrel src/domain/pathspec/index.ts):

  ```ts
  /** The elements that do not name `path` exactly: a literal whose body is `path`. */
  export const withoutExactly = (spec: Pathspec, path: FilePath): Pathspec =>
    spec.filter((entry) => !(entry.isLiteral && entry.body === path));

  /** git's verdict for a path held at `entryCount` index entries (ADR-1000). */
  export const matchesUnmergedPath = (spec: Pathspec, path: FilePath, entryCount: number): boolean =>
    matchesPathspec(spec, path) || (entryCount > 1 && matchesPathspec(withoutExactly(spec, path), path));
  ```

  `withoutExactly` is exported (design §D9 kept it private) because DC-P1 reuses it for the
  beneath-report rule (Parts 9, 10). Name a constant for the `1` if biome or review asks.
- Edit `src/domain/pathspec/matching-path.ts`: `matchesUnmergedIndexPath(spec, entry: IndexPath,
  entryCount)` = `matchesUnmergedPath(spec, escapedPathOf(entry), entryCount)`, like
  `matchesIndexPath`.
- `PathspecEntry { pattern, body, negated, isLiteral, compiled }` and `compilePathspec` in
  src/domain/pathspec/compile-pathspec.ts (read-only): `!f` → body `f`, negated, literal; d/ →
  literal directory; `*.txt` → glob (`isLiteral: false`); `''` / `.` whole tree. Bodies reach
  `add` collapsed by `resolvePathspec` (./f → `f`).
- Edit `test/unit/domain/pathspec/match-pathspec.test.ts`,
  `test/unit/domain/pathspec/match-pathspec.properties.test.ts` (arbitraries in
  test/unit/domain/pathspec/arbitraries.ts: `arbLiteralPattern`, `arbGlobPattern`,
  `arbCandidatePath`), `test/unit/domain/pathspec/matching-path.test.ts`,
  `test/unit/domain/pathspec/matching-path.properties.test.ts`.
- Rule rows (design §D1.5), all `entryCount = 3` unless stated, spec compiled with
  `compilePathspec`: D0 `['.', '!f']`, `f` → true; D4 `['d', '!d/f']`, d/f → true; D7
  `['*.txt', '!f.txt']`, `f.txt` → true; E1 `['f', '.', '!f']`, `f` → true; D5 `['.', '!d']`, d/f
  → false; D6 `['.', '!*.txt']`, `f.txt` → false; E3 `['.', '!f*']` → false; E7 `['.', '!f',
  '!f*']` → false; D9 `['f', '!f']` → false; D10 `['top', '!f']` → false; S1 `['.', '!f']`,
  `entryCount = 1` → false.

### TDD steps

1. RED — the eleven rule rows on `matchesUnmergedPath`; `withoutExactly(['a', 'a/c', '!a',
   'a*'], 'a')` keeps `a/c` and `a*`. Fail: not exported.
2. GREEN — `withoutExactly`, `matchesUnmergedPath`.
3. RED — `matchesUnmergedIndexPath` for a lossy entry (`indexPathOfBytes` of `d/\xff`) matched
   through its escaped view, and for a plain one. Fails: not exported.
4. GREEN — `matchesUnmergedIndexPath`.
5. RED/GUARD (properties, lens 2, numRuns 100): `entryCount = 1` ⇒ equals `matchesPathspec`;
   `matchesPathspec` true ⇒ true; appending a glob exclusion that matches the path ⇒ false; for
   `entryCount ≥ 2`, appending an exact exclusion (`!<path>`) to a spec that covers the path
   through a non-exact positive (`.`) stays true; `withoutExactly` never keeps a literal whose
   body is the path and keeps every other element in order. `matching-path.properties.test.ts`:
   `matchesUnmergedIndexPath(spec, { path }, n) ≡ matchesUnmergedPath(spec, path, n)` for a
   non-lossy entry. GUARD once 2 and 4 are green.
6. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/domain/pathspec/match-pathspec.test.ts test/unit/domain/pathspec/match-pathspec.properties.test.ts test/unit/domain/pathspec/matching-path.test.ts test/unit/domain/pathspec/matching-path.properties.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/domain/pathspec/match-pathspec.ts src/domain/pathspec/matching-path.ts test/unit/domain/pathspec/match-pathspec.test.ts test/unit/domain/pathspec/match-pathspec.properties.test.ts test/unit/domain/pathspec/matching-path.test.ts test/unit/domain/pathspec/matching-path.properties.test.ts \
  && npm run check:spelling \
  && npx typedoc --json reports/api.json --disableSources --out reports/api-tmp && rm -rf reports/api-tmp && git diff --no-ext-diff --exit-code --stat -- reports/api.json
```

### Commit

`feat(pathspec): match unmerged paths past an exact exclusion`

## Part 9 — Fast path: drop and report the entries beneath an inserted path

### Context

- Edit `src/application/commands/add.ts`:
  - `dispatchPathspec` (206): pass `resolved` to the fast path.
  - `addLiteralOnly` (220): signature `(ctx, resolved: ResolvedPathspec, scope)`; stage
    `resolved.literalMustMatch` as today, then apply the D/F step before `commitIfChanged`, return
    `removed` sorted (`.sort()`, as `addByPathspec` at 491).
  - Inserted paths: literals whose `previous` (`existing.get(keyOfPath(p))`, read **before**
    staging) has no stage-0 entry — `previous === undefined || previous.flags.stage !== 0`
    (C1, C2: a path with a stage-0 entry is replaced in place, no check; the clean re-stage
    never reaches the rule). Derive them in the caller or return them from `stageLiterals`.
  - For each inserted `P`: `beneath = entriesBeneath(sorted, P)` (Part 2; empty in the clean
    case) → one value per key from `existing` (the map's representative, so an unmerged path is
    handled once). Report matcher: `resolved.matcher` when `previous === undefined`,
    `withoutExactly(resolved.matcher, P)` when `previous` is unmerged (DC-P1, rows P1-P4).
    - stage-0 beneath values → `collectMatchedRemovals(ctx, <those>, [], reportMatcher)`
      (add.ts:500, unchanged: stage 0 + matcher + skip-worktree + lossy + `presentOnDisk`) →
      reported; the stage-0 ones not reported → silent (excluded R6, skip-worktree R7).
    - unmerged beneath values → reported when `matchesUnmergedIndexPath(reportMatcher, entry,
      <stage count>)` (Part 8), else kept with every stage (R12h). `Map.get` is typed
      `| undefined`: take the count from an iteration or a narrowed lookup, never a non-null
      assertion or a dead `?? 0` fallback.
    - delete every reported and silent key from `newEntries`; `withEveryStage` then writes no
      stage of an unmerged reported path and `resolvedRecords` records it (V8).
  - Keep helpers small: e.g. `insertedPaths(...)`, `replacedBeneath(...)` returning
    `{ reported, silent }`. No boolean parameters (pass the report matcher, not a flag).
- Read-only: `entriesBeneath` (Part 2), `withoutExactly` / `matchesUnmergedIndexPath` (Part 8),
  `withEveryStage` / `resolvedRecords` (Parts 4, 7), `collectMatchedRemovals` (500),
  `collectRemovedEntries` (789), `presentOnDisk` (765: a leading symlink → gone, `NOT_A_DIRECTORY`
  → gone), `ResolvedPathspec` in src/application/commands/internal/resolve-pathspec.ts:28.
- Create `test/unit/application/commands/add-directory-file.test.ts` (memory adapter). Fixture:
  `seedFreshRepo` working tree a/b, a/c, a/x/y, real/b, `top`; index the same at stage 0
  via `add([], { all: true })` or `seedIndex`; then remove the `a` directory (files first, then
  directories) and create `ctx.fs.symlink('real', '<workDir>/a')` or write a regular file `a`.
  Precedent: add.test.ts:196-262.
- Edit `test/unit/application/commands/add-index-fixtures.ts` if a row needs a helper (e.g.
  `removeTree(ctx, paths)`).
- Edit `test/integration/add-interop.test.ts` (D/F rows; seed both sides with `git add -A` and
  `git commit` through `runGit`, then mutate both identically; skip-worktree with
  `update-index --skip-worktree a/b`; unmerged a/b stages and the lossy `a/\xff` with
  `stageRaw` / `update-index --index-info` on both). Assert `snapshot` (`lsStage` + `writeTreeOf`
  where no stage remains) and `removed` exactly; `REUC` via `indexExtensionOf` (Part 7).
- Rows (design §D1.1 + plan pins): R1, R2, R3 (./a), R4 (`top a`), R5 (nested a/x), R6
  (`a '!a/b'`), R7, R10 (+ `REUC` a/b, V8), R12 (`a '!a/b'` with unmerged a/b: reported,
  `REUC`), R12h (`a '!a/b*'`: a/b kept at stages 1-3, no `REUC`), L1, C2 (index already holding
  `a`(120000) and a/* written with `stageRaw`; `a` retargeted to `realx`; `add a` keeps a/*),
  P1 (file and symlink), P1b.

### TDD steps

1. RED — Given a tracked directory `a` replaced by a symlink to `real` / When `add(['a'])` / Then
   `removed` is `['a/b', 'a/c', 'a/x/y']`, the index is `a`(120000) `real/b` `top`. Interop R1.
   Fails: `addLiteralOnly` returns `removed: []` and keeps `a/*` beside `a`.
2. GREEN — inserted paths, `entriesBeneath`, reported stage-0 removals deleted from `newEntries`.
3. GUARD — R2 (regular file `a`), R3 (`./a`), R4 (`top a`), R5 (`a/x` → `a/x/y` only), L1
   (lossy `a/\xff` reported by its U+FFFD view), C2 (previous stage 0 → no drop), and a clean
   re-stage of `top` with `a/*` tracked → nothing dropped; unit + interop. Pass after step 2.
4. RED — R6 (`add(['a', '!a/b'])` → `removed` `['a/c', 'a/x/y']`, `a/b` gone from the index) and
   R7 (`a/b` skip-worktree → same, `a/b` gone). Interop R6, R7. Fail: an excluded or
   skip-worktree beneath entry is neither reported nor dropped, so `a/b` stays beside `a`.
5. GREEN — silent drop of the beneath stage-0 entries not reported.
6. RED — R10 (`a/b` at stages 1, 2, 3; `add(['a'])` → `removed` `['a/b', 'a/c', 'a/x/y']`, no
   stage of `a/b` left, `REUC` `a/b`) and R12 (`add(['a', '!a/b'])` → same). Interop R10, R12
   (with `REUC` bytes). Fail: `collectMatchedRemovals` names stage-0 entries only, so `a/b` keeps
   its stages.
7. GREEN — unmerged beneath selected through `matchesUnmergedIndexPath`.
8. GUARD — R12h (`add(['a', '!a/b*'])`: `a/b`@1 @2 @3 kept, `removed` `['a/c', 'a/x/y']`, no
   `REUC`); unit + interop. Passes: the glob exclusion still shields.
9. RED — P1: Given `a`@1 @2 @3 with `a/b`, `a/c` at stage 0, `a` now a file (and a symlink) /
   When `add(['a'])` / Then `removed` is `[]`, `modified` is `['a']`, index `a`@0 `real/b` `top`
   (+ `d/e`), `REUC` `a`; P1b `add(['a', 'top'])` the same. Interop P1, P1b. Fails: the report
   matcher is the full matcher, so `a/b`, `a/c` are reported.
10. GREEN — report matcher `withoutExactly(matcher, P)` for an inserted path whose previous entry
    is unmerged.
11. REFACTOR — `addLiteralOnly` < 20 lines; extract the D/F step so Part 10 reuses it.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-index-fixtures.ts test/integration/add-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): drop the index entries beneath a path a non-directory replaced`

## Part 10 — Walk paths: the same drop on `add <dir|glob|.>` and `add -A`

### Context

- Edit `src/application/commands/add.ts`:
  - `addByPathspec` (460-497): inserted = walked outcomes whose `previous`
    (`staged.existing.get(keyOfPath(path))`) has no stage-0 entry (kind `added`, or an unmerged
    previous). After `collectMatchedRemovals` (unchanged), apply the Part 9 step per inserted
    path: unmerged beneath values the report matcher selects → appended to `removedEntries`
    (`collectMatchedRemovals` never names an unmerged path, so none is reported twice); stage-0
    beneath values not in `removedEntries` → deleted from `remaining` silently (R9). DC-P1 on the
    walk: for an inserted path with an unmerged previous, a beneath entry `collectMatchedRemovals`
    reported but that `withoutExactly(matcher, P)` does not match is moved from reported to silent
    (P1c, P1d). `enforceLiteralMustMatch` keeps receiving every removed path (reported and
    demoted) plus `matched`, as today.
  - `addAll` (702-751): inserted from `outcomes` + `existing`; `collectRemovedEntries` already
    reports gone beneath entries (unmerged ones once per path; R15); the new part is the silent
    drop of the stage-0 beneath entries it skipped (skip-worktree, R8). No pathspec, so no
    report-matcher demotion (P3 reports).
  - Reuse the Part 9 helper; one rule, three call sites.
- Edit `test/unit/application/commands/add-directory-file.test.ts` and
  `test/integration/add-interop.test.ts` (Part 9 fixtures).
- Rows: R8 (a/b skip-worktree, symlink `a`, `add -A` → `removed` `['a/c', 'a/x/y']`, a/b
  gone), R9 (`add . '!a/b'` → same), R16 (a/b unmerged, `add .` → `removed` `['a/b', 'a/c',
  'a/x/y']`, `REUC` `a/b`), R12d (`add . '!a/b'` with unmerged `a/b` → same as R16), R12hd (`add .
  '!a/b*'` → `a/b`@1 @2 @3 kept), R15 (`add -A` regression + `REUC` `a/b`), P1c (`add a d` →
  a/b, a/c silent, d/e modified), P2 (`add .`, `add a .` → reported), P3 (`add -A` →
  reported), P5 (`add x` → x/a/b reported), P6 (`add x/a`, fast path → silent), P4
  (stage-2-only `a`: `add a d` silent, `add .` reported). P1d (`add a/b a`, `a` a regular file)
  cannot run here: the fast-path probe still throws `NOT_A_DIRECTORY` for a/b until Part 12,
  which asserts it.

### TDD steps

1. RED — R9 (`add(['.', '!a/b'])`, `a` a file): `a/b` dropped, `removed` `['a/c', 'a/x/y']`.
   Interop R9. Fails: the walk keeps the excluded `a/b` beside `a`.
2. GREEN — D/F step in `addByPathspec` (silent stage-0 drop).
3. RED — R8 (`add([], { all: true })`, `a/b` skip-worktree, symlink `a`): `a/b` dropped.
   Interop R8. Fails: `collectRemovedEntries` skips skip-worktree entries and nothing drops them.
4. GREEN — D/F step in `addAll`.
5. RED — R16 and R12d: `a/b` reported once, no stage left, `REUC` `a/b`. Interop R16, R12d.
   Fail: `collectMatchedRemovals` filters stage 0, so `a/b` keeps its stages.
6. GREEN — unmerged beneath selection appended to `removedEntries`.
7. RED — P1c (`add(['a', 'd'])`: `removed` `[]`, index `a`@0 `d/e` `real/b` `top`, `REUC` `a`).
   Interop P1c. Fails: `collectMatchedRemovals` reports `a/b`, `a/c` through the literal `a`.
8. GREEN — demote beneath reports of an unmerged-previous inserted path that
   `withoutExactly(matcher, P)` does not match.
9. GUARD — R12hd, R15, P2, P3, P4, P5, P6; unit + interop. Pass: the walk's removal pass reports
   them and the shielding glob keeps `a/b`.
10. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-directory-file.test.ts test/integration/add-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): drop the entries beneath a replaced directory on the walk paths`

## Part 11 — Mirror: a directory replaced a tracked file or symlink

### Context

- Edit `src/application/commands/add.ts`:
  - Wire `entriesAtLeadingDirectories(existing, P)` (Part 2) into the D/F step of all three
    routes (Parts 9-10): for every inserted path, the stage-0 entries at its leading directories
    are deleted silently from the working map (M1, M8-M11). An unmerged leading entry is skipped
    by the function, so `withEveryStage` writes all its stages next to a/b@0 (M5, no `REUC`).
  - `presentOnDisk(ctx, scanner, path)` (765) becomes `presentOnDisk(ctx, scanner, entry:
    IndexEntry)`: after the leading-path check, an `lstat` that is a directory and not a symlink
    counts as gone unless `entry.mode === FILE_MODE.GITLINK` (a submodule checkout is a directory
    by design). `collectRemovedEntries` (789, call at 799) passes `entry`. This reaches `add a`
    and `add .` through `collectMatchedRemovals` and `add -A` through `addAll` (M2-M4, M6, M7a).
- Edit `test/unit/application/commands/add-directory-file.test.ts` and
  `test/integration/add-interop.test.ts`. Fixture: tracked `a` (file), real/b, `top`; then
  `a` removed and directory `a` with a/b written (M6: `a` was a symlink to `real`).
- Rows: M1 (`add a/b` → `added` `['a/b']`, `a` gone, `removed` `[]`), M2 (`add a` → `removed`
  `['a']`), M3 (`add .`), M4 (`add -A`), M6 (symlink `a`, the four commands), M5 (`a`@1 @2 @3,
  `add a/b` → stages kept, no `REUC`), M7a (as M5, `add -A` → `removed` `['a']`, no stage left,
  `REUC` `a`), M8 (`add a/`), M9 (`add 'a/*'`), M10 (`a` skip-worktree, `add -A`), M11 (`a`
  skip-worktree, `add .`). Not asserted: M7b, M7c (O2, out of scope).

### TDD steps

1. RED — M1 (fast path), M8 / M9 (walk), M10 / M11 (skip-worktree `a`): `a` gone, nothing
   reported. Interop M1, M8, M9, M10, M11. Fail: nothing drops the stage-0 entry at a leading
   directory, so `a` stays next to `a/b`.
2. GREEN — `entriesAtLeadingDirectories` in the shared D/F step (three routes).
3. GUARD — M5: stages 1-3 of `a` kept beside `a/b`@0, no `REUC`; unit + interop. Passes: the
   function skips a non-zero-stage leading entry and `withEveryStage` writes every stage.
4. GUARD — a tracked gitlink (mode `160000`) whose directory exists is not removed by
   `add([], { all: true })`. Passes today (`lstat` finds it); it pins the gitlink exemption the
   next GREEN adds.
5. RED — M2, M3, M4, M6 (`removed` `['a']`), M7a (`removed` `['a']`, every stage gone, `REUC`
   `a`). Interop M2, M3, M4, M6, M7a. Fail: `presentOnDisk` reads a directory at a tracked file
   path as present.
6. GREEN — `presentOnDisk` takes the entry; directory → gone unless gitlink.
7. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-unmerged.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-directory-file.test.ts test/integration/add-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): drop a tracked file or symlink a directory replaced`

## Part 12 — Stage the removal beneath a regular file instead of refusing

### Context

- Edit `src/application/commands/add.ts`: `allLiteralsAreFiles` (315) catches a `TsgitError`
  with `data.code === 'NOT_A_DIRECTORY'` around its `lstatOrMissing` (335) call and returns
  `false` (the literal routes to `addByPathspec`, which already stages the removal: X1, X2).
  `lstatOrMissing` is unchanged, so `stageOne`, `literalsOnDisk`, `renormalizeOne` keep refusing
  (N1, N2). Every other code still propagates. Name the code constant.
- Edit `test/unit/application/commands/add-directory-file.test.ts` and
  `test/integration/add-interop.test.ts` (fixture: tracked a/b, a/c, a/x/y, real/b, `top`;
  `a` replaced by a regular file).
- Rows: R14 (`add a/b` → `removed` `['a/b']`, exit 0), R13 (`add a a/b` → `added` `['a']`,
  `removed` `['a/b', 'a/c', 'a/x/y']`); P1d (plan pin: `a`@1 @2 @3 with a/b, a/c at stage 0,
  `a` a regular file, `add a/b a` → `removed` `['a/b']`, a/c dropped silently, `REUC` `a`; it
  exercises Part 10's demotion through the walk this probe change opens); regressions N1 (`add a/b` with `renormalize` →
  `NOT_A_DIRECTORY`), N2 (`add a` with `renormalize` → `NOT_A_DIRECTORY`).

### TDD steps

1. RED — R14, R13 and P1d, unit + interop (git exits 0; compare `snapshot` or `lsStage`, and
   `removed`). Fail: the probe's `lstatOrMissing` throws `NOT_A_DIRECTORY`.
2. GREEN — catch that one code in the probe.
3. GUARD — N1, N2 still throw `NOT_A_DIRECTORY` (assert `err.data.code`); a probe `lstat` that
   throws `PERMISSION_DENIED` (wrap `ctx.fs` in a `Proxy` as `staleLockCtx` does at add.test.ts:63,
   throwing `permissionDenied(path)` from src/domain/index.ts for the literal) still propagates
   with that code. Pass before and after.
4. REFACTOR.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-directory-file.test.ts test/integration/add-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): stage the removal of a path beneath a regular file`

## Part 13 — Let an exact exclusion leak onto a multi-stage unmerged path on the walk

### Context

- Edit `src/application/commands/add.ts`:
  - `withPathspec(ignore, matcher)` (643) gains the unmerged lookup: a leaf is kept when
    `matchesPathspec(matcher, path)` (unchanged early return, so a matched leaf pays nothing) or
    when `unmergedStages.get(keyOfPath(path))` exists and `matchesUnmergedPath(matcher, path,
    stages.length)` holds (Part 8). An unmatched leaf pays one lookup in a map that is empty on a
    merged index.
  - `stageIgnoredWalk` (620) reads `readExistingEntries` first and builds the filter from it:
    it takes `repoIgnore` and `matcher` instead of the combined predicate; `addByPathspec` (466)
    stops building `combinedIgnore` itself.
  - The leaked path then flows through `processWalkEntry` as any unmerged path: staged at stage
    0, in `modified` (Part 5), recorded in `REUC` (Part 7). The fast path's staging (O3),
    `collectMatchedRemovals` (O2) and `addAll` (no pathspec) are not touched.
- Edit `test/unit/application/commands/add-unmerged.test.ts` and
  `test/integration/add-unmerged-interop.test.ts` (Part 4 merge fixture, conflicted path `F` per
  row: `f`, d/f or `f.txt`; MD12 for D1; S1 = `f` at stage 3 only and modified, seeded with
  `update-index --index-info` after the base commit).
- Rows (design §D1.5): leaks D0 (`. !f`), D1 (MD12), D4 (`d !d/f`), D7 (`*.txt !f.txt`), D8
  (`f* !f`), E1 (`f . !f`), interop-only D16 (git `:(exclude)f`, tsgit `!f`), E8 (git `:!./f`,
  tsgit `!f`), E10 (git `:(exclude,literal)f.txt`, tsgit `!f.txt`) — `F`@0, `modified` contains
  `F`, `REUC` `F`; shields D5 (`. !d`), D6 (`. !*.txt`), E3 (`. !f*`), E4 (`. !d/`), E7 (`. !f
  !f*`), S1 — every stage kept, no `REUC`. Not asserted: D2, E9 (spellings tsgit lacks), D3
  (ADR-038), E5 (no pathspec on `all`), D9, E6, D15 (O3), D12, D13 (O2), R12g, R12gd (O7).

### TDD steps

1. RED — D0, D1, D4, D7, D8, E1 (unit) and the nine leak rows (interop): `F` staged at stage 0,
   reported in `modified`, `REUC` for `F` equal to git's. Fail: `withPathspec` filters the
   excluded leaf out of the walk, so `F` keeps its stages.
2. GREEN — index read before the filter; unmerged lookup in `withPathspec`.
3. GUARD — D5, D6, E3, E4, E7, S1 (unit + interop): every stage kept, no `REUC`. Pass before
   and after: a glob or leading-directory exclusion, or a single stage, still shields.
4. REFACTOR — `withPathspec` and `stageIgnoredWalk` < 20 lines.

### Gate

```sh
PATH=<git-2.55-bin>:$PATH npx vitest run test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add.test.ts \
  && PATH=<git-2.55-bin>:$PATH npx vitest run --project integration test/integration/add-unmerged-interop.test.ts test/integration/add-interop.test.ts \
  && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add-unmerged.test.ts test/integration/add-unmerged-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(add): stage an unmerged path an exact exclusion names when another element covers it`

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-P1 | Beneath entries of an inserted path whose prior entry is **unmerged** (plan-time pins P1-P6) | **A** Fold the inferred rule on every route: reported iff `withoutExactly(matcher, P)` matches (Parts 9, 10). **B** Fold the fast path only (always silent there, P1/P1b/P4 `add a`); the walk rows P1c, P1d stay divergent and are listed out of scope. **C** Follow the design as written (report on every route): P1, P1b, P1c, P1d diverge. | **A** (the plan implements A) | ADR-226 binds the observable index and reported removals; A matches every pinned row (P1-P6 and the R1 contrast set) with one predicate Part 8 already ships. Its rule is inferred from rows, not from git's source, like ADR-1000's. B is the minimal certain subset if the user wants no inferred rule on the walk. |
| DC-P2 | Where the resolve-undo merge plugs into the index write (design §D8.2 left the existing `Stryker disable` guard in `carriedExtensions` to the implementer) | **A** New domain `withResolveUndo(carried, previous, resolved, digestLength)` in carry-extensions.ts applied to `carriedExtensions`' result; the guard line and its existing equivalence note stay byte-identical; `carryExtensions` keeps its signature. **B** Design literal: `carryExtensions(…, resolved)` 5th parameter, and the guard changes so an extension-less index still gets a fresh `REUC` — that edits the line under an existing suppression comment (its proof text no longer holds as worded) and sweeps ~24 test call sites. | **A** (the plan implements A) | No suppression line touched, no mechanical test sweep, the `REUC` policy still lives in the domain carry module (ADR-965). Every new conditional in A has a killing test (V13 vs V1, V9, V14). |

Settled before this plan (design §Decision candidates): DC1-DC10, O1, O5, all via ADR-990 … ADR-1000.

## Out of scope (proven, not acted on)

- O2, O3, O4, O6, O7 as listed in the design §Out of scope; M7b, M7c, D12, D13, D14 stay divergent.
- With DC-P1 = B: P1c, P1d stay divergent (walk `add a d` / `add a/b a` with an unmerged `a`).
