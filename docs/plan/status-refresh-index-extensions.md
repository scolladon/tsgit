# Plan — `status` refresh write-back, stat-cache arming, index extension carry

> Source: design doc `docs/design/status-refresh-index-extensions.md` (rev. 6e674e8d) · ADRs 958, 959, 960, 961, 962, 963, 964, 965, 966, 967
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

<!-- cspell:ignore backticked handback misordered ENOSPC pgrep bytewise refreshable deadbeef REUC UNTR ZZZZ IEOT EOIE FSMN untrackedcache sdir realise -->

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

## Planning decisions (taken here, binding on the parts)

- **`IndexLock.commit(entries, kind)` migration is staged, never one-shot.** Part 7 adds
  `kind?: IndexWriteKind` as an OPTIONAL second parameter; `undefined` keeps today's
  behaviour (`extensions: []`), a defined kind carries extensions. Parts 8–12 migrate all 28
  `src/` call sites (and pre-migrate the test-seed call sites they touch). Part 13 makes
  `kind` required and deletes the `undefined` branch. Every commit type-checks
  (`noUnusedParameters` is on, which is why the parameter only lands together with the code
  that reads it). A one-shot migration is 18 `src` modules + 7 test files and breaches the
  6-file part ceiling.
- **Public vs internal, per new symbol.**
  - PUBLIC: `StatusOptions` (+ `refresh`) and the new `status(ctx, opts?)` signature
    (Part 19: barrel src/application/commands/index.ts, facade src/repository.ts,
    docs/use/commands/status.md, reports/api.json). The new error code
    `ENV_BAD_BOOLEAN_VALUE` (Part 18: `TsgitErrorData` is public; exhaustiveness switch,
    docs/use/errors.md row; its api.json delta is regenerated in Part 19). The added
    optional `indexMtime` parameter of the already-public `compareWorkingTreeEntry`
    (Part 16 regenerates reports/api.json). The TSDoc of the already-public
    `compareEntryPath` (Part 1 regenerates reports/api.json).
  - INTERNAL (no barrel entry, imported by direct module path the way
    domain/git-index/path-validator.ts is): `cache-tree.ts`, `diff-index-entries.ts`,
    `carry-extensions.ts` and every symbol in them (`serializeCacheTree`,
    `invalidateCacheTree`, `diffIndexEntries`, `IndexChange`, `carryExtensions`,
    `CarryKind`); `IndexWriteKind`, `commitRefresh`, `acquireOptionalIndexLock`
    (primitives/internal); `compareAndRefresh`, `RefreshedComparison`, `ComparisonScope`
    (NOT added to the primitives barrel); `withStatData`; `hasRacyTimestamp`;
    `readPreviousIndex`; `inIndexOrder`/`configuresFilterDriver` moved to clean-order.ts.
    Reason: src/domain/index.ts and src/application/primitives/index.ts are typedoc entry
    points and package subpaths, so a barrel entry would make each of them public API and
    add bytes to near-capped size budgets.
- **Interop and bench parts stay standalone (Parts 23–25).** They are harness suites with
  no `src/` delta. The status-refresh interop spans Parts 13–19, the extension interop
  spans Parts 7–13, and folding either into one shipping part breaches the 6-file ceiling.
  The path-order interop twin is folded into Part 1, which ships that behaviour.
- **`commitRefresh` owns its own degrade** (Part 14): it never rejects for a failure at a
  refresh-write site; it releases, warns and resolves `false`. `status` only decides
  whether to call it. Same observable behaviour as design §D2.3–§D2.4, one catch site.
- **`TREE` is faithful per writer (session ruling on DC-P2, ADR-226 + ADR-964).** git's
  `add_index_entry_with_check` calls `cache_tree_invalidate_path` for every entry `add`
  re-stages, whatever its oid; `add_file_to_index` skips the re-stage only when `ie_match_stat`
  says the stat matches and renormalize is off. So `IndexLock.commit` gains an optional third
  parameter `{ restagedPaths?: ReadonlyArray<FilePath> }` (options object, applied to `'update'`
  only); the carry invalidates `diffIndexEntries(…).changedPaths ∪ restagedPaths`.
  `diffIndexEntries` stays id/mode-only (that keeps the pinned `checkout -- x/y` row: `TREE`
  same). Only `add`'s four sites pass `restagedPaths` (Part 8): every path add rebuilt the entry
  for (stat mismatch, new path, and under renormalize every re-cleaned path); stat-matched
  skipped paths are left out. Pinned results: `touch b; add b` → `<root>:-1`, rest valid;
  `add --renormalize .` with no content change → every directory invalidated; `add b` with the
  stat unchanged → `TREE` bytes unchanged. Part 24 pins exact git `TREE` bytes for the add rows.
- **`smudgeRacilyClean` takes the previous index as a parameter** (Part 7) instead of
  keeping its own read as a fallback: the lock's `commit` is its only `src` caller, so a
  fallback read would be test-only code. Tests read the previous index through the same
  exported `readPreviousIndex`.

## Decision candidates (not pre-decided by ADRs 958–967; session rulings 2026-10-14: DC-P1 (a), DC-P3 (a), DC-P4 as written; DC-P2 ruled, see §Planning decisions)

