# Plan — session caches and the per-command floor

> Source: design doc `docs/design/session-caches-per-command-floor.md` · spike
> `docs/spike/config-validation-tier.md` · ADRs 850, 851, 852, 853, 854, 855, 856, 857, 858,
> 859, 860, 861, 862 (all accepted); supersedes in scope ADR-064, 637, 726, 727, 736.
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

**Thirteen parts, seventeen commits.** The partition is the design's own (design §"Partition
proposal", re-derived three times against the ADRs); its ordering constraints are load-bearing
and are restated per part. **No deviation from that partition** — the only corrections are file
paths and line anchors re-verified against the worktree (three ADRs' `subjects:` metadata
entries name `primitives/internal/…` for files that live at `primitives/…`; the design's own
table has the right paths and this plan uses the verified ones).

`plan-lint` warns when two parts' `### Context` blocks name the same file. Several do —
`config-read.ts` (Parts 4, 6, 10), `internal/repo-state.ts` (Parts 6, 9, 10), `ref-store.ts`
(Parts 9, 11), `object-caches.ts` (Parts 3, 7, 8), `object-resolver.ts` (Parts 7, 8),
`reflog.ts` (Parts 6, 11, 12), `branch.ts` (Parts 5, 6). Every one is a **different function in
the same file**, enumerated in the design's cross-item ownership table and repeated in the part
blocks. The warnings are expected and are not a merge signal.
`reports/api.json` is declared in four parts (2, 3, 4, 8) — that is the design's own count of
public-surface regenerations, and it is shared infrastructure rather than a shared unit of work.

## Release line

This is the **v5** line. Exactly one commit is breaking: **Part 8, commit 2**, typed
`feat(objects)!:` — ADR-854 flips `Context.deltaCache` from `LruCache<Uint8Array>` to
`LruCache<ObjectContent>` and `RawObject` loses `bytes`. ADR-862's narrowing of the Tier-2
`writeObject` contract (it can now refuse `CONFIG_BAD_NUMERIC_VALUE`) is a **behaviour**
narrowing on a primitive, not a type change; it lands in Part 6 commit 1 as `feat(config):`
without `!`, and is documented on `docs/use/primitives/write-object.md` by the docs phase.
No other part carries `!`.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- **Part 1 is the only test-infra-only part** (`test/bench/**`, zero `src/` delta) and takes the
  exception deliberately: it must land first so every later part's `bench:ab` has a
  before-series on the same snapshot keys.

## The part gate, and its two traps

Every part's `### Gate` resolves this command with literal, space-separated paths:

```
npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling
```

**Trap 1 — wireit cache hits read like passes.** `npm run check:types` and
`npm run check:spelling` are wireit-cached; on a cache hit they print
`Ran 0 scripts and skipped 1`, which is indistinguishable from a pass at a glance. When a gate
must be *proved*, use the bare bypasses:

```
npx tsc --noEmit -p tsconfig.json
npx cspell --no-progress <files>          # never pass cspell.json itself as a target
```

**Trap 2 — the shell is zsh.** An unquoted `$FILES` holding several paths is passed as **one**
argument: `biome check $FILES` then errors on a bogus concatenated path, and `cspell $FILES`
checks zero files and exits 0. A gate that checked zero files is not a green gate. Write the
paths out literally; if you must use a variable, use a zsh array (`${(@)files}`).

**New words.** `check:spelling` reads `cspell.json`'s `words` array (1 248 entries today). New
identifiers introduced here may need an entry — in particular the **lowercased** config-key
spellings, because git prints config keys lowercased and the refusal assertions quote them
verbatim, plus the new module basenames. Add each to `cspell.json`'s `words`, keep the array
sorted, and never pass `cspell.json` itself as a lint target.

**Phase gate** (not per part): `npm run validate`. Two extra checks are named per part where the
change trips them: `npm run check:architecture` (depcruise `no-circular`, the oracle for every
new import edge) and `npm run docs:json` (regenerates `reports/api.json` — a **prepush** gate,
not a validate gate, so it must be pre-paid in the part that changes a public symbol).
`npm run check:size` / `check:tarball` can read falsely red off a stale build — `rm -rf dist
.wireit` and rebuild before believing either.

## Beyond part-level TDD: smokes and probes

| Part | Extra step | Why |
|---|---|---|
| **1** (harness) | **Full-suite bench smoke**: `npx vitest bench --run` over the three touched bench files, and confirm the scratch repos are actually removed afterwards | Bench files touch harness hooks and prove nothing at part-TDD level. `afterAll` never runs under `vitest bench` and tinybench teardown is un-awaited — cleanup must go through `BenchComparison.teardown` + `removeSync`, not a hook. A warm-up error is swallowed as a zero-sample pass, so assert `sampleCount > 0` per row. |
| **4** (async registry) | **Measurement probe**: `npm run bench:ab -- main feat/session-caches-per-command-floor 2` over `log.bench`, `cat-file.bench`, `delta-chain-read.bench` | 19 call sites gain a promise hop on the object-read hot path and the registry's construction becomes async behind a single-flight memo. Reviewer reading cannot see a hop regression; only absolute wall-clock main-vs-branch can. |
| **6** (repo-settings tier) | **Measurement probe**: `bench:ab` `log.bench` both rows | `commitHeader` runs once per walked commit and `getPackRegistry` once per object read; the design's whole reason for the synchronous `repoSettingsVerdictSettled` fast path is ≈ 1–2 ms per 5 000-commit `log`. The estimate is unverified — this bench is its oracle. |
| **8** (`{ type, content }`) | **Measurement probe**: `bench:ab` `delta-chain-read.bench` (all three rows) + `loose-read.bench` (both rows) | The change removes one content-sized copy per pack-resolved read and moves a hash onto the verify path. It also changes the **public type surface** and therefore the emitted `.d.ts` shape — run `npm run check:size` and `check:exports` fresh (after `rm -rf dist .wireit`) before committing. |
| **11** (pooled enumeration) | Non-regression re-run of `packed-refs-interop.test.ts` and `pack-refs-interop.test.ts` unchanged | The design's contract is "must not move a byte"; the unit in-flight counter proves pooling, the interop re-run proves byte-identity. |

**Verification discipline.** Any "pre-existing failure" claim must be verified against `main`,
never against an earlier commit on this branch. Any scripted edit (python `str.replace`,
`sed -i`) anchored on statement text must be confirmed with `git diff --stat` before the gate is
trusted — biome re-wraps lines and a silent no-op edit produces a green gate over unchanged code.
A fix batch that adds a guard arm without its own test row turns the 100 % coverage gate red at
the next full validate: run a scoped coverage check on the touched file before committing.

## Part 1 — Harness: tag-list and branch-list benches, rev-parse abbreviated-oid row (design P0, D11)

### Context

Test-infra only. **Zero `src/` delta.** Lands first so every later part's `bench:ab` has a
before-series on the same `gh-pages` snapshot keys (`tooling/bench-to-snapshot.ts`); three new
series start and none end, so `bench:check` reports them `new`, which is non-blocking.

**Files to create**
- `test/bench/tag-list.bench.ts` — rows `When tag.list() lists 2000 packed tags, Then measure tsgit`
  and `When tag.list() lists 10000 packed tags, Then measure tsgit`.
- `test/bench/branch-list.bench.ts` — row `When branch.list() lists 1000 loose branches, Then measure tsgit`.

**File to edit**
- `test/bench/rev-parse.bench.ts` — add row `When revParse() resolves an abbreviated oid, Then measure tsgit`
  (7-hex prefix of the medium fixture's head commit). The file today has the HEAD row only.

**Helpers to extend — verified paths and line anchors**
- `setupSmallRepo(opts: { commits?: number } = {}): Promise<BenchRepo>` — `test/bench/fixtures.ts:50`.
- `removeSync(dir: string): void` — `test/bench/support/fixture-scratch.ts:43`.
- `resolveScaledContext(spec?: FixtureSpec)` — `test/bench/support/scaled-bench.ts:41`;
  `scaledScenario(…)` — `:56`.
- `benchScenario(…)` — `test/bench/support/bench-dsl.ts:107`; `hooksFor(comparison)` — `:90`;
  `onMeasuredRun` — `:61`.
- **Pattern to copy:** `test/bench/name-rev.bench.ts` — the many-tag in-process fixture built
  with tsgit's own primitives (`createNodeContext`, `updateRef`, `writeObject`, `writeTree`,
  `createCommit`), scrubbed `GIT_*` env, `removeSync` teardown. Build the fixtures **in-process
  with tsgit primitives, never by spawning `git`**, and never against the shared bench cache.

**Primitives used to build the fixtures**
- `updateRef` — `src/application/primitives/update-ref.ts`.
- `repo.packRefs()` — the `Repository` facade binding (ADR-707 surface).
- `boundedMapFor(ctx, 'ioBound', items, worker)` — `src/application/primitives/internal/concurrency.ts:53`
  — for populating N refs without a serial loop.

**Pinned behaviour the fixture builder must assert**
- After `repo.packRefs()`, `refs/tags/` holds **no loose files** — every tag must be packed-only,
  or the bench measures the loose path and item (f) has no oracle.

**Not committed:** `fs-count.cjs` (verbatim from `.claude/perf-31-1-closure-walks-prompt.md:107-113`)
and `floor-oracle.mjs`. These are implementation-time scratch scripts; their before/after tables
go in the **PR body**, per the 31.1 precedent. `docs/perf/baseline.*` is **not** regenerated —
the `profile` workload set is unchanged.

### TDD steps

1. **RED** — `npx vitest bench --run test/bench/tag-list.bench.ts`. Fails: *no test files found*
   (the file does not exist). This is the honest failing-first oracle for a bench part; there is
   no unit assertion that can precede a bench file's existence.
2. **GREEN** — write `tag-list.bench.ts`: `setupSmallRepo()` base, N lightweight tags via
   `updateRef` under `boundedMapFor`, then `repo.packRefs()`; two rows (2 000 / 10 000). Inside
   the fixture builder, throw if `refs/tags/` still holds loose entries after packing.
3. **RED** — same for `test/bench/branch-list.bench.ts` (1 000 loose branches via `updateRef`, no
   `packRefs`).
4. **GREEN** — write it.
5. **RED** — `npx vitest bench --run test/bench/rev-parse.bench.ts` and observe only the HEAD row
   in `raw.json`.
6. **GREEN** — add the abbreviated-oid row (resolve the medium head commit, take its 7-hex
   prefix).
7. **Full-suite bench smoke (mandatory for this part)** — `npx vitest bench --run` over the three
   files; assert **every** entry in `raw.json` has `sampleCount > 0` (a warm-up error is swallowed
   as a zero-sample pass, so a "green" run with a zero-sample row is a failure). Confirm the
   scratch directories are gone afterwards; if they are not, the teardown is riding on a dead
   `afterAll` — move it to `BenchComparison.teardown` + `removeSync`.
8. **REFACTOR** — lift any duplicated env-scrubbing / fixture-population helper shared by the two
   new files into `test/bench/fixtures.ts` beside `setupSmallRepo`.

### Gate

```
npx vitest bench --run test/bench/tag-list.bench.ts test/bench/branch-list.bench.ts test/bench/rev-parse.bench.ts && npm run check:types && ./node_modules/.bin/biome check test/bench/tag-list.bench.ts test/bench/branch-list.bench.ts test/bench/rev-parse.bench.ts test/bench/fixtures.ts && npm run check:spelling
```

Bare bypasses if either wireit script reports `Ran 0 scripts and skipped 1`:
`npx tsc --noEmit -p tsconfig.json` and
`npx cspell --no-progress test/bench/tag-list.bench.ts test/bench/branch-list.bench.ts test/bench/rev-parse.bench.ts`.

**Surface gates tripped:** none (`test/**` only — no barrel, no `reports/api.json`, no doc page,
no error code). `check:test-pyramid` counts bench files in their own tier; run
`npm run check:test-pyramid` once before committing.

### Commit

`test(bench): add tag-list and branch-list benches and a rev-parse abbreviated-oid row`

## Part 2 — `LruCache.set` reports its over-cap refusal (design P1, D1, ADR-853)

### Context

**Public type change** — `LruCache<V>` is exported from `src/domain/storage/index.ts` and is
reachable through `Context.deltaCache` (`src/ports/context.ts:219`, mirrored at `:281`); 25 hits
in `reports/api.json`. The return type of `set` changes from `void` to `boolean`. No call site's
behaviour changes.

**File to edit**
- `src/domain/storage/lru-cache.ts` — verified anchors:
  - `:3` the interface member `set(key: string, value: V, byteSize: number): void;` → `: boolean`,
    with the doc comment the design writes out in D1.
  - `:20-21` `createLruCache<V>(maxSizeBytes: number, maxEntries = ∞)` — **unchanged**; it still
    performs no validation of `maxSizeBytes` and `0` is still accepted (a `0` cache refuses every
    `set`; ADR-852 relies on that for a git-legal `core.deltaBaseCacheLimit = 0`).
  - `:92` the implementation `set(key, value, byteSize): void` → `: boolean`.
  - `:93-95` the `byteSize <= 0` **throw** is unchanged — a refusal is a sizing fact, a
    non-positive size is a caller bug, and the two must stay distinguishable.
  - `:96-98` the over-cap early return → `return false`.
  - after `evict()` (around `:113`) → `return true`.
  - `:57` `evict()`'s `while ((currentSize > maxSizeBytes || map.size > maxEntries) && tail !== null)`
    — untouched.

**Nine `set` call sites, all compile unchanged** (the design's D1 table is the authority on what
each does with the verdict; none branches on `false` at runtime):
`src/application/primitives/read-head-tree.ts:136`, `object-resolver.ts:121` (memo) and `:702`
(`cacheEntry`), `internal/object-caches.ts:273` (`cacheDeltaBase`), `internal/index-pack.ts:363`
and `:558`, `load-reftable-stack.ts:276`, `internal/bitmap-reconstruct.ts:88`,
`src/adapters/node/node-file-system.ts:1115` (`parentRealpathCache`, declared at `:503`).

**Tests to extend** — `test/unit/domain/storage/lru-cache.test.ts` (677 lines):
- `:341` the "single 200-byte entry in cache(50)" case — assert the verdict is `false` **and**
  that `currentSize` / `entryCount` / iteration order are unchanged.
- `:430` the "totaling exactly 100" case — extend so a `set` at **exactly** `maxSize` returns
  `true` (this is the `>` vs `>=` boundary kill).
- `:498-575` the existing property block — add the invariant: `set` returns `false` **iff**
  `byteSize > maxSize`, and a `false` never changes `currentSize` or `entryCount`.

**Stryker directive in this file:** `lru-cache.ts:106` (ConditionalExpression — relink fast path)
is on an untouched line; re-run, do not re-prove.

### TDD steps

1. **RED** — in `lru-cache.test.ts`, assert `sut.set('big', value, 200)` returns `false` for a
   `createLruCache(50)`. Fails to compile / fails at runtime: `set` returns `void`, so the
   expectation reads `undefined`.
2. **RED** — assert an in-cap `set` returns `true`, and that a `set` at exactly `maxSize` returns
   `true`. Same failure.
3. **GREEN** — change the interface member at `:3` and the implementation at `:92`; `return false`
   at `:96-98`, `return true` after `evict()`.
4. **RED** — add the property invariant to the `:498-575` block; it should pass immediately if
   step 3 is right, and it is the regression net, so write it and watch it go green rather than
   red-first (it is an invariant over already-correct behaviour, not new behaviour).
5. **REFACTOR** — none expected; the body is four lines. Do **not** add a counter, a logger or a
   typed verdict — ADR-853 records all three as rejected so they are not re-proposed.
6. **Pre-pay the surface gate** — `npm run docs:json`, commit the regenerated `reports/api.json`
   in this same commit.

### Gate

```
npx vitest run test/unit/domain/storage/lru-cache.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/lru-cache.ts test/unit/domain/storage/lru-cache.test.ts && npm run check:spelling
```

Then, before committing: `npm run docs:json` and `git add reports/api.json`.

**Surface gates tripped:** `reports/api.json` (public `LruCache.set` signature) — a **prepush**
gate, pre-paid here. No barrel change (the type is already exported), no new error code, no doc
page required by `check:doc-coverage`. The `LruCache.set` verdict is mentioned on
`docs/use/primitives/internals.md` by the docs phase — declared here, not written here.

### Commit

`feat(storage): report an over-cap LruCache refusal as a boolean`

## Part 3 — Entry-bound memo, FlatTree budget, five validated options, `cacheBudgets` (design P2, D2-i, ADR-851)

### Context

**Depends on Part 2** — the two invariant tests read `set`'s verdict.

The defect: both derived caches take `1/16 × deltaCacheMaxBytes` (1 MiB at the default). The memo
charges 256 B fixed per entry, so its byte cap binds at **≤ 4 096 entries** and a 5 000-commit
walk in the same order hits ≈ 0 %. The FlatTree holds ≈ 6 400 tracked files in 1 MiB and the
medium HEAD tree is 3.3 MB, so `readHeadTree` is refused on **every** `status`.

**Files to edit — verified anchors**
- `src/application/primitives/internal/object-caches.ts`
  - `:81` `export const PARSED_OBJECT_MEMO_FRACTION = 0.0625` → **retired**, replaced by
    `export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 512`.
  - `:92` `export const PARSED_OBJECT_MEMO_MAX_ENTRIES = 65_536` → **removed** (ADR-851: a second
    fixed cap would either never bind or silently re-create the cliff).
  - `:99-100` the `createLruCache(ctx.deltaCache.maxSize * PARSED_OBJECT_MEMO_FRACTION, PARSED_OBJECT_MEMO_MAX_ENTRIES)`
    call inside `parsedObjectMemoFor` (`:94-104`) → `createLruCache(memoByteValve(ctx), memoMaxEntries(ctx))`
    where `memoByteValve = (ctx) => ctx.deltaCache.maxSize` and
    `memoMaxEntries = (ctx) => ctx.cacheBudgets?.parsedObjectMemoMaxEntries ?? Math.floor(memoByteValve(ctx) / PARSED_OBJECT_TYPICAL_ENTRY_BYTES)`.
  - `:132` `const PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 256` and the sizer at `:149-171` —
    **unchanged**.
  - `:117` `forgetParsedObjectMemo` — unchanged.
  - The module's own **fraction-sweep table** in the header comment (`:55-79`) is replaced by the
    entry-bound rationale plus a pointer to the medium-fixture A/B. The sweep was taken on the
    medium fixture, i.e. entirely on the wrong side of the cliff, and concluded the fraction did
    not matter; leaving it is leaving a wrong conclusion in the code.
  - Add `budgetsFor(ctx)` here — the single resolver for the two synchronous budgets, shaped on
    the existing `concurrency?` / `limitFor` house pattern.
- `src/application/primitives/read-head-tree.ts`
  - `:50` `FLAT_TREE_CACHE_FRACTION = 0.0625` → `export const FLAT_TREE_TYPICAL_ENTRY_BYTES = 164`
    plus `const FLAT_TREE_DEFAULT_SHARE = 0.5`.
  - `:62` `FLAT_TREE_CACHE_MAX_ENTRIES = 65_536` — **kept** (the FlatTree's bound is bytes; the
    entry cap is the secondary guard).
  - `:64-74` `flatTreeCacheFor(ctx)` → `createLruCache(flatTreeMaxBytes(ctx), FLAT_TREE_CACHE_MAX_ENTRIES)`
    where `flatTreeMaxBytes = (ctx) => ctx.cacheBudgets?.flatTreeCacheMaxBytes ?? ctx.deltaCache.maxSize * FLAT_TREE_DEFAULT_SHARE`.
  - `:112-118` `flatTreeByteSize` (48 + Σ(path + oid + 110)) — unchanged; `:131,136` the
    `cache?.set(key, tree, flatTreeByteSize(tree))` call — unchanged except that its verdict is
    now asserted in tests.
  - Carried forward from ADR-726: the `(rootTreeOid, maxDepth)` key, gitlink preservation, the
    floor-at-1 sizer.
- `src/ports/context.ts` — add `readonly cacheBudgets?: CacheBudgets` beside `readonly concurrency?: ConcurrencyLimits`
  (`:226-230`), on the `Context` interface (near `:219`) **and** the `RepositoryHandle` mirror
  (near `:281-282`). `CacheBudgets = { readonly parsedObjectMemoMaxEntries?: number; readonly flatTreeCacheMaxBytes?: number; readonly deltaBaseCacheMaxBytes?: number }`
  — **all three optional** (the third has no synchronous default; Part 4 resolves it
  asynchronously). Frozen. Optional so every hand-built `Context` literal in the test suite keeps
  compiling and behaves as a default-budget Context.
- Five options on the three adapter option types and the three entry points — `deltaCacheMaxBytes`
  and `deltaCacheMaxEntries` exist; `parsedObjectMemoMaxEntries`, `flatTreeCacheMaxBytes`,
  `deltaBaseCacheMaxBytes` are new:
  - `src/index.node.ts:51-52` (`OpenNodeRepositoryOptions`) + the Context build at `:115`.
  - `src/index.browser.ts:42-43` + `:94-96`; note the destructure at `:106-107` that strips the
    option keys.
  - `src/index.default.ts:99` (bytes only today).
  - `src/adapters/node/node-adapter.ts:27-28` + `:71-73`.
  - `src/adapters/browser/browser-adapter.ts:21-22` + its `createLruCache` call.
  - `src/adapters/memory/memory-adapter.ts:21-22` + `:67-69`.
  - `DEFAULT_DELTA_CACHE_BYTES = 16 * 1024 * 1024` appears in six places
    (`index.node.ts:40`, `index.browser.ts:26`, `index.default.ts:30`, `node-adapter.ts:18`,
    `browser-adapter.ts`, `memory-adapter.ts:14`) — unchanged.
- `src/repository/validate-options.ts` — `interface ValidatableOptions` at `:9` gains the five
  option fields; `validateOptions` at `:37` gains five validators: `Number.isInteger(v) && v >= 0`
  else `INVALID_OPTION`. **No upper bound** — the valve is the memory guard. `0` means disabled
  for every one of them (it already does for `deltaCacheMaxBytes`, which switches the whole family
  off through `deltaBaseCachingEnabled` — preserve that). Four call sites:
  `index.node.ts:57`, `index.browser.ts:63`, `index.default.ts:47`, `repository.ts:554`.
  **Correction the design pins:** neither `deltaCacheMaxBytes` nor `deltaCacheMaxEntries` is
  validated today; a `0` or a negative silently yields a dead cache — the exact failure mode this
  part exists to remove.
- `src/repository.ts:279` (`readonly deltaCache: Context['deltaCache']` on the fallback shape) and
  `:655` (`deltaCache: fallback.deltaCache`) — the fallback shape carries `cacheBudgets` through.

**Public-surface verdict for every new symbol in this part.** `CacheBudgets` is **public** — it
names a field type on the public `Context` / `RepositoryHandle` interfaces, so it must be exported
from `src/ports/context.ts` and it lands in `reports/api.json`. The three new option fields on
`OpenNodeRepositoryOptions` / `OpenBrowserRepositoryOptions` / the memory adapter options are
**public**, same report. `PARSED_OBJECT_TYPICAL_ENTRY_BYTES`, `FLAT_TREE_TYPICAL_ENTRY_BYTES`,
`FLAT_TREE_DEFAULT_SHARE`, `budgetsFor`, `memoByteValve` and `memoMaxEntries` are **internal** —
exported only for the sibling module and the unit tests, never added to a barrel.

**Defaults at the stock dial** (`deltaCacheMaxBytes = 16 MiB`): memo valve 16 MiB, 32 768 entries;
FlatTree 8 MiB ≈ 51 k tracked files. Deriving the entry count *from* the valve rather than pinning
32 768 as a literal is what keeps ADR-851's invariant structural at every dial value — a browser
tab at 4 MiB gets 8 192 entries, still `entries × 512 ≤ valve`.

**Tests to edit**
- `test/unit/application/primitives/internal/object-caches.test.ts` (119 lines, 4 suites) — the
  fraction suite is rewritten to the entry bound.
- `test/unit/application/primitives/read-head-tree.test.ts` (473 lines) — `:171` (over-cap case),
  `:395` ("multiplied share"), `:420` rewritten for the new sizing.
- `test/unit/repository/validate-options.test.ts` — five new boundary triples.
- `test/unit/index.node.test.ts`, `test/unit/index.browser.test.ts`,
  `test/unit/adapters/memory/memory-adapter.test.ts`, `test/unit/adapters/node/node-adapter.test.ts`
  — options reach `ctx.cacheBudgets`.
- `test/unit/ports/context.test.ts` — a hand-built Context **without** `cacheBudgets` resolves the
  defaults.
- `test/unit/application/primitives/pack-registry.test.ts:2570-2596` — entry-count assertions stay
  unchanged here; the delta-base row is Part 4's.
- **`test/unit/application/primitives/object-resolver.test.ts` — the part's one non-obvious
  casualty.** It **imports the two retired constants** at `:4-5`
  (`PARSED_OBJECT_MEMO_FRACTION`, `PARSED_OBJECT_MEMO_MAX_ENTRIES`) and builds three suites on
  them: `:3618-3620` asserts `createLruCache` was called with
  `ctx.deltaCache.maxSize * PARSED_OBJECT_MEMO_FRACTION` and `PARSED_OBJECT_MEMO_MAX_ENTRIES`;
  `:3626-3654` is a whole `When more entries than PARSED_OBJECT_MEMO_MAX_ENTRIES are inserted`
  suite whose premise ("the byte share never binds") is **the defect being fixed**; `:3673` sizes
  a Context as `cap / PARSED_OBJECT_MEMO_FRACTION`. Removing the constants breaks this file's
  compile. Rewrite all three against the valve/entries pair — the `:3626` suite becomes "more
  entries than the derived cap are inserted" and keeps its `entryCount` assertion.
- `src/application/primitives/internal/index-pack.ts:134` — a **doc comment** naming
  `PARSED_OBJECT_MEMO_MAX_ENTRIES` beside `FLAT_TREE_CACHE_MAX_ENTRIES`. Not a compile break, but
  a dangling reference to a constant that no longer exists; update the sentence.
- `instrumentedContext(base)` — `test/unit/application/primitives/fixtures.ts:343` — is the
  zero-object-read oracle for the FlatTree hit.

### TDD steps

1. **RED** — `object-caches.test.ts`: insert 5 000 distinct commit-shaped entries into
   `parsedObjectMemoFor(ctx)` at the default budget and assert `entryCount === 5 000`. Fails at
   ≈ 4 096: the byte cap binds first.
2. **RED** — the valve-ordering invariant as a literal test: `32_768 × 512 ≤ 16 MiB`. Fails — the
   constants do not exist.
3. **RED** — the derivation at a non-default dial: `deltaCacheMaxBytes = 4 MiB` ⇒ 8 192 entries.
4. **GREEN** — `object-caches.ts`: `PARSED_OBJECT_TYPICAL_ENTRY_BYTES`, `memoByteValve`,
   `memoMaxEntries`, remove `PARSED_OBJECT_MEMO_FRACTION` and `PARSED_OBJECT_MEMO_MAX_ENTRIES`,
   rewrite the module header comment.
5. **RED** — `read-head-tree.test.ts`: a 20 000-entry synthetic tree at the defaults — the second
   `readHeadTree` call issues **zero** object reads (`instrumentedContext`) and the `set` verdict
   is `true`. Fails today: 3.3 MB over a 1 MiB budget, `set` refused every time.
6. **RED** — the same tree under a deliberately shrunk `flatTreeCacheMaxBytes` ⇒ `set` returns
   `false` (this is what makes a dead default impossible to ship again); and the literal invariant
   `164 × 50_000 ≤ 8 MiB`.
7. **GREEN** — `read-head-tree.ts`: `FLAT_TREE_TYPICAL_ENTRY_BYTES`, `FLAT_TREE_DEFAULT_SHARE`,
   `flatTreeMaxBytes`.
8. **RED** — `validate-options.test.ts`: each of the five options refused when non-integer or
   negative (`INVALID_OPTION` with its `data` asserted field by field — never `toThrow(Class)`
   alone), `0` accepted, defaulted when absent. Fails: `ValidatableOptions` carries none of them.
9. **RED** — `index.node.test.ts` / `index.browser.test.ts` / `memory-adapter.test.ts` /
   `node-adapter.test.ts`: a non-default `parsedObjectMemoMaxEntries` observed in the memo's
   `entryCount`; `context.test.ts`: a Context without `cacheBudgets` resolves defaults.
10. **GREEN** — `ports/context.ts` `cacheBudgets`, the seven entry/adapter wiring points,
    `validate-options.ts`.
11. **REFACTOR** — collapse the two synchronous resolvers behind one `budgetsFor(ctx)` in
    `object-caches.ts`; keep `read-head-tree.ts` importing it rather than re-deriving.
12. **Pre-pay the surface gate** — `npm run docs:json`, commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/primitives/internal/object-caches.test.ts test/unit/application/primitives/read-head-tree.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/repository/validate-options.test.ts test/unit/index.node.test.ts test/unit/index.browser.test.ts test/unit/adapters/memory/memory-adapter.test.ts test/unit/adapters/node/node-adapter.test.ts test/unit/ports/context.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/object-caches.ts src/application/primitives/read-head-tree.ts src/application/primitives/internal/index-pack.ts src/ports/context.ts src/index.node.ts src/index.browser.ts src/index.default.ts src/adapters/node/node-adapter.ts src/adapters/browser/browser-adapter.ts src/adapters/memory/memory-adapter.ts src/repository/validate-options.ts src/repository.ts && npm run check:spelling
```

Then `npm run docs:json` and `git add reports/api.json`.

**Surface gates tripped:** `reports/api.json` (`Context`/`RepositoryHandle` gain `cacheBudgets`;
`OpenNodeRepositoryOptions`, `OpenBrowserRepositoryOptions` and the memory adapter options gain
three fields each) — prepush gate, pre-paid here. **Doc debt declared:** the three new options
belong wherever `deltaCacheMaxEntries` is documented today (`docs/understand/architecture.md` is
the only non-design hit) and `docs/use/primitives/internals.md`'s `parsedObjectMemoFor` /
`readHeadTree` paragraphs plus the family-total sentence — the docs phase writes them; nothing
mechanical fails if they lag. No new error code, no barrel change, no Tier-1 command.

### Commit

`feat(cache): bound the parsed-object memo by entries and give the flat-tree cache its own budget`

## Part 4 — `core.deltaBaseCacheLimit` budget and the async pack registry (design P3, D2-ii, ADR-852 + ADR-858)

### Context

**Depends on Part 3** (`cacheBudgets`). **Must precede Part 6** — Part 6's class check is
`createPackRegistry`'s first `await`, and it needs the lenient parse this part adds.

**Transitional state, stated so it is not mistaken for a bug:** until Part 6 lands, a malformed
`core.deltaBaseCacheLimit` is **lenient** (parsed as absent → 96 MiB default). That is a
branch-internal state, never a release. **Write no interop row for the key in this part.**

**Public-surface verdict for every new symbol in this part.**
`ParsedConfig.core.deltaBaseCacheLimit` is **public** (`ParsedConfig` has 5 hits in
`reports/api.json`) — regenerate the report in this part.
`GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES` and `deltaBaseCacheBudgetFor` are **internal**: the
module lives under `primitives/internal/` and is never added to `primitives/index.ts`. The
`createPackRegistry` / `getPackRegistry` async flip touches **no** public name — neither they nor
`PackRegistry` nor `DeltaBaseCacheEntry` appear in the report.

**Git's mechanism (pinned C1–C5, design §C).** Unsigned-long grammar: decimal / `0x` hex /
leading-`0` octal, one optional `k`/`K`/`m`/`M`/`g`/`G` unit (× 1024ⁿ); `0` is accepted; `-1`,
`abc`, `96x`, `1.5m`, an empty value and a valueless key are all `invalid unit`; `99999999999999g`
is `out of range`. Resolution is **last-wins**. Git's default is `96 * 1024 * 1024` bytes.

**Files to edit — verified anchors**
- `src/application/primitives/config-read.ts` (71.7 KB) — **lenient parse only; the finder is
  Part 6's**:
  - `ParsedConfig.core` (the typed record around `:44-57`; `maxTreeDepth?: number` is at `:57`)
    gains `readonly deltaBaseCacheLimit?: number` with the doc comment "unsigned-long bytes; absent
    when unset or malformed (lenient read)".
  - `interface MutableCore` (around `:855-870`, `maxTreeDepth?: number` at `:865`) gains the field.
  - New `applyDeltaBaseCacheLimitEntry` beside `applyMaxTreeDepthEntry` (`:900-905`), reusing
    `checkPackWindowMemoryBound` (`:1238-1245`) — that is git's **unsigned-long** grammar
    (`parseGitInt(value, GIT_UINT64_MAX)`, negative ⇒ `'invalid unit'`), the same check
    `pack.windowMemory` uses at `:1253`.
  - `applyCoreEntry`'s dispatch (`:943-959`, where `:959` routes `MAX_TREE_DEPTH_KEY`) gains the
    new key constant.
  - `finalizeCore` (`:1450-1466`, spreading `maxTreeDepth` at `:1465`) spreads the new field the
    same way. Also the mirror type at `:1531`.
  - A value above `Number.MAX_SAFE_INTEGER` becomes an inexact `number`; it is a comparison bound
    for `LruCache`, never arithmetic, so the inexactness is harmless — say so in the doc comment.
- **New** `src/application/primitives/internal/resolve-delta-base-cache-limit.ts`:
  ```ts
  export const GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES = 96 * 1024 * 1024;
  export const deltaBaseCacheBudgetFor = async (ctx: Context): Promise<number> =>
    ctx.cacheBudgets?.deltaBaseCacheMaxBytes ??
    (await readConfig(ctx)).core?.deltaBaseCacheLimit ??
    GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES;
  ```
  **No refusal here** — ADR-858's precedence is option ⊳ key ⊳ default, and when the option is
  supplied the key is **neither read nor validated** (git's `-c`, pin C5). It lives in its own
  module so `pack-registry.ts` gains no runtime edge into `object-caches.ts`.
  There is **no** `resolveDeltaBaseCacheLimit` lazy twin of `resolveMaxTreeDepth` — the twin
  exists for `core.maxTreeDepth` because tree walks can run ahead of the store boundary; this
  key's only consumer *is* the store boundary, so a twin would be dead code.
- `src/application/primitives/pack-registry.ts`:
  - `:631` `export function createPackRegistry(ctx: Context): PackRegistry` → `export async function createPackRegistry(ctx: Context): Promise<PackRegistry>`.
  - `:640-642` `createLruCache<DeltaBaseCacheEntry>(ctx.deltaCache.maxSize, DELTA_BASE_CACHE_MAX_ENTRIES)`
    → `createLruCache<DeltaBaseCacheEntry>(await deltaBaseCacheBudgetFor(ctx), DELTA_BASE_CACHE_MAX_ENTRIES)`.
  - `:629` `DELTA_BASE_CACHE_MAX_ENTRIES = 65_536` — **carried forward** (ADR-852). The crossover
    is a 1 536 B mean entry; the cap is the right order of magnitude and does not move.
  - The comment at `:633-639` (already says *additive*, not "shared") is rewritten to name the key.
  - `:187-199` `DeltaBaseCacheEntry = { type, content, chainDepth }`, `:313`
    `readonly deltaBaseCache: LruCache<DeltaBaseCacheEntry>`, `:919`/`:961` `clear` on
    refresh/dispose — unchanged.
  - `deltaBaseCachingEnabled(ctx)` (`ctx.deltaCache.maxSize > 0`) stays the family gate. A
    git-legal `core.deltaBaseCacheLimit = 0` yields `createLruCache(0)` whose every `set` is
    refused — the cache is inert, `probe` always misses, exactly git's "limit 0" outcome.
- `src/application/primitives/read-object.ts`:
  - `:39` `const registryCache = new WeakMap<Context['session'], PackRegistry>()` →
    `registryMemos: WeakMap<Context['session'], PromiseMemo<PackRegistry>>` **plus**
    `resolvedRegistries: WeakMap<Context['session'], PackRegistry>` for the two sync/void helpers.
  - `:47-53` `export function getPackRegistry(ctx): PackRegistry` → `export const getPackRegistry = async (ctx): Promise<PackRegistry>`.
  - `:63-65` `refreshPackRegistry(ctx): void` → `resolvedRegistries.get(ctx.session)?.refresh()`
    (a registry still constructing has not scanned yet — nothing to refresh).
  - `:72-74` `disposePackRegistry(ctx): Promise<void>` → `await (await registryMemos.get(ctx.session)?.peek())?.dispose()`.
  - Memo: `createPromiseMemo` — `src/application/primitives/internal/promise-memo.ts:22`
    (`PromiseMemo<T>` at `:13`, `peek` at `:17`/`:37`). **A rejection clears the slot** (`:24-31`)
    — Part 6's class refusal relies on exactly that.

**The 19 `getPackRegistry` call sites + 1 `createPackRegistry` (verified — every one is already
inside an `async` function; none of these names is public).** Five of them **chain** and need a
parenthesised await, not a naive `await` prefix:

| Site | Today | After |
|---|---|---|
| `resolve-oid-prefix.ts:54` | `await getPackRegistry(ctx).all()` | `(await getPackRegistry(ctx)).all()` |
| `has-object.ts:14` | `await getPackRegistry(ctx).lookup(id)` | `(await getPackRegistry(ctx)).lookup(id)` |
| `internal/blob-source.ts:86` | `await getPackRegistry(ctx).assertLoadable()` | `(await getPackRegistry(ctx)).assertLoadable()` |
| `commands/internal/fsck/object-presence.ts:46` | `(await getPackRegistry(ctx).lookup(id)) !== undefined` | `(await (await getPackRegistry(ctx)).lookup(id)) !== undefined` |
| `commands/internal/gc-pipeline.ts:1069` | `await getPackRegistry(ctx).all()` | `(await getPackRegistry(ctx)).all()` |

The remaining fourteen are plain `const registry = getPackRegistry(ctx)` → `= await getPackRegistry(ctx)`:
`read-object.ts:154`, `:166`, `:228`; `enumerate-objects.ts:34`; `internal/closure-engine.ts:337`;
`internal/blob-source.ts:102`; `commands/internal/gc-pipeline.ts:829`, `:870`;
`commands/internal/fsck/pack-health.ts:34`, `bitmap-health.ts:58`, `midx-health.ts:42`,
`rev-index-health.ts:106`, `object-cache.ts:276`. Plus `commands/fetch-missing.ts:66`
`const registry = createPackRegistry(ctx)` → `await createPackRegistry(ctx)` (its **private**
construction never goes through `getPackRegistry`).

**Stryker directives to re-prove after this part:** `gc-pipeline.ts:1067` (CallExpression on the
`refreshPackRegistry` line, whose equivalence argument is about the dirty-flag model — the
argument survives, the line moves) and the `getPackRegistry` line at `:1069`.

**Why the registry is where the class check hangs (Part 6's reason, stated here so this part does
not re-shape it):** every `readObject` / `readRawObject` / `readObjectMetadata*`
(`read-object.ts:154,166,228`), `hasObject`, `resolveOidPrefix`, `enumerateObjects` and
`blob-source.ts:86`'s `assertLoadable` call `getPackRegistry` **before** touching the store, loose
or packed. Inside a Tier-1 command the registry is therefore always created *after* that command's
gate.

**Tests to edit**
- `test/unit/application/primitives/config-read.test.ts` — the lenient-parse rows of C1:
  `96m`/`1K`/`0x6000000`/`0` → 100 663 296 / 1 024 / 100 663 296 / 0; absent for `-1`/`abc`/`1.5m`.
  **Nothing in `repo-state.test.ts` for this key** — the gate never sees it.
- **New** `test/unit/application/primitives/internal/resolve-delta-base-cache-limit.test.ts`.
- `test/unit/application/primitives/pack-registry.test.ts` (`:2570-2596`).
- `test/unit/application/primitives/read-object.test.ts` (1 068 lines).
- `test/unit/application/commands/fetch-missing.test.ts`.
- **Every test that calls `getPackRegistry` OR `createPackRegistry` synchronously** — enumerate
  with `grep -rn "getPackRegistry(\|createPackRegistry(" test/` (**both** names — the second is
  easy to miss) and fix each. A known one:
  `test/unit/application/primitives/object-resolver.test.ts:3610` does
  `const registry = createPackRegistry(ctx)`.

### TDD steps

1. **RED** — `config-read.test.ts`: `readConfig(ctx)` on `[core] deltaBaseCacheLimit = 96m` yields
   `core.deltaBaseCacheLimit === 100_663_296`. Fails: the field does not exist.
2. **RED** — the same for `1K` / `0x6000000` / `0`, and **absent** for `-1` / `abc` / `1.5m`
   (lenient: an invalid value merges as absent, exactly as `applyMaxTreeDepthEntry` does).
3. **GREEN** — `config-read.ts`: the field on `ParsedConfig.core` and `MutableCore`,
   `applyDeltaBaseCacheLimitEntry` reusing `checkPackWindowMemoryBound`, the `applyCoreEntry`
   dispatch, `finalizeCore`.
4. **RED** — new `resolve-delta-base-cache-limit.test.ts`: absent key → `100_663_296`; present →
   the value; option-over-key; and — the ADR-858 pin — a `readConfig` **spy records zero calls**
   when `cacheBudgets.deltaBaseCacheMaxBytes` is set. Fails: the module does not exist.
5. **GREEN** — write `internal/resolve-delta-base-cache-limit.ts`.
6. **RED** — `pack-registry.test.ts`: `createPackRegistry(ctx)` resolves to a registry whose
   `deltaBaseCache.maxSize` equals the key's value / the option / 96 MiB across three fixtures; a
   `readConfig` spy shows **one** read per session and **none** on `refreshPackRegistry`. Fails:
   `createPackRegistry` is synchronous and sizes from `ctx.deltaCache.maxSize`.
7. **GREEN** — `pack-registry.ts` async + budget.
8. **RED** — `read-object.test.ts`: two concurrent first `readObject` calls construct **one**
   registry (`createPackRegistry` spy `toHaveBeenCalledTimes(1)`). Fails: no single-flight memo.
9. **GREEN** — `read-object.ts` `PromiseMemo` + `resolvedRegistries`; then sweep the 19 + 1 call
   sites from the table above, **chained sites first** (a naive `await` prefix on those five
   compiles but awaits the registry object, not its method's promise — it type-errors, which is
   the point: let `check:types` find them, do not guess).
10. **RED/GREEN** — `fetch-missing.test.ts`: its private `createPackRegistry` construction.
11. **REFACTOR** — none expected in `pack-registry.ts`; the rejected alternative (a lazily-sized
    cache in a still-synchronous registry) is recorded in the design and must not be revived:
    `probeDeltaBaseCache` is synchronous and on the hot path and would have to tolerate an
    "only defined after the store gate" invariant.
12. **Pre-pay the surface gate** — `npm run docs:json` (`ParsedConfig` is public, 5 hits in
    `reports/api.json`, so the new `core.deltaBaseCacheLimit` field is a report change).
13. **Measurement probe (mandatory for this part)** —
    `npm run bench:ab -- main feat/session-caches-per-command-floor 2` over `log.bench`,
    `cat-file.bench`, `delta-chain-read.bench`. Absolute wall-clock both sides, alternating
    rounds. Record in the PR body. A per-object-read promise hop is invisible to reading.

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/internal/resolve-delta-base-cache-limit.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/commands/fetch-missing.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/internal/resolve-delta-base-cache-limit.ts src/application/primitives/pack-registry.ts src/application/primitives/read-object.ts src/application/primitives/resolve-oid-prefix.ts src/application/primitives/has-object.ts src/application/primitives/enumerate-objects.ts src/application/primitives/internal/blob-source.ts src/application/primitives/internal/closure-engine.ts src/application/commands/fetch-missing.ts src/application/commands/internal/gc-pipeline.ts src/application/commands/internal/fsck && npm run check:spelling
```