| # | Choice | Alternatives | Recommendation |
|---|---|---|---|
| DC-P1 | Error code for an invalid `GIT_OPTIONAL_LOCKS` | (a) new `ENV_BAD_BOOLEAN_VALUE { variable, value }`, message `bad boolean environment value '<value>' for '<variable>'` (git's exact `git_env_bool` die text); (b) reuse `CONFIG_BAD_BOOLEAN_VALUE { key, source, value }` with `source: 'environment'` — wrong message (`bad boolean config value … in file …`) and a fake file source | (a). Plan Part 18 implements (a). |
| DC-P3 | ADR-967 realisation: how the "no filter section" verdict reaches the comparator | (a) internal `compareAndRefresh(ctx, entry, scope)` takes a `ComparisonScope { provider?, indexMtime?, filterDriversConfigured? }`; `resolveConversion` gains `{ filterDriversConfigured?: boolean }`; status computes it once; (b) memo inside `resolveConversion` keyed on the `ParsedConfig` object (helps every caller but still pays a `readConfig` stat per file); (c) a fifth positional boolean (boolean-parameter smell) | (a). It deviates from design §D2.1's positional `compareAndRefresh` signature; the public `compareWorkingTreeDelta`/`compareWorkingTreeEntry` keep their positional shape. Parts 16 and 20 implement (a). |
| DC-P4 | Size budgets (.size-limit.json, browser bundle limit 329.3 kB, little headroom per project memory) if the new code pushes a bundle over | (a) raise the affected caps by the measured delta, with user approval; (b) find offsetting savings in the same PR; (c) both | Decide when measured. Part 25 runs `npm run check:size` and hands back `{ unit, reason, options }` with the per-row deltas if red; no part bumps a cap on its own. |

## Shared-file rationale (plan-lint cognitive-locality warnings)

- reports/api.json (Parts 1, 16, 19): regenerated by each part that changes a public TSDoc or signature, at the commit that changes it (prepush gate).
- src/application/primitives/internal/index-lock.ts (Parts 7, 13, 14): carry (7), required kind + refresh-only commit (13), optional lock + degrade (14) — one part would exceed 5 RED→GREEN cycles, and Part 13 can only land after every caller migrated (Parts 8–12).
- src/application/commands/status.ts (Parts 17, 19, 20, 22): refresh lifecycle, public option, filter-driver skip, helper move — sequential layers on one central file, each with its own test file.
- src/application/primitives/compare-working-tree-entry.ts and its test (Parts 16, 20): refresh verdict vs the ADR-967 scope flag (DC-P3); merging breaches the 6-file ceiling.
- src/application/commands/rm.ts (Parts 8, 21) and src/application/commands/stash.ts (Parts 12, 22): write-kind migration vs stat-cache arming/pooling — unrelated concerns that only share the module.

## Shared context (every part reads this first)

- Worktree: the repo root of this branch (`feat/status-refresh-index-extensions`). Implementers
  have NO MCP tools (no serena, no graft): use the exact paths and symbols in the part.
- Test conventions: `describe('Given …')` > `describe('When …')` > `it('Then …')` (the 2-level
  `Given …, When …` shortcut only with a single `it`), AAA comments, system under test in
  `sut`. Error assertions read `err.data` field by field (try/catch), never `toThrow(Class)`.
  No `v8 ignore`/`istanbul ignore`/`stryker-disable`/`biome-ignore`/`@ts-ignore` added; existing
  `Stryker disable` lines on code you move stay with that code, obsolete ones go with the code
  they described. No phase/ADR/backlog numbers in `src` or test code.
- Memory adapter: `createMemoryContext()` (src/adapters/memory/memory-adapter.ts, accepts
  `{ env }`); file times come from `Date.now()` at write, second resolution, no `mtimeNs`.
  Tests control time with `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(ms)`
  (precedent: test/unit/application/primitives/internal/smudge-racily-clean.test.ts:49).
  "Touch" = rewrite the same bytes after advancing the clock. A logger is injected by
  spreading: `{ ...ctx, logger: { warn: vi.fn() } }`; env by `createMemoryContext({ env: { get: (n) => … } })`.
- Type-check: `npm run check:types` (wireit; "skipped 1" means inputs unchanged). When in doubt
  run the bare `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit -p tsconfig.typecheck.json`.
  Spelling: `npm run check:spelling`, bare `npx cspell --no-progress <files>`.
- Interop runs use git 2.55.0 (local git is 2.56; goldens target 2.55): prefix with
  `PATH=<git-2.55.0-bin>:$PATH`, where `<git-2.55.0-bin>` is the session-provided git 2.55.0
  `bin` directory (under the user's home, `.local/git-2.55.0/bin`).
- Standing rules, every part:
  1. When an existing test row breaks, decide whether the OLD expectation encoded the contract.
     If it did, fix the code, not the row, and say so in the handback.
  2. `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse
     NOT_A_DIRECTORY use the throwing helpers.
  3. Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a
     scripted edit before trusting a gate.
  4. Poll, never end your turn waiting on a background notification.
  5. Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).
  6. Every gate is chained with `&&` and its exit status read; never pipe a gate through
     `tail`/`head`; never commit on red; never `--no-verify`.

## Part 1 — Bytewise index entry order (comparator, property, interop twin)

### Context
- Edit `src/domain/git-index/index-writer.ts`: `export function compareEntryPath(a: IndexEntry, b: IndexEntry): number` (lines 42-47) compares with JS `<`, i.e. UTF-16 code-unit order. `serializeIndex(index, digestLength)` sorts with it (line 51). Design §D5, ADR-966: compare code units; at the FIRST differing unit map each unit `u >= 0xD800` with `u >= 0xE000 ? u - 0x800 : u + 0x2000` (surrogates then sort after E000–FFFF, which is UTF-8 byte order); a strict prefix sorts first; equal → 0. No allocation (no `TextEncoder`). Update its TSDoc ("byte-sorted" is now true).
- Hot path (sort of every index write; memory: hot-path perf over simplicity). Probe before/after with a throwaway script in the session scratchpad (not committed): sort 20 000 realistic paths (shared `src/application/...` prefixes) with old vs new comparator, 5 runs each, report medians in the handback. If the new one is >10 % slower, keep the loop but start it at the common-prefix fast path you measure best; behaviour is fixed by the property.
- `compareEntryPath` is exported through src/domain/git-index/index.ts (line 20) → src/domain/index.ts, a typedoc entry point: the TSDoc change makes `reports/api.json` stale. Regenerate with `npm run docs:json` and commit it.
- Tests: extend `test/unit/domain/git-index/index-writer.test.ts`; create `test/unit/domain/git-index/index-writer.properties.test.ts` (sibling, per .claude/workflow/property-testing.md: 200 runs, `fc.string({ unit: 'binary' })` — fast-check 4.10.2 has no `fullUnicodeString`; oracle = `compareBytes(encode(a), encode(b))` from src/domain/objects/encoding.ts lines 35 and the `encode` export, both independently tested). Build entries with the arbitraries in test/unit/domain/git-index/arbitraries.ts or a local minimal `IndexEntry` factory.
- Interop twin: extend `test/integration/index-interop.test.ts` (header `@proves surface: index`; helpers `git`, `runGit`, `makePeerPair`, `GIT_AVAILABLE` from test/integration/interop-helpers.ts). Row: files `😀.txt` (U+1F600, content `a`) and `�.txt` (content `b`) added by tsgit `add` → `git ls-files -s` lists `�.txt` first, equal to git's own `add` of the same files in the peer repo; `git fsck` exits 0. Today git refuses with `fatal: unordered stage entries in index` (design §D1.7).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — index-writer.test.ts `Given entries named U+FFFD.txt and 😀.txt` / `When serializeIndex orders them` / `Then U+FFFD.txt is written first`; plus `When compareEntryPath('�.txt', '😀.txt')` / `Then it is negative`. Fails: `<` puts `😀.txt` (0xD83D) before `�.txt` (0xFFFD) and returns +1.
2. RED — properties: `Given arbitrary strings a, b` / `Then sign(compareEntryPath) equals sign(compareBytes(utf8(a), utf8(b)))`. Fails on any surrogate-vs-E000–FFFF pair (fast-check shrinks to one).
3. GREEN — the code-unit loop with the surrogate fix-up at the first difference; prefix rule by length.
4. GUARD — existing index-writer.test.ts ordering rows (ASCII, prefix `a` < `a/b` < `ab`) pass unchanged: ASCII and BMP-below-D800 order is untouched.
5. RED — interop row (git 2.55.0 on PATH). Fails before step 3 lands (`git fsck` exit 128). After step 3 it passes; run it to confirm.
6. REFACTOR — TSDoc of `compareEntryPath`; `npm run docs:json`; run the perf probe and record medians.

### Gate
`npx vitest run test/unit/domain/git-index/index-writer.test.ts test/unit/domain/git-index/index-writer.properties.test.ts && PATH=<git-2.55.0-bin>:$PATH npx vitest run --project integration test/integration/index-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/index-writer.ts test/unit/domain/git-index/index-writer.test.ts test/unit/domain/git-index/index-writer.properties.test.ts test/integration/index-interop.test.ts && npm run check:spelling`

### Commit
`fix(index): order index entries by UTF-8 bytes`

## Part 2 — Align the in-memory pre-sorts on the bytewise comparator

### Context
- Three pre-sorts still use UTF-16 `<` and hand misordered arrays to merge-joins and to the writer (design §D5):
  - `src/application/primitives/build-index-from-tree.ts` — `const byPath` (lines 131-133, with a now-obsolete `Stryker disable` line inside) used at line 151 `entries.sort(byPath)`. Replace with `compareEntryPath` (import from src/domain/git-index/index-writer.ts or the git-index barrel) and delete `byPath` plus its comment block (lines ~123-130) — the "leaves arrive byte-sorted, sort is a no-op" claim is false for non-BMP names.
  - `src/application/primitives/materialize-tree.ts` line 170 `merged.sort((a, b) => (a.path < b.path ? -1 : 1))` (with the `Stryker disable` line 169 and comment 163-168) → `merged.sort(compareEntryPath)`; line 193 `sortIndexEntries` already uses `compareEntryPath`.
  - `src/application/primitives/apply-merge-to-worktree.ts` lines 292-298 `combined.sort(...)` → `compareEntryPath(a, b) || a.flags.stage - b.flags.stage` (keep the stage tiebreak and its existing `Stryker disable … ArithmeticOperator` line; the `>` branch and its disable line disappear).
- Tests to extend: `test/unit/application/primitives/build-index-from-tree.test.ts`, `test/unit/application/primitives/materialize-tree.test.ts`, `test/unit/application/primitives/apply-merge-to-worktree.test.ts` (each already builds memory repos with trees; reuse their local builders). Names: `😀.txt` and `�.txt` in one tree (git tree order puts U+FFFD first).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — build-index-from-tree.test.ts: `Given a tree holding U+FFFD.txt and 😀.txt` / `When buildIndexFromTree` / `Then the entries come back U+FFFD.txt first`. Fails: `byPath` re-sorts the walk to `😀.txt` first.
2. GREEN — `entries.sort(compareEntryPath)`; delete `byPath` and its obsolete comments.
3. RED — materialize-tree.test.ts: same names, `materializeTree` result `newIndexEntries` order. Fails: line 170's `<`.
4. GREEN — `merged.sort(compareEntryPath)`.
5. RED — apply-merge-to-worktree.test.ts: a clean merge adding both names → result index entries U+FFFD first; plus a conflicted path keeps stage 1, 2, 3 order. Fails: line 292's `<` (the stage row is a GUARD).
6. GREEN — bytewise comparator with the stage tiebreak.

### Gate
`npx vitest run test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/build-index-from-tree.ts src/application/primitives/materialize-tree.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/application/primitives/build-index-from-tree.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts && npm run check:spelling`

### Commit
`fix(index): sort in-memory index entries bytewise before writing`

## Part 3 — Cache-tree serializer

### Context
- Create `src/domain/git-index/cache-tree.ts` (internal: NOT added to src/domain/git-index/index.ts). Export `serializeCacheTree(root: CacheTreeEntry, digestLength: 20 | 32): Uint8Array` — exact inverse of `parseCacheTree(data, digestLength)` in src/domain/git-index/index-parser.ts (lines 240-365): per node `path` bytes, NUL, ASCII `"<entryCount> <subtreeCount>\n"`, then the raw oid (`digestLength` bytes, `hexToBytes(id)`) only when `entryCount >= 0`, then the children depth-first in the given order (git's on-disk subtree order, which the parser preserves). `CacheTreeEntry` is in src/domain/git-index/index-entry.ts lines 52-58. Use `encode`/`hexToBytes` from src/domain/objects/encoding.ts; pre-size one `Uint8Array` (two passes: measure, then write) rather than concatenating.
- Module header: mirror the `@writes` docblock of src/domain/git-index/index-writer.ts (`surface: index`, `kind: equivalent-under-readback`, `format: git-index-dirc`) — the serializer emits index bytes and the index surface already has interop coverage.
- Tests: create `test/unit/domain/git-index/cache-tree.test.ts` (examples, both widths) and `test/unit/domain/git-index/cache-tree.properties.test.ts` (round trip, 200 runs, w ∈ {20, 32}). Edit `test/unit/domain/git-index/arbitraries.ts`: `arbCacheTreeEntry(depth = 3)` (line 209) uses `arbObjectId()` (40 hex only) — add a `hexLength: 40 | 64 = 40` parameter threaded to `arbObjectId(hexLength)` (test/unit/domain/objects/arbitraries.ts line 16 already takes it). Example bytes: the test-local encoder in test/unit/domain/git-index/cache-tree-parser.properties.test.ts lines 23-31 shows the grammar.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — cache-tree.test.ts `Given a root with one valid subtree d and an invalidated subtree x` / `When serializeCacheTree at width 20` / `Then the bytes equal the literal encoding` (spell the bytes: `"\0" "3 2\n" <20 oid bytes> "d\0" "2 0\n" <oid> "x\0" "-1 0\n"`). Fails: module does not exist.
2. GREEN — two-pass serializer.
3. RED — same tree at width 32 → 32-byte oids. Fails if step 2 hard-coded 20; if step 2 already threads `digestLength`, record it as a GUARD instead.
4. RED — properties: `parseCacheTree(serializeCacheTree(t, w), w)` deep-equals `t` for `arbCacheTreeEntry(3, 40)` with w=20 and `arbCacheTreeEntry(3, 64)` with w=32. Fails until `arbCacheTreeEntry` takes `hexLength` (type error / 40-hex ids at width 32).
5. GREEN — `hexLength` parameter in arbitraries.ts.

### Gate
`npx vitest run test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts test/unit/domain/git-index/cache-tree-parser.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/cache-tree.ts test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts test/unit/domain/git-index/arbitraries.ts && npm run check:spelling`

### Commit
`feat(index): serialize the cache-tree extension`

## Part 4 — Cache-tree invalidation along changed paths

### Context
- Edit `src/domain/git-index/cache-tree.ts`: add `invalidateCacheTree(root: CacheTreeEntry, paths: ReadonlyArray<FilePath>): CacheTreeEntry` — transcription of git's `do_invalidate_path` (cache-tree.c): for each path, walk components from the root; every node on the chain from the root to the path's parent gets `entryCount: -1` and no `id` (omit the key; `exactOptionalPropertyTypes` is on); recurse into a child only when a subtree with that component name exists (stop otherwise); at the LAST component, if a subtree of that exact name exists (a directory replaced by a file, or deleted) remove it and decrement `subtreeCount`. Untouched subtrees are returned as the SAME object (`toBe`). No mutation; FilePath is `/`-separated. An empty `paths` returns `root` itself.
- Invariant this part must prove (ADR-623, ADR-964): after invalidation, no node with `entryCount >= 0` covers a changed path. Only git-written or untouched oids survive.
- Tests: extend `test/unit/domain/git-index/cache-tree.test.ts` and `test/unit/domain/git-index/cache-tree.properties.test.ts`. Example rows from design §D1.5, base tree `<root>:5/2 d:2/1 e:1/0 x:1/0` (`e` under `d`): `add d/c` → `<root>:-1 d:-1 e:valid x:valid`; `add d/e/n` → `<root>:-1 d:-1 e:-1 x:valid`; `rm` of a directory name `x` (path `x`) → `x` subtree removed, root `subtreeCount` 1; `mv b d/b2` → paths `b` and d/b2 → `<root>:-1 d:-1`, `e`,`x` same objects.
- Properties (100 runs): for arbitrary trees and arbitrary path lists built from the tree's own component names plus random ones: (1) invariant above; (2) a subtree no path enters is `toBe` the input's; (3) idempotence `inv(inv(t, p), p)` deep-equals `inv(t, p)`; (4) serialize→parse of the result round-trips at width 20.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — `Given the base tree` / `When invalidateCacheTree(['d/c'])` / `Then root and d are -1 without id, e and x are the same objects`. Fails: function not exported.
2. GREEN — chain invalidation with structural sharing.
3. RED — `When invalidateCacheTree(['x'])` (x is a subtree name) / `Then x is removed and root subtreeCount is 1`. Fails: step 2 only invalidates the chain.
4. GREEN — last-component subtree removal.
5. RED — `When invalidateCacheTree(['b', 'd/b2'])` with an extra path whose directory has no node (`q/r`) / `Then only the root and d chains are invalidated and no node is created`. Fails only if step 2 created nodes; otherwise a GUARD.
6. GUARD — properties file additions (invariant, sharing, idempotence, round trip). Expected green on first run against steps 2–4; a red property is a real bug: fix the code, not the property.

### Gate
`npx vitest run test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/cache-tree.ts test/unit/domain/git-index/cache-tree.test.ts test/unit/domain/git-index/cache-tree.properties.test.ts && npm run check:spelling`

### Commit
`feat(index): invalidate the cache-tree along changed paths`

## Part 5 — Index entry diff for extension carry

### Context
- Create `src/domain/git-index/diff-index-entries.ts` (internal, no barrel): `export interface IndexChange { readonly changedPaths: ReadonlyArray<FilePath>; readonly trackedSetChanged: boolean; readonly resolvedUnmerged: boolean }` and `export const diffIndexEntries = (before: ReadonlyArray<IndexEntry>, after: ReadonlyArray<IndexEntry>): IndexChange`.
  - Sort COPIES of both lists by `compareEntryPath` (bytewise since Part 1, no allocation) then `flags.stage`: an older tsgit wrote UTF-16 order and callers pass unsorted lists. Then one O(n) merge-join, no Map.
  - `changedPaths`: every path whose (path, stage) is present on one side only, or present on both with a different `id` or `mode`. Each path once, in bytewise order. Flags and stat data are ignored (a sparse-checkout flag flip is not a change — §D1.5 `sparse-checkout` row).
  - `trackedSetChanged`: the SET of paths (any stage) differs.
  - `resolvedUnmerged`: some path has a stage > 0 entry before and only a stage-0 entry after.
- Tests: create `test/unit/domain/git-index/diff-index-entries.test.ts` and `test/unit/domain/git-index/diff-index-entries.properties.test.ts` (arbitraries from test/unit/domain/git-index/arbitraries.ts: `arbIndexEntry`, `arbFilePath`). Properties (100 runs): `changedPaths` empty iff both lists agree on the set of (path, stage, id, mode); `trackedSetChanged` symmetric under swapping before/after; result independent of input order (shuffle both lists); `diff(x, x)` is all-empty/false.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — `Given before [a, d/c] and after [a, d/c'] (new id)` / `When diffIndexEntries` / `Then changedPaths is [d/c] and trackedSetChanged is false`. Fails: module missing.
2. GREEN — sorted copies + merge-join on (path, stage), id/mode compare.
3. RED — `Given after adds d/e/n and drops a` / `Then changedPaths [a, d/e/n] and trackedSetChanged true`. Fails if step 2 only compared shared keys; else GUARD.
4. RED — `Given before has stages 1,2,3 for m and after stage 0 for m` / `Then resolvedUnmerged true and changedPaths [m]`. Fails: flag not computed.
5. GREEN — `resolvedUnmerged`.
6. RED — `Given unsorted inputs (UTF-16 order: 😀.txt before U+FFFD.txt) with only a stat change` / `Then nothing changed`. GUARD if steps 2–5 already sort; record which.
7. Properties file (GUARD on first run expected; a failure is a real bug — fix the code).

### Gate
`npx vitest run test/unit/domain/git-index/diff-index-entries.test.ts test/unit/domain/git-index/diff-index-entries.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/diff-index-entries.ts test/unit/domain/git-index/diff-index-entries.test.ts test/unit/domain/git-index/diff-index-entries.properties.test.ts && npm run check:spelling`

### Commit
`feat(index): diff index entry lists by path, stage, id and mode`

## Part 6 — Extension carry policy and `core.untrackedCache`

### Context
- Create `src/domain/git-index/carry-extensions.ts` (internal): `export type CarryKind = 'refresh' | 'update' | 'replace'`; `export const NO_INDEX_CHANGE: IndexChange` (empty, false, false — what `refresh` uses); `export const carryExtensions = (previous: ReadonlyArray<IndexExtension>, change: IndexChange, kind: CarryKind, settings: { readonly untrackedCache: boolean | undefined; readonly digestLength: 20 | 32 }): ReadonlyArray<IndexExtension>`. Table (design §D4.2, ADRs 963/964/965), output order `TREE`, `REUC`, `UNTR`, everything else dropped (`EOIE`, `IEOT`, `FSMN`, unknown like `ZZZZ`):
  - `TREE`: `refresh` verbatim (same object). `update`/`replace`: `parseCacheTree(data, digestLength)` → `invalidateCacheTree(root, change.changedPaths)` (Part 4) → `serializeCacheTree` (Part 3); when `changedPaths` is empty return the previous extension object (no re-serialise). A parse failure (`errorDataCode(err) === 'INVALID_INDEX_ENTRY'`, helper in src/domain/error-data-code.ts) drops `TREE`; any other error rethrows.
  - `REUC`: `refresh` verbatim; `update` verbatim unless `change.resolvedUnmerged`; `replace` dropped.
  - `UNTR`: dropped whenever `settings.untrackedCache === false`; else `refresh` verbatim; `update`/`replace` verbatim iff `!change.trackedSetChanged`.
  - `previous` empty → `[]` early (hot path: tsgit-written indexes carry nothing).
  - Also export `withRestagedPaths(change: IndexChange, restagedPaths: ReadonlyArray<FilePath>): IndexChange` — `changedPaths` becomes the de-duplicated union (bytewise order), the two flags unchanged; an empty `restagedPaths` returns `change` itself. Part 7 applies it for `'update'` writes (§Planning decisions, `TREE` faithful per writer).
  - Imports: `IndexChange` from `diff-index-entries.ts` (Part 5), `parseCacheTree` from src/domain/git-index/index-parser.ts, `IndexExtension` from src/domain/git-index/index-entry.ts. Signatures as named constants (`TREE_SIGNATURE = 'TREE'` …).
- Config: edit `src/application/primitives/config-read.ts` — add `readonly untrackedCache?: boolean` to `ParsedConfig['core']` (type at lines ~58-115) and to `MutableCore` (line ~1463), finalize it in `finalizeCoreIdentityFields` (line ~2357), and parse `core.untrackedCache` in the `[core]` entry handling (`applyCoreBooleanEntry` area, lines ~1631-1670). git 2.55 `prepare_repo_settings`: the LAST value wins; a value `git_parse_maybe_bool` accepts sets true/false; `keep`, any other non-boolean, and a valueless key leave the default (keep) — i.e. UNSET the field (as `applyCoreEol` does for `eol`), never refuse. Do NOT add it to `CORE_BOOLEAN_KEYS` (that set feeds refusal paths). Use `parseGitBoolean` from src/domain/config/config-ini.ts (line 845) but treat `null` (valueless) as unset before calling it.
- Tests: create `test/unit/domain/git-index/carry-extensions.test.ts` (cell by cell; build `TREE` payloads with `serializeCacheTree`, compare bytes with `toEqual` on `Uint8Array`, assert order and absence); extend `test/unit/application/primitives/config-read.test.ts` (find its `core` describe; rows true, false, `keep`, `bogus`, valueless, `false` then `keep` → unset, `keep` then `false` → false).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — `Given TREE, REUC, UNTR, ZZZZ, EOIE` / `When carryExtensions(…, NO_INDEX_CHANGE, 'refresh', { untrackedCache: undefined, digestLength: 20 })` / `Then TREE, REUC, UNTR come back as the same objects in that order and ZZZZ, EOIE are gone`. Fails: module missing.
2. GREEN — refresh column + fixed output order.
3. RED — `When … 'update'` with `changedPaths [d/c]` / `Then TREE bytes equal serializeCacheTree(invalidated)`, `REUC` kept, `UNTR` kept; second row `resolvedUnmerged` → `REUC` dropped; third row `trackedSetChanged` → `UNTR` dropped; fourth row corrupt `TREE` payload → `TREE` dropped, others kept. Fails: step 2 copies `TREE` verbatim for every kind.
4. GREEN — update column.
5. RED — `When … 'replace'` / `Then REUC dropped`, `TREE` invalidated, `UNTR` per tracked-set rule. Fails: step 4 keeps `REUC`.
6. GREEN — replace column.
7. RED — `untrackedCache: false` drops `UNTR` for each kind (three rows). Fails: no settings branch yet.
8. GREEN — the settings branch. Then RED → GREEN for config-read `core.untrackedCache` rows (fails: field undefined for `true`).
9. RED (SHA-256) — the `update` row at `digestLength: 32` with 64-hex oids. GUARD if green; record it.
10. RED — `withRestagedPaths({ changedPaths: [d/c] …}, ['b', 'd/c'])` → `changedPaths` `[b, d/c]` (each once), flags kept; `[]` → the same object; and `carryExtensions` of the result for `'update'` invalidates the root for `b` (git's `touch b; add b` row `<root>:-1`, rest valid). Fails: not exported.
11. GREEN — `withRestagedPaths`.

### Gate
`npx vitest run test/unit/domain/git-index/carry-extensions.test.ts test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/git-index/carry-extensions.ts src/application/primitives/config-read.ts test/unit/domain/git-index/carry-extensions.test.ts test/unit/application/primitives/config-read.test.ts && npm run check:spelling`

### Commit
`feat(index): extension carry policy per index write kind`

## Part 7 — Index lock commit carries extensions (kind optional) and shares the previous index with the smudge

### Context
- Edit `src/application/primitives/internal/index-lock.ts`. Today: `IndexLock { release, commit(entries) }` (lines 13-22); `makeLock` (lines 108-146) serialises `{ version: 2, entries: [...(await smudgeRacilyClean(ctx, entries))], extensions: [], trailerSha: new Uint8Array(0) }`, hashes, writes `index.lock`, renames, `invalidateIndexCache(ctx)`.
  - Add `export type IndexWriteKind = Exclude<CarryKind, 'refresh'>` (CarryKind from src/domain/git-index/carry-extensions.ts) with TSDoc: `'update'` = entries replaced in place (add, rm, mv, mixed reset, checkout paths, sparse-checkout, submodule add); `'replace'` = index rebuilt from a tree or a merge (checkout branch, reset --hard, merge family, stash, pull, clone, worktree add).
  - `commit: (entries, kind?: IndexWriteKind, options?: CommitOptions) => Promise<void>` (`kind` OPTIONAL in this part — see §Planning decisions); `export interface CommitOptions { readonly restagedPaths?: ReadonlyArray<FilePath> }`, honoured only when `kind === 'update'` (the change passed to the carry is `withRestagedPaths(diff, options.restagedPaths ?? [])`, Part 6); ignored for `'replace'`. Body: `const previous = await readPreviousIndex(ctx)`; entries ← `smudgeRacilyClean(ctx, entries, previous)`; extensions ← `kind === undefined || previous === undefined ? [] : carryExtensions(previous.extensions, diffIndexEntries(previous.entries, entries), kind, { untrackedCache: (await readConfig(ctx)).core?.untrackedCache, digestLength: ctx.hashConfig.digestLength })`. Skip `diffIndexEntries` when `previous.extensions` is empty (hot path). Factor the serialise→hash→write→rename→invalidate tail into one internal `writeLocked(…)` helper — Part 13's `commitRefresh` reuses it.
- Edit `src/application/primitives/internal/smudge-racily-clean.ts`: export `readPreviousIndex(ctx): Promise<GitIndex | undefined>` — `lstatIfReachable(ctx.fs, indexPath(ctx.layout.gitDir))` (src/application/primitives/internal/fs-probes.ts) → `undefined` when absent; `readIndexAt(ctx, stat)` (session cache serves it when the stat is unchanged); an `INVALID_INDEX_*` code → `undefined` (today's `entriesAsRead` rule, lines 37-48); any other error rethrows. Change `smudgeRacilyClean(ctx, entries, previous: GitIndex | undefined)`: `previous` (or its `indexMtime`) undefined → return `entries`; racy filter uses `previous.indexMtime`; `carriedOver` uses `previous.entries` (no second read). Delete `entriesAsRead` and the `lstat` in `racilyClean`.
- Behaviour change to accept: the previous index is now read on every commit (before: only when an entry was racy). A non-`INVALID_INDEX_*` read error now propagates from `commit`.
- Test helper (new) `test/unit/application/primitives/helpers/index-extensions.ts`: `UNKNOWN_EXTENSION` (`ZZZZ`, bytes de ad be ef), `UNTR_EXTENSION` (opaque bytes), `resolveUndoExtension(path, id, digestLength)` (git REUC record: path NUL, three octal mode strings each NUL-terminated, then one raw oid per non-zero mode — grammar in src/domain/git-index/resolve-undo.ts), `cacheTreeExtension(root, digestLength)`, `withIndexExtensions(ctx, extensions)` (read the on-disk index with `readIndex`, re-serialise with `serializeIndex` + `ctx.hash.hash` trailer, write, `invalidateIndexCache(ctx)`), `indexExtensionsOf(ctx)` (`invalidateIndexCache` then `readIndex`, map signature → data). Parts 8–13 and 24 reuse it.
- Tests: create `test/unit/application/primitives/internal/index-lock.test.ts` (the existing lock tests live in test/unit/application/commands/internal/index-update.test.ts and keep passing untouched: they call `commit([])` without a kind); update `test/unit/application/primitives/internal/smudge-racily-clean.test.ts` — every `sut(ctx, entries)` becomes `sut(ctx, entries, await readPreviousIndex(ctx))`, and its two `lock.commit([...])` seeds (lines 228, 263) pass `'update'`.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. REFACTOR (behaviour-preserving, GUARD-backed) — `readPreviousIndex` + new `smudgeRacilyClean` parameter; smudge tests migrated; all smudge rows and the index-update.test.ts rows stay green.
2. RED — index-lock.test.ts `Given an index carrying TREE, REUC, UNTR and ZZZZ` (memory repo, files `a`, d/c; `withIndexExtensions`) / `When commit(entries with d/c's id changed, 'update')` / `Then REUC and UNTR bytes are kept, ZZZZ is gone, TREE has root and d invalidated`. Fails: `commit` serialises `extensions: []`.
3. GREEN — previous read once, `carryExtensions` wired, `writeLocked` helper.
4. RED — `When commit(…, 'replace')` / `Then REUC is dropped and TREE is invalidated along d/c`. Fails only if step 3 hard-coded `'update'`; else GUARD.
5. GUARD — `When commit(entries)` with no kind / `Then no extension is written` (today's behaviour, the migration default).
6. RED — `Given core.untrackedCache=false` / `When commit(…, 'update')` with an unchanged tracked set / `Then UNTR is dropped`. Fails if step 3 did not read the config; else GUARD.
7. RED — `When commit(entries identical to the index, 'update', { restagedPaths: ['b'] })` / `Then TREE has the root invalidated and d, e, x untouched`; same call with `'replace'` → `TREE` bytes unchanged. Fails: the third argument is ignored.
8. GREEN — `CommitOptions` wired through `withRestagedPaths`.
9. RED (SHA-256) — `createMemoryContext` with the SHA-256 hash config (find the option in src/adapters/memory/memory-adapter.ts; precedent: grep `sha256` in test/unit) and a width-32 `TREE`/`REUC` → carried bytes intact. GUARD if green; record.

### Gate
`npx vitest run test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/unit/application/commands/internal/index-update.test.ts test/unit/application/primitives/read-index.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/index-lock.ts src/application/primitives/internal/smudge-racily-clean.ts test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/unit/application/primitives/helpers/index-extensions.ts && npm run check:spelling`

### Commit
`feat(index): carry index extensions through lock commits`

## Part 8 — In-place writers declare `'update'`: add, rm, mv, sparse-checkout

### Context
- Change per site `lock.commit(x)` → `lock.commit(x, 'update', { restagedPaths })` for add, `lock.commit(x, 'update')` for the others (design §D4.4, §Planning decisions `TREE` faithful per writer).
- `restagedPaths` in add.ts — the knowledge already exists: `stageFromStat` (line ~832) has exactly one skip, `if (previous !== undefined && restagesAsIs(previous, fresh, indexMtime)) return { entry: previous };` (lines 840-841; `restagesAsIs` lines 890-899 = `ie_match_stat` clean and same mode); every other return builds a fresh entry via `indexEntryFromStat`. So a path was re-staged iff its staged `entry !== previous` (object identity, no extra I/O). Make that explicit with a named helper (e.g. `wasRestaged(previous, entry)`) and collect at the four collection points: `stageLiterals` loop (lines 256-265, `addLiteralOnly`), `tallyWalkOutcomes` (lines ~603-620, `addByPathspec`; `WalkOutcome` gets the path through `outcome.entry !== existing.get(outcome.path)`), the `addAll` outcome loop (lines ~656-660), and `renormalizeEntries` (lines 518-538: every `isRecleaned` entry is rebuilt by `renormalizeOne`, so every re-cleaned path is re-staged). New paths are re-staged (no previous); `addAll`'s removed paths are already in the diff.
  - `src/application/commands/add.ts` — four sites: `addLiteralOnly` (line 213), `addByPathspec` (450), `addRenormalized` (486), `addAll` (669). Grep `lock.commit(` to confirm.
  - `src/application/commands/rm.ts` line 112.
  - `src/application/commands/mv.ts` line 122.
  - `src/application/commands/internal/apply-sparse-checkout.ts` line 218.
- Test (new) `test/unit/application/commands/index-carry-update-writers.test.ts`, one `describe` per command, built on the Part 7 helper test/unit/application/primitives/helpers/index-extensions.ts. Fixture per row: memory repo with files `a`, `b`, d/c, d/e/f, x/y, committed; then `withIndexExtensions(ctx, [cacheTreeExtension(<root>:5/2 d:2/1 e:1/0 x:1/0, 20), resolveUndoExtension('m', <any blob id>, 20), UNTR_EXTENSION, UNKNOWN_EXTENSION])` (any well-formed oids — carry checks structure, not oids). Assert with `indexExtensionsOf(ctx)` and `parseCacheTree`.
- Expected rows (design §D1.5): `add d/c` (modified) → root, d invalid; e, x valid; `REUC`, `UNTR` bytes kept; `ZZZZ` gone. `add d/e/n` (new) → root, d, e invalid; `UNTR` dropped (tracked set changed). `touch b; add b` (stat moved, same oid) → root invalid, d, e, x valid. `add b` with the stat unchanged (clock advanced so it is not racy) → `TREE` bytes unchanged. `add` with `renormalize` and no content change → every directory invalidated (root, d, e, x), `REUC` kept. `addAll` (the all/`-A` entry point; find its option name in add.ts) adding d/untracked → chain invalid, `UNTR` dropped. `rm d/c` → chain invalid, `UNTR` dropped. `mv b d/b2` → root, d invalid, `UNTR` dropped. `sparseCheckout` set (entry point in src/application/commands/sparse-checkout.ts) → `TREE` unchanged (flags only), `REUC` kept.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — the `add d/c`, `add d/e/n`, add-all and `add b` (stat unchanged) rows. Fail: `commit` without a kind writes no extension, so `REUC` is absent.
2. GREEN — `'update'` at the four add.ts sites (no `restagedPaths` yet).
3. RED — the `touch b; add b` and renormalize rows. Fail: a stat-only re-stage is not an id/mode change, so `TREE` keeps the root (and every directory) valid.
4. GREEN — `restagedPaths` collected at the four collection points and passed to `commit`. GUARD — `add b` with the stat unchanged still keeps the `TREE` bytes.
5. RED — rm and mv rows. Fail: `REUC` absent.
6. GREEN — rm.ts, mv.ts.
7. RED — sparse-checkout row. Fails: `REUC` absent.
8. GREEN — apply-sparse-checkout.ts. Run the full add/rm/mv/sparse-checkout unit suites (Gate) — a broken existing row follows standing rule 1.

### Gate
`npx vitest run test/unit/application/commands/index-carry-update-writers.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/internal/apply-sparse-checkout.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/rm.ts src/application/commands/mv.ts src/application/commands/internal/apply-sparse-checkout.ts test/unit/application/commands/index-carry-update-writers.test.ts && npm run check:spelling`

### Commit
`feat(index): add, rm, mv and sparse-checkout carry index extensions`

## Part 9 — reset, checkout and submodule add declare their write kind

### Context
- `src/application/commands/reset.ts`: `rebuildIndexFromCommit` line 147 → `'update'` (mixed reset); `hardResetFromCommit` line 201 → `'replace'`.
- `src/application/commands/checkout.ts`: `switchBranch` line 265 → `'replace'`; `materializePathRestoreLocked` line 419 → `'update'`.
- `src/application/commands/submodule.ts`: `stageSubmodule` line 633 → `'update'`.
- Pre-migrate the test seeds (OPTIONAL `kind` still accepts them): `test/unit/application/commands/submodule-add.test.ts` lines 85 and 313, `test/unit/application/commands/submodule-remote-shorthand-warning.test.ts` line 65 → `lock.commit([...], 'update')`.
- Test (new) `test/unit/application/commands/index-carry-reset-checkout.test.ts`, same fixture and helper as Part 8 (test/unit/application/primitives/helpers/index-extensions.ts) plus a branch `other` that changes x/y and adds z/w. Rows (design §D1.5): mixed `reset` to the same HEAD → `TREE` and `REUC` unchanged, `ZZZZ` gone; mixed `reset HEAD~1` → chain of the changed path invalid, `REUC` kept; `reset --hard` → `REUC` dropped, `TREE` kept; `checkout other` → `REUC` dropped, root and x invalid, d valid, `UNTR` dropped (tracked set changed); `checkout -- x/y` after a worktree edit → `TREE` unchanged, `REUC` kept; `checkout other -- x/y` → root, x invalid, `REUC` kept; submodule add (reuse the fixture builders in test/unit/application/commands/submodule-add.test.ts) → `REUC` kept, `UNTR` dropped.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — reset rows. Fail: no extension written (`TREE`/`REUC` absent).
2. GREEN — reset.ts sites.
3. RED — checkout rows. Fail: no extension written.
4. GREEN — checkout.ts sites.
5. RED — submodule add row. Fails: `REUC` absent.
6. GREEN — submodule.ts; migrate the three test seeds; run the reset/checkout/submodule suites.

### Gate
`npx vitest run test/unit/application/commands/index-carry-reset-checkout.test.ts test/unit/application/commands/reset.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/submodule-add.test.ts test/unit/application/commands/submodule-remote-shorthand-warning.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/reset.ts src/application/commands/checkout.ts src/application/commands/submodule.ts test/unit/application/commands/index-carry-reset-checkout.test.ts test/unit/application/commands/submodule-add.test.ts test/unit/application/commands/submodule-remote-shorthand-warning.test.ts && npm run check:spelling`

### Commit
`feat(index): reset, checkout and submodule add carry index extensions`

## Part 10 — Merge and pull writers declare `'replace'`

### Context
- `'replace'` at: `src/application/commands/merge.ts` `materialiseAndApply` line 1008 and `underIndexLock` line 1672; `src/application/commands/pull.ts` `fastForwardWorkTree` line 446; `src/application/commands/internal/pull-into-void.ts` line 51; `src/application/commands/internal/reset-worktree.ts` line 38 (find its command caller with a grep for `resetWorktree`/the export name, and test through that command).
- Pre-migrate the seed in `test/unit/application/commands/pull.test.ts` line 264 (`'update'`).
- Test (new) `test/unit/application/commands/index-carry-merge-pull.test.ts`, Part 8 fixture/helper. Rows: fast-forward merge and true merge (clean) → `REUC` dropped, `TREE` carried with the changed chains invalid and untouched subtrees byte-identical, `ZZZZ` gone; conflicted merge → `REUC` dropped, conflicted chain invalid; pull fast-forward (reuse pull.test.ts's local-remote fixture) → same as ff merge; the reset-worktree caller → `REUC` dropped. pull-into-void writes into an unborn branch with no previous index in every reachable fixture: no observable carry — the change there is type-only (state it in the handback).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — merge rows (ff, clean, conflicted). Fail: `TREE` absent (no extension written).
2. GREEN — merge.ts sites.
3. RED — pull ff row and the reset-worktree caller row. Fail: `TREE` absent.
4. GREEN — pull.ts, reset-worktree.ts, pull-into-void.ts (type-only); migrate the pull.test.ts seed; run the merge and pull suites.

### Gate
`npx vitest run test/unit/application/commands/index-carry-merge-pull.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/pull.test.ts test/unit/application/commands/internal/reset-worktree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts src/application/commands/pull.ts src/application/commands/internal/pull-into-void.ts src/application/commands/internal/reset-worktree.ts test/unit/application/commands/index-carry-merge-pull.test.ts test/unit/application/commands/pull.test.ts && npm run check:spelling`

### Commit
`feat(index): merge and pull carry index extensions`

## Part 11 — Pick, revert, rebase and clone writers declare `'replace'`

### Context
- `'replace'` at: `src/application/commands/cherry-pick.ts` line 257; `src/application/commands/revert.ts` `applyOneRevert` line 147; `src/application/commands/internal/replay-sequence.ts` lines 183 and 245; `src/application/commands/internal/rebase-merges-steps.ts` lines 154 (conflict) and 157 (clean); `src/application/primitives/materialize-worktree-from-head.ts` line 27 (clone checkout: no previous index → type-only, say so).
- Test (new) `test/unit/application/commands/index-carry-pick-rebase.test.ts`, Part 8 fixture/helper (test/unit/application/primitives/helpers/index-extensions.ts). Rows: cherry-pick clean and conflicted, revert clean, rebase (a linear replay → replay-sequence sites), rebase with `rebaseMerges` over a merge commit (rebase-merges-steps sites; reuse the builders in test/unit/application/commands/internal/rebase-merges-steps.test.ts and rebase-replay.test.ts). Each: `REUC` dropped, `TREE` present with changed chains invalid, `ZZZZ` gone. If a site is reachable only through a scenario the existing suites build, import that suite's builder rather than re-deriving it.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — cherry-pick and revert rows. Fail: `TREE` absent.
2. GREEN — cherry-pick.ts, revert.ts.
3. RED — rebase rows (replay-sequence, rebase-merges-steps). Fail: `TREE` absent.
4. GREEN — replay-sequence.ts, rebase-merges-steps.ts, materialize-worktree-from-head.ts (type-only); run the cherry-pick/revert/rebase suites.

### Gate
`npx vitest run test/unit/application/commands/index-carry-pick-rebase.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/internal/rebase-merges-steps.test.ts test/unit/application/commands/internal/rebase-replay.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/cherry-pick.ts src/application/commands/revert.ts src/application/commands/internal/replay-sequence.ts src/application/commands/internal/rebase-merges-steps.ts src/application/primitives/materialize-worktree-from-head.ts test/unit/application/commands/index-carry-pick-rebase.test.ts && npm run check:spelling`

### Commit
`feat(index): cherry-pick, revert and rebase carry index extensions`

## Part 12 — Stash and worktree add declare `'replace'`

### Context
- `'replace'` at `src/application/commands/stash.ts` `resetAfterPush` line 520, `reinstateIndex` line 634, `applyUnderLock` line 716; `src/application/commands/worktree.ts` line 212 (fresh index in a new worktree → type-only, say so).
- Pre-migrate seeds: `test/unit/application/commands/submodule-update.test.ts` (five `lock.commit([` sites, lines 108, 240, 356, 484, 614) and `test/unit/application/primitives/read-index.test.ts` line 723 → add `'update'`.
- Test (new) `test/unit/application/commands/index-carry-stash.test.ts`, Part 8 fixture/helper. Rows (design §D1.5): `stashPush` of worktree-only edits (and with `includeUntracked`) → `REUC` dropped, `TREE` unchanged (the index already equals HEAD, so no path changed), `ZZZZ` gone; `stashApply` → `REUC` dropped; `stashPop` with the index reinstated (the `reinstateIndex` path) → `REUC` dropped.
- After this part every `src` call site passes a kind: confirm with `grep -rn "lock.commit(" src` (each line has a second argument).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — stash push/apply/pop rows. Fail: `TREE` absent.
2. GREEN — the three stash.ts sites; worktree.ts (type-only); migrate the seeds; run stash, worktree, submodule-update and read-index suites.

### Gate
`npx vitest run test/unit/application/commands/index-carry-stash.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/worktree.test.ts test/unit/application/commands/submodule-update.test.ts test/unit/application/primitives/read-index.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/commands/worktree.ts test/unit/application/commands/index-carry-stash.test.ts test/unit/application/commands/submodule-update.test.ts test/unit/application/primitives/read-index.test.ts && npm run check:spelling`

### Commit
`feat(index): stash and worktree add carry index extensions`

## Part 13 — Required write kind and the refresh-only commit

### Context
- `src/application/primitives/internal/index-lock.ts`:
  - `commit: (entries, kind: IndexWriteKind, options?: CommitOptions) => Promise<void>` — `kind` REQUIRED now; delete the `kind === undefined` branch. Then run the type-check: every error left is a test seed; the known ones are in `test/unit/application/commands/internal/index-update.test.ts` (lines 138, 153, 247, 250, 398, 414, 418, 436 → `'update'`). Any other file the type-check names gets the same one-word fix; list it in the handback. Delete the Part 7 GUARD row "commit without a kind writes no extension" in `test/unit/application/primitives/internal/index-lock.test.ts` (it no longer compiles; the behaviour is gone by design).
  - Add `commitRefresh: (read: GitIndex, refreshed: ReadonlyArray<IndexEntry>) => Promise<boolean>` to `IndexLock` (design §D4.1, ADR-959). Body: if committed/released → `false`. Re-read the on-disk index with `readPreviousIndex(ctx)` (Part 7, src/application/primitives/internal/smudge-racily-clean.ts). Absent (index vanished) or its `trailerSha` bytes differ from `read.trailerSha` → `release()`, resolve `false` (git's `verify_index_from`; no warn). Otherwise replace each stage-0 entry of `read.entries` whose path has a refreshed entry by that refreshed entry (Map by path; refreshed entries differ only in stat fields by construction — design §D2.3), then the shared `writeLocked` tail (Part 7) with extensions `carryExtensions(previous.extensions, NO_INDEX_CHANGE, 'refresh', settings)`, smudge with `previous`; resolve `true`.
  - Trailer bytes compare: `trailerSha` is a `Uint8Array` at `ctx.hashConfig.digestLength`; compare length + bytes (a tiny local `sameBytes`).
  - Refreshed entries are never smudged: their stat differs from the previous index's, so they are not "carried over" (design §D2.3 last bullet).
- Tests: extend `test/unit/application/primitives/internal/index-lock.test.ts`. Build a refreshed entry by hand (same entry, later `mtimeSeconds`); Part 16's `withStatData` does not exist yet.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. REFACTOR — `kind` required; branch deleted; seeds migrated; GUARD: index-update.test.ts and index-lock.test.ts green.
2. RED — `Given an index with TREE, REUC, UNTR, ZZZZ read into memory` / `When commitRefresh(read, [entry with a later mtime])` / `Then it resolves true, the on-disk entry has the new mtime and the same id, mode and flags, TREE, REUC and UNTR bytes are identical, ZZZZ is gone`. Fails: `commitRefresh` is not a function.
3. GREEN — stat copy + `writeLocked` with the `refresh` carry, no verify yet.
4. RED — `Given another commit rewrote the index after the read` / `Then commitRefresh resolves false, the index bytes are the other writer's, and no index.lock remains`. Fails: step 3 writes over the newer index.
5. GREEN — trailer guard.
6. RED — `Given the index file was deleted after the read` / `Then it resolves false and writes nothing`. Fails if step 5 dereferenced an undefined previous; else GUARD.
7. RED (SHA-256) — the step-2 row in a SHA-256 memory repo (32-byte trailer and `TREE` oids). GUARD if green; record.

### Gate
`npx vitest run test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/commands/internal/index-update.test.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/index-lock.ts test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/commands/internal/index-update.test.ts && npm run check:spelling`

### Commit
`feat(index): require a write kind and add the refresh-only commit`

## Part 14 — Optional index lock and the degrade report

### Context
- `src/application/primitives/internal/index-lock.ts` (design §D2.3–§D2.4, ADR-961):
  - `export const acquireOptionalIndexLock = async (ctx: Context): Promise<IndexLock | undefined>` — ONE `ctx.fs.writeExclusive(lockPath, new Uint8Array())`; success → `makeLock(…)`; ANY failure (TsgitError of any code incl. `FILE_EXISTS`, or a non-TsgitError such as an OPFS `DOMException`) → report, resolve `undefined`. Never breaks a stale lock (ignore `ctx.config?.breakStaleLockMs`), never builds `RESOURCE_LOCKED`, never throws.
  - Degrade report, one per degrade: `ctx.logger?.warn?.('status: index refresh skipped', { code, path, reason? })`. `code` = `errorDataCode(err)` (src/domain/error-data-code.ts) when it is a TsgitError, else the thrown value's string `name` when it has one, else the named constant `UNKNOWN_FAILURE_CODE = 'unknown'`. `reason` = the TsgitError data's string `reason` (Node's unmapped errno via `UNSUPPORTED_OPERATION { operation: 'filesystem', reason }`, mapErrno in src/adapters/node/node-file-system.ts lines 301-330), key omitted when absent. `path` = the path the failing operation targeted.
  - `commitRefresh` (Part 13) never rejects for a failure at a refresh-write site: the on-disk re-read (path = index file), serialise/hash/write of `index.lock` (path = lock path), rename (path = index file) → `release()`, report, resolve `false`. A trailer mismatch is not a failure (no report). A failing `release()` inside that path propagates (it is not a refresh-write site; nothing is swallowed).
  - Logger port: `Logger.warn?: (message, context?) => void` (src/ports/logger.ts line 15), optional; `Context.logger?` (src/ports/context.ts line 296). Precedent: `ctx.logger?.warn?.(…)` in src/application/primitives/internal/bitmap-container.ts line 80.
- Tests: extend `test/unit/application/primitives/internal/index-lock.test.ts`. Fake fs = a `Proxy` over the memory fs that throws at one method (pattern: `countingIndexStats` in test/unit/application/commands/status.test.ts lines ~49-70). Error data shapes: read the `PERMISSION_DENIED` / `UNSUPPORTED_OPERATION` / `FILE_EXISTS` members in src/domain/error.ts and src/domain/storage/error.ts before building them. `new DOMException('denied', 'NoModificationAllowedError')` gives the browser shape.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — `Given no index.lock` / `When acquireOptionalIndexLock` / `Then it returns a lock whose release removes index.lock`. Fails: not exported.
2. GREEN — single `writeExclusive` + `makeLock`.
3. RED — `Given an index.lock older than breakStaleLockMs` / `Then it resolves undefined, the lock bytes and mtime are untouched, and warn got exactly { code: 'FILE_EXISTS', path: <lock path> }`. Fails: step 2 rejects with FILE_EXISTS.
4. GREEN — catch-all + report.
5. RED — `writeExclusive` throwing `UNSUPPORTED_OPERATION { reason: 'ENOSPC' }` and `{ reason: 'EIO' }` → warn carries `reason`; `PERMISSION_DENIED` → no `reason` key; a `DOMException` named `NoModificationAllowedError` → `code` is that name; a thrown string → `code: 'unknown'`. Fails: step 4 reports no `reason` and reads no `name`.
6. GREEN — `reason`/`name` extraction. GUARD: no logger → resolves undefined, no throw.
7. RED — `commitRefresh` with `write` of index.lock throwing ENOSPC → resolves false, no index.lock left, warn path = lock path; `rename` throwing → warn path = index path. Fails: Part 13's `commitRefresh` rejects.
8. GREEN — site-tagged catch in `commitRefresh`.

### Gate
`npx vitest run test/unit/application/primitives/internal/index-lock.test.ts test/unit/application/commands/internal/index-update.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/index-lock.ts test/unit/application/primitives/internal/index-lock.test.ts && npm run check:spelling`

### Commit
`feat(index): optional index lock that degrades with a logged report`

## Part 15 — Second-granularity racy trigger

### Context
- Edit `src/application/primitives/internal/is-entry-stat-clean.ts`: add `export const hasRacyTimestamp = (entries: ReadonlyArray<IndexEntry>, indexMtime: IndexMtime): boolean` — git's `has_racy_timestamp` as built without USE_NSEC (design §D1.1 Q4, §D2.2, ADR-960): `indexMtime.seconds !== 0` AND some entry with `mode !== FILE_MODE.GITLINK` has `mtimeSeconds >= indexMtime.seconds`. All stages count (git loops over every cache entry). Nanoseconds are ignored — this differs on purpose from the existing nanosecond-aware `isRacy` (lines 25-29), which stays for the stat-cache guard. `FILE_MODE` from src/domain/objects/file-mode.ts. TSDoc says why (second granularity, gitlinks excluded).
- Tests: extend `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts` and `test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts` (property, 100 runs: result ⇔ `indexMtime.seconds !== 0 && entries.some(non-gitlink && mtimeSeconds >= seconds)` stated as two invariants — appending a non-gitlink entry with `mtimeSeconds >= seconds` makes it true; any list of only gitlinks or only older entries gives false — not as a copy of the implementation).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — `Given an entry with mtime 946.0 and an index mtime 946.085` (the Q4 pin) / `When hasRacyTimestamp` / `Then true`. Fails: not exported.
2. GREEN — the predicate.
3. RED — `Given only a gitlink in the same second` / `Then false`; `Given index seconds 0` / `Then false`. Fail if step 2 omitted either guard; else GUARD (record which).
4. Properties (GUARD on first run expected).

### Gate
`npx vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts && npm run check:spelling`

### Commit
`feat(status): second-granularity racy timestamp check`

## Part 16 — Refresh verdict in the working-tree comparator

### Context
- `src/application/primitives/internal/index-entry-from-stat.ts`: add `export const withStatData = (entry: IndexEntry, stat: FileStat): IndexEntry` — copies ctime/mtime (seconds + `nanosecondsOf`), `dev`, `ino`, `uid`, `gid`, `fileSize` (= `stat.size`) from the stat; keeps `id`, `mode`, `flags`, `path`. Refactor `indexEntryFromStat(stat, mode, id, path)` (lines 21-40) to delegate (`withStatData({ …, mode, id, path, flags: STAGE0_FLAGS }, stat)` or equivalent).
- `src/application/primitives/compare-working-tree-entry.ts` (design §D2.1, DC-P3):
  - New internal `export interface ComparisonScope { readonly provider?: AttributeProvider; readonly indexMtime?: IndexMtime }`, `export interface RefreshedComparison { readonly delta: WorkingTreeDelta; readonly refreshed?: IndexEntry }`, `export const compareAndRefresh = (ctx, entry, scope: ComparisonScope = {}): Promise<RefreshedComparison>` holding today's `compareWorkingTreeDelta` body (lines 169-195) so the `stat` it already has is visible — no second `lstat`, no extra read. NOT added to src/application/primitives/index.ts.
  - `refreshed = withStatData(entry, stat)` iff `delta.status === 'unchanged'` AND `!matchesContentStat(entry, stat)` AND stage 0 AND not `assumeValid`, not `skipWorktree`, not `intentToAdd`, `mode !== FILE_MODE.GITLINK`.
  - `compareWorkingTreeDelta(ctx, entry, provider?, indexMtime?)` (public, unchanged signature) = `(await compareAndRefresh(ctx, entry, scopeOf(provider, indexMtime))).delta` (conditional spreads: `exactOptionalPropertyTypes`).
  - `compareWorkingTreeEntry(ctx, entry, provider?, indexMtime?)` (lines 218-222) gains the same optional fourth argument and forwards it (ADR-511's shape). This is public (primitives subpath) → `npm run docs:json`, commit `reports/api.json`.
  - Miss path unchanged: `readThresholdBeforeHashing`, `readWorkingBytes`, `convertedWorktreeBytes`, `serializeAndHash`.
- Tests: extend `test/unit/application/primitives/internal/index-entry-from-stat.test.ts` and `test/unit/application/primitives/compare-working-tree-entry.test.ts` (reuse its existing context builders and whatever conversion spy it already has for the miss path — grep it for `convertToGit`/`vi.mock`).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — index-entry-from-stat.test.ts `Given a skip-worktree entry with id X` / `When withStatData(entry, stat)` / `Then stat fields come from the stat, id, mode, flags, path are kept`. Fails: not exported.
2. GREEN — `withStatData`; `indexEntryFromStat` delegates (its existing rows are the GUARD).
3. RED — compare test `Given a committed file rewritten with the same bytes after the clock moved` / `When compareAndRefresh(…, { indexMtime })` / `Then delta is unchanged and refreshed carries the new mtime and the old id`; plus `Given nothing moved` / `Then refreshed is undefined`. Fails: not exported.
4. GREEN — `compareAndRefresh` with the refresh rule; `compareWorkingTreeDelta` delegates.
5. RED — not refreshed when: content changed (`modified`), mode changed, `assumeValid`, `intentToAdd`, gitlink, stage 2 (one row each). Fails for any guard step 4 skipped; the rest are GUARDs — record which.
6. RED — `compareWorkingTreeEntry(ctx, entry, provider, indexMtime)` on a stat-clean, non-racy entry does not read the file (spy `ctx.fs.read`: 0 calls). Fails: today it drops `indexMtime` and hashes (1 read).
7. GREEN — forward `indexMtime`; `npm run docs:json`.

### Gate
`npx vitest run test/unit/application/primitives/internal/index-entry-from-stat.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/index-entry-from-stat.ts src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/internal/index-entry-from-stat.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts && npm run check:spelling`

### Commit
`feat(status): report refreshable stat data from the working-tree comparator`

## Part 17 — `status` refresh write-back under the optional lock

### Context
- `src/application/commands/status.ts` (451 lines). Today `statusInScope(ctx)` (line 131): gates → `readHeadRaw` → `readIndex` → `trackedEntriesOf` → `progress.start` → `scanStatusTree` (line 181: tracked pass `scanWorkingTree` AND untracked pass `scanUntracked` together) → `reportStatus` → result; `progress.end` in `finally`. `scanEntry` (line ~226) calls `compareWorkingTreeDelta(ctx, entry, provider, indexMtime)`.
- Target lifecycle (design §D2.3, ADR-959/960):
  1. `scanEntry` calls `compareAndRefresh(ctx, entry, { provider, indexMtime })` (Part 16, src/application/primitives/compare-working-tree-entry.ts) and returns the delta plus `refreshed`; the tracked pass returns `{ workingMap, refreshed: ReadonlyArray<IndexEntry> }` (input order; `boundedMapFor` keeps it).
  2. After the tracked pass: `const lock = await acquireOptionalIndexLock(ctx)` (Part 14, src/application/primitives/internal/index-lock.ts).
  3. Inside `try { … } finally { await lock?.release() }`: the untracked pass (`scanUntracked`), then `reportStatus` — keep today's relative order (untracked before report) so refusal precedence is unchanged — then `if (lock) await updateIndexIfAble(lock, index, refreshed)`.
  4. `updateIndexIfAble`: write iff `refreshed.length > 0 || (index.indexMtime !== undefined && hasRacyTimestamp(index.entries, index.indexMtime))` (Part 15, src/application/primitives/internal/is-entry-stat-clean.ts); false → `lock.release()`; true → `lock.commitRefresh(index, refreshed)` (it degrades by itself, Part 14).
  - `release` after a commit is a no-op, so the `finally` is safe on every path. A throwing report/untracked scan propagates after the release (not a degrade). `readIndex` failures propagate before any lock exists.
  - No index file → `indexMtime` undefined, nothing refreshed: the lock is still taken and released, nothing written (git does the same).
- Internal callers keep the default (design §D1.8, no code change): `describe` `computeDirty` (src/application/commands/describe.ts line 169), `worktreeRemove` (src/application/commands/worktree.ts line 382), `assertSubmoduleClean` (src/application/commands/submodule.ts line 426). Confirm none of them holds the same repository's `index.lock` when it calls `status` (a held lock would turn every call into a FILE_EXISTS degrade warn); report what you found.
- Tests: create `test/unit/application/commands/status-refresh.test.ts`; extend `test/unit/application/commands/describe.test.ts`; existing `test/unit/application/commands/status.test.ts` rows that count index reads/stats (`countingIndexStats`, lines ~45-70 and its users) or freeze the clock may now see a write: apply standing rule 1 (those rows pin the scan's reads, so the usual fix is advancing the clock past the index second; say which you changed and why). "Rewritten" in unit tests = `vi.spyOn(ctx.fs, 'rename')` called with (`<gitDir>/index.lock`, `<gitDir>/index`); also assert the refreshed entry's stat via `readIndex` after `invalidateIndexCache`.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — status-refresh.test.ts `Given a settled repo (files written at T, clock T+2 s, add + commit)` / `When file b is rewritten with the same bytes at T+5 s and status runs at T+7 s` / `Then the index is rewritten once and b's entry carries the new mtime with the same id`; and describe.test.ts `Given a stat-moved tracked file` / `When describe with dirty` / `Then the index is rewritten`. Fail: status never writes.
2. GREEN — split tracked/untracked passes, optional lock, `updateIndexIfAble` with the `refreshed.length > 0` trigger only, `finally` release.
3. RED — `Given an entry whose mtime is in the same second as the index and unchanged content` / `Then status rewrites the index`. Fails: step 2 has no racy trigger.
4. GREEN — `|| hasRacyTimestamp(…)`.
5. GUARD — settled repo, nothing moved, clock advanced → no rename (the step-2/4 trigger is false). GUARD — content-only change (not racy) → no write. GUARD — `StatusResult` deep-equals the result of a second status run and of a run with the lock pre-created (R4). GUARD — `index.lock` pre-created → no write, lock bytes untouched, result returned.
6. GUARD — a fs proxy that rewrites the index (an `add` through the same fs) inside `writeExclusive` of the optional lock → no write by status (Part 13's trailer guard), no `index.lock` left.
7. GUARD — `core.warnAmbiguousRefs` refusal (or any report-time refusal already pinned in status.test.ts) with the lock taken → error data asserted field by field, `index.lock` absent afterwards. GUARD — corrupt index → `INVALID_INDEX_*` data asserted, `writeExclusive` never called.
8. GUARD — fresh repo with no index file → no `index` and no `index.lock` afterwards.

### Gate
`npx vitest run test/unit/application/commands/status-refresh.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/status-clean-order.test.ts test/unit/application/commands/describe.test.ts test/unit/application/commands/worktree.test.ts test/unit/application/commands/submodule.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/status.ts test/unit/application/commands/status-refresh.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/describe.test.ts && npm run check:spelling`

### Commit
`feat(status): write refreshed stat data back under the optional index lock`

## Part 18 — `ENV_BAD_BOOLEAN_VALUE` error code

### Context
- DC-P1 (a). New `CommandError` member and factory in `src/domain/commands/error.ts`: union member `{ readonly code: 'ENV_BAD_BOOLEAN_VALUE'; readonly variable: string; readonly value: string }` next to `CONFIG_BAD_BOOLEAN_VALUE` (lines ~302-307); factory `export const envBadBooleanValue = (variable: string, value: string): TsgitError` next to `configBadBooleanValue` (lines ~1140-1150), `value` through `sanitizeForDisplay` like its sibling.
- Message in `src/domain/error.ts` message switch (near line 650): `bad boolean environment value '${data.value}' for '${data.variable}'` (git 2.55 `git_env_bool` die text, design §D1.2 P9).
- Exhaustiveness: add the case in `test/unit/domain/exhaustiveness.ts` (list near line 201). Message + factory rows in `test/unit/domain/commands/error.test.ts` (factory rows near 1519; message table near 2056, format `"<CODE>: <message>"`).
- Public surface: `TsgitErrorData` is public → document the code as a row in `docs/use/errors.md` after line 254 (`variable, value`; refused by `status` when `GIT_OPTIONAL_LOCKS` fails git's boolean grammar — same grammar as `CONFIG_BAD_BOOLEAN_VALUE`; `refresh: false` never consults the variable). reports/api.json changes too: it is regenerated in Part 19 (api.json is a prepush gate, not a validate gate); do not regenerate it here.
- The factory has no `src` caller until Part 19 (dead-code is a phase-gate check, not a part gate).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — error.test.ts `Given variable GIT_OPTIONAL_LOCKS and value bogus` / `When envBadBooleanValue` / `Then data is { code, variable, value }` (field by field) and `message` is `bad boolean environment value 'bogus' for 'GIT_OPTIONAL_LOCKS'`. Fails: factory missing.
2. GREEN — union member, factory, message case, exhaustiveness case.
3. RED — `Given a value with a control character` / `Then value is sanitised for display`. Fails if step 2 skipped `sanitizeForDisplay`; else GUARD.
4. Docs row in errors.md (the doc gates run at the phase gate; check spelling here).

### Gate
`npx vitest run test/unit/domain/commands/error.test.ts test/unit/domain/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts && npx cspell --no-progress docs/use/errors.md && npm run check:spelling`

### Commit
`feat(error): ENV_BAD_BOOLEAN_VALUE for a malformed boolean environment variable`

## Part 19 — `StatusOptions.refresh` and `GIT_OPTIONAL_LOCKS`

### Context
- `src/application/commands/status.ts`: `export interface StatusOptions { /** … default true; false = git --no-optional-locks status: the index is never written. */ readonly refresh?: boolean }` (TSDoc per design §D2.5); `export const status = (ctx: Context, opts: StatusOptions = {}): Promise<StatusResult>` → `statusInScope(ctx, opts)`. Gate the optional lock with `refreshEnabled(ctx, opts)`, evaluated where the lock is taken (after the tracked pass — git calls `use_optional_locks()` after `refresh_index`): `opts.refresh === false` → `false` WITHOUT reading the env (`--no-optional-locks` overwrites the variable in git); otherwise `ctx.env?.get('GIT_OPTIONAL_LOCKS')`: unset → `true`; `parseGitBoolean(value)` (src/domain/config/config-ini.ts line 845; '' → false, `2` → true) ok → its value; not ok → `throw envBadBooleanValue('GIT_OPTIONAL_LOCKS', value)` (Part 18). Name the variable as a constant. Disabled → no lock is taken at all.
- Barrel: `src/application/commands/index.ts` status block (lines ~366-373) adds `type StatusOptions`.
- Facade: `src/repository.ts` lines 970-973 `status: (() => { guard(); return commands.status(ctx); })` → forward `opts`; the `Repository['status']` type (line 413, `BindCtx<typeof commands.status>`) follows automatically.
- Docs: `docs/use/commands/status.md` — Signature `repo.status(opts?: StatusOptions)` + the interface; Behaviour: refresh write-back under the optional `index.lock` (written only when an entry was refreshed or is racy), `GIT_OPTIONAL_LOCKS` read from the context env, `ENV_BAD_BOOLEAN_VALUE` refusal, failures to lock or write degrade to a read-only status reported through `logger.warn` (never in the result).
- `reports/api.json`: regenerate with `npm run docs:json` and commit (also covers Part 18's union change).
- Tests: extend `test/unit/application/commands/status-refresh.test.ts` (facade row: build the repository the way test/unit/repository/repository.test.ts does — `openRepository` from src/repository.ts — or through the memory facade it uses; env through `createMemoryContext({ env })`).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — `Given a stat-moved tracked file` / `When status(ctx, { refresh: false })` / `Then the index is not rewritten and writeExclusive was never called`. Fails: Part 17 always refreshes.
2. GREEN — `StatusOptions`, `opts` threaded, `refresh === false` short-circuit.
3. RED — env rows: `GIT_OPTIONAL_LOCKS` = `0`, `false`, `off`, the empty string → no write; `2`, `yes` → write; `bogus` → refusal with data `{ code: 'ENV_BAD_BOOLEAN_VALUE', variable: 'GIT_OPTIONAL_LOCKS', value: 'bogus' }` read field by field; env false with `refresh: true` → no write. Fail: env never read.
4. GREEN — `refreshEnabled`.
5. GUARD — `refresh: false` with `bogus` → no refusal (step 2 short-circuits before the env).
6. RED — facade: `repo.status({ refresh: false })` on a stat-moved repo → no write. Fails: the binding drops `opts`.
7. GREEN — facade forwards; barrel export; docs; `npm run docs:json`.

### Gate
`npx vitest run test/unit/application/commands/status-refresh.test.ts test/unit/application/commands/status.test.ts test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/status.ts src/application/commands/index.ts src/repository.ts test/unit/application/commands/status-refresh.test.ts && npx cspell --no-progress docs/use/commands/status.md && npm run check:spelling`

### Commit
`feat(status): refresh option and GIT_OPTIONAL_LOCKS`

## Part 20 — Skip filter-driver resolution when no filter section exists

### Context
- DC-P3 (a), ADR-967. Per file on the comparator miss path, `convertedWorktreeBytes` (src/application/primitives/compare-working-tree-entry.ts lines 80-99) calls `resolveConversion(…, { eagerSectionValidation: true })` and `readThresholdBeforeHashing` → `streamsThroughDriver` (lines 144-167) calls `resolveFilterDriver`. With no `[filter "<d>"]` section neither can find a driver.
- `src/application/primitives/resolve-conversion.ts` `resolveConversion` (lines 60-79): options gain `readonly filterDriversConfigured?: boolean`; when it is `false`, skip `validateFilterSections` and use `IDENTITY_CONVERSION.filter` instead of `filterChoiceFromSources` (text/eol/ident lookups unchanged; the early `IDENTITY_CONVERSION` return unchanged). `undefined` = today's behaviour for every other caller.
- `src/application/primitives/compare-working-tree-entry.ts`: `ComparisonScope` (Part 16) gains `readonly filterDriversConfigured?: boolean`, passed to `resolveConversion`; `streamsThroughDriver` returns `false` without resolving when it is `false`.
- `src/application/commands/status.ts`: compute `configuresFilterDriver(ctx)` (lines 273-274) ONCE per call in the tracked pass, put it in the scope, and reuse it for the `ordered` decision (line 266) instead of a second call.
- Tests: extend `test/unit/application/primitives/resolve-conversion.test.ts` (with `filterDriversConfigured: false` a malformed `filter.x.required` is not validated and a `filter=x` attribute yields the identity filter — the flag is trusted) and `test/unit/application/primitives/compare-working-tree-entry.test.ts`; create `test/unit/application/commands/status-filter-skip.test.ts` with a partial module mock (`vi.mock` of src/application/primitives/resolve-filter-driver.ts using `importOriginal`, wrapping `resolveFilterDriver` and `filterChoiceFromSources` in `vi.fn`) — isolated file so the mock touches no other suite.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — resolve-conversion.test.ts `When resolveConversion(…, { eagerSectionValidation: true, filterDriversConfigured: false })` on a config holding `[filter "x"] required = bogus` and attribute `filter=x` / `Then it returns the identity filter and does not refuse`. Fails: today it refuses `CONFIG_BAD_BOOLEAN_VALUE`.
2. GREEN — the option.
3. RED — status-filter-skip.test.ts `Given .gitattributes '* text=auto', no [filter] section, three modified-stat files` / `When status` / `Then resolveFilterDriver and filterChoiceFromSources are never called` and the result equals a run with a `[filter "x"]` section that no path uses. Fails: called once per file.
4. GREEN — scope flag through the comparator; status computes it once.
5. GUARD — status-clean-order.test.ts and the compare suite with a configured filter (driver still runs, order kept).

### Gate
`npx vitest run test/unit/application/primitives/resolve-conversion.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/commands/status-filter-skip.test.ts test/unit/application/commands/status-clean-order.test.ts test/unit/application/commands/status.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-conversion.ts src/application/primitives/compare-working-tree-entry.ts src/application/commands/status.ts test/unit/application/primitives/resolve-conversion.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/commands/status-filter-skip.test.ts && npm run check:spelling`

### Commit
`perf(status): skip filter-driver resolution without a filter section`

## Part 21 — Arm the stat cache in rm, clean-work-tree and would-overwrite

### Context
- Design §D3.1, ADR-511 (no new ADR). Pass the index's `indexMtime` as the fourth argument of `compareWorkingTreeEntry` (Part 16):
  - `src/application/commands/rm.ts`: `classifyEntries(ctx, entries, head, cached)` (line 154; call at 182; comparator at 165) gains an `indexMtime: IndexMtime | undefined` parameter fed from the index read at line 78. Its `.catch` fallback (`{ entries: [] }`, lines 78-81) has no `indexMtime` — pass `undefined` for it (type the fallback so `indexMtime` is readable).
  - `src/application/commands/internal/clean-work-tree.ts`: `unstagedDirty(ctx, stage0)` (lines 54-67) gains `indexMtime`; `assertCleanWorkTree` and `unstagedChangePaths` keep the `readIndex` result and pass `index.indexMtime`.
  - `src/application/primitives/find-would-overwrite.ts` line 119: pass `currentIndex.indexMtime`. Callers already hand indexes from `readIndex` (merge.ts line 1655, rebase-merges-steps.ts line 148, pull.ts line 442, stash.ts lines 512/711) or `input.currentIndex` (apply-merge-to-worktree.ts line 481) — no change there.
  - Safety check to state in the handback: src/application/commands/internal/replay-sequence.ts line 273 builds `{ ...currentIndex, entries: res.result.newIndexEntries }`, keeping the old `indexMtime` with new entries. Read the donor rule in src/application/primitives/build-index-from-tree.ts `donorByPath` (lines 59-66) and its use: an entry whose id changed must never keep the donor's stat (else a stale stat could match); entries written during the replay carry post-write stat (racy → re-hashed). Confirm or hand back.
- Tests: extend `test/unit/application/commands/rm.test.ts`, `test/unit/application/commands/internal/clean-work-tree.test.ts`, `test/unit/application/primitives/find-would-overwrite.test.ts`. Pattern for each: files written at T, clock to T+2 s, `add` (index newer than the files) → the entry is stat-clean and not racy; spy `ctx.fs.read` on that path.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. RED — rm.test.ts `Given a stat-clean, non-racy tracked file` / `When rm classifies it` / `Then the file is never read`. Fails: one read (hash) per entry today.
2. GREEN — thread `indexMtime` through `classifyEntries`.
3. RED — clean-work-tree.test.ts same shape through `unstagedChangePaths`. Fails: one read.
4. GREEN — `unstagedDirty` armed.
5. RED — find-would-overwrite.test.ts same shape. Fails: one read.
6. GREEN — `currentIndex.indexMtime`. GUARD — the existing verdict rows of all three suites (R5) and find-would-overwrite.properties.test.ts.

### Gate
`npx vitest run test/unit/application/commands/rm.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts test/unit/application/commands/merge.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/rm.ts src/application/commands/internal/clean-work-tree.ts src/application/primitives/find-would-overwrite.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/unit/application/primitives/find-would-overwrite.test.ts && npm run check:spelling`

### Commit
`perf: arm the stat cache in rm, clean-work-tree and would-overwrite checks`

## Part 22 — `stash push` armed and pooled

### Context
- Move from src/application/commands/status.ts into `src/application/primitives/internal/clean-order.ts` (which already exports `withCleanOrder(ctx, body, span = 'clean')`, `CleanOrder`, `OrderSpan`): `inIndexOrder` (status.ts lines 277-285) and `configuresFilterDriver` (lines 273-274, reads `readConfig(ctx).filter`). Export both; `src/application/commands/status.ts` imports them (behaviour-preserving).
- `src/application/commands/stash.ts` (design §D3.2, ADR-953/954):
  - `classifyTracked(ctx, index, provider)` (lines 220-239, sequential): pool with `boundedMapFor(ctx, 'ioBound', …)` (src/application/primitives/internal/concurrency.ts) over the entries, calling `compareWorkingTreeEntry(ctx, entry, provider, index.indexMtime)` (armed, Part 16); with `configuresFilterDriver(ctx)` true run under `inIndexOrder` and release each path's turn in a `finally` (the status `scanWorkingTree` shape). Keep the two existing `Stryker disable` lines attached to their unchanged conditions (stage ≠ 0 skip, skip-worktree keep).
  - `projectWorkingTree` (lines 241-268) and `hashUntracked` (lines 315-333): each one `withCleanOrder(ctx, body, span)` with `span = scope.settings.safeCrlf === true ? 'write' : 'clean'`, paths enlisted in input order, each task under `limiterFor(ctx, 'ioBound')`, every task settled and the EARLIEST failure in input order rethrown — mirror src/application/commands/add.ts `stageWalkedEntries`/`dispatchInCleanOrder`/`dispatchWalkEntry`/`stagedOutcomes` (lines 320-420). Results and `eolNotices` assembled in input order (W-tree entries and loose-object set unchanged; ADR-954 refusal data unchanged).
- Tests: create `test/unit/application/commands/stash-pool.test.ts`; extend `test/unit/application/primitives/internal/clean-order.test.ts` with rows for the moved helpers. Concurrency/ordering proxies: copy the slow-`lstat`/slow-`read` Proxy pattern from test/unit/application/commands/add-clean-order.test.ts.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. REFACTOR — move `inIndexOrder`/`configuresFilterDriver` to clean-order.ts with clean-order.test.ts rows (enlists every path in order; true/false on a `[filter "x"]` section); GUARD: status suites green.
2. RED — stash-pool.test.ts `Given a stat-clean, non-racy tracked file` / `When stashPush` / `Then the file is never read during classification`. Fails: `classifyTracked` passes no `indexMtime`.
3. RED — `Given 8 modified tracked files behind a slow lstat proxy` / `When stashPush` / `Then more than one comparison is in flight`. Fails: sequential `for…await`.
4. GREEN — pooled, armed `classifyTracked`.
5. RED — `Given 8 modified tracked and 8 untracked files behind a slow read proxy` / `Then more than one hash is in flight in projectWorkingTree and in hashUntracked`. Fails: sequential.
6. GREEN — pooled projection/untracked hashing under `withCleanOrder` with the safecrlf span.
7. GUARD — `core.safecrlf=true` with two lossy files where the SECOND file's read resolves first → the refusal names the first (index order) and no object for the second is written; `eolNotices` order equals input order; the existing stash.test.ts and stash interop rows.

### Gate
`npx vitest run test/unit/application/commands/stash-pool.test.ts test/unit/application/commands/stash.test.ts test/unit/application/primitives/internal/clean-order.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/status-clean-order.test.ts && PATH=<git-2.55.0-bin>:$PATH npx vitest run --project integration test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/primitives/internal/clean-order.ts src/application/commands/status.ts test/unit/application/commands/stash-pool.test.ts test/unit/application/primitives/internal/clean-order.test.ts && npm run check:spelling`

### Commit
`perf(stash): pool working-tree comparisons and hashing with the stat cache armed`

## Part 23 — Interop harness: `status` refresh against git 2.55.0

### Context
- Harness-only part (no `src` delta; §Planning decisions). Create `test/integration/status-refresh-interop.test.ts` and `test/integration/posix-only/status-refresh-readonly-interop.test.ts` (the posix-only folder runs in the `posix-integration` vitest project). Header shape from test/integration/status-racy-clean-interop.test.ts: `@proves` with `surface: status`, `bucket: cross-tool-interop`, a `unique:` line, `interopSurface: index`. Helpers from test/integration/interop-helpers.ts: `GIT_AVAILABLE`, `git`, `runGit`, `runGitAsync`, `tryRunGit`, `makePeerPair`, `lsStage`. tsgit side: `createNodeContext({ workDir })` (src/adapters/node/node-adapter.ts; `algorithm: 'sha256'` for the twin), `status` from src/application/commands/status.ts; env via `{ ...ctx, env: { get: (name) => … } }`; logger via `{ ...ctx, logger: { warn: vi.fn() } }`.
- "Rewritten" = the index file's inode changed (`statSync(<gitDir>/index).ino` before/after), not a byte compare. Settle deterministically instead of sleeping: `utimes` every tracked file 10 s into the past, then `git update-index --refresh` (index written now, nothing racy).
- Rows (design §Test strategy, §D1.1–§D1.2):
  - copy shape: `fs.cp` the git-built repo (ino and ctime move) → tsgit `status` rewrites; `git ls-files --debug` then shows each file's lstat ctime/mtime/ino; a following git `status` does not rewrite (after settling).
  - `touch b` (utimes forward, same bytes) → rewrite; content change only, nothing racy → no rewrite; racy-only (entry mtime set equal to the index mtime, ns included) → rewrite.
  - `status(ctx, { refresh: false })` and env `GIT_OPTIONAL_LOCKS=0` → no rewrite; `=2` → rewrite (git agrees); `=bogus` → `ENV_BAD_BOOLEAN_VALUE` data field by field, and git exits 128 with `fatal: bad boolean environment value 'bogus' for 'GIT_OPTIONAL_LOCKS'` — compare `'fatal: ' + err.message` to git's stderr line.
  - empty `index.lock` present → no rewrite, lock still 0 bytes, one warn `{ code: 'FILE_EXISTS', path }`, tsgit result equals git's `status --porcelain=v2` reconstructed from the structured fields (reuse the reconstruction helper in test/integration/status-interop.test.ts if it has one).
  - readback: after a tsgit refresh write, git `status --porcelain=v2` equals tsgit's reconstructed result and `git fsck` exits 0.
  - SHA-256 twin (`git init --object-format=sha256`): `touch b` → rewrite; `git fsck` exit 0.
  - posix-only file: skip when `process.getuid?.() === 0`; `chmod a-w .git` → no rewrite, no throw, one warn whose `code` is `PERMISSION_DENIED`; `chmod a-w .git/index` with the directory writable → rewritten (rename replaces the read-only file). Restore modes in `afterEach`.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. GUARD — every row above is expected green against Parts 13–19 (this part adds no `src`). A red row is a real divergence from git: reproduce it, fix the `src` cause in this part only if it is a one-site fix inside the status/index-lock code already named by Parts 13–19 (state file:line and the failing output in the handback); otherwise stop and hand back `{ unit, reason, ≤3 options }`.
2. GUARD — the existing suites stay green: status-racy-clean-interop, index-racy-smudge-interop, status-interop.

### Gate
`PATH=<git-2.55.0-bin>:$PATH npx vitest run --project integration test/integration/status-refresh-interop.test.ts test/integration/status-racy-clean-interop.test.ts test/integration/index-racy-smudge-interop.test.ts test/integration/status-interop.test.ts && PATH=<git-2.55.0-bin>:$PATH npx vitest run --project posix-integration test/integration/posix-only/status-refresh-readonly-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/status-refresh-interop.test.ts test/integration/posix-only/status-refresh-readonly-interop.test.ts && npm run check:spelling`

### Commit
`test(status): pin refresh write-back against git`

## Part 24 — Interop harness: extension carry per writer class

### Context
- Harness-only part. Create `test/integration/index-extensions-interop.test.ts` (`@proves` header like test/integration/index-interop.test.ts, `surface: index`, `interopSurface: index`).
- Base built by git IN PLACE (the `UNTR` ident embeds the worktree path; a copy resets it), design §D1.5: files `a b d/c d/e/f x/y` committed; a conflicted merge on `m` resolved with `git add m` + commit → `REUC`; `git -c core.untrackedCache=true status` twice → `UNTR`; `TREE` from the commit. Append `ZZZZ` by splicing bytes: strip the trailer, append `ZZZZ`, a big-endian u32 length 4, `de ad be ef`, then the SHA-1 of the new payload (`node:crypto`); sanity: `git status` stderr contains `ignoring ZZZZ extension`.
- For each tsgit writer of §D4.4 that has a §D1.5 git row (add modified, add new, add -A, rm, rm --cached, mv, mixed reset, reset --hard, checkout branch, checkout -- path, checkout branch -- path, merge clean and conflicted, cherry-pick, stash push and apply, sparse-checkout set), read extensions with tsgit `readIndex` (fresh context, `parseCacheTree` for `TREE`) and assert: `ZZZZ` absent; `REUC` present-and-identical or absent per the column; `UNTR` per the tracked-set rule; `TREE` — `update` rows: the set of valid nodes equals git's valid nodes for the same command run by git on a twin repo built identically (`makePeerPair`; TREE oids are content-addressed so the twins agree); `replace` rows: every valid node's oid equals `git rev-parse HEAD:<dir>` (root: `HEAD^{tree}`) after the command; every row: `git fsck` exits 0.
- add rows (add modified, add new, add -A, `touch b` then `add b`, `add b` with the stat unchanged, `add --renormalize .` with no content change): assert the `TREE` payload bytes EQUAL git's for the same command on the twin (`toEqual` on `Uint8Array`), not just the valid-node oids.
- SHA-256 twin: the `add d/c` row in a `--object-format=sha256` repo (`createNodeContext({ workDir, algorithm: 'sha256' })`).
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. GUARD — all rows expected green against Parts 3–13. A red row is a divergence: same rule as Part 23 step 1 (one-site fix in the carry/lock code with file:line and output, else hand back).
2. GUARD — existing interop suites that write over git-built indexes stay green: add-interop, rm-interop, stash-interop, index-interop, index-racy-smudge-interop, fsck-interop.

### Gate
`PATH=<git-2.55.0-bin>:$PATH npx vitest run --project integration test/integration/index-extensions-interop.test.ts test/integration/add-interop.test.ts test/integration/rm-interop.test.ts test/integration/stash-interop.test.ts test/integration/index-interop.test.ts test/integration/index-racy-smudge-interop.test.ts test/integration/fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/index-extensions-interop.test.ts && npm run check:spelling`

### Commit
`test(index): pin extension carry per writer against git`

## Part 25 — Benches: settled vs stat-invalid `status`, `stash` round trip

### Context
- Bench-harness part (no `src` delta). Benches load as native modules (#312; vitest.bench.config.ts registers the transpile hook); vitest bench hooks do not run, so all setup happens in the scenario builder.
- `test/bench/status.bench.ts` (today one tiered scenario on the SHARED read-only fixture, `tieredScenario(MULTI_TIERS, …)` from test/bench/support/tiered-bench.ts). `status` now writes, so each tier copies first with `copyFixtureToScratch(fixture.cwd)` (test/bench/support/fixture-scratch.ts line 57; teardown pattern with `removeSync` in test/bench/checkout.bench.ts lines 31-99). Two scenarios per tier (design §D6):
  - settled: copy → wait 1.1 s (copy mtimes leave the index's second) → one unmeasured `repo.status()` (the refresh write) → measure `repo.status()`.
  - stat-invalid: copy → measure `repo.status({ refresh: false })` (stays stat-invalid every iteration; reproduces the CI tar-restore shape).
  - isomorphic-git `statusMatrix` baseline on both, against the scratch `cwd`.
  - If docs/perf/hot-paths.json (CI bench allowlist) names the old status scenario title, keep its key valid (update the entry, do not drop the row) and say so.
- `test/bench/stash.bench.ts` (new) + `buildStashScratch(modified: number, untracked: number)` in `test/bench/support/write-scratch.ts` (pattern: `buildAddManyScratch`, `newScratch`, `disposeSync`): measure `stash push` with untracked + `stash pop` as one round trip through the facade's stash namespace (find the method names in src/repository.ts `bindStashNamespace`), so every iteration starts dirty. No isomorphic-git baseline.
- grep test/bench for other `status(` callers on shared fixtures (status-dirty.bench.ts already uses its own repo) and copy-first any you find.
- Measurement (after the commit; `bench:ab` measures COMMITTED refs): quiet-machine check first (`uptime` load low, `pgrep -fl stryker` empty, no other session benching); then `npm run bench:ab -- main HEAD` as a directional probe. Report main vs HEAD for the shared rows and the absolute figures of the new rows. Then `npm run check:size`: green → say so; red → DC-P4: hand back the per-row deltas, do not touch .size-limit.json.
- PR note to carry in the handback (design §D6): the nightly `status` row changes meaning from "CI tar-restored fixture, stat-invalid, every call re-hashes" to "settled, stat-valid"; the stat-invalid figure moves to the new row.
- Standing rules: (1) When an existing test row breaks, decide whether the OLD expectation encoded the contract. If it did, fix the code, not the row, and say so. (2) `statSync(…, { throwIfNoEntry: false })` swallows ENOTDIR — probes that must refuse NOT_A_DIRECTORY use the throwing helpers. (3) Never run two wireit scripts concurrently in one tree; check `git diff --stat` shows a scripted edit before trusting a gate. (4) Poll, never end your turn waiting on a background notification. (5) Second-resolution memory adapter: tests asserting "no write" must advance the clock (ADR-960).

### TDD steps
1. GUARD — smoke-run both bench files once (`npx vitest bench --run --config vitest.bench.config.ts test/bench/status.bench.ts test/bench/stash.bench.ts`); each scenario registers and completes; no scratch directory left behind (`ls` the fixture cache dir for `*.scratch.*`).
2. GUARD — settled row: assert in the builder, once, that the measured `status()` leaves the index inode unchanged (it is read-only after settling); stat-invalid row: same for `refresh: false`.
3. Commit, then the measurement probe and `check:size` (Context).

### Gate
`npx vitest bench --run --config vitest.bench.config.ts test/bench/status.bench.ts test/bench/stash.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/status.bench.ts test/bench/stash.bench.ts test/bench/support/write-scratch.ts && npm run check:spelling`

### Commit
`test(bench): status settled and stat-invalid rows, stash round trip`