Plus, in this part specifically: `npm run check:architecture` — the new edge
`pack-registry.ts → internal/resolve-delta-base-cache-limit.ts → config-read.ts`. depcruise's
transitive closure of `config-read.ts` is 78 modules and contains **no** object-store module, so
the edge closes no cycle; `check:architecture` is the oracle that says so, not this sentence.

Then `npm run docs:json` and `git add reports/api.json`.

**Surface gates tripped:** `reports/api.json` (`ParsedConfig.core` gains a public field) — prepush,
pre-paid. `check:architecture` — new inward edge. Neither `createPackRegistry`, `getPackRegistry`,
`PackRegistry` nor `DeltaBaseCacheEntry` is public, so the async flip trips nothing else.
**Doc debt declared:** `docs/use/primitives/internals.md`'s `PackRegistry.deltaBaseCache`
paragraph (sized from the key, async construction) and the family-total sentence, plus
`docs/understand/performance.md`'s "~34 MiB" sentence → 136 MiB — docs phase.

### Commit

`feat(pack): size the delta-base cache from core.deltaBaseCacheLimit`

## Part 5 — `branch.create` types its start point through the object store (design P4, D12, ADR-860 + ADR-861)

### Context

**Ordering:** independent of Parts 2–4 in code, but it **must precede Part 6** so
`repo-settings-config-interop` pins `branch.create` refusing *through the store* rather than
through a transcribed call that Part 6 would then delete. ADR-859 explicitly drops
`branch.create`'s transcribed call for that reason.

**The gap.** `git branch x <tree-oid>` refuses; tsgit creates a branch pointing at a tree — a ref
no later operation can use. This is a refusal-surface gap that the prime directive binds.

**Git's order (pins B1–B11, design §B):** validate the name (B9) → refuse an existing branch
unless `-f`, **before** resolving the start point (B10) → resolve it
(`fatal: not a valid object name` when it does not resolve, B7) → **type it through the object
store**: a tree or blob (by full oid, abbreviated oid, lightweight tag or annotated tag) is
refused `error: object <oid> is a <type>, not a commit` + `fatal: not a valid branch point: '<start>'`,
exit 128, **nothing written** (B2–B6, B8); an annotated tag over a commit is **peeled** — the
branch lands on the commit, never on the tag object (B4).

**File to edit — verified anchors**
`src/application/commands/branch.ts`:
- `branchCreate` at **`:114-137`** (the design cites `:118-140`; the verified span is `:114-137`):
  ```
  :118  await assertOperationalRepository(ctx);
  :119  const name = validateRefName(`${HEADS_PREFIX}${input.name}`);
  :120  const startPoint = input.startPoint ?? 'HEAD';
  :121  const target = await resolveBranchTarget(ctx, startPoint);
  :122  const reflogMessage = branchCreatedFrom(startPoint);
  :123-133  try { await updateRef(ctx, name, target, force ? { reflogMessage } : { expected: 'absent', reflogMessage }) }
            catch (err) { if (REF_UPDATE_CONFLICT) throw branchExists(name); throw err; }
  :136  return { name, id: target };
  ```
  Target shape, in git's order:
  ```ts
  await assertOperationalRepository(ctx);
  const name = validateRefName(`${HEADS_PREFIX}${input.name}`);          // B9, unchanged
  if (input.force !== true && (await refExists(ctx, name))) throw branchExists(name);  // B10, NEW — before resolution
  const startPoint = input.startPoint ?? 'HEAD';
  const id = await resolveBranchTarget(ctx, startPoint);                 // B7, ladder unchanged, now peeling
  const object = await readObject(ctx, id);                              // THE store touch
  if (object.type !== 'commit') throw unexpectedObjectType('commit', object.type, id);  // B2, ADR-861
  … updateRef(ctx, name, id, …) as today → { name, id }                  // id = the PEELED commit (B4)
  ```
  The `updateRef` CAS (`expected: 'absent'`) **stays** as the race guard — the new `refExists`
  check is the refusal-order fix, not a replacement.
- `resolveBranchTarget` at **`:227-241`** — the ladder keeps its shape (full oid via
  `isOid(startPoint, ctx.hashConfig)` → `refs/heads/<x>` → `<x>` verbatim → `HEAD`) and gains
  `{ peel: true }` on **both** `resolveRef` calls (`peelChain` reads the tag objects — another
  store touch). Its terminal `throw branchNotFound(startPoint as RefName)` is unchanged.
- `branchDelete` at `:139` — **not this part's** (Part 6 adds its transcribed call there).

**Imports to add**
- `readObject` from `../primitives/read-object.js`.
- `unexpectedObjectType` from `../../domain/objects/error.ts` — verified at **`:77`**:
  `unexpectedObjectType(expected: ObjectType, actual: ObjectType, id: ObjectId): TsgitError`
  producing `{ code: 'UNEXPECTED_OBJECT_TYPE', expected, actual, id }`. Call it as
  `unexpectedObjectType('commit', object.type, id)`.

**ADR-861: reuse, do not add.** No new error code ⇒ **no** error-union edit, **no** exhaustiveness
switch, **no** barrel-surface test change, **no** `reports/api.json` regeneration. Git's second
line — `fatal: not a valid branch point: '<start>'` — needs the start point **as the caller
spelled it**, which the caller already holds; under ADR-249 composing it is the caller's job.

**Tests to write**
- `test/unit/application/commands/branch.test.ts` (935 lines): `seedWithCommit` at `:39-55` is the
  fixture to extend — add a tree oid (`writeObject` a tree), a blob oid,
  `updateRef('refs/tags/light-to-tree', tree)`, and annotated tags written via
  `writeObject({ type: 'tag', … })` pointing at the tree and at the commit. `refExists` is the
  nothing-written assertion. `:452-490`'s two oid cases stay. New cases: tree oid / blob oid /
  lightweight tag → tree / annotated tag → tree each refuse with `UNEXPECTED_OBJECT_TYPE` and
  `{ id, expected: 'commit', actual }` asserted **field by field** (try/catch + `.data`, never
  `toThrow(Class)`); annotated tag → commit creates the branch at the **commit** oid; existing
  name + unresolvable start point → `BRANCH_EXISTS`; `force` + unresolvable → `BRANCH_NOT_FOUND`;
  a nonexistent full oid → `OBJECT_NOT_FOUND`.
- **New** `test/integration/branch-start-point-interop.test.ts` — `@proves` header with
  `bucket: cross-tool-interop`, `interopSurface: branch`. Helpers verified in
  `test/integration/interop-helpers.ts`: `makePeerPair` `:181`, `initBothRepos` `:191`,
  `runGit` `:91`, `runGitEnv` `:105`, `runGitAsync` `:118`, `gitAsync` `:204`,
  `tryRunGitWithExit` `:257`. Rules: **one shared repo per `describe` in `beforeAll`, 60 s
  timeout**, `GIT_*` scrubbed, `HOME` isolated, signing off, a fresh tsgit `Context` after every
  git write. The peer builds `tag-to-commit` / `tag-to-tree` / `light-to-tree` with `git tag -a`
  and `git tag`. Pin B1–B11: exit codes, the `error:` / `fatal:` lines reconstructed from
  `{ id, expected, actual }` plus the caller's own `startPoint`, and for B4 the branch oid equal
  to `git rev-parse <tag>^{commit}`.

**Mechanical enumeration ADR-860 requires:** unit tests elsewhere that used `branch.create` to
point a branch at a non-commit as a fixture shortcut. `grep -rn "startPoint:" test/unit` finds 11
uses, all commit oids or `HEAD`/branch names, so the expected set is **empty** — but the full
`npm run test:unit` run is the proof, not the grep. Run it.

### TDD steps

1. **RED** — `branch.test.ts`: `branchCreate({ name: 'b2', startPoint: <tree-oid> })` throws
   `UNEXPECTED_OBJECT_TYPE` with `{ expected: 'commit', actual: 'tree', id: <tree-oid> }` and
   `refExists('refs/heads/b2')` is `false` afterwards. Fails: today it creates the branch.
2. **RED** — the blob-oid, lightweight-tag→tree and annotated-tag→tree cases (each a separate
   `it`, each asserting `actual` — a single case covering all four would not kill the type-literal
   mutants).
3. **RED** — annotated tag → commit creates the branch at the **commit** oid, not the tag object.
   Fails: `resolveBranchTarget` does not peel.
4. **RED** — `branchCreate({ name: 'side', startPoint: 'nope' })` on an existing `side` throws
   `BRANCH_EXISTS`, not `BRANCH_NOT_FOUND`. Fails: the exists check is the CAS, which runs after
   resolution.
5. **RED** — `force: true` + unresolvable start point still throws `BRANCH_NOT_FOUND` (B10′: force
   skips the exists check).
6. **RED** — a nonexistent **full oid** start point throws `OBJECT_NOT_FOUND` (the oid arm passes
   through the ladder untyped today and only now reaches `readObject`).
7. **GREEN** — edit `branchCreate` and `resolveBranchTarget` per the shape above.
8. **RED** — `branch-start-point-interop.test.ts` pinning B1–B11 against real git. Write it after
   the unit cases are green so the interop run is a confirmation, not a debugging loop.
9. **GREEN** — reconcile any interop disagreement **toward git**, never toward the unit test.
10. **REFACTOR** — keep `resolveBranchTarget` a single ladder; do not fold the type check into it
    (the caller needs the resolved `object` for the error's `actual`).
11. Run `npm run test:unit` whole and treat any `branch.create`-as-fixture-shortcut failure as the
    ADR-860 enumeration; fix each by constructing the ref another way.

### Gate

```
npx vitest run test/unit/application/commands/branch.test.ts test/integration/branch-start-point-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/branch.ts test/unit/application/commands/branch.test.ts test/integration/branch-start-point-interop.test.ts && npm run check:spelling
```

The interop file spawns git: 60 s timeout, one shared `beforeAll` repo. If the run exits 1 with
every test reported green, that is the known EPIPE flake — re-run to unblock.

**Surface gates tripped:** `npm run check:write-surfaces` — the new interop file's `interopSurface`
must list only the `@writes`-declared names it exercises; `tooling/audit-write-surfaces.ts` warns
on undeclared ones. `npm run check:test-pyramid` — one new integration file. **No**
`reports/api.json` change (ADR-861 reuses an existing code) and **no** error-union /
exhaustiveness / barrel-surface change. **Doc debt declared:** `docs/use/commands/branch.md`
Behaviour (the start point must peel to a commit; an annotated tag lands on its commit; an
existing name is refused before the start point resolves) and `docs/use/errors.md`'s
`UNEXPECTED_OBJECT_TYPE` row (gains `branch.create` as a thrower, and states that git's
`fatal: not a valid branch point` line is composed by the caller) — docs phase.

### Commit

`fix(branch): verify the branch start point peels to a commit`

## Part 6 — The repo-settings tier: one class validated at the store, index and graph boundaries (design P5, D2-iii, ADR-859 + ADR-858 + ADR-862) — 2 commits

### Context

**Depends on Parts 4 and 5. Must precede Parts 9 and 10** (all three edit
`src/application/primitives/internal/repo-state.ts`, different functions).

**Why the tier moves.** Git reads `core.maxTreeDepth` (`repo-settings.c:103`) and
`core.deltaBaseCacheLimit` (`:142`) in **one function**, `prepare_repo_settings`, and nowhere
else; across 86 probed commands × the two keys the outcome is identical in every cell. Git has
**no die-set list** — a command dies iff it reaches that function: any object read, any pack
enumeration, any index read, any commit-graph / midx / bitmap load, or one of four builtins that
call it at the top of `cmd_*` (`rev-parse`, `worktree`, `sparse-checkout`, `stash`).

tsgit today refuses `core.maxTreeDepth` at the **eager operational gate**
(`repo-state.ts:211-244` `assertEagerConfigValid`), which over-refuses exactly three verbs where
git runs — `branch.list`, `tag.list`, `branch.rename` — and names the class **before** the
streaming classes in the 19 of 24 commands where git names it after. The unit tests that pinned
that ordering (`repo-state.test.ts:1356-1406`) measured `status`/`commit` — two of the five
minority commands — and generalised. `remote.*` was never over-refused: it sits on
`assertAcceptedRepository`, which runs no eager check.

**Scope boundary, stated so it is not widened:** only the **class** moves. **No verb moves between
gates.** Every other refusal — discovery, ownership, format, the five streaming classes,
work-tree, pending-operation — is byte-identical before and after.

#### Commit 1 — the tier, with `core.maxTreeDepth` migrated

**Public-surface verdict.** Every symbol this part adds is **internal**:
`assertRepoSettingsValid`, `computeRepoSettingsVerdict`, `memoizeRepoSettingsVerdict`,
`repoSettingsVerdictSettled`, `memoizeSessionVerdict`, `findLastInvalidDeltaBaseCacheLimit` and
the `gateWorktree` / `gateStash` prologue helpers. `config-read.ts`'s existing
`findLastInvalidMaxTreeDepth` is the precedent — ADR-637 ratified "no new public surface" for that
finder and this one follows it. Consequently **no** `reports/api.json` regeneration in either
commit; if the report changes, something was exported that should not have been.

**New file** `src/application/primitives/internal/repo-settings-gate.ts`:
```ts
import { configBadNumericValue } from '../../../domain/commands/error.js';
import type { Context } from '../../../ports/context.js';
import { findLastInvalidDeltaBaseCacheLimit, findLastInvalidMaxTreeDepth, memoizeRepoSettingsVerdict } from '../config-read.js';

const computeRepoSettingsVerdict = async (ctx: Context): Promise<void> => {
  const [maxTreeDepth, deltaBaseCacheLimit] = await Promise.all([
    findLastInvalidMaxTreeDepth(ctx),                                   // repo-settings.c:103
    ctx.cacheBudgets?.deltaBaseCacheMaxBytes === undefined              // ADR-858 / C5
      ? findLastInvalidDeltaBaseCacheLimit(ctx)                         // repo-settings.c:142 — commit 2
      : undefined,
  ]);
  const invalid = maxTreeDepth ?? deltaBaseCacheLimit;                  // in-function order
  if (invalid !== undefined) throw configBadNumericValue(invalid.key, invalid.source, invalid.value, invalid.reason);
};
export const assertRepoSettingsValid = (ctx: Context): Promise<void> =>
  memoizeRepoSettingsVerdict(ctx, computeRepoSettingsVerdict);
```
At **commit 1** only the first finder exists; the second arm lands in commit 2.

**`src/application/primitives/config-read.ts` — verified anchors**
- `:279` `let gateVerdictCache: WeakMap<Context['session'], Promise<FilePath>>` — add beside it
  `repoSettingsVerdictCache: WeakMap<Context['session'], Promise<void>>` and
  `settledRepoSettings: WeakSet<Context['session']>` (added when the memoised promise **resolves**,
  dropped with the memo).
- `:299-311` `memoizeGateVerdict(ctx, compute)` — generalise its body into
  `memoizeSessionVerdict(slot, ctx, compute, onResolve?)` (one single-flight + rejection-eviction
  body, two slots); `memoizeGateVerdict` and the new `memoizeRepoSettingsVerdict` become its two
  bindings. `memoizeGateVerdict`'s **call shape is unchanged**, so its existing kill tests carry
  over verbatim. Note `:306-308`: the rejection eviction is `if (gateVerdictCache.get(ctx.session) === pending) …delete(…)`
  — preserve that identity check in the generalised helper.
- New `export const repoSettingsVerdictSettled = (ctx: Context): boolean => settledRepoSettings.has(ctx.session)`
  — the **synchronous** hot-path fast path.
- `:365-369` `__resetConfigCacheForTests` and `:389-393` `invalidateConfigCache` both drop the new
  slot **and** the settled set. One invalidation domain (ADR-351).
- `:736` `findLastInvalidMaxTreeDepth` — unchanged, but its **caller** changes.
- `:716` `InvalidNumericEntry` — the shape both finders return.

**`src/application/primitives/internal/repo-state.ts`**
- `assertEagerConfigValid` at `:211` loses the `findLastInvalidMaxTreeDepth` call (`:212-213`) and
  its throw (`:221-228`); the import at `:39` goes with it. It **keeps** the five streaming
  classes and their lowest-line pick, unchanged.
- Its docblock (`:195-210`), which today calls the ordering "PINNED against measured git
  behaviour", is rewritten to say **what** was measured, **on which set** (`status`/`commit`, the
  minority), and **where the class now lives**. Leaving that sentence is leaving a claim the spike
  disproved.
- `computeGateVerdict` `:305-309` and `assertOperationalRepository` `:320-325` — untouched here
  (Part 10 adds the epoch call).

**Six boundary statements in five files** (the design's D2-iii table is the authority on *where
exactly* inside each):

| # | Site | Placement | Git's route |
|---|---|---|---|
| 1 | `read-object.ts` `getPackRegistry` | first statement, **behind** `repoSettingsVerdictSettled(ctx)`: `if (!repoSettingsVerdictSettled(ctx)) await assertRepoSettingsValid(ctx);` | `odb_read_object` / `prepare_packed_git` |
| 1′ | `pack-registry.ts` `createPackRegistry` | first statement, plain `await` — covers `fetch-missing.ts:66`'s private construction | the store's own setup |
| 1″ | `write-object.ts` `writeObject` (`:22`) | first statement, behind the fast path — every object write, Tier-1 or Tier-2 (`writeTree` → `writeObject` via `write-tree.ts:15`) | `hash-object -w` / `write-tree` die (pin H) |
| 2 | `read-index.ts` `readIndex` (`:169`) | first statement, **before** the `exists` probe at `:171` — git's `repo_read_index` calls `prepare_repo_settings` unconditionally, absent index included | `repo_read_index` |
| 3 | `internal/read-commit-graph.ts` `commitHeader` (`:353-358`) and `correctedCommitDatesEnabled` (`:257-258`) | first statement of **each**, behind the fast path — **not** inside the memoised `loadGraph` (`:228`): a later command served entirely from `headerCache` (`:99`) would otherwise touch no boundary at all | `commit-graph.c` ×3 |

**Twelve transcribing statements in nine command files** (verified anchors; placement inside each
verb is **pinned by probe, not reasoned** — see the design's O and W matrices):

| Verb | File:line | Placement | Pin |
|---|---|---|---|
| `revParse` | `rev-parse.ts:36` | right after `assertOperationalRepository` | O6: even `--git-dir` and an unresolvable argument die |
| `worktreeList/Add/Move/Remove` | `worktree.ts:60,216,304,338` | a `gateWorktree(ctx)` prologue = gate + class (the `assertSparseReady` shape); `worktree` has no work-tree requirement | O8, W1 |
| `assertSparseReady` | `sparse-checkout.ts:69-73` | after the gate, **before** `requireWorkTree` (`:71`) | W1: bare `sparse-checkout list` dies on the class, not the work tree |
| `stashPush/List/Drop/Apply/Pop` | `stash.ts:197,288,299,432,491` (each `requireWorkTree` at `:202,290,304,437,498`) | a `gateStash(ctx, op)` prologue = gate → `requireWorkTree(ctx, op)` → class, **in that order** | W1: bare `stash list` dies on the **work tree** first; O9: `stash drop` on an empty stack dies on the class |
| `reflog` | `reflog.ts:75-79` | after the `exists` dispatch (`:108`), before `delete`/`expire`/`show` | O5: `reflog exists` **runs** in git |
| `branchDelete` | `branch.ts:139` | right after the gate, before the checked-out and not-found checks | O1: unforced `branch -d nope` dies on the class |
| `tagCreate` | `tag.ts:84`, after the target resolves (around `:119`'s `resolveObjectType`) and before the annotated/lightweight split | the point where git types the target | O3: `tag t3 nope` reports the unresolvable target **without** the class |
| `tagDelete` | `tag.ts:209`, after the `refExists` check at `:212`, before `updateRef` | | O2: `tag -d nope` is "not found", exit 1, no class |
| `submoduleInit` | `submodule.ts:217`, before `requireWorkTree` (`:222`) and before `readWorktreeGitmodules` (`:223`) | | W1 + O7 |
| `syncLevel` | `submodule.ts:300`, before `requireWorkTree` (`:307`) | | W1 + O7 |
| `notesRead` | `notes.ts:128` | right after the gate | N2 |
| `notesRemove` | `notes.ts:173` | right after the gate | N3 |

**Deliberately NOT transcribed — do not add these calls:**
- `branch.create` — Part 5 types its start point through `readObject`, so it reaches boundary 1
  structurally (ADR-859 drops the call rather than keeping redundancy).
- `notes.add` (`notes.ts:95`) — it writes the note blob first (`writeObject` at `:107`), so it
  reaches boundary 1″ for the same reason git's `notes add` does (ADR-862). A redundant call here
  would be behaviourally invisible behind the memo, so **no test can catch it** — its absence is a
  review fact.
- `notes.list` (`notes.ts:149`), `packRefs` — they read an object exactly when git does
  (`loadNotesTree` → `readObject`; `peelToNonTag`, `ref-store.ts:845-863`), so both fixtures come
  out right with **no per-verb code**.
- `branch.list`, `tag.list`, `branch.rename`, `reflog exists` — git runs.

**`core.maxTreeDepth`'s lazy twin stays.** `src/application/primitives/internal/resolve-max-tree-depth.ts`
(9 call sites) keeps its own refusal — its callers are tree walks that may resolve the cap before
their first object read, so the redundancy is real there (ADR-859 carries it forward), unlike the
delta key's.

**Tests that move or are rewritten** (`test/unit/application/commands/internal/repo-state.test.ts`,
1 631 lines — the design enumerates them so this is not rediscovered):

| Today | Fate |
|---|---|
| `:1266-1291` `invalid unit` on `core.maxTreeDepth = 2.5` | **moves** to `repo-settings-gate.test.ts`; an inverse case is added here — `assertEagerConfigValid` **and** `assertOperationalRepository` **resolve** on that config |
| `:1293-1318` `out of range` on `2147483648` | moves likewise |
| `:1320-1331` porcelain `assertRepository` survives; `:1333-1353` `configGet`/`configList` survive | **stay**, unchanged |
| `:1356-1380` "`core.loosecompression = bogus` earlier — maxTreeDepth wins" | **rewritten**: the gate throws `CONFIG_BAD_NUMERIC_VALUE` with `key === 'core.loosecompression'`; `assertRepoSettingsValid` alone throws `core.maxtreedepth`. The title states the majority (19 of 24) and names the five exceptions |
| `:1382-1406` "`core.sparseCheckout = bogus` earlier — maxTreeDepth wins" | **rewritten**: the gate throws `CONFIG_BAD_BOOLEAN_VALUE` `core.sparsecheckout`; the class is refused only at a boundary (`readIndex` in the same test) |
| `:1408-1420` invalid-then-valid resolves; `:1422-1446` valid-then-invalid throws | **move** to `repo-settings-gate.test.ts` (last-wins is the class's property) |

**Fixtures/helpers**
- `createMemoryContext`, `seedRepo` / `seedConfig` as `repo-state.test.ts` defines them — the new
  gate test needs the same three; copy or lift into a shared fixture.
- `instrumentedContext` — `test/unit/application/primitives/fixtures.ts:343` — for the
  zero-finder-call spy and the zero-`stat` assertions.
- `buildSeededContext` — `fixtures.ts:253`.
- A **bare-layout** Context (`layout.workDir` undefined) for the W1 order cases.
- `test/integration/max-tree-depth-config-interop.test.ts` is the **scaffold** for the new interop
  file (`datedEnv`, `assertRefusesWithBadMaxTreeDepth`, one shared `beforeAll` repo,
  `tryRunGitWithExit`) — and is itself **re-run unchanged**: every row it pins (log / rev-parse /
  add / commit / archive / fsck / grep / bundle create refuse; config / remote / init /
  bundle list-heads / verify run; last-wins on `status`) holds under the new tier.

**Tests to write/edit at commit 1:** new
`test/unit/application/primitives/internal/repo-settings-gate.test.ts`; `repo-state.test.ts`
(`:1265-1446`); boundary tests in `read-object.test.ts`, `pack-registry.test.ts`,
`fetch-missing.test.ts`, `write-object.test.ts`, `write-tree.test.ts`, `read-index.test.ts`,
`internal/read-commit-graph.test.ts`; one case per transcribed statement in `rev-parse.test.ts`,
`worktree.test.ts`, `sparse-checkout.test.ts`, `stash.test.ts`, `reflog.test.ts`,
`branch.test.ts`, `tag.test.ts`, `submodule.test.ts`, `notes.test.ts`, `pack-refs.test.ts`
(**plus the success cases of the not-transcribed verbs** — those kill an over-eager call);
`config-read.test.ts` (memo / settled / invalidate); new
`test/integration/repo-settings-config-interop.test.ts` with the `core.maxTreeDepth` parameter.

#### Commit 2 — `core.deltaBaseCacheLimit` joins the class

- `config-read.ts`: `findLastInvalidDeltaBaseCacheLimit` immediately after
  `findLastInvalidMaxTreeDepth` (`:736-768`), sharing `InvalidNumericEntry`'s shape. Last-wins;
  valueless ⇒ `{ value: '', reason: 'invalid unit' }`; negative ⇒ `'invalid unit'`; `> 2^64-1` ⇒
  `'out of range'`. `key` is the **lowercased** qualified name, built exactly as
  `findLastInvalidMaxTreeDepth` builds `core.maxtreedepth`.
- `repo-settings-gate.ts`: the second finder behind the ADR-858 skip.
- Tests: `config-read.test.ts` (C1 finder rows — each of `invalid unit` / `out of range` /
  valueless `''` **isolated**; C4 last-wins both orders); `repo-settings-gate.test.ts` (C1 / C4 /
  the C5 skip / the both-malformed order); `repo-settings-config-interop.test.ts` (the second
  key's parameter; C1 / C4 / C5 rows).

**Recorded residual, pinned as such in the interop file's test title:** five commands where git
names the class first and tsgit names the streaming class first — `status`, `commit`, `diff`,
`bundle.create`, `rebase` — plus `maintenance` (git `gc`) for `core.deltaBaseCacheLimit` only
(`gc.c:219` reads it ahead of `prepare_repo_settings`, which is also the one intra-class
inversion). Under the eager gate those were 19 order mismatches **plus three over-refusals**; now
they are 5 (+1 cell) and no over-refusal.

### TDD steps

**Commit 1**

1. **RED** — new `repo-settings-gate.test.ts`: `assertRepoSettingsValid(ctx)` on
   `core.maxTreeDepth = 2.5` throws `CONFIG_BAD_NUMERIC_VALUE` with `data` asserted field by field
   (`key`, `source`, `value`, `reason`). Fails: the module does not exist.
2. **RED** — the inverse in `repo-state.test.ts`: `assertOperationalRepository(ctx)` **resolves**
   on that same config. Fails: the eager gate throws.
3. **GREEN** — write `repo-settings-gate.ts` and the `config-read.ts` memo trio
   (`repoSettingsVerdictCache`, `settledRepoSettings`, `memoizeSessionVerdict`,
   `memoizeRepoSettingsVerdict`, `repoSettingsVerdictSettled`), and remove the finder call from
   `assertEagerConfigValid`.
4. **RED** — memo behaviour, each as its own case: two concurrent calls run the finder **once**
   (spy); a **rejection is not cached** (a second call re-runs and re-throws);
   `invalidateConfigCache` drops it (malformed → throws; file fixed + invalidate → resolves; file
   broken **without** invalidate → **still resolves**, the per-session contract — assert it as
   such, Part 10 flips this case); `repoSettingsVerdictSettled` false before, true after
   resolution, false after invalidate **and** false after a rejection.
5. **RED, one boundary at a time** — `read-object.test.ts` (a first `readObject` on a **loose**
   fixture and on a **packed** fixture both refuse); `pack-registry.test.ts`
   (`createPackRegistry` alone refuses); `fetch-missing.test.ts` (its private construction
   refuses); `read-index.test.ts` (`readIndex` refuses **with no index file present**);
   `read-commit-graph.test.ts` (`commitHeader` and `correctedCommitDatesEnabled` refuse **before**
   probing the graph file — an `exists` spy records zero calls; `graphCache` holds no rejection;
   `isGraphKnownAbsent` stays false; a **header-cache hit** after `invalidateConfigCache` +
   malformed rewrite **still** refuses); `write-object.test.ts` (`writeObject` refuses on a bare
   `Context` **with no gate having run** — the ADR-862 contract narrowing — and writes **no** loose
   file, `exists` false afterwards); `write-tree.test.ts` (`writeTree` refuses through it; a second
   write on a settled session calls **no** finder).
6. **GREEN after each** — add that one boundary statement. Each RED must flip exactly one test;
   if a RED goes green from a different boundary, the placement is wrong.
7. **RED, one transcribed statement at a time** — the table above, each asserting `data` and,
   where O pins it, the **order against the verb's own errors**. Include the success cases:
   `branch.list` / `branch.rename` / `tag.list` succeed on a malformed class; `reflog exists`
   succeeds; `notes.list` with no notes ref succeeds and with one note refuses; `pack-refs` idle
   succeeds and with one loose ref refuses.
8. **GREEN after each.**
9. **RED** — `repo-state.test.ts`'s two rewritten ordering cases (the gate names the streaming
   class; the class is refused only at a boundary).
10. **RED** — new `repo-settings-config-interop.test.ts` parameterised on `core.maxTreeDepth`, and
    `max-tree-depth-config-interop.test.ts` **re-run unchanged**.
11. **REFACTOR** — `gateWorktree(ctx)` and `gateStash(ctx, op)` prologue helpers (nine call sites
    collapse into two); confirm `memoizeGateVerdict`'s existing kill tests still pass **unmodified**
    after the generalisation — if one needed editing, the generalisation changed behaviour.

**Commit 2**

12. **RED** — `config-read.test.ts`: `findLastInvalidDeltaBaseCacheLimit` over the C1 matrix,
    each reason isolated; C4 both orders.
13. **GREEN** — the finder.
14. **RED** — `repo-settings-gate.test.ts`: both keys malformed ⇒ `core.maxtreedepth` is named
    (in-function order); **ADR-858's skip observably** — malformed key +
    `cacheBudgets.deltaBaseCacheMaxBytes` set ⇒ resolves; the same config **without** the option ⇒
    throws.
15. **GREEN** — the second finder behind the skip.
16. **RED/GREEN** — the interop file's second-key parameter (C1 / C4 / C5 rows).
17. **Measurement probe (mandatory)** — `bench:ab` `log.bench` both rows main-vs-branch. The
    settled fast path exists to save ≈ 1–2 ms per 5 000-commit `log`; that number is an estimate
    and this bench is its only oracle.

### Gate

```
npx vitest run test/unit/application/primitives/internal/repo-settings-gate.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/write-object.test.ts test/unit/application/primitives/write-tree.test.ts test/unit/application/primitives/read-index.test.ts test/unit/application/primitives/internal/read-commit-graph.test.ts test/unit/application/commands/fetch-missing.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/commands/worktree.test.ts test/unit/application/commands/sparse-checkout.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/reflog.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/submodule.test.ts test/unit/application/commands/notes.test.ts test/unit/application/commands/pack-refs.test.ts test/integration/repo-settings-config-interop.test.ts test/integration/max-tree-depth-config-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/repo-settings-gate.ts src/application/primitives/config-read.ts src/application/primitives/internal/repo-state.ts src/application/primitives/read-object.ts src/application/primitives/pack-registry.ts src/application/primitives/write-object.ts src/application/primitives/read-index.ts src/application/primitives/internal/read-commit-graph.ts src/application/commands/rev-parse.ts src/application/commands/worktree.ts src/application/commands/sparse-checkout.ts src/application/commands/stash.ts src/application/commands/reflog.ts src/application/commands/branch.ts src/application/commands/tag.ts src/application/commands/submodule.ts src/application/commands/notes.ts && npm run check:spelling
```

Plus `npm run check:architecture` — the new edges
`{ read-object, pack-registry, write-object, read-index, internal/read-commit-graph, the nine
transcribing command files } → internal/repo-settings-gate → config-read`. Commands importing
`primitives/internal/*` has precedent (`tag.ts:22` `boolean-config-guard`, `merge.ts:41`
`resolve-max-tree-depth`).

**Surface gates tripped:** `check:architecture` (many new inward edges). `check:write-surfaces`
and `check:test-pyramid` (one new integration file). **No** `reports/api.json` change — nothing
public changes signature (`assertRepoSettingsValid` and the memo helpers are internal).
**Doc debt declared:** `docs/use/primitives/internals.md` gains a `repo-settings-gate.ts`
paragraph (the class, its four boundaries — object read, object write, index, commit graph — the
transcribed prologues, the memo beside the gate verdict, the settled fast path, the 5-command
ordering residual), its `pack-registry.ts` (`:35`) and `read-index.ts` (`:64`) paragraphs each
gain "validates the repo-settings class first", and — **the one that matters most** —
`docs/use/primitives/write-object.md` (and `write-tree.md`, which routes through it) must state
that the primitive validates the class first and can refuse `CONFIG_BAD_NUMERIC_VALUE` whether or
not a Tier-1 gate has run; `docs/use/errors.md`'s `CONFIG_BAD_NUMERIC_VALUE` row names the tier
and lists `writeObject` / `writeTree` among the throwers. Docs phase writes them; nothing
mechanical fails if they lag, which is exactly why they are declared here.

### Commit

Commit 1: `feat(config): validate repo settings at the object-store, index and commit-graph boundaries`

Commit 2: `feat(config): validate core.deltaBaseCacheLimit with the repo-settings class`

## Part 7 — Per-chain delta-base insert budget (design P6, D3-i)

### Context

**Depends on Part 2** (the `set` verdict) and **Part 4** (the registry's `maxSize` is now the
key's value, which the fraction is taken of). Ordered after Part 6 in the sequential worktree;
no code dependency on it.

**Today** one deep read inserts every level (`object-resolver.ts:494-519` inside
`resolvePackChainWithDepth` at `:471`): a depth-43 chain over a 400 KB target pushes ≈ 17 MB of
intermediates through the cache and flushes it. At ADR-852's 96 MiB default it no longer does —
**the chain budget is ¼ of the configured limit, 24 MiB at 96 MiB**, and that example fits
entirely. It is kept as a **fraction**, not an absolute, so a user who lowers the key to `16m`
gets a 4 MiB chain budget and the example binds again.

Git has **no** per-chain rule — this is a tsgit policy, **unobservable by construction** (a miss
re-reads; bytes identical).

**Files to edit — verified anchors**
- `src/application/primitives/object-resolver.ts`
  - `resolvePackChainWithDepth` at `:471-531`; the unwind loop at `:494-519` inserts one full
    intermediate per level, **nearest-the-base first** (today's order — preserve it).
  - Target shape:
    ```ts
    const chainBudget = registry.deltaBaseCache.maxSize * DELTA_BASE_CHAIN_INSERT_FRACTION;  // 24 MiB at the default
    let inserted = 0;
    const insertLevel = (key, content, chainDepth): void => {      // base AND every level go through this
      const size = deltaBaseCacheEntrySize(content);
      if (inserted + size > chainBudget) return;                   // over budget: skip caching, KEEP APPLYING
      if (cacheDeltaBase(ctx, registry, key, phase1.baseType, content, chainDepth)) inserted += size;
    };
    ```
    The **base** insert goes through `insertLevel` too — the first draft left it outside the check
    and that is what makes the `false`-is-unreachable proof hold.
  - `applyDelta(current, step.instructions)` is **always** applied; only the caching is budgeted.
  - `chainDepth` accounting, `enforcePackBaseCap` on probe hits, and the target's own
    `ctx.deltaCache` insert are **unchanged**.
- `src/application/primitives/internal/object-caches.ts`
  - `:251` `deltaBaseCacheEntrySize(content)` = content + 200 B — unchanged, but now **called by
    the resolver** for the accounting, so it must be exported.
  - `:264-274` `cacheDeltaBase(...)` returns `void` → `boolean` (forwarding `LruCache.set`'s
    verdict from `:273`).
  - New `export const DELTA_BASE_CHAIN_INSERT_FRACTION = 0.25`.

**`false` from `set` is unreachable here — the re-derivation, so it is not re-argued.** `set`
refuses iff `byteSize > maxSize`. `insertLevel` calls `cacheDeltaBase` only when
`inserted + size ≤ chainBudget = ¼ · maxSize`, hence `size ≤ ¼ · maxSize < maxSize` for every
`maxSize > 0` — the base insert included. With `maxSize = 0` the chain budget is `0`, so no level
ever reaches `set`. The claim holds for any fraction in `(0, 1)` and any limit. `cacheDeltaBase`
returns the verdict **for the accounting**, and the unit test asserts it is `true` at every
inserted level; **no runtime path branches on `false`** (a branch would be dead code and mutation
testing would flag it).

**Oracle honesty.** **No existing bench exercises the budget** — `delta-chain-read.bench`'s chains
total far below 24 MiB, so it never binds on any existing fixture. The **only** oracle is the unit
invariant. A fixture whose intermediates exceed 24 MiB would make it measurable and is explicitly
out of scope (a new generated fixture family).

**Tests to edit**
- `test/unit/application/primitives/object-resolver.test.ts` (3 729 lines) — the chain suites at
  `:1606-1900`, including the existing `:1670` probe-hit `chainDepth` suite.
- `test/unit/application/primitives/internal/object-caches.test.ts`.

**Stryker directives on touched structures:** `object-resolver.ts:173-193` (BlockStatement,
pre-apply cap) and `:394` (CallExpression, pre-apply cap) are on untouched lines — re-run, do not
re-prove.

### TDD steps

1. **RED** — `object-resolver.test.ts`: build a chain whose levels exceed ¼ of a small
   `deltaBaseCacheMaxBytes` and assert only the **base-nearest** levels are resident
   (`entryCount`, plus `has(key)` per level), while the returned bytes are **identical** to
   today's. Fails: every level is inserted.
2. **RED** — the **base arm isolated**: a base larger than ¼ of the limit is skipped, and its
   levels are still cached if they fit.
3. **RED** — `cacheDeltaBase` returns `true` at every inserted level (`object-caches.test.ts`).
   Fails: it returns `void`.
4. **GREEN** — `object-caches.ts`: `cacheDeltaBase` returns the verdict, export
   `deltaBaseCacheEntrySize`, add `DELTA_BASE_CHAIN_INSERT_FRACTION`. `object-resolver.ts`:
   `insertLevel` with the chain budget, base insert inside it.
5. **RED** — the boundary level (the one that exactly fits vs the one that exactly does not) as
   its own case — this is the fraction-mutant kill.
6. **GREEN**.
7. **REFACTOR** — the existing `:1670` `chainDepth`-on-probe-hit suite must still pass unchanged;
   if it needed editing, the `chainDepth` accounting moved and that is a regression, not a
   refactor.

### Gate

```
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/internal/object-caches.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/internal/object-caches.ts && npm run check:spelling
```

**Surface gates tripped:** none — `cacheDeltaBase`, `deltaBaseCacheEntrySize` and
`DELTA_BASE_CHAIN_INSERT_FRACTION` are all internal; no `reports/api.json` change, no doc page, no
error code.

### Commit

`perf(pack): budget delta-base inserts per chain`

## Part 8 — `{ type, content }` in the loose-object cache (design P7, D3-ii, ADR-854) — 2 commits, the second breaking

### Context

**Depends on Part 7** (same loop tail in `resolvePackChainWithDepth`).

**What goes wrong today.** `ctx.deltaCache` stores `<type> <size>\0content` so `parseObject`,
`RawObject.bytes` and `verifyAndReturn` can consume one shape. Every pack-resolved read pays
`prependHeader` (a content-sized copy, ≈ 20–40 µs at 400 KB) and every REF-delta base pays
`splitHeader` (NUL scan + a `TextDecoder` construction). The type is known on **both** sides of
that round trip. Git's own delta-base entry carries the type beside the data.

#### Commit 1 — additive, domain only

- `src/domain/objects/git-object.ts` — verified: `splitObject(rawBytes)` at `:16`,
  `parseObject(id, rawBytes, hash)` at `:33` whose body starts
  `const { type, content } = splitObject(rawBytes)` at `:34`. Add:
  ```ts
  export interface ObjectContent { readonly type: ObjectType; readonly content: Uint8Array; }
  export function parseObjectContent(id: ObjectId, type: ObjectType, content: Uint8Array, hash: HashConfig): GitObject;
  ```
  `parseObjectContent` is `parseObject`'s dispatch switch, extracted; `parseObject` becomes
  `splitObject` + `parseObjectContent` and **stays public** (on-disk loose bytes are still that
  shape).
- `src/domain/objects/index.ts:37` — export both.
- `reports/api.json` — regenerate in **this** commit (both new symbols are public).
- Tests: `test/unit/domain/objects/git-object.test.ts` (385 lines) — `parseObjectContent` per
  type, plus the equivalence `parseObject ≡ parseObjectContent ∘ splitObject`.

#### Commit 2 — `feat(objects)!:` the type flip

**Public, breaking**
- `src/ports/context.ts:219` `readonly deltaCache: LruCache<Uint8Array>` →
  `LruCache<ObjectContent>`; the `RepositoryHandle` mirror at `:281` likewise.
- `src/application/primitives/types.ts:82-96` — `export type RawObject = ObjectContent` (`bytes`
  is gone). Its own doc comment claiming it is "not re-exported from the primitives barrel" is
  **stale** — it **is** public via `primitives/index.ts:96` `export type * from './types.js'`
  (4 hits in `reports/api.json`). Fix the comment.

**Seven `createLruCache` creation sites** → `createLruCache<ObjectContent>(…)`:
`src/adapters/node/node-adapter.ts:71`, `src/adapters/browser/browser-adapter.ts` (its
`createLruCache` call), `src/adapters/memory/memory-adapter.ts:67`, `src/index.node.ts:115`,
`src/index.browser.ts:94`, `src/index.default.ts:99`, `src/application/commands/fsck.ts:42`
(`createNoDeltaCache`).

**`src/application/primitives/object-resolver.ts` — verified anchors**
- `:50` `const EMPTY_TREE_BYTES = new TextEncoder().encode('tree 0\0')` — **retired**; the
  empty-tree short-circuit at `:79` returns `{ type: 'tree', content: EMPTY }`.
- `:64` `resolveObjectBytesWithDepth` → `resolveObjectContentWithDepth: Promise<ObjectContent & { chainDepth }>`.
  Cache-hit arm (`:83-84`) returns the entry. Loose arm (`:91`): inflate → `splitObject(inflated)`
  (`content` is a **view**, no copy; the retained backing store still holds the 10-byte header) →
  `cacheEntry` → verify. Pack arm (`:100-103`): `{ type: packTypeName(baseType, id), content: current }`
  → `cacheEntry` → verify.
- `:108-115` `resolveObject` calls `parseObjectContent`.
- `:149-160` `enforceCachedCap` becomes `cached.content.length > maxBytes` — the NUL scan and the
  "header-less poisoned buffer" branch (`:153-154`) are **dead by type** and are removed with
  their five poisoned-cache tests.
- `:246-262` `verifyAndReturn` → **exported** `verifyObjectContent(ctx, id, type, content)`:
  `createHasher()` → `update(serializeHeader(type, content.length))` → `update(content)` →
  `digestHex()`. No buffer. On Node the incremental hash costs the same as one-shot; an adapter
  whose hasher cannot stream concatenates at digest — the copy **moves to the verify path**, which
  is off by default, rather than sitting on every read. Hashing the **canonical** header is git's
  own `check_object_signature`; a loose object stored with a non-canonical header never reaches a
  hash in git (pin V1 — it is refused at header parse), so the arm change is unobservable on any
  object git accepts.
  Port shapes: `Hasher.update` / `digestHex` — `src/ports/hash-service.ts:2-9`; `serializeHeader`
  — `src/domain/objects/header.ts`.
- `:471-531` `resolvePackChainWithDepth` tail (`:520-530`) — Part 7 owns the loop, this commit
  owns the tail: `:528` `prependHeader(current, phase1.baseType, targetId)` goes away.
- `:533-545` `prependHeader` and `:659-682` `splitHeader` — **deleted**.
- `:684-697` `typeNameToPackType` — its `default` arm goes; the switch becomes exhaustive over
  `ObjectType`.
- `:611-657` `resolveBaseForRefDelta` — returns
  `{ ...cached, type: objectTypeToPackType(cached.type), chainDepth: 0 }`; its `:633-634` and
  `:656` `splitHeader` calls go.
- `:699-703` `cacheEntry` charges `content.byteLength + OBJECT_CACHE_ENTRY_OVERHEAD_BYTES`, a new
  **32 B** constant in `object-caches.ts`. **It is deliberately not 200 B** (the delta-base
  cache's key+node term): `deltaCacheMaxBytes` is a public dial whose documented capacity
  consumers tuned against, and charging 200 B per entry would evict a 50 k-commit walk that fits
  today — a large-fixture cliff hidden by the medium fixture, the exact class this item removes.

**Public-surface verdict.** `ObjectContent` and `parseObjectContent` are **public** (commit 1,
exported from `domain/objects/index.ts:37`, in `reports/api.json`); `Context.deltaCache`,
`RepositoryHandle.deltaCache` and `RawObject` are **public and breaking** (commit 2, same report).
`verifyObjectContent` and `OBJECT_CACHE_ENTRY_OVERHEAD_BYTES` are **internal** — exported across
`object-resolver.ts` / `object-caches.ts` / `blob-source.ts` only, never barrelled.

**Consumers**
- `src/application/primitives/read-object.ts:160-178` — `readRawObject` returns the payload
  directly (no `splitObject`). **Eight of nine callers compile unchanged** (they use
  `type`/`content`): `diff-trees.ts:443`, `internal/deltify.ts:428`, `internal/raw-tree-io.ts:15`,
  `internal/resolve-tree-path.ts:218,235`, `internal/walk-raw-subtree.ts:189`,
  `internal/flatten-raw.ts:204`, `internal/raw-subtree-prefetch.ts:102`, `read-object.ts:244`.
- `src/application/commands/internal/fsck/content-validation.ts` — the **one** caller that hashed
  `raw.bytes` (`:80` → `:203`) hashes `serializeHeader(kind, rawBody.length)` ‖ `rawBody` through
  the incremental hasher. **The loose arm at `:54` keeps hashing the inflated on-disk bytes as
  stored** — a malformed on-disk header must still hash as written. Also `:20`, `:184-205`.
- `src/application/primitives/internal/blob-source.ts` — `:89-92` cache arm becomes
  `resolveFromCache(ctx, id, cached: ObjectContent, gate)` verifying via `verifyObjectContent` and
  returning `{ kind: 'bytes', ...cached }`; `verifyBufferedBytes` (`:153-162`) **stays one-shot**
  for the inflated loose arm; `toBytesSource` (`:140-143`) serves only that arm.
- `src/application/commands/internal/gc-pipeline.ts:1015` (`delete`) and `src/repository.ts:729`
  (`clear`) are value-type-agnostic — no edit.

**Migration note for the release (5.0)** — the docs phase places it; the table is:
```
// before (4.x)                                        // after (5.0)
deltaCache: createLruCache<Uint8Array>(bytes, n)       deltaCache: createLruCache<ObjectContent>(bytes, n)
ctx.deltaCache.set(id, looseBytes, looseBytes.length)  ctx.deltaCache.set(id, { type, content }, content.byteLength + 32)
const raw = ctx.deltaCache.get(id)  // bytes           const { type, content } = ctx.deltaCache.get(id) ?? …
raw.bytes  (RawObject)                                 serializeHeader(raw.type, raw.content.length) + raw.content, if genuinely needed
```

**Tests to edit (commit 2)** — enumerated so they are not rediscovered:
- `object-resolver.test.ts` (3 729 lines): the four `deltaCache.set(id, rawBytes, …)` seeds at
  `:828, :860, :889, :920` become `{ type, content }`; the **five poisoned-cache suites** at
  `:2536, :2572, :3156, :3195, :3237` are **deleted** (unreachable by type); a hasher double
  records two `update` calls in order on a `verifyHash: true` cache hit / pack read; the sizer
  charges `content.byteLength + 32` (observed through `currentSize` after one insert).
- `read-object.test.ts` (1 068): `readRawObject` returns `{ type, content }` with **no** `bytes`
  key.
- `blob-source.test.ts` (`:79, :100` seeds); `pack-registry.test.ts:4172`; `fsck.test.ts:6057`;
  `content-validation.test.ts` (306 lines — the packed-object hash pass hashes `serializeHeader` ‖
  body; a mismatch is still reported).
- The **15 trivial** `set('a', one, 1)` seeds → `{ type: 'blob', content: one }`:
  `index.node.test.ts:198-201`, `index.browser.test.ts:224-227`,
  `memory-adapter.test.ts:251-253`, `node-adapter.test.ts:248-249`, `repository.test.ts:654`.
- The **six explicit** `LruCache<Uint8Array>` generics → `LruCache<ObjectContent>`:
  `snapshot-iteration-stability.test.ts`, `primitives-binding-surface.test.ts`,
  `object-resolver.test.ts`, `context.test.ts`, `repository.test.ts`, `snapshot-wiring.test.ts`.
- The ≈ 90 contextually-typed `createLruCache(…)` calls in test fixtures compile unchanged.

**Stryker directives**
- `object-resolver.ts:621` (BlockStatement — `resolveBaseForRefDelta`'s cache shortcut) is
  **touched**: re-prove at the new line. The equivalence argument survives in the new shape — the
  fall-through resolves the same `ObjectContent` from the same cache via
  `resolveObjectContentWithDepth`, `chainDepth` 0.
- `object-resolver.ts:671` / `:676` (EqualityOperator — `splitHeader` guards) are **dropped with
  `splitHeader`**.
- `fsck.ts:46, :48` (BooleanLiteral — `createNoDeltaCache`'s `has`/`delete` arms) — value type
  only; re-run.

### TDD steps

**Commit 1**

1. **RED** — `git-object.test.ts`: `parseObjectContent(id, 'commit', content, hash)` returns the
   parsed commit. Fails: the function does not exist.
2. **RED** — one case per `ObjectType` (this is the exhaustive-switch kill), plus
   `parseObject(id, raw, hash)` deep-equals `parseObjectContent(id, ...splitObject(raw), hash)`.
3. **GREEN** — extract the switch, delegate from `parseObject`, export `ObjectContent` and
   `parseObjectContent` from `domain/objects/index.ts:37`.
4. `npm run docs:json`; commit with `reports/api.json`.

**Commit 2**

5. **RED** — `read-object.test.ts`: `readRawObject` returns an object with **no** `bytes` key.
   Fails.
6. **RED** — `object-resolver.test.ts`: a `verifyHash: true` cache hit drives a hasher double with
   exactly two `update` calls, `serializeHeader(type, len)` first and `content` second (the order
   is the mutant kill), then `digestHex`.
7. **RED** — the sizer: one insert leaves `currentSize === content.byteLength + 32`.
8. **GREEN** — flip `ports/context.ts` and `primitives/types.ts`, then let `npm run check:types`
   drive the sweep. **The type flip is the compile gate** — work the error list, do not grep for
   call sites. Delete `prependHeader`, `splitHeader`, `EMPTY_TREE_BYTES`, the
   `typeNameToPackType` `default` arm and the dead `enforceCachedCap` branch as the errors point
   at them.
9. **GREEN** — the five poisoned-cache suites are **deleted**, not rewritten: the state they test
   is unreachable by type. Deleting them is correct; keeping a contrived reconstruction is not.
10. **GREEN** — `content-validation.ts`: the packed arm hashes `serializeHeader` ‖ body; the loose
    arm at `:54` is **unchanged** — assert both in `content-validation.test.ts`.
11. **REFACTOR** — `verifyObjectContent` is exported once and used by every arm and by
    `blob-source`; no arm keeps a private copy.
12. `npm run docs:json`; commit with `reports/api.json`.
13. **Measurement probe (mandatory)** — `bench:ab` `delta-chain-read.bench` (all three rows) and
    `loose-read.bench` (both rows). The loose arm should be **unchanged in cost** (`splitObject`
    is a view); every pack-resolved read loses one `prependHeader`. Also, because this changes the
    emitted public type surface: `rm -rf dist .wireit && npm run build && npm run check:size &&
    npm run check:exports` — a size/tarball red read off a stale build is not evidence.

### Gate

Commit 1:
```
npx vitest run test/unit/domain/objects/git-object.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/objects/git-object.ts src/domain/objects/index.ts test/unit/domain/objects/git-object.test.ts && npm run check:spelling
```

Commit 2:
```
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/internal/blob-source.test.ts test/unit/application/commands/internal/fsck/content-validation.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/commands/fsck.test.ts test/unit/index.node.test.ts test/unit/index.browser.test.ts test/unit/adapters/memory/memory-adapter.test.ts test/unit/adapters/node/node-adapter.test.ts test/unit/repository/repository.test.ts test/unit/ports/context.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/context.ts src/application/primitives/types.ts src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts src/application/primitives/internal/object-caches.ts src/application/primitives/internal/blob-source.ts src/application/commands/internal/fsck/content-validation.ts src/application/commands/fsck.ts src/adapters/node/node-adapter.ts src/adapters/browser/browser-adapter.ts src/adapters/memory/memory-adapter.ts src/index.node.ts src/index.browser.ts src/index.default.ts && npm run check:spelling
```

For commit 2 the type-check must be run **bare** (`npx tsc --noEmit -p tsconfig.json`) — a wireit
cache hit on `check:types` is exactly the wrong thing to trust when the flip *is* the gate.

**Surface gates tripped:** `reports/api.json` **twice** (commit 1: `ObjectContent`,
`parseObjectContent`; commit 2: `Context.deltaCache`, `RepositoryHandle.deltaCache`, `RawObject`)
— prepush gate, pre-paid in each commit. `check:size` / `check:tarball` / `check:exports` (the
`.d.ts` surface changes). **Doc debt declared:** `docs/use/primitives/read-object.md`
(`RawObject` is `{ type, content }`) and a **5.0 migration note** with the before/after table —
docs phase. No new error code, no barrel addition beyond `domain/objects/index.ts:37`.

### Commit

Commit 1: `feat(objects): expose ObjectContent and parseObjectContent`

Commit 2: `feat(objects)!: store type and content in the loose-object cache`

## Part 9 — One HEAD reader, one slot, symlinked HEAD resolves symbolic (design P8, D4, ADR-855 + ADR-856)

### Context

**Depends on Part 6** (both edit `internal/repo-state.ts`, different functions). **Must precede
Part 10.**

**Today** HEAD is read twice per command: the gate `lstat`s + `readUtf8`s it
(`repo-state.ts:130-144` `hasUsableHead`), then the ref store reads it again
(`ref-store.ts:393-401` `readLooseContent`, reached from `resolveDirect` at `:403-415`).
`revParse('HEAD')` costs 4 fs calls / 13 libuv hops; a warm `catFile` is the gate alone.
`readHeadRaw` (`repo-state.ts:351-355`) is **not** a third reader — it goes through
`getRefStore(ctx).resolveDirect`.

**Two facts constrain any cache over it.**
1. A **symlinked HEAD is currently resolved wrongly**: `readLooseContent` follows the link and
   returns the branch's oid, so `resolveDirect('HEAD')` reports `direct` (detached) where git
   reports a symbolic ref (pin H1). The gate already models the link correctly through
   `isRefsLinkText` (`repo-state.ts:24,140`); the ref store does not. The sole reader fixes it by
   construction — preserving today's answer would mean re-implementing a divergence inside the fix
   that removes its cause.
2. The identity key `(mtime, size, ino)` is **degenerate on two of three adapters**: the memory
   adapter reports `ino: 0` for every file (`memory-file-system.ts:548`) and the browser adapter
   likewise (`browser-file-system.ts:330`), both with millisecond `mtimeMs`. There are **187 raw
   `writeUtf8` calls to a HEAD path across 66 unit-test files** that rewrite HEAD between commands
   on the memory adapter.

**New file** `src/application/primitives/internal/head-file.ts`:
```ts
export type HeadFile =
  | { readonly kind: 'symlink'; readonly linkText: string }   // lstat said symlink; readlink text verbatim
  | { readonly kind: 'file'; readonly content: string }        // regular file, decoded UTF-8
  | { readonly kind: 'unusable'; readonly cause: unknown };    // absent / EACCES / EISDIR / EIO — the adapter's error, KEPT

interface HeadSlot {
  readonly identity: string | undefined;   // `${mtimeNs ?? mtimeMs}:${ctimeNs ?? ctimeMs}:${ino}:${size}`; undefined when ino === 0
  readonly head: HeadFile;
  trusted: boolean;
}
const slots = new WeakMap<Context, HeadSlot>();    // ADR-856: Context identity, like the ref store — NOT the session

export const validateHead = async (ctx: Context): Promise<HeadFile> => { … };   // the gate's read: ALWAYS lstat; marks trusted
export const readHeadFile  = async (ctx: Context): Promise<HeadFile> => { … };  // the store's read: trusted slot ⇒ no I/O; else same path WITHOUT marking trusted
export const invalidateHeadSlot = (ctx: Context): void => { slots.delete(ctx); };
```

**Why `WeakMap<Context, …>` and not the session (ADR-856):** the slot holds **bytes read through
`ctx.fs`**, and a derived Context built as a spread with a proxied filesystem is a routine shape
here. A session-keyed slot would serve a proxied Context bytes the proxy never produced — the ref
store already documents having hit exactly this: `storeCache = new WeakMap<Context, RefStore>()`
with the "deliberately NOT on `ctx.session`" rationale at `ref-store.ts:243-255`.

**Read path on a slot miss, in git's order** (`files_read_raw_ref`, `refs/files-backend.c`):
`lstat` → symlink ⇒ `readlink` (2 hops; identity = the link's own lstat) · directory ⇒
`unusable` · regular ⇒ **the `lstat`'s `ino` picks the reader**:
- `ino !== 0` (Node): `openWithNoFollow(path, 'read')` → `handle.stat()` (identity from the
  **same open file**, so bytes and identity can never disagree) → `read` → `close` = 4 hops.
- `ino === 0` (memory, browser): `readUtf8` — identity is never trusted there, and the browser
  adapter's `openWithNoFollow` throws `UNSUPPORTED_OPERATION` (`browser-file-system.ts:205-207`),
  so the discriminator that decides *trust* also decides *reader*. **Nothing branches on
  `ctx.runtime`** — this is "the gate is the data", not a capability flag.

Port shapes: `FileSystem.lstat` / `readlink` / `readUtf8` / `openWithNoFollow` —
`src/ports/file-system.ts:214`; `FileHandle.stat` / `read` / `close` — `:34-48`;
`FileStat.mtimeNs` / `ctimeNs` / `ino` / `size` — `:2-18`.

**Consumers**
- `repo-state.ts:130-144` `hasUsableHead` → `validateHead(ctx)`; the predicate over the result is
  **unchanged** (`isRefsLinkText` for `symlink`, `isValidHeadContent` for `file`, `false` for
  `unusable`) — `repo-state.test.ts:202-340`'s matrix stays green. "HEAD deleted between two
  commands" (`:184-200`) → the second `lstat` misses → slot dropped → refuses. Reftable layouts:
  unchanged (the `HEAD` stub is read the same way; the reftable store never reads the slot).
- `ref-store.ts:403-415` `resolveDirect`, the `name === HEAD_NAME` arm → `readHeadFile(ctx)`:
  `symlink` with `refs/`-prefixed valid text ⇒ `{ kind: 'symbolic', target }` (**the fix**; a
  non-`refs/` symlink never reaches here — the gate refused it, pin H2); `file` ⇒
  `parseLooseRef(content)` as today; `unusable` with a `FILE_NOT_FOUND` cause ⇒ `missing`; **any
  other cause is rethrown** — a primitive caller on an EACCES/EISDIR HEAD sees the same
  `PERMISSION_DENIED`/mapped errno as today. `headCandidate` (`:462-465`) keeps its `exists` probe.
- `ref-store.ts:769` `applySet` and `:777` `applySetSymbolic` call `invalidateHeadSlot(ctx)` when
  `update.name === HEAD_NAME`, **after** `atomicWriteRef`. Reflog-only updates never touch HEAD's
  file.
- `src/application/commands/internal/bootstrap.ts:77` — the one raw HEAD writer in `src/`
  (`await ctx.fs.writeUtf8(\`${gitDir}/HEAD\`, …)`) — invalidates after the write.
- `list-worktrees.ts`'s per-worktree Contexts (`deriveWorktreeContext`) get their own slot — a miss
  once per listing, exactly today's one read (ADR-856's accepted cost).

**Not touched, recorded:** non-HEAD symlinked loose refs (`readLooseContent` still follows
symlinks for every other ref — pre-existing, needs its own pin matrix);
`core.preferSymlinkRefs` (tsgit does not implement it; a write through `applySetSymbolic('HEAD')`
over a symlinked HEAD replaces the link with a regular file, which is git's own default too).

**Window that changes (ledger L1):** within one command, after the gate validated HEAD, an
external rewrite is not observed by that command's later `resolveDirect('HEAD')` calls. The
residual staleness on Node needs an in-place write leaving `mtimeNs`, `ctimeNs`, `ino` and `size`
all identical — git's own lock-and-rename always changes the inode.

**Tests**
- `test/unit/application/commands/internal/repo-state.test.ts` — matrix `:202-340` unchanged;
  `:184-200` deleted-HEAD case; **new**: a second gate on an unchanged HEAD issues `lstat`
  **only**. The memory adapter reports `ino: 0`, so the identity path is reachable **only through
  an `fs` proxy** reporting Node-shaped fields with `ino !== 0` — and ADR-856's Context keying
  makes the proxied Context's slot its own. Also: the miss path goes `openWithNoFollow` →
  `handle.stat` → `read` → `close`; the plain memory adapter (`ino === 0`) re-reads through
  `readUtf8` and **never opens a handle**; a rewritten HEAD (new ino) is re-read.
- `test/unit/application/primitives/ref-store.test.ts` (1 638 lines) — `:867` symbolic-HEAD suite;
  the **two existing call-list assertions that name `readUtf8` on `/HEAD`** must be re-pinned;
  `resolveDirect('HEAD')` after a gate issues **no** `readUtf8`; a symlinked HEAD →
  `{ kind: 'symbolic', target: 'refs/heads/main' }` (memory adapter `symlink`); own
  `setSymbolic('HEAD')` invalidates; primitive-only sequence re-validates by `lstat` each call;
  `unusable` with an EACCES cause rethrows `PERMISSION_DENIED`.
- **New** `test/unit/application/primitives/internal/head-file.test.ts` — fixtures:
  `buildSeededContext` (`fixtures.ts:253`), `instrumentedContext` (`:343`), and — for the symlink
  arm — `refuseReadOnSymlink(base, symlinkPath)` (`fixtures.ts:322-332`), which wraps a Context so
  that `ctx.fs.read` on the symlink path **throws**; it is the no-dereference proof. Plus the
  `ino !== 0` proxy.
- `test/unit/application/primitives/list-worktrees.test.ts` — per-worktree slot.
- **New** `test/integration/head-symlink-interop.test.ts` — H1: after
  `ln -s refs/heads/main .git/HEAD`, tsgit `revParse('HEAD')`, `currentBranchRef`, `branch.list`'s
  `current`, and a `commit` advancing `main` all agree with git; H2: a non-`refs/` link refuses
  `NOT_A_REPOSITORY` where git fails discovery. Twin-repo helpers from `interop-helpers.ts`.

**Stryker directive:** `memory-file-system.ts:438` (MethodExpression — handle read clamp) is on
the HEAD miss path only under the `ino !== 0` proxy — re-run.

### TDD steps

1. **RED** — `head-file.test.ts`: `validateHead(ctx)` on a regular HEAD returns
   `{ kind: 'file', content }`; on a symlinked HEAD returns `{ kind: 'symlink', linkText }`; on an
   absent HEAD returns `{ kind: 'unusable', cause }` carrying the adapter's own error. Fails: the
   module does not exist.
2. **RED** — the `ino` discriminator, each arm isolated: with the `ino !== 0` proxy the miss path
   calls `openWithNoFollow` → `handle.stat` → `read` → `close` and **never** `readUtf8`; on the
   plain memory adapter (`ino === 0`) it calls `readUtf8` and **never** `openWithNoFollow`.
3. **RED** — identity: a second `validateHead` on an unchanged HEAD issues `lstat` only; after a
   rewrite that changes `ino`, it re-reads. Then **one case per identity field** (mtime, ctime,
   ino, size) varied alone through the proxy — a single combined case cannot kill the
   identity-field mutants.
4. **GREEN** — write `head-file.ts`.
5. **RED** — `repo-state.test.ts`: `hasUsableHead` routed through `validateHead` keeps the whole
   `:202-340` matrix green **and** the second gate issues `lstat` only. (If any matrix row moves,
   the predicate changed and that is a regression.)
6. **GREEN** — `hasUsableHead` → `validateHead`.
7. **RED** — `ref-store.test.ts`: `resolveDirect('HEAD')` on a **symlinked** HEAD returns
   `{ kind: 'symbolic', target: 'refs/heads/main' }`. Fails: today it follows the link and reports
   `direct`.
8. **RED** — `resolveDirect('HEAD')` after a gate issues **no** `readUtf8`; an EACCES `unusable`
   cause **rethrows** `PERMISSION_DENIED` rather than collapsing to `missing` (the cause-filter
   mutant kill).
9. **GREEN** — the `resolveDirect` HEAD arm.
10. **RED** — `applySetSymbolic('HEAD')` and the `bootstrap.ts:77` write each drop the slot (a
    stale slot served after our own write is the trust-bit mutant).
11. **GREEN** — the two `invalidateHeadSlot` calls plus bootstrap's.
12. **RED/GREEN** — `head-symlink-interop.test.ts` (H1, H2) against real git.
13. **REFACTOR** — the gate and the store must **not** construct each other: `head-file.ts` is a
    module both import (the gate cannot construct a ref store for a reftable layout it has not
    validated yet, and the files store must share the slot — this is the only acyclic shape).

### Gate

```
npx vitest run test/unit/application/primitives/internal/head-file.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/list-worktrees.test.ts test/integration/head-symlink-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/head-file.ts src/application/primitives/internal/repo-state.ts src/application/primitives/ref-store.ts src/application/commands/internal/bootstrap.ts && npm run check:spelling
```

**Surface gates tripped:** `check:architecture` (the new `head-file.ts` module and its two
importers). `check:write-surfaces` + `check:test-pyramid` (one new integration file). **No**
`reports/api.json` change — `HeadFile`, `validateHead`, `readHeadFile` and `invalidateHeadSlot`
are all internal. **Doc debt declared:** `docs/use/primitives/internals.md`'s
`RefStore · getRefStore` paragraph (HEAD read through the slot, symlinked HEAD symbolic) — docs
phase.

### Commit

`fix(refs): read HEAD once per command and resolve a symlinked HEAD as symbolic`

## Part 10 — Config epoch at the gate, worktree-scope check through the cache, one config read per ref update (design P9, D5, ADR-850)

### Context

**Depends on Part 9.** This part also **hosts the oracle for Parts 4 and 6's code** — "the
registry's config read and the class check inside a gated command issue zero `stat` of config"
can only be asserted once the epoch exists, so those assertions live in this part's test files
although the code under test is Parts 4's and 6's.

**(e) The epoch.** `readConfig` validates its cache entry with a `stat` of `.git/config` on
**every sequential** call (`config-read.ts:230` `coalescedMtimeKey` coalesces **concurrent** stats
only; `readConfigEntry` at `:342-356`). 48 call sites — one per object written in
`write-object.ts:34`, one per `walkTree` across eleven callers, two back to back in
`record-ref-update.ts`. And the gate's own verdict memo (`gateVerdictCache`, `:279`) is
**session-keyed and never re-validated**, so a `[core]` value made malformed by an external writer
after the first command is refused by **no** later command, while `readConfig`'s own consumers do
see the edit. The per-read stat and the never-re-read verdict are the same question asked at two
layers and answered inconsistently.

**Files to edit — verified anchors**
- `src/application/primitives/config-read.ts`
  - `:177` `interface CachedConfigEntry` gains `trusted: boolean`.
  - `:342-356` `readConfigEntry`:
    ```ts
    if (layoutFailsTrustGate(ctx.layout)) return loadConfigEntry(ctx);
    const cached = cache.get(ctx.session);
    if (cached?.trusted === true) return cached.promise;   // inside an epoch: NO stat
    … today's stat-validated path, which does NOT set `trusted` …   // primitive-only: per-read freshness kept
    ```
  - New `export const openConfigEpoch = async (ctx: Context): Promise<void>` — **one** `stat`. A
    changed key drops the parse entry **and both verdict memos** (`gateVerdictCache` and Part 6's
    `repoSettingsVerdictCache` + `settledRepoSettings`), so each verdict is re-derived from fresh
    tokens, as git's per-process `git_default_config` and `prepare_repo_settings` would. An
    unchanged key marks the entry `trusted`.
  - `memoizeSessionVerdict(slot, ctx, compute, onResolve?)` (Part 6's helper) gains an `mtimeKey`
    parameter: a memo whose key differs is recomputed — **for both slots**, so the repo-settings
    class is re-validated at the next boundary touch after an external edit, not only the gate's
    own classes.
  - `:365-369` `__resetConfigCacheForTests` resets the `trusted` bit along with the entry;
    `:389-393` `invalidateConfigCache` is unchanged in shape — the epoch dies with the entry.
- `src/application/primitives/internal/repo-state.ts` — `assertOperationalRepository` (`:320-325`)
  becomes `hasUsableHead` (Part 9's `validateHead`) → `openConfigEpoch` → memoised verdict.
  `computeGateVerdict` (`:305-309`) unchanged. **`assertRepository` (`:98-103`), the bare gate
  behind the `config` porcelain, opens NO epoch** — its readers are the scoped cache, which keeps
  its own per-call stat. Nested gates re-stat: harmless, one hop.
- **Cost, stated so it is not mistaken for a regression:** a command that reads config pays the
  same one stat as today, moved from its first `readConfig` to the gate. A command that reads
  **none** (`catFile`, `readBlob`, `revParse`) pays **one more** stat than today — the price of
  the refusal git makes and tsgit did not. ADR-850 chose this over the lazy variant deliberately.

**(h-i) `isWorktreeScopeActive`.** Today `src/application/primitives/internal/config-scope.ts:52-76`
raw-reads and re-`parseIniSections`es the local file **outside every cache**, on every
`config.get`, reached from `resolveScopePath('worktree')` (`:83-112`, the check at `:94`).
`readSingleScope` (`config-scoped-read.ts:148-166`) already caches local sections behind an mtime
key — but routing the check through it **from where it lives today would close an import cycle**
(`config-scoped-read.ts` imports `internal/config-scope.ts`; depcruise `no-circular` is enforced).
So the predicate **moves** into `config-scoped-read.ts` next to `readSingleScope`, exported under
today's name from that module; `resolveScopePath(ctx, 'worktree')` becomes
`resolveWorktreeScopePath(ctx, { active })` taking the verdict from its caller, and the three
importers pass it: `config-scoped-read.ts`, `update-config.ts`, `update-config-sections.ts`. The
`layoutFailsAcceptance` short-circuit (`config-scope.ts:58`) and the `parseGitBoolean` rule are
carried **verbatim**.

**(h-ii) `recordRefUpdate`.** `src/application/primitives/record-ref-update.ts:39-40` calls
`isLoggable` (which reads config at `:51`) and then `resolveReflogIdentity(ctx)` (which reads it
again at `reflog-identity.ts:26`). `resolveReflogIdentity(ctx, config?)` accepts the already-read
`ParsedConfig`; `recordRefUpdate` reads once and passes it. Under the epoch both reads are
stat-free anyway; the fold removes the second call (a promise hop), nothing else.

**Test impact — the mechanical enumeration ADR-850 prescribes.** 46 test files seed `.git/config`
with a raw `writeUtf8`; 3 also call `invalidateConfigCache`; 14 mix a Tier-1 command with a
config-reading primitive. The shape that breaks is *gated command → raw config rewrite →
config-reading primitive called directly (no gate)*. The expected set is **single digits**. The
procedure is not analysis: **land the epoch, run `npm run test:unit`, and every failure is one of
these** — add `invalidateConfigCache(ctx)` after the raw rewrite in each. Enumerate the resulting
set in the PR body (R4 requires it).

**Tests to edit**
- `config-read.test.ts`: gate → `readConfig` ×3 = **one** `stat`; a raw rewrite inside the epoch
  is unseen and is seen at the next gate; `invalidateConfigCache` clears `trusted`; **no gate ⇒ a
  `stat` per read** (today's tests must still hold); **both** verdict memos re-run on a key change
  — a raw rewrite to a malformed `core.sparseCheckout` between two commands ⇒ the second's gate
  refuses; to a malformed `core.deltaBaseCacheLimit` / `core.maxTreeDepth` ⇒ the second's gate
  **passes** and its first boundary touch refuses. Today's `:110` / `:130` cases are kept.
- `repo-state.test.ts` — `:110`, `:130` verdict cases; the malformed-class-between-commands case.
- `repo-settings-gate.test.ts` — Part 6's "broken **without** invalidate → still resolves" case
  **flips** to "→ refused at the next gate + boundary touch". This is the one place a Part 6
  assertion is deliberately rewritten; do not treat it as a regression.
- `config-scoped-read.test.ts` — an unscoped `config.get` issues **one** local read.
- `config-scope.test.ts` (+ its properties file).
- `record-ref-update.test.ts` — a `readConfig` spy called **once**.
- `reflog-identity.test.ts`.
- `read-object.test.ts` / `read-index.test.ts` / `internal/read-commit-graph.test.ts` — **the
  Parts 4/6 oracle**: a first `readObject` / `readIndex` / `commitHeader` after
  `assertOperationalRepository` issues **zero** `stat` of `config` (`instrumentedContext`).
- `test/integration/config-interop.test.ts` (**extend**) — the correction-8 case: an external edit
  making `core.sparseCheckout` malformed between two tsgit commands is refused by the second.

**Stryker directive:** `config-scope.ts:105` (ConditionalExpression — global path) **moves** with
the `resolveScopePath` refactor — re-prove in place. `config-read.ts:185` (StringLiteral — absent
sentinel) and `update-config.ts:435, :564` (CallExpression — invalidate pairing) are untouched —
re-run.

### TDD steps

1. **RED** — `config-read.test.ts`: `assertOperationalRepository(ctx)` then three `readConfig(ctx)`
   calls issue **one** `stat` of `config` (`instrumentedContext`). Fails: four today.
2. **RED** — inside the epoch a raw `writeUtf8` of `.git/config` is **not** seen by a later
   `readConfig`; after the next `assertOperationalRepository` it **is**.
3. **RED** — `invalidateConfigCache(ctx)` clears `trusted` (the next `readConfig` stats again).
4. **RED** — **no gate ⇒ a `stat` per read** — assert the existing primitive-only behaviour is
   untouched; this is the contract for `assertRepository` and for primitive-only sessions.
5. **GREEN** — `CachedConfigEntry.trusted`, `openConfigEpoch`, the `readConfigEntry` fast path,
   the `assertOperationalRepository` wiring.
6. **RED** — both verdict memos re-run on a changed key, as two separate cases: a malformed
   **streaming** class between two commands ⇒ the second command's **gate** refuses; a malformed
   **repo-settings** class ⇒ the second command's gate **passes** and its first boundary touch
   refuses.
7. **GREEN** — `memoizeSessionVerdict` gains the `mtimeKey` parameter; `openConfigEpoch` drops
   both slots and the settled set on a changed key.
8. **RED** — `config-scoped-read.test.ts`: an unscoped `config.get` issues **one** local
   `readUtf8` (today: the cached scope read **plus** the raw `isWorktreeScopeActive` read).
9. **GREEN** — move the predicate into `config-scoped-read.ts`, thread the verdict through
   `resolveWorktreeScopePath`, update the three importers. `npm run check:architecture` is the
   oracle that the cycle stayed open — run it before believing the move.
10. **RED** — `record-ref-update.test.ts`: a `readConfig` spy records **one** call across a ref
    update. Fails: two.
11. **GREEN** — `resolveReflogIdentity(ctx, config?)`, threaded from `recordRefUpdate`.
12. **RED/GREEN** — the Parts 4/6 oracle in `read-object.test.ts` / `read-index.test.ts` /
    `read-commit-graph.test.ts`: zero `stat` of `config` on a first boundary touch after a gate.
13. **RED/GREEN** — `config-interop.test.ts`'s correction-8 case.
14. **The enumeration** — run `npm run test:unit` whole. Each failure is a test that seeds config
    with a raw write between a gated command and a gate-less config read; add
    `invalidateConfigCache(ctx)` after the write. List them in the PR body.
15. **REFACTOR** — `assertOperationalRepository` reads as three named steps
    (`validateHead` → `openConfigEpoch` → memoised verdict); do **not** parallelise the gate's
    `lstat HEAD` and `stat config` (the design records that as rejected: it would read config on a
    non-repository before refusing, for ~10 µs).

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/commands/internal/repo-state.test.ts test/unit/application/primitives/internal/repo-settings-gate.test.ts test/unit/application/primitives/config-scoped-read.test.ts test/unit/application/primitives/internal/config-scope.test.ts test/unit/application/primitives/record-ref-update.test.ts test/unit/application/primitives/reflog-identity.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/read-index.test.ts test/unit/application/primitives/internal/read-commit-graph.test.ts test/integration/config-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/internal/repo-state.ts src/application/primitives/config-scoped-read.ts src/application/primitives/internal/config-scope.ts src/application/primitives/update-config.ts src/application/primitives/update-config-sections.ts src/application/primitives/record-ref-update.ts src/application/primitives/reflog-identity.ts && npm run check:spelling
```

Plus `npm run check:architecture` — the `isWorktreeScopeActive` move exists **because** of the
cycle; this check is its oracle.

**Surface gates tripped:** `check:architecture`. **No** `reports/api.json` change (`openConfigEpoch`,
`resolveWorktreeScopePath` and the memo helpers are internal; `invalidateConfigCache` keeps its
signature). **Doc debt declared:** `docs/use/primitives/internals.md`'s `readConfig` /
`invalidateConfigCache` paragraph (`:61`) must carry ADR-850's contract **with ADR-862's
qualification** — a config file changed by tsgit's own writers is seen on the next read; a **raw
external write** is seen at the next operational gate (next command) or the next
`invalidateConfigCache`; a session that never runs a gate keeps per-read staleness detection;
object **writes** validate the repo-settings class whether or not a gate has run. Plus the
`recordRefUpdate` (one config read) paragraph. Docs phase.

### Commit

`perf(config): read config once per command at the operational gate`

## Part 11 — `packed-refs` single stat and pooled loose enumeration (design P10, D6 + D7) — 2 commits

### Context

**Ordered after Parts 9 and 10** — not a code dependency, but `listRefs`'s HEAD candidate now
reads through Part 9's slot. **Contract: this part must not move a byte.** The interop files
`packed-refs-interop.test.ts` and `pack-refs-interop.test.ts` are **re-run unchanged** as the
proof.

#### Commit 1 — `packed-refs`: one stat, packed-only oids from the snapshot (D6)

**Git's mechanism.** `packed_ref_store` validates by `stat` (`stat_validity_check`) and treats
ENOENT as "no packed refs"; any other read failure is fatal (pin P1: a **directory** at
`.git/packed-refs` → `fatal: couldn't read .git/packed-refs: Is a directory`, exit 128, on every
ref operation).

**File to edit** `src/application/primitives/ref-store.ts`:
- `loadPackedRefs` at `:376-391` — today `exists` (which is itself a `stat` on Node,
  `node-file-system.ts:719-730`) **then** `stat`. Target:
  ```ts
  const path = packedRefsPath(commonGitDir(ctx));
  let stat: FileStat;
  try { stat = await ctx.fs.stat(path); }
  catch (err) { if (isFileNotFound(err)) return EMPTY_PACKED_REFS; throw err; }   // one stat, not exists + stat
  const key = `${stat.mtimeMs}:${stat.size}`;
  … cache hit / readUtf8 / parse as today …    // a directory still fails in readUtf8 EXACTLY as today
  ```
- `listRefs` (around `:561-569`) splits the candidate set `collectCandidateNames` (`:532-542`)
  **already computes**: `collectCandidateNames` holds the packed **entries with oids**, yet
  `listRefs` still `resolveEntry`s every name serially, so each packed-only name costs a
  `readUtf8` (ENOENT) + `exists` + `stat`. After: loose names (from `walkAllLooseRefNames`) resolve
  through `resolveEntry`; packed-only names (in the snapshot, **not** in the loose set) become
  `{ name, value: { kind: 'direct', id: entry.id } }` straight from the snapshot — byte-for-byte
  what `resolveDirect` returns for them today (`:412-414`), without the per-name `readUtf8`.
  The result is sorted after, as today (`byName`). `collectCandidateNames` and `listRefNames`
  (`:571-573`) keep their shapes; `packableEntries` (`:836-841`) inherits.
- **Equivalence, stated so the implementer does not "improve" it:** a loose name that fails to
  parse is excluded and never falls back to packed (today's `resolveEntry` catch) — unchanged,
  because loose names still go through `resolveEntry`. A loose file that vanished between `readdir`
  and read falls through to the packed map inside `resolveDirect` — unchanged.
- Ledger: **no freshness change** — one `stat` per `loadPackedRefs` is the same staleness detector
  as today's `exists`+`stat` pair.

**Measured target:** `tag.list` over 2 000 packed-only tags costs 3N + gate = **6 005 fs calls,
104.6 ms** today (`git tag -l`: 13 ms). After (d)+(e)+(f): ≈ 5 calls.

#### Commit 2 — loose enumeration through the `ioBound` pool (D7)

Four serial `for … await` loops become
`boundedMapFor(ctx, 'ioBound', items, worker)` — `internal/concurrency.ts:53-58`, which
**preserves input order** and propagates the first rejection, with `limitFor` from
`ctx.concurrency` (`:33`):

| Site | Today | After |
|---|---|---|
| `ref-store.ts:562-567` `listRefs` loose arm | `for … await resolveEntry(name)` | pooled → filter `undefined` → concat packed-only → sort |
| `ref-store.ts:881-885` `packRefs` prune probe | serial `exists` per packable | pooled `exists`, `toPrune` filtered in input order; the `rm` loop at `:890-892` pooled likewise |
| `commands/reflog.ts:234-241` `resolveTips` | serial `tryResolve` per ref | pooled; `Set` dedup after |
| `list-worktrees.ts:202-205` | serial `linkedEntry` per admin dir (`readdir` at `:202`, `sort(byPath)` at `:206`) | `boundedMapFor` over the `readdir` entries, sort after |

**The one partial-failure difference, and why it is safe:** a mid-way failure in `packRefs`'
pooled `rm` loop leaves an **arbitrary subset** of loose duplicates instead of a **prefix** — but
`packed-refs` was written first (`:888`) and a surviving loose file holds the same value, so both
partial states read identically.

**Concurrency safety:** `loadPackedRefs` is a pure read + memo (a concurrent miss parses twice,
never corrupts); the `packedCache` write is a single assignment. The `mainCtx` ref store shared
across worktree Contexts (`list-worktrees.ts:197`) is the same object under the pool as under the
loop. `verifyIntegrity` (`:575-597`) is **fsck's and stays serial** — out of scope.

**Measured target:** 1 000 loose branches, 79 ms → 12–14 ms.

**Tests**
- `test/unit/application/primitives/ref-store.test.ts` (1 638 lines): the packed suites at
  `:339-475`; `:633` (loose-overrides-packed), `:885`, `:955` (unparseable-loose-excluded) and
  `:1062` (spread-ceiling) must stay **unchanged**. New: absent `packed-refs` ⇒ **one** `stat`,
  **zero** `exists`; packed-only names in `listRefs` ⇒ **zero** `readUtf8` under the prefix; a
  directory at `packed-refs` throws the adapter's mapped error as today. For commit 2:
  `listRefs` over 64 loose names with an `fs` double recording **max in-flight `readUtf8` > 1**
  and asserting sorted output (a `boundedMapFor` → `for…await` mutant reads 1 — that counter is
  the only thing that kills it).
- `test/unit/application/primitives/list-worktrees.test.ts` — order + in-flight.
- `test/unit/application/commands/reflog.test.ts` — `resolveTips` dedup.
- `test/integration/packed-refs-interop.test.ts` and `pack-refs-interop.test.ts` — **re-run
  unchanged**.

**Stryker directives:** `ref-store.ts:318, :320` (`compareRefNames`) and
`list-worktrees.ts:185, :187` (`byPath`) are untouched — re-run.

### TDD steps

**Commit 1**

1. **RED** — `ref-store.test.ts`: with `packed-refs` absent, `loadPackedRefs` issues **one** `stat`
   and **zero** `exists` (`instrumentedContext`). Fails: `exists` + `stat`.
2. **RED** — `listRefs` over a snapshot of 64 packed-only names issues **zero** `readUtf8` under
   `refs/tags/`. Fails: one per name.
3. **RED** — a directory at `.git/packed-refs` still throws the adapter's mapped error (the
   `FILE_NOT_FOUND → EMPTY` filter must not swallow EISDIR).
4. **GREEN** — `loadPackedRefs` single stat; `listRefs` split.
5. **Verify non-regression** — `:633`, `:885`, `:955`, `:1062` unchanged and green; then re-run
   `packed-refs-interop.test.ts`.

**Commit 2**

6. **RED** — `listRefs` over 64 loose names: the `fs` double's **max in-flight `readUtf8`** is
   > 1, and the output is sorted. Fails: serial.
7. **RED** — the same in-flight oracle for `packRefs`' prune probe, `resolveTips`, and
   `list-worktrees`.
8. **GREEN** — four `boundedMapFor(ctx, 'ioBound', …)` substitutions.
9. **REFACTOR** — none; do **not** change the pool bucket (`ioBound` is the bucket `packRefs`
   already uses, and the design records the choice as settled).
10. Re-run `pack-refs-interop.test.ts` and `packed-refs-interop.test.ts` **unchanged** — this is
    the byte-identity proof for both commits.

### Gate

```
npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/list-worktrees.test.ts test/unit/application/commands/reflog.test.ts test/integration/packed-refs-interop.test.ts test/integration/pack-refs-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/primitives/list-worktrees.ts src/application/commands/reflog.ts && npm run check:spelling
```

**Surface gates tripped:** none — `RefStore`'s public method shapes are unchanged, no
`reports/api.json` change, no error code, no doc page gate. **Doc debt declared:**
`docs/use/primitives/internals.md`'s `RefStore · getRefStore` paragraph (single stat, packed-only
from the snapshot, pooled `listRefs`) and `listWorktrees` (pooled) — docs phase.

### Commit

Commit 1: `perf(refs): load packed-refs with one stat and take packed-only oids from the snapshot`

Commit 2: `perf(refs): enumerate loose refs through the io-bound pool`

## Part 12 — `reflog expire` follows git's reachability rule (design P11, D8, ADR-857)

### Context

**Depends on Part 11** for the pooled `resolveTips`. Part 6's transcribed prologue call in
`reflog.ts:75-79` **stays where it is** — this part edits different functions.

**ADR-064's "fully faithful" claim is superseded.** Pinned against git 2.55.0, tsgit's rule
diverges in four ways:
- Git expires `timestamp < expire_total` **unconditionally**, with no reachability question asked.
- The unreachable clock tests **both** the old and the new object id, not the new one alone.
- Reachability is measured from **the ref's own tip** (`UE_NORMAL`); every tip is used only for
  `HEAD` (`UE_HEAD`); a log whose ref does not resolve to a commit expires by clock alone
  (`UE_ALWAYS`).
- The mark walk is **bounded** at `expire_total`: commits older than that are kept as a
  `leftover` frontier and **never expanded**, so an old commit is reachable only if it *is* a
  frontier commit.

Git also skips the walk entirely when `expire_unreachable <= expire_total`. **That skip is a
consequence of git's rule, not a substitute for it** — the brief framed it as the perf fix on its
own, and on the default clocks (90 days vs 30 days) the two are never equal, so the skip alone
buys nothing.

**File to edit** `src/application/commands/reflog.ts` — verified anchors: `runExpire` at `:156`
(the `collectReachable` call at `:168`, the `keepEntry` call at `:183`), `keepEntry` at `:213-221`,
`collectReachable` at `:224-232` (whose `resolveTips` call is at `:225`), `resolveTips` at `:234`
(Part 11 pooled it — keep the pooled helper).

```ts
type ExpireKind = { readonly kind: 'always' } | { readonly kind: 'walk'; readonly tips: ReadonlyArray<ObjectId> };
const expireKindFor = async (ctx, ref, expireCut, unreachableCut): Promise<ExpireKind> => {
  if (unreachableCut <= expireCut) return { kind: 'always' };                  // git: expire_unreachable <= expire_total
  if (ref === 'HEAD') return { kind: 'walk', tips: await resolveTips(ctx) };   // UE_HEAD
  const tip = await peelRefToCommit(ctx, tipOid);                             // lookup_commit_reference_gently — REUSE, do not write a new peeler
  return tip === undefined ? { kind: 'always' } : { kind: 'walk', tips: [tip] };  // UE_ALWAYS | UE_NORMAL
};
const shouldExpire = (entry, kind, reach, expireCut, unreachableCut): boolean =>
  entry.identity.timestamp < expireCut ||
  (entry.identity.timestamp < unreachableCut &&
    (kind.kind === 'always' || reach.isUnreachable(entry.oldId) || reach.isUnreachable(entry.newId)));
```

**Marking is lazy and date-bounded**: expand a commit only while `committerDate >= expireCut`;
`isUnreachable(oid)` extends the walk from the `leftover` frontier **before** answering, as git's
`unreachable()` does.

**The peeler already exists — reuse it.** `peelRefToCommit(ctx, oid): Promise<PeeledRef | undefined>`
(`src/application/primitives/internal/peel-ref-to-commit.ts:20`) peels annotated tags, returns
`undefined` for a non-commit **and** for an over-depth chain, and returns `{ commit, viaTag,
taggerDate }` otherwise — which is exactly `lookup_commit_reference_gently`'s contract. Do **not**
write a new `peelToCommitOrUndefined`; `tipOid` above is the ref's own resolved oid
(`getRefStore(ctx).resolveDirect(ref)`), and `undefined` from the peeler is the `UE_ALWAYS` arm.

**Peeling, which today's code skips.** Both `lookup_commit_reference_gently` calls **peel tags**:
the ref's tip (`UE_NORMAL`), every tip under `UE_HEAD` (`push_tip_to_list`, non-commits skipped),
and each entry's `old`/`new` oid before the reachability test. So `resolveTips` resolves with
`{ peel: true }` and drops non-commits, and `isUnreachable(oid)` peels through `readObject` before
consulting the marks. Today's `collectReachable` seeds `walkCommits` with **unpeeled** tips —
another pre-existing gap the rewrite closes. **Null oids (`0000…`) and non-commit oids are
"reachable" (kept)**, exactly as `unreachable()` returns 0 for them.

**Cutoffs need no change:** `resolveExpiryCutoff` (`src/application/primitives/expiry-cutoff.ts`)
already maps `never` → −∞ and `all`/`now` → +∞ (git: 0 and `TIME_MAX`), so
`never <= anything` and `now <= never` behave exactly as git's comparison.

**Reads through** `readCommitMeta` (`src/application/primitives/internal/read-commit-meta.ts`, the
graph-first reader), `resolveRef(…, { peel: true })`, and `readObject` for the non-commit check —
so no new traversal seam appears. The performance win (one tip instead of all tips, a bounded walk
instead of a full one) **falls out of the faithful shape** rather than being engineered.

**The measured divergences the matrix must flip** (design §R, pins R1–R7):
- R2 `--expire=never --expire-unreachable=now refs/heads/main`: git keeps **1 of 3**, tsgit keeps
  3 (tsgit's all-tips reachable set makes B reachable via `side`; git measures from `main`'s own
  tip A).
- R6 `--expire=now --expire-unreachable=never`: tsgit keeps `B→D`, git expires it.
- R6 `--expire=never --expire-unreachable=now`: tsgit keeps `D→B` (newId B reachable), git
  expires it (**old** oid D unreachable).

**Tests**
- `test/unit/application/commands/reflog.test.ts` (1 349 lines): `:742-1010` encode **today's**
  rule and are **rewritten** to the R-matrix as parameterised cases over
  `{expire, unreachable} × {reachable-from-own-tip, reachable-from-other-tip, unreachable,
  null-old}`. Additional isolated cases: the `UE_ALWAYS` short-circuit issues **zero** object
  reads; the bounded walk stops at `expireCut`; `HEAD` uses all tips; an unresolvable ref under
  `--all` ⇒ always. Each predicate arm isolated; `<` vs `<=` at the cut; old/new **symmetry** via a
  case where only `old` is unreachable.
- `test/integration/reflog-interop.test.ts` — extend the expire suites (`:695-960`, `:1074`,
  `:1134`, `:1358`) with R1–R6′ on the pinned history, twin repos (git rewrites the peer, tsgit
  ours; compare log **bytes**).

**Out of scope, recorded (ADR-857):** `gc.reflogExpire` / `gc.reflogExpireUnreachable` (expire uses
constants — a pre-existing configuration gap), and the single-ref expire of a log whose ref no
longer resolves (git refuses `reflog could not be found`; tsgit's file-probe `hasReflog` at `:104`
proceeds — R6′).

### TDD steps

1. **RED** — `reflog.test.ts`, R2 as its own case: on the pinned history, `--expire=never
   --expire-unreachable=now refs/heads/main` keeps **1 of 3** entries. Fails: tsgit keeps 3.
2. **RED** — R1 (`--expire=now --expire-unreachable=never` keeps 0 of 3 via the
   `unreachable <= total` ⇒ `UE_ALWAYS` short-circuit), R3 (`HEAD` keeps 6 of 6), R4 (no walk,
   3 of 3), R5 (explicit timestamps, 1 of 3), R6 (with D: 0 of 4 / 2 of 4 / 2 of 4) — each its own
   case.
3. **RED** — old/new symmetry: an entry whose **old** oid alone is unreachable expires. This is
   the single most load-bearing case; today's `keepEntry` consults `newId` only.
4. **RED** — a **null** old oid (`0000…`) is treated as reachable (kept); a **non-commit** oid
   likewise.
5. **RED** — the `UE_ALWAYS` short-circuit issues **zero** object reads (an `instrumentedContext`
   or `readObject` spy) — this is what proves the walk is skipped rather than merely ignored.
6. **RED** — the bounded walk: a commit older than `expireCut` is kept as a frontier and **not**
   expanded (assert the visited set, not just the verdict).
7. **GREEN** — `expireKindFor`, the lazy date-bounded marker over `readCommitMeta`, `shouldExpire`;
   delete `keepEntry` and `collectReachable`'s all-tips seed.
8. **RED/GREEN** — `resolveTips` resolves with `{ peel: true }` and drops non-commits;
   `isUnreachable` peels through `readObject` before consulting the marks.
9. **RED/GREEN** — `reflog-interop.test.ts` R1–R6′ against real git, twin repos, comparing log
   bytes.
10. **REFACTOR** — keep the pooled `resolveTips` from Part 11 (it now survives only for the
    `UE_HEAD` case); do **not** re-serialise it.

### Gate

```
npx vitest run test/unit/application/commands/reflog.test.ts test/integration/reflog-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/reflog.ts test/unit/application/commands/reflog.test.ts test/integration/reflog-interop.test.ts && npm run check:spelling
```

The interop file spawns git — 60 s timeout, one shared `beforeAll` repo, `GIT_*` scrubbed, signing
off, deterministic dates.

**Surface gates tripped:** none mechanical — `reflog`'s one-command discriminated `action` shape
and its `show` / `exists` / `delete` / `expire` split are carried forward from ADR-064, so no
`reports/api.json` change, no error code, no barrel change. **Doc debt declared:**
`docs/use/commands/reflog.md`'s Behaviour section must carry ADR-857's rule verbatim — docs phase.
ADR-064's supersession note is already committed.

### Commit

`fix(reflog): follow git's expire reachability rule`

## Part 13 — `rev-parse` candidate sweep without thrown misses, and `appendUtf8` attempt-first (design P12, D9 + D10) — 2 commits

### Context

**Independent of every other part**; last because smallest. The two commits share nothing but
size.

#### Commit 1 — the rev-parse candidate sweep (D9)

**Today** `rev-parse.ts:61-77` `resolveBase` iterates `refCandidates(base)` (six eagerly-built
strings, `domain/refs`) and each miss throws `REF_NOT_FOUND` from `resolveDirectChain`
(`resolve-ref.ts:51-53` `throw refNotFound(current)`) on top of the adapter's `FILE_NOT_FOUND`;
the `catch {}` swallows **every** error. A `TsgitError` stack capture costs 2.1 µs (0.22 µs
without the stack), and there are two per miss.

**Files to edit — verified anchors**
- `src/application/primitives/resolve-ref.ts`:
  ```ts
  type ChainOutcome = { readonly kind: 'found'; readonly id: ObjectId } | { readonly kind: 'missing'; readonly name: RefName };
  // resolveDirectChain(refStore, initial, maxDepth): Promise<ChainOutcome> — today's loop (:25-…),
  //   returning `missing` instead of throwing at :51-53
  export const resolveRefOrMissing = async (ctx, name, options?): Promise<ObjectId | undefined> => { … peel as resolveRef … };
  export async function resolveRef(ctx, name, options?) {
    const outcome = await resolveDirectChain(getRefStore(ctx), name, maxSymbolicDepth);   // :15, :20
    if (outcome.kind === 'missing') throw refNotFound(outcome.name);   // the name the chain ENDED on, as today
    return peel ? peelChain(ctx, outcome.id, maxPeelDepth) : outcome.id;
  }
  ```
  **The care point:** today `refNotFound(current)` names the ref the chain **ended** on — a
  dangling symref `refs/heads/x → refs/heads/gone` reports `gone`. That is why the chain returns
  the *name* and `resolveRef` throws with it. **The message must be unchanged.** Every other
  failure (cycle, depth, bad content, invalid name) still throws exactly as today.
- `src/application/commands/rev-parse.ts:61-77` (`resolveBase`, the loop at `:65`) and
  `src/application/commands/internal/commit-ish.ts:22` — call `resolveRefOrMissing` inside the
  **same** `try/catch { continue }` (git's `expand_ref` continues past broken/dangling candidates,
  so swallowing non-miss errors stays). `commit-ish.ts:24` passes `{ peel: true }`, so
  `options.peel` must be threaded.
- `refCandidates` **stays an array** — `canonicalizeRef` (`rev-parse.ts:105-124`) iterates it
  twice, so a generator would break it, and six short strings cost ≈ 0.3 µs. The **two stack
  captures** are where the time goes. `rev-parse.ts:36`'s Part 6 prologue call is untouched.
- Per miss after this change: **zero** thrown `REF_NOT_FOUND`. The adapter's `FILE_NOT_FOUND` on
  the loose probe remains — that is 31.3's `tryReadUtf8`, explicitly out of scope here. The
  existing `AMBIGUOUS_OID_PREFIX` / `OBJECT_NOT_FOUND` fallbacks are untouched.

**Stryker directive:** `resolve-ref.ts:34` (StringLiteral/ConditionalExpression — HEAD name guard)
**moves into `resolveRefOrMissing`** — re-prove at the new line.

**Tests:** `test/unit/application/primitives/resolve-ref.test.ts` (`resolveRefOrMissing` returns
`undefined` on a missing chain; `resolveRef` still throws `REF_NOT_FOUND` with the **same** `data`
— `ref` = the chain's last name; cycle / depth / invalid-name still throw);
`test/unit/application/commands/rev-parse.test.ts` (a miss sweep constructs **no**
`REF_NOT_FOUND` — a `RefStore` double counting `resolveDirect` calls reads 6 and `resolveRef` is
never invoked); the `commit-ish` tests.

**Bench oracle:** the abbreviated-oid row Part 1 added to `rev-parse.bench.ts` — the only shape
that exercises the sweep.

#### Commit 2 — `appendUtf8` attempts first, `mkdir` on ENOENT (D10)

**File to edit** `src/adapters/node/node-file-system.ts` — `appendUtf8` at `:705-712`:
`resolveWrite` (`:706`) → `assertWritableLeaf` (`:707`) → **`mkdir -p`** → `appendFile` (`:710`,
with `APPEND_FLAGS` from `:81`). The `mkdir` costs 15 µs against the append's 57 µs on every
reflog line. Target:
```ts
await runFs(async () => {
  try { await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS }); }
  catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
    await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
    await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS });   // once; a second ENOENT propagates
  }
}, path);
```
`resolveWrite` + `assertWritableLeaf` are **unchanged** — the leaf check still precedes the
attempt, exactly as today.

**Explicitly not changed:** `write` / `writeUtf8` / `writeExclusive` keep their `mkdir`-first
shape. 31.4(e) owns the checkout write path, and `writeExclusive` is the ref-lock path whose
parent almost always exists — the same fix applies but its harness is 31.4's `checkout.bench`.
Memory and browser adapters already create parents implicitly and issue **no** `mkdir` —
unchanged.

**Oracle:** the `test/unit/adapters/node/node-file-system-injected.test.ts` pattern — an `fsOps`
double records that an append into an **existing** directory issues **no** `mkdir`; a **missing**
parent issues `appendFile` (ENOENT) → `mkdir` → `appendFile`; a **non-ENOENT** failure propagates
**without** `mkdir`. `15 vs 57 µs` is inside `commit.bench`'s noise — **there is no honest bench
for this; the unit test is the whole oracle.** Say so rather than quoting a bench.

**Tests:** `node-file-system-injected.test.ts` plus the append cases in
`test/unit/adapters/node/node-file-system.test.ts`.

### TDD steps

**Commit 1**

1. **RED** — `resolve-ref.test.ts`: `resolveRefOrMissing(ctx, 'refs/heads/gone')` resolves to
   `undefined`. Fails: it does not exist.
2. **RED** — `resolveRef(ctx, 'refs/heads/x')` on a dangling symref `x → gone` still throws
   `REF_NOT_FOUND` with `data.ref === 'refs/heads/gone'` (**the name the chain ended on**, not the
   name asked for). This is the message-preservation kill; assert the field, not the class.
3. **RED** — cycle, depth-exceeded, bad content and invalid-name each still throw their own code
   (four isolated cases — a single combined case cannot prove each arm).
4. **GREEN** — `ChainOutcome`, `resolveDirectChain` returning it, `resolveRefOrMissing`,
   `resolveRef` throwing on `missing`.
5. **RED** — `rev-parse.test.ts`: a miss sweep constructs **no** `REF_NOT_FOUND`; the `RefStore`
   double counts exactly 6 `resolveDirect` calls and `resolveRef` is never invoked.
6. **GREEN** — `resolveBase` and `commit-ish.ts:22` call `resolveRefOrMissing`, `{ peel: true }`
   threaded.
7. **REFACTOR** — keep `refCandidates` an array and keep the `try/catch { continue }`; both are
   recorded as settled (a generator breaks `canonicalizeRef`'s second iteration; the catch is
   git's `expand_ref` behaviour).

**Commit 2**

8. **RED** — `node-file-system-injected.test.ts`: an `appendUtf8` into an **existing** directory
   records **zero** `mkdir` calls on the `fsOps` double. Fails: one today.
9. **RED** — a **missing** parent records `appendFile` → `mkdir` → `appendFile`, in that order
   (the order is the retry-count mutant kill).
10. **RED** — an **EACCES** failure propagates and records **no** `mkdir` (the errno-filter mutant
    kill); and a **second** ENOENT after the `mkdir` propagates rather than looping.
11. **GREEN** — the try/catch shape above.
12. **REFACTOR** — none; one `mkdir` + one retry is the settled retry count (a second ENOENT is a
    real fault).

### Gate

Commit 1:
```
npx vitest run test/unit/application/primitives/resolve-ref.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/commands/internal/commit-ish.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-ref.ts src/application/commands/rev-parse.ts src/application/commands/internal/commit-ish.ts && npm run check:spelling
```

Commit 2:
```
npx vitest run test/unit/adapters/node/node-file-system-injected.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/node/node-file-system.ts && npm run check:spelling
```

**Surface gates tripped:** `resolveRefOrMissing` is a new export from
`src/application/primitives/resolve-ref.ts` — **decide it now: it is internal.** Its only
consumers are `rev-parse.ts` and `commit-ish.ts` inside `src/`. Do **not** add it to
`src/application/primitives/index.ts`; if a later need makes it public it trips
`reports/api.json` + `docs/use/primitives/resolve-ref.md` and that is a separate decision.
`ChainOutcome` is module-private. No `reports/api.json` change in either commit. **Doc debt
declared:** none — `docs/use/commands/rev-parse.md` needs no change (behaviour is identical).

### Commit

Commit 1: `perf(refs): resolve rev-parse candidates without thrown misses`

Commit 2: `perf(adapters): append first and mkdir only on ENOENT`
