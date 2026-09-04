# Plan — streaming index pass for received packs

> Source: design doc `docs/design/streaming-index-pass.md` · ADRs 779, 780, 781, 782, 783,
> 784, 785, 786, 787, 788, 789, 790
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## How to read the design doc

The design is **settled**: zero decision candidates, twelve ratified ADRs. Where the design
body and an ADR disagree, the ADR wins. The design already folds every ADR in, so the body
and the ADRs agree throughout — but five things are under-specified or slightly wrong, and
this plan resolves them. Do not re-derive them.

| Design says | What this plan implements, and why |
|---|---|
| §Test strategy: "the ADR-788 budget sweep … on all four fixtures" and R15's "`INDEX_PASS_BASE_CACHE_MAX_BYTES` forced to `0`" | **There is no mechanism to force it.** ADR-788 makes it a constant and R12 forbids a config key. So in **Part 5** the indexer's internal entry points take an optional trailing `IndexPackOptions { baseCacheMaxBytes?: number }`, defaulting to the constant. They live under `primitives/internal/`, are unbarrelled, and are absent from `reports/api.json`, so this adds no published surface. ADR-783's "keeps its signature" is honoured: `walkPackEntries`' existing three parameters are unchanged and `bundle-verify.ts` passes nothing new. Part 4 must **not** declare the interface early — an exported type with no reader is a knip finding |
| §11b: "the ADR-789/790 half touches **fourteen** test files" | **Fifteen.** `test/unit/application/primitives/internal/pack-offset-table.properties.test.ts:17` imports `arbPackIndexWriterEntries` from `test/unit/domain/storage/arbitraries.js` and maps `e.id`/`e.crc32`/`e.offset` into its own `TestIndexEntry`. It was missed twice (the draft said eleven, the revision fourteen) |
| §6a.5 / R13d: "`check:duplicates` binds the fixture, so there is one of it" | **`check:duplicates` is `jscpd src/`** — it never scans `test/`. Nothing mechanical binds the fixture builder to being singular; Part 2's own instruction does. R13d's *production* half (one ordering, one serializer) is genuinely jscpd-gated |
| §Test strategy: "a bench-side memory scenario … measured from a child process's kernel high-water mark" | **No kernel high-water measurement exists anywhere in the repo.** `test/bench/*.bench.ts` is `vitest bench`, wall-clock only. `tooling/bench-memory.ts` exists but is an **in-process `process.memoryUsage()` poller** — precisely the instrument §1d's methodology note forbids for this pipeline. So the residency work is net-new and lands in `tooling/bench-memory.ts` as child-process workloads reading `process.resourceUsage().maxRSS` in the child (Node normalises it to **kilobytes** on darwin and linux alike — verified locally: 244 336 against a 240.3 MB RSS). `test/bench/fetch-pack.bench.ts` carries only wall clock |
| §5a: the measurement "is recorded in the plan as a gating step" but names no artefact | Its deliverable is **`docs/spike/index-pass-base-cache-budget.md`**, committed in Part 5 — the demand curve, the eight-point sweep on four fixtures, an explicit verdict against each of the four named falsifiers, and the chosen default. `docs/spike/` is the repo's home for "technical spike findings"; the number is published there as a **local sizing measurement**, never as a performance claim |

Two more facts the design states correctly but which are easy to under-weight, so they are
restated here as instructions:

- **The equivalence net (R4) must exist before the pipeline is replaced.** Part 1 lands it,
  against the *current* pipeline, and Parts 3–5 must keep it green unchanged.
- **`packIndexEntriesFrom` is not written** (ADR-790). Parts 1–3 do carry a *module-private,
  interim* array→slab conversion inside `internal/index-pack.ts`; it is deleted in Part 4 and
  must never be published, barrelled, or moved into `src/domain/`.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- **This plan uses no standalone test-only part.** Every one of the five parts changes
  production code and lands as one atomic conventional commit.

## Public-vs-internal, decided up front

| New / moved symbol | Verdict | Gates tripped (pre-paid in the owning part) |
|---|---|---|
| `PackIndexEntries` (`src/domain/storage/pack-order.ts`) | **public** — it is the parameter type of `sortPackIndexEntries` and the type of `BuildPackResult.entries`, both published. An unexported type in a published signature fails `tsc` (TS4023) and `rollup-plugin-dts`. Barrel from `src/domain/storage/index.ts`, which `src/domain/index.ts:28` re-exports with `export *` and `src/public-types.ts` picks up | barrel + `npm run docs:json` → commit `reports/api.json` (Part 2) |
| `SortedPackIndex` (same file) | **public**, same reason — parameter type of all three serializers | same (Part 2) |
| `PackIndexWriterEntry` | **deleted** — public today (`reports/api.json` `qualifiedName` rows near L212361 plus `.id`/`.crc32`/`.offset`); zero production consumers survive Part 2 | `reports/api.json` (Part 2); commit carries `!` |
| `SortedEntry` | **deleted** — public today (`qualifiedName` rows L212301/212306/212311) | same (Part 2) |
| `sortPackIndexEntries`, `serializePackIndex`, `serializePackRevIndex`, `serializeCruftMtimes`, `BuildPackResult` | **public, re-typed** | same (Part 2) |
| `indexQuarantinedPack`, `indexPackEntries`, `IndexPackOptions`, `PackByteSource`, `WalkedEntry`, `walkPackEntries`, `ExternalBaseResolver`, `DISK_WALK_WINDOW_BYTES`, `verifyPackTrailer` | **internal** — `src/application/primitives/internal/**` is unbarrelled by construction; none of these is in `src/application/primitives/index.ts` (which exports only `FetchPackInput`, `FetchPackResult`, `fetchPack` from this area, at `:47-48`) and none appears in `reports/api.json` today | none — but every part still runs `npm run docs:json` and expects `reports/api.json` **unchanged**; a diff means something leaked into the public surface |
| `createPackRecordStore`, `PackRecordStore`, `PackRecordType`, the two child-index builders (`src/application/primitives/internal/pack-records.ts`) | **internal**, same reason | none |
| `INDEX_PASS_BASE_CACHE_MAX_BYTES`, `INDEX_PASS_BASE_CACHE_MAX_ENTRIES`, `INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES` | **internal** — module exports of `internal/index-pack.ts`, reachable from tests only | none |
| `packIndexEntriesOf` (`test/fixtures/storage/pack-index-entries.ts`) | **test fixture**, not `src/` | none — but it is **parity-reachable**, see the repo-wide facts |

**No new Tier-1 command, no new error code, no new discriminated-union member, no new config
key.** So none of `check:doc-coverage`, `audit-browser-surface`, the `Repository` facade, the
sorted `Object.keys(sut)` snapshot in `test/unit/repository/repository.test.ts`, the "N Tier-1
commands" README line, nor `src/domain/error.ts`'s exhaustiveness switches are touched.
`INVALID_PACK_HEADER` and `PACK_TOO_LARGE` are reused verbatim.

**`reports/api.json` moves exactly twice.** Part 2 (seven symbols moved, two added) and Part 4
(a doc-comment-only change to `RepositoryConfig.maxObjectsPerPack`, which typedoc embeds).
Every other part regenerates it and expects **no diff**.

## Repo-wide facts every part needs

- **Part gate** (each part runs it before committing, from the manifest's `gates.part`):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`
- ⚠️ `npm run check:types` and `npm run check:spelling` are **wireit-cached**;
  `Ran 0 scripts and skipped 1` reads exactly like a pass and has put commits on red here.
  Bypass with `npx tsc --noEmit -p tsconfig.typecheck.json` (that is the exact project
  `check:types` runs — **not** `tsconfig.json`) and `npx cspell --no-progress <files>`.
- ⚠️ **Never read a gate through a pipe.** `… | tail` reports exit 0 on a red run. Run gates
  bare into a file and `echo $?`; if you background a gate, write the *real* exit code into
  the log and read it from there — a wrapper's exit code has lied twice in this repo.
- **Poll, do not wait.** Never end your turn to wait on a background notification; loop and
  poll the log file instead.
- **Coverage** (`vitest.config.ts`) gates `src/domain/**`, `src/ports/**`,
  `src/adapters/{node,memory}/**`, `src/operators/**` at **100 %** line/branch/function/
  statement, excluding `src/**/index.ts`. `src/application/**` is **not** covered. Stryker
  mutates **all** of `src/`. So Part 2's domain half is coverage-gated *and* mutated — a guard
  without a test fails `npm run test:coverage`, earlier and louder than mutation. Parts 1, 3,
  4, 5 live under `src/application/primitives/`: **mutated but not coverage-gated**, so their
  tests carry the whole weight. Write them to the same standard anyway.
- **`check:test-pyramid` (`tooling/audit-test-pyramid.ts`) gates mechanically** on
  `underAssertedUnit`, `gwtTitle`, `aaaBody`, `sutNaming`, `sutBindsResult`,
  `bareClassToThrow`, `emptyAaaSection` (`test-pyramid-budgets.json` → `gating`).
  `integrationProof` is report-only, but new integration files still carry a `@proves` header
  in `test/integration/packfile-interop.test.ts:11-15`'s grammar.
- **Test conventions.** `describe('Given …')` > `describe('When …')` > `it('Then …')`;
  AAA body with `// Arrange` / `// Act` / `// Assert` section comments; the function under
  test is bound to `sut` (never the result — the result goes in `result`). Error assertions
  assert **data** (`code`, `reason`, `offset`, `value`) via try/catch, never a bare
  `toThrow(Class)` — that one is gated. A guard of the form `if (A || B)` gets **one test per
  condition**, each triggering exactly one.
- **`check:duplicates` is `jscpd src/`** — it never scans `test/`. `check:dead-code` is
  `knip`. `check:architecture` is `depcruise src/ --config .dependency-cruiser.cjs` with
  `no-circular` enforced.
- **`reports/api.json` is a PREPUSH gate, not a validate gate**: `check:doc-typedoc` is
  literally `git diff --exit-code -- reports/api.json` with `docs:json` as its dependency, and
  `prepush` = `validate` + `check:doc-typedoc`. Local validate can be green while the push
  hook rejects. `docs:json` inputs are `src/**/*.ts`, `typedoc.json`, `tsconfig.build.json`
  and `README.md` — **so changing a doc comment on a published symbol makes it stale**.
- **`test/fixtures/**` is parity-reachable.** `test/fixtures/storage/bitmap-writers.ts` is the
  precedent: plain `export function` / `export interface`, **zero test-framework
  dependencies** (no `vitest`, no `fast-check`), and imports carry explicit **`.ts`**
  extensions (`from '../../../src/domain/objects/encoding.ts'`) — the opposite of every file
  under `test/unit/`, which uses `.js`. The Deno, Bun and `workerd` drivers resolve the whole
  scenario graph from source; a dev dependency anywhere in it fails the run before a single
  assertion executes. `check:parity-fixtures` audits this.
- **`beforeAll` needs an explicit timeout.** `vitest.config.ts` sets `testTimeout: 120_000`
  but **no `hookTimeout`**, so hooks default to 10 s. Any git-spawning `beforeAll` must be
  written `beforeAll(async () => { … }, 60_000)`.
- **No provenance refs in code or tests** — no `§`, `Phase`, `ADR-`, `R14`, `X9`, `S1`,
  `P3` markers in any `src/` or `test/` file. Those tokens exist only in this plan and in
  `docs/`. Comments explain *why*, in their own words.
- **No suppression directives.** No `@ts-ignore`, `v8 ignore`, `biome-ignore`,
  `stryker-disable`. A `// Stryker disable next-line <Mutator>: equivalent — <proof>` comment
  is the one sanctioned form and only for a **proven** equivalent, re-proved against *this*
  code — never carried forward across a data-structure change.
- **`push(...spread)` over an array sized by object count overflows the call stack near
  125 k elements**, which a real clone reaches. This change accumulates per object
  everywhere. **Loop-drain, never spread.**
- **A "pre-existing" claim is verified against `main`**, never against an earlier commit on
  this branch.
- `rm -rf dist .wireit` before trusting any `check:size` / `check:tarball` failure — stale
  chunks inflate on incremental rebuilds and this has fired three times in one branch.
- **`command grep`, never bare `grep`** — bare grep is hook-rewritten to a proxy that
  truncates at ~200 results with no warning.
- Real git on this machine is **2.55.0** (`/opt/homebrew/bin/git`).
  `test/integration/interop-helpers.ts` already exports `runGit`, `runGitAsync`,
  `runGitBytes`, `runGitEnv()`, `git(dir, …)`, `gitAsync(dir, …)`, `GIT_AVAILABLE`,
  `makePeerPair(slug)`, `PeerPair`, `initBothRepos`, `disableAutoMaintenance(dir)`,
  `tryRunGit`, `tryRunGitWithExit`. Its `SAFE_ENV` strips every `GIT_*`, sets
  `GIT_CONFIG_NOSYSTEM=1`, an isolated `HOME`/`XDG_CONFIG_HOME`, and `gc.auto=0`.
- **cspell needs no dictionary edit.** `slab`, `indexer`, `ofsChildren`, `refChildren`,
  `passId`, `crcValues`, `digestLength`, `packIndexEntriesOf`, `indexQuarantinedPack`,
  `unresolvable` were probed through `npx cspell` and all pass. If a genuinely new word does
  appear: **never re-sort `cspell.json`** — insert the one word at its alphabetical position;
  its order tiebreaks uppercase-first in a way `localeCompare` does not reproduce.
- **Phase-boundary gate**, run once per round rather than per commit: `npm run validate`.
  ⚠️ Do **not** run it between Part 3 and Part 4 if you deviate from Part 3's wiring
  instruction — see that part's context.

---

## Part 1 — Move the entry pipeline and its byte sources into an index-pack module, and pin its output

### Context

**Two jobs, one commit: a behaviour-preserving relocation, and the regression net every later
part is measured against.** Nothing about what the pipeline *does* changes here.

**Files.**

| Action | Path |
|---|---|
| create | `src/application/primitives/internal/index-pack.ts` |
| edit | `src/application/primitives/fetch-pack.ts` (1 036 lines → ≈ 460) |
| edit | `src/application/commands/bundle-verify.ts` (199 lines — imports only) |
| edit | `test/unit/application/primitives/fetch-pack.test.ts` (3 606 lines — imports + one new top-level describe) |
| create | `test/unit/application/primitives/index-pass-corpus.ts` |
| create | `test/integration/index-pack-interop.test.ts` |

**What moves, verbatim, from `fetch-pack.ts` into `internal/index-pack.ts`** (current line
spans; move them in file order so the diff reads as a move):

| Lines | Symbol |
|---|---|
| 38–48 | `ExternalBaseResolver` (exported type; doc comment moves with it) |
| 51 | `const PACK_HEADER_BYTES = 12` — module-private. **`fetch-pack.ts` still needs it** at `:418` and `:447`, so it is duplicated, not moved. Resolve the duplication by importing the already-exported `PACK_HEADER_SIZE` from `src/domain/storage/pack-entry.ts:60` (same value, same meaning) in **both** files and deleting both private copies |
| 212–234 | `walkQuarantinedEntries` → **renamed** `indexQuarantinedPack(ctx, tmpPath, totalBytes)`, same body, same `cleanupQuarantine`-on-failure semantics. `cleanupQuarantine` stays in `fetch-pack.ts`, so pass it in as a parameter: `indexQuarantinedPack(ctx, tmpPath, totalBytes, onFailure: (path) => Promise<void>)` |
| 461–482 | `WalkedEntry`, `BaseTypeName`, `PendingEntry`, `ResolvedEntry` |
| 484–543 | `PackByteSource<TCrcContext>` (doc comment included) and `inMemoryPackByteSource` |
| 545–567 | `DISK_WALK_WINDOW_BYTES` (exported) and `DiskWindow` |
| 575–636 | `errorDataReason`, `RETRYABLE_DECOMPRESS_REASON`, `RETRYABLE_ENTRY_HEADER_REASON_PREFIX`, `isFreshDocumentedWindow`, `isAnchoredHere`, `isRetryableWindowFailure` |
| 647–653 | `withAbsoluteEntryOffset` (**carries a Stryker suppression at `:648`** — moves verbatim, still true: single caller, `parsePackEntryHeader` only ever raises `invalidPackEntry`) |
| 680–825 | `diskPackByteSource` — the whole window ladder (`fetchWindow`, `initialWindowSize`, `nextRung`, `windowCovering`, `growOrRethrow`, `withGrowth`). **Carries suppressions at `:716` and `:718`** — move verbatim; Part 4 re-proves `:716` |
| 827–858 | `walkFromPending` (**suppressions at `:844`, `:846`** — move verbatim; Part 3 retires them) and `walkPackEntries` (exported) |
| 860–902 | `inflateAllEntries` (**suppressions at `:889`, `:891`** — move verbatim; Part 4 re-proves) |
| 904–1036 | `resolveAllEntries`, `firstUnresolvedError` (**suppression at `:939`**), `refDeltaBaseId`, `tryResolveEntry`, `resolveDelta`, `isBaseHeader`, `baseTypeName`, `computeLooseObjectId`, and `const TEXT_ENCODER` (`:50`) which only `computeLooseObjectId` uses |

**What stays in `fetch-pack.ts`**: the module docstring, `FetchPackInput`/`FetchPackResult`/
`PackDownload`/`NegotiatePackBytes`, `fetchPack` (`:129`), `emptyPackResult`,
`materializePack` (`:163`), `downloadPack`, `randomTmpPackName`, `claimQuarantinePath`,
`concatBytes`, `removeQuarantineFileIfPresent`, `cleanupQuarantine`, `renamePackIntoPlace`,
`QuarantineReceipt`, `receivePackToQuarantine`, `packTooLargeBytes`, `hasSideBand`,
`verifyPackTrailer` (`:445`), and the constants `SIDE_BAND_CAPS`, `PROGRESS_TICK_BYTES`,
`TMP_PACK_*`, `DEFAULT_MAX_RESPONSE_BYTES`, `DEFAULT_MAX_OBJECT_COUNT`,
`MAX_QUARANTINE_NAME_ATTEMPTS`.

⚠️ **`DEFAULT_MAX_OBJECT_COUNT` (`:71`) is read by `inflateAllEntries` (`:865`), which moves.**
Move the constant **with it** into `index-pack.ts`; nothing left in `fetch-pack.ts` reads it.
`DEFAULT_MAX_RESPONSE_BYTES` stays (read at `:370` by `receivePackToQuarantine`).

**`materializePack`'s call site** (`fetch-pack.ts:177`) becomes:
```ts
const entries = await indexQuarantinedPack(ctx, receipt.tmpPath, receipt.totalBytes, (p) =>
  cleanupQuarantine(ctx, p),
);
```
Everything downstream (`entries.length === 0` at `:181`, `writePackSiblingArtifacts` at
`:193`) is untouched in this part.

**`bundle-verify.ts`** currently imports at `:17-21`:
```ts
import {
  type ExternalBaseResolver,
  verifyPackTrailer,
  walkPackEntries,
} from '../primitives/fetch-pack.js';
```
Split it: `verifyPackTrailer` keeps coming from `'../primitives/fetch-pack.js'`;
`ExternalBaseResolver` and `walkPackEntries` come from
`'../primitives/internal/index-pack.js'`. `buildExternalBaseResolver` (`:170-178`), its
`resolveExternalBase` helper (`:158-168`) and the `:76` Stryker comment are **untouched here**
— Part 5 owns them.

**`fetch-pack.test.ts`** imports at `:4-10`:
```ts
import {
  DISK_WALK_WINDOW_BYTES,
  type ExternalBaseResolver,
  fetchPack,
  type NegotiatePackBytes,
  walkPackEntries,
} from '../../../../src/application/primitives/fetch-pack.js';
```
`fetchPack` and `NegotiatePackBytes` stay on that path; `DISK_WALK_WINDOW_BYTES`,
`ExternalBaseResolver` and `walkPackEntries` re-point at
`'../../../../src/application/primitives/internal/index-pack.js'`. **No test body changes** —
`DISK_WALK_WINDOW_BYTES` is referenced at `:2378, 2379, 2390, 2423, 2424, 2438, 2487, 2562,
2603, 2628`, `walkPackEntries` at `:2309, 2775, 2803, 2848, 2857`, all by name only.
**Do not move the existing describe blocks into a new file** — the 3 606-line file is the
pipeline's test home and moving it is churn the refactor phase can revisit.

**R14: `fetch-pack.ts` must end under 800 lines.** Verify with `wc -l`. Expect ≈ 460.
ADR-787 names two new modules; `index-pack.ts` lands ≈ 590 here.

**No import cycle, by construction.** `index-pack.ts` imports **nothing** from
`fetch-pack.ts` — the quarantine cleanup it needs is injected as `onFailure`, and
`verifyPackTrailer` stays behind and is not called by the indexer. The edges are
`fetch-pack.ts → index-pack.ts` and `bundle-verify.ts → { fetch-pack.ts, index-pack.ts }`.
`npm run check:architecture` (`depcruise`, `no-circular` enforced) is the oracle; do not
create a back-edge for convenience.

#### The equivalence net (R4) — an oracle, not a captured golden

`test/unit/application/primitives/pack-fixture.ts:81` `buildSyntheticPack(ctx, entries)`
returns `PackBuildResult { packBytes, idxBytes, ids, offsets }` where `ids[i]` is the oid the
*fixture builder* computed independently (`ctx.hash.hashHex` over `<type> <size>\0<content>`,
`:139-141`) and `offsets[i]` is entry `i`'s start (`:132`). It does **not** expose its
`crc32Values`, but the test can recompute them:
`crc32(packBytes.subarray(offsets[i], offsets[i + 1] ?? packBytes.length - digestLength))` —
`crc32` is exported from `src/domain/storage/crc32.ts` (see `packfile-interop.test.ts:24`).

So the net asserts the indexer's `(id, crc32, offset)` set against an oracle the indexer had
no hand in producing. That is strictly stronger than a golden captured from today's code, and
it cannot drift.

`EntrySpec` (`pack-fixture.ts:69`) is
`BaseEntrySpec | OfsDeltaSpec | RefDeltaSpec`:
```ts
{ kind: 'base'; type: 'commit'|'tree'|'blob'|'tag'; content: Uint8Array; idOverride?: string }
{ kind: 'ofs-delta'; baseIndex: number; targetContent: Uint8Array; distanceOverride?: number }
{ kind: 'ref-delta'; baseId: string; baseUncompressed: Uint8Array; targetContent: Uint8Array }
```

**`test/unit/application/primitives/index-pass-corpus.ts`** (new) exports
`INDEX_PASS_CORPUS: ReadonlyArray<{ readonly name: string; readonly entries: (ctx) => Promise<EntrySpec[]> }>`
— a factory per case, because REF-delta specs need a `baseId` computed from the context's
hash. `.js`-extension imports (it lives under `test/unit/`, not `test/fixtures/`). The cases,
one per accepting row of the design's degenerate-input table plus R5/R6:

| name | shape |
|---|---|
| `empty-pack` | `[]` |
| `single-base` | one blob |
| `base-then-ofs-delta` | base blob + OFS delta on it |
| `base-then-ref-delta` | base blob + REF delta naming its oid |
| `ref-delta-before-base` | REF delta first, its base second — **R5** |
| `ofs-chain-depth-1` | base + one delta |
| `ofs-chain-depth-50` | base + 50 chained OFS deltas |
| `ofs-chain-depth-1000` | base + 1 000 chained OFS deltas — **R6**, must not overflow the JS stack. Keep each level's target one byte longer than its parent: `encodeDeltaFromScratch` runs per level and the fixture is built once per test run |
| `zero-length-object` | one blob with `content: new Uint8Array(0)` |
| `duplicate-oid` | four identical zero-length blobs |
| `multi-window` | 12 × 60 000 pseudo-random blobs (the `buildMultiWindowPack` shape at `fetch-pack.test.ts:324`) |
| `entry-larger-than-window` | one blob of `DISK_WALK_WINDOW_BYTES * 2 + 1` pseudo-random bytes |
| `branching-forest` | one base with **three** OFS-delta children, each with one child of its own — the shape the retained-ancestor release rule depends on |

Use `fetch-pack.test.ts:299`'s `pseudoRandomBytes(length, seed)` shape for content (copy it
into the corpus module; it is 11 lines and the test file's copy stays).

The **thin-pack** case is deliberately not in the corpus: it needs an `ExternalBaseResolver`
and is already pinned by `fetch-pack.test.ts:2827`'s existing block, which this part leaves
alone.

The new top-level describe in `fetch-pack.test.ts` drives every corpus case twice — through
`walkPackEntries` (in-memory source) and through `fetchPack` (disk source), reusing the file's
existing `toNegotiator`, `captureRequests`, `buildUploadPackResponseBody` and `withFsPatch`
helpers. `empty-pack` reaches `fetchPack`'s zero-entry suppression path, so its `fetchPack`
assertion is `objectCount === 0` and no `.idx` written, not an entry-set comparison.

#### The cross-tool half (`test/integration/index-pack-interop.test.ts`, new)

Created here with **one** case; Part 4 adds the rest. `describe.skipIf(!GIT_AVAILABLE)`, a
`@proves` header in `packfile-interop.test.ts:11-15`'s grammar
(`surface: packIndex` / `bucket: cross-tool-interop` / `unique:` / `interopSurface: packfile`),
one shared `beforeAll(async () => { … }, 60_000)` building the repo, `makePeerPair('index-pack')`.

**The fixture-A generator.** The design's fixture A is 300 commits over one 2 000-line
generated file with 20 lines rewritten and 1 appended each — 903 objects, max chain 50 after
`git -c pack.threads=1 repack -a -d`. Do **not** build it with 300 `git commit` invocations;
build it with a single `git fast-import` stream (deterministic content from a seeded xorshift,
fixed author/committer identity and dates so the HEAD sha is reproducible), then
`git -c pack.threads=1 repack -a -d`. Put the helper in the test file, not in
`interop-helpers.ts`. If `fast-import` proves awkward, a reduced commit count is acceptable
**provided the chain depth still saturates `pack.depth`** — that is the property the fixture
exists for.

The case (design's X1): given fixture A's repacked pack, `walkPackEntries` over its bytes
returns an `(oid, offset)` set equal to `git show-index < <idx>`'s, and
`git verify-pack <idx>` exits 0 with empty stdout and stderr. Parse `show-index` output as
`<offset> <oid> [crc]` per line.

⚠️ Every later interop case that corrupts an entry **header** must recompute the pack trailer,
or git answers `fatal: pack is corrupted (SHA1 mismatch)` and never reaches the condition
under test.

#### Suppressions

All eleven Stryker suppressions in `fetch-pack.ts` move or stay **verbatim** in this part.
None is falsified by a relocation. Their re-proof schedule is: `:844`/`:846` → Part 3;
`:716`, `:889`, `:891`, `:939` → Part 4; `bundle-verify.ts:76` → Part 5.

### TDD steps

1. **RED** — add `test/unit/application/primitives/index-pass-corpus.ts` and the new
   `describe('index pass equivalence', …)` block in `fetch-pack.test.ts`, importing
   `walkPackEntries` from `.../internal/index-pack.js`. Fails:
   `Cannot find module '.../src/application/primitives/internal/index-pack.js'`.
2. **GREEN** — create `internal/index-pack.ts` by moving the spans in the table above
   verbatim; re-point `fetch-pack.ts`, `bundle-verify.ts` and `fetch-pack.test.ts`'s imports;
   rename `walkQuarantinedEntries` → `indexQuarantinedPack` with the injected `onFailure`.
   Delete both private `PACK_HEADER_BYTES` copies in favour of `PACK_HEADER_SIZE`.
3. **RED** — the `ofs-chain-depth-1000` case. If today's `resolveAllEntries` fixed-point loop
   times out rather than overflowing, raise that one `it`'s timeout; **do not shrink the
   case** — R6 is the reason it exists and Part 4 must make it fast.
4. **GREEN** — no production change expected; if step 3 fails for a reason other than time,
   stop and escalate `{ unit, reason, ≤3 options }` rather than weakening the case.
5. **RED** — `test/integration/index-pack-interop.test.ts` with the fixture-A generator and
   the `git show-index` / `git verify-pack` case. Fails first on the generator, then on any
   `show-index` parse mismatch.
6. **GREEN** — fix the generator/parse until git and tsgit agree. A genuine disagreement here
   is a defect in today's code and is an escalation, not a test relaxation.
7. **REFACTOR** — `wc -l src/application/primitives/fetch-pack.ts` (expect < 800, ≈ 460) and
   `src/application/primitives/internal/index-pack.ts` (expect < 800). Confirm
   `command grep -rn "walkQuarantinedEntries" src test` returns nothing. Run
   `npm run docs:json` and confirm `git status --porcelain -- reports/api.json` is **empty** —
   nothing published moved in this part.

### Gate

```
npx vitest run test/unit/application/primitives/fetch-pack.test.ts test/integration/index-pack-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/index-pack.ts src/application/primitives/fetch-pack.ts src/application/commands/bundle-verify.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/primitives/index-pass-corpus.ts test/integration/index-pack-interop.test.ts \
  && npm run check:spelling
```
Cache bypass when either wireit gate prints `Ran 0 scripts and skipped 1`:
`npx tsc --noEmit -p tsconfig.typecheck.json` and `npx cspell --no-progress <files>`.
Surface check (expect **no** diff): `npm run docs:json && git status --porcelain -- reports/api.json`.

### Commit

`refactor(fetch-pack): move the entry pipeline and byte sources into an index-pack module`

---

## Part 2 — The pack-index slab: serializers, `buildPack`, and the seven moved published symbols

### Context

**This is an atomic gate-sweep.** Deleting `SortedEntry` and `PackIndexWriterEntry` breaks
every consumer at once, so all of it lands in one commit or the gate is red. There is no
intermediate shape: an additive "second sort function" would be exactly the fork ADR-625,
ADR-789 §6a.4 and `check:duplicates` all exist to prevent.

**The commit carries the conventional-commit `!` breaking marker**, riding the pending 4.0.0
exactly as ADR-776 and ADR-789 reasoned (last release 3.6.0, the 4.0.0 release PR still open).

#### The two new domain types — `src/domain/storage/pack-order.ts` (29 lines today, verbatim)

```ts
import { compareBytes, hexToBytes } from '../objects/encoding.js';

export interface PackIndexWriterEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}

export interface SortedEntry {
  readonly shaBytes: Uint8Array;
  readonly entry: PackIndexWriterEntry;
}

export function sortPackIndexEntries(
  entries: ReadonlyArray<PackIndexWriterEntry>,
): ReadonlyArray<SortedEntry> {
  const withBytes: SortedEntry[] = entries.map((entry) => ({
    shaBytes: hexToBytes(entry.id),
    entry,
  }));
  withBytes.sort((a, b) => compareBytes(a.shaBytes, b.shaBytes));
  return withBytes;
}
```

After (both interfaces deleted, both replaced):
```ts
/** One pack's index inputs in EMISSION order (ascending pack offset).
 *  Arrays may be longer than `count` — `count` is the only bound. */
export interface PackIndexEntries {
  readonly count: number;
  readonly digestLength: number;   // 20 | 32
  readonly oids: Uint8Array;       // >= count * digestLength
  readonly crcValues: Int32Array;  // >= count
  readonly offsets: Float64Array;  // >= count
}

/** An entry set paired with its own oid-ascending permutation:
 *  index position p holds entry ordinal `order[p]`. */
export interface SortedPackIndex {
  readonly entries: PackIndexEntries;
  readonly order: Uint32Array;     // length === entries.count
}

export function sortPackIndexEntries(entries: PackIndexEntries): SortedPackIndex
```
`sortPackIndexEntries` builds `order = Uint32Array` of `[0, count)` and sorts it with a
comparator that `compareBytes`-es the two slab ranges. `hexToBytes` leaves `pack-order.ts`
entirely; `compareBytes` stays. **Do not `subarray` per comparison into a retained array** —
compare in place over `oids`.

#### The three serializers — before and after

```ts
// today
sortPackIndexEntries(entries: ReadonlyArray<PackIndexWriterEntry>): ReadonlyArray<SortedEntry>
serializePackIndex   (entries, packChecksum, presorted?: ReadonlyArray<SortedEntry>): Uint8Array
serializePackRevIndex(entries, packChecksum, presorted?: ReadonlyArray<SortedEntry>): Uint8Array
serializeCruftMtimes (entries, packChecksum, mtimeOf, presorted?: ReadonlyArray<SortedEntry>): Uint8Array
BuildPackResult.entries: ReadonlyArray<PackIndexWriterEntry>

// after
sortPackIndexEntries (entries: PackIndexEntries): SortedPackIndex
serializePackIndex   (sorted: SortedPackIndex, packChecksum: Uint8Array): Uint8Array
serializePackRevIndex(sorted: SortedPackIndex, packChecksum: Uint8Array): Uint8Array
serializeCruftMtimes (sorted: SortedPackIndex, packChecksum: Uint8Array, mtimeOf): Uint8Array
BuildPackResult.entries: PackIndexEntries
```
**The optional `presorted` parameter is gone and the sort is mandatory.** That deletes three
`presorted ?? sortPackIndexEntries(entries)` fallbacks — `pack-writer.ts:117`,
`rev-index.ts:129`, `cruft-pack.ts:56` — three branches, three mutants and three prose
invariants at once, and makes ADR-625's guarantee structural.

**`src/domain/storage/pack-writer.ts`** (202 lines). `serializePackIndex` is `:104-202`. Its
body indexes `withBytes[i]!.shaBytes` (`:170`), `.entry.crc32` (`:176`) and `.entry.offset`
(`:122, 185`); all become `order[p]`-indexed reads out of the slab:
`bytes.set(oids.subarray(k * W, (k + 1) * W), shaStart + p * W)` where `k = order[p]`.
`n` becomes `sorted.entries.count`, never `order.length` and never an array `.length`.
`:151-153`'s fanout bucket loop reads `oids[k * W]` instead of `shaBytes[0]`.
Line `:25`'s import of `PackIndexWriterEntry`/`SortedEntry`/`sortPackIndexEntries` and line
`:27`'s `export type { PackIndexWriterEntry };` both go; `PackEntryMeta` (`:46-49`) is a
**different** type and is untouched. The two existing Stryker suppressions at `:156` and
`:162` describe the 256-iteration fanout loops and survive verbatim — that code does not move.

**`src/domain/storage/rev-index.ts`** (181 lines). `serializePackRevIndex` `:112-143`;
`objectCount` at `:126` becomes `sorted.entries.count`. Module-private
`packPositionsByOffset` `:152-165` currently reads `byOid[i]!.entry.offset` — it becomes
`sorted.entries.offsets[sorted.order[i]!]!`. **Keep the sort**: it is a producer invariant no
signature states, it is already `Float64Array`-based, and its own doc comment explains why.
Imports at `:13-14` go.

**`src/domain/storage/cruft-pack.ts`** (145 lines). `serializeCruftMtimes` `:41-70`. Its
`mtimeOf(oid: ObjectId) => number` contract is **kept** (ADR-789 §6a.3): the body derives a
**transient** hex per index position with `bytesToHex(oids.subarray(k * W, (k + 1) * W))`
inside the write loop, where today the same hex was *retained* for every object — the cruft
path gets strictly better. `:64-66`'s `forEach` becomes a `for` over `[0, count)`. Imports at
`:21-22` go; add `bytesToHex` from `'../objects/encoding.js'`.

**Structural guards, new, one per serializer** (ADR-789 §6a.2). Each serializer already
derives `digestLength` from `packChecksum.length` and refuses anything but 20 or 32
(`pack-writer.ts:109-112` via `invalidPackIndex(reason)`; `rev-index.ts:117-123` via
`invalidPackRevIndex('hash-id', reason)`; `cruft-pack.ts:47-50` via
`invalidCruftMtimes('hash-id', reason)`). Add, using the same factory and check-token each
file already uses:
- `entries.digestLength !== packChecksum.length`
- `oids.length < count * digestLength`
- `crcValues.length < count`
- `offsets.length < count`
- `order.length !== count`

These are in `src/domain/**`, so **every branch is coverage-gated at 100 %**: each guard needs
its own isolated test triggering exactly that condition, asserting `error.data` via try/catch.
`<` versus `<=` is the live mutant — write the case that lands **exactly on equality** and
passes.

**`src/domain/storage/index.ts`** (101 lines, explicit named re-exports, alphabetised by
module). Line `:81` is `export { type SortedEntry, sortPackIndexEntries } from './pack-order.js';`
→ `export { type PackIndexEntries, type SortedPackIndex, sortPackIndexEntries } from './pack-order.js';`.
Line `:86`'s `PackIndexWriterEntry` inside the `export type { … } from './pack-writer.js'`
block (`:83-90`) is deleted.

#### The application half

**`src/application/primitives/internal/write-pack-artifacts.ts`** (349 lines). Import block
`:15-28` re-points. Signatures:
- `buildIdx` `:30` → `(ctx: Context, sorted: SortedPackIndex, packSha: string)`
- `buildRev` `:57` → `(ctx: Context, sorted: SortedPackIndex, packSha: string)`
- `buildCruftMtimes` `:81` → `(ctx, sorted: SortedPackIndex, packSha, mtimeOf)`
- private `writeRevArtifact` `:157` → `(ctx, path, sorted: SortedPackIndex, packSha)`
- `WritePackArtifactsInput.entries` `:118` and `WritePackSiblingArtifactsInput.entries` `:170`
  → `PackIndexEntries`
- `writeSiblingsGiven` `:183`: `:192`'s `sortPackIndexEntries(input.entries)` stays (one sort
  per write, shared by `.idx` and `.rev`); `:200`'s
  **`objectCount: input.entries.length` becomes `input.entries.count`** — `length` is the
  over-allocated capacity, `count` is the bound. Same at `:345` inside
  `writePackArtifactsViaQuarantine`, whose own `sortPackIndexEntries` call is `:305`.

⚠️ `objectCount: input.entries.length` → `.count` is the single highest-consequence one-line
change in this part: on a `buildPack`-produced slab the two are equal, so **nothing in the
existing suite catches a miss**. Part 3's over-allocated store is the first producer where
they differ. Write the test now: a `PackIndexEntries` whose arrays are deliberately longer
than `count`, asserting `written.objectCount === count`.

**`src/application/primitives/internal/cruft-pack-lifecycle.ts`** (305 lines).
`writeCruftPack`'s inline input type at `:229-234`: `entries` → `PackIndexEntries`. `:245`'s
`sortPackIndexEntries(input.entries)` stays, and `:246-252`'s `buildCruftMtimes` call drops
its separate `input.entries` argument and passes `sorted`. Note this file already runs a
**second** full sort beyond `writeSiblingsGiven`'s — that duplication is pre-existing and is
**not** in this change's scope.

**`src/application/primitives/build-pack.ts`** (98 lines, whole file relevant). `:58` today:
```ts
const entries = plan.ids.map((id, i) => ({ id, ...packfile.entries[i]! }));
```
becomes an explicit slab fill (ADR-790) — the one new piece of arithmetic this decision adds:
```ts
const digestLength = ctx.hash.digestLength;
const count = plan.ids.length;
const oids = new Uint8Array(count * digestLength);
const crcValues = new Int32Array(count);
const offsets = new Float64Array(count);
for (let i = 0; i < count; i += 1) {
  oids.set(hexToBytes(plan.ids[i]!), i * digestLength);
  const meta = packfile.entries[i]!;
  crcValues[i] = meta.crc32;
  offsets[i] = meta.offset;
}
const entries: PackIndexEntries = { count, digestLength, oids, crcValues, offsets };
```
`hexToBytes` joins the existing `bytesToHex` import from `'../../domain/objects/encoding.js'`;
`PackIndexWriterEntry` leaves the import block at `:18` and `BuildPackResult.entries` at `:42`
becomes `PackIndexEntries`. Keep the doc comment's meaning (emission order, identity travels
with the meta) and restate it for the slab.

**Pass-through call sites** — verified, each a pure hand-off whose type widens with the input:
`src/application/commands/pack-objects.ts:87 → :92`;
`src/application/commands/internal/gc-pipeline.ts:484 → :488`, `:527 → :531`, `:560 → :564`.
Expect **no textual edit** at these four, only that they type-check. `push.ts:353` reads only
`.bytes`; `bundle-create.ts:312` reads `.bytes`, `.objectCount`, `.sha` — neither touches
`.entries`, neither is affected. `gc-pipeline.ts:408` and `:416` carry comments about
`buildPack`'s entry ordering; re-read them and correct any wording the slab falsifies.

**`src/application/primitives/internal/index-pack.ts`** (from Part 1). `indexQuarantinedPack`
now returns `PackIndexEntries` instead of `ReadonlyArray<WalkedEntry>`, via a
**module-private, interim** converter:
```ts
// Interim: the two passes fill this slab directly; until then the resolved
// entries are re-encoded into it here.
const slabFromWalkedEntries = (entries: ReadonlyArray<WalkedEntry>, digestLength: number): PackIndexEntries
```
It is deleted in Part 4 and must never be exported, barrelled or moved into `src/domain/`
(ADR-790: `packIndexEntriesFrom` is not written). `walkPackEntries` keeps returning
`ReadonlyArray<WalkedEntry>` unchanged (ADR-783).

**`src/application/primitives/fetch-pack.ts`** — two lines in `materializePack`:
`:181`'s `entries.length === 0` becomes `indexed.count === 0`, and `:193-198`'s
`writePackSiblingArtifacts({ packDir, entries, packSha, promisor })` now hands that same
value across as the widened `PackIndexEntries`. No other line in the file changes.

**Verify, do not assume**: `src/domain/commit/commit-graph-writer.ts:12` carries a doc-comment
reference to `serializePackRevIndex` ("the split `serializePackRevIndex` uses for `.rev`").
Re-read it and correct any wording the new signature falsifies; it is a comment, so it is not
caught by the compiler.

**`test/unit/application/primitives/fetch-pack.test.ts` is expected to need no edit** in this
part — the equivalence net asserts `walkPackEntries`' unchanged `WalkedEntry[]` and
`fetchPack`'s unchanged result — but it is in the gate because it must stay green.

#### The fifteen test files

**None may be weakened.** Byte-exact goldens keep their expected bytes **verbatim**; only the
Arrange that builds the input changes. One moved expected byte means the change is wrong.

New shared fixture, **one of it, never a per-file copy**:
`test/fixtures/storage/pack-index-entries.ts`, on `bitmap-writers.ts`'s precedent — plain
`export function`, **no `vitest`, no `fast-check`**, **`.ts`-extension imports**
(`from '../../../src/domain/objects/encoding.ts'`), parity-reachable:
```ts
export interface PackIndexEntryLiteral {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}
export function packIndexEntriesOf(
  entries: ReadonlyArray<PackIndexEntryLiteral>,
  digestLength: number,
): PackIndexEntries
```

| File | What changes |
|---|---|
| `test/unit/domain/storage/pack-order.test.ts` (78) | Rewritten against the new return type, **keeping all four cases**: out-of-order sorts ascending; each ordinal pairs with its own oid bytes (now `order[p]` selecting a slab range); order is input-order-independent; the empty set returns an empty order. Its local `makeEntry` (`:7-9`) becomes the shared builder |
| `test/unit/domain/storage/pack-writer.test.ts` (727) | 17 `serializePackIndex` references, call sites at `:301, 323, 387, 447, 467, 497, 517, 539, 562, 586, 606, 628, 680`, all 2-arg. Each Arrange wraps in `sortPackIndexEntries(packIndexEntriesOf([...], 20))`. Its local `arbUniqueIndexEntries` (`:35-59`, a near-duplicate of `arbPackIndexWriterEntries` with a SHA-256 hex-length knob) gains the same `.map` |
| `test/unit/domain/storage/rev-index.test.ts` (650) | 12 `serializePackRevIndex` references; `f1Entries()` at `:68-74` becomes slab-producing |
| `test/unit/domain/storage/rev-index.properties.test.ts` (174) | **Properties unchanged.** `arbPackIndexWriterEntries(30)` at `:112` and `:159` gains a `.map` through `packIndexEntriesOf` |
| `test/unit/domain/storage/cruft-pack.test.ts` (479) | 18 `serializeCruftMtimes` references; `fourEntries()` `:16-23` becomes slab-producing; `expectRefusal(act, check, reasonContains)` `:49-67` gains the new guard cases |
| `test/unit/domain/storage/cruft-pack.properties.test.ts` (56) | Same `.map` at `:21`; the length-matched mtime vector is unchanged |
| `test/unit/domain/storage/arbitraries.ts` (601) | `arbPackIndexWriterEntries` `:472-490` **keeps generating readable `{ id, crc32, offset }` triples** — that is what gives it hex-domain coverage — and its element type becomes the fixture's `PackIndexEntryLiteral`. Import at `:7` re-points. Rewriting it to emit slabs directly would silently drop that coverage |
| `test/unit/application/primitives/internal/pack-offset-table.properties.test.ts` | **The file the design's count missed.** Imports `arbPackIndexWriterEntries` at `:17` and uses it at `:32` inside `arbPackLayout()`, mapping `e.id`/`e.crc32`/`e.offset` into `TestIndexEntry`. Expect a type-import change only — verify, do not assume |
| `test/unit/application/primitives/internal/write-pack-artifacts.test.ts` (681) | Top-level describes `buildRev` `:40`, `writePackArtifacts` `:81`, `writePackArtifactsViaQuarantine` `:350`. Add the over-allocated-slab `objectCount === count` case here |
| `test/unit/application/primitives/build-pack.test.ts` (534) | `:232` ("each meta carries the emission-order oid alongside its crc32/offset") and `:333` ("each `entries[]` id, crc32 and offset all describe the SAME object") **restated against the slab, not relaxed** — see S1 below |
| `test/unit/application/primitives/pack-fixture.ts` (421) | `:152`'s `serializePackIndex(idxEntries, packChecksum)` wraps; `:147-151` builds through the shared fixture |
| `test/integration/packfile-interop.test.ts` | `:102` and `:187`. **Oracle unchanged** — `git fsck --strict` + `cat-file -p`; its assertions must keep passing with zero change |
| `test/parity/scenarios/pack-pair.ts` | `:71`, single-entry literal |
| `test/parity/scenarios/bitmap-closure.scenario.ts` | `:158`, `objects.map(...)` at `:153-157` |
| `test/parity/scenarios/fsck-degraded-store.scenario.ts` | `:87`, single-entry literal |

Three tests carry the weight the type change adds:

- **S1 — the slab-filling pin, on `buildPack`** (`build-pack.test.ts`, extended). For every
  `i < count`, `oids[i*W … (i+1)*W)` equals `hexToBytes` of the oid emitted at position `i`,
  and `crcValues[i]` / `offsets[i]` are `serializePackfile`'s meta for that same entry.
  `:333`'s fixture — input order deliberately opposite to the delta-emission sort — is what
  makes it bite and is **not relaxed**. Run it at **both** digest widths, since `W` is now an
  index stride rather than a string length. `build-pack.ts` is under `application/`, so this
  loop is mutated but **not** coverage-gated: S1 is an explicit named test, not a by-product.
- **S2 — property, compositional, `numRuns` 100** (`rev-index.properties.test.ts` or a sibling
  under `test/unit/domain/storage/`). `sortPackIndexEntries(packIndexEntriesOf(E, W)).order`
  reads out a **non-decreasing** oid byte sequence that is a permutation of `E`'s oids —
  including when `E` carries duplicate oids, which the degenerate-input table pins as legal.
  The `sut` is `sortPackIndexEntries`; the builder is Arrange only.
- **S3 is deferred to Part 4** — it indexes a `buildPack` pack through `indexQuarantinedPack`,
  which does not produce a native slab until then.

**Mutation-hazardous spots to write kill tests for up front**: each slab guard's `<` vs `<=`
(a case landing exactly on equality); `buildPack`'s `i * digestLength` stride and the
`plan.ids[i]` ↔ `packfile.entries[i]` pairing (an off-by-one mis-pairs every oid with the
*next* object's crc and offset, and every set-membership assertion still passes — S1 is the
kill test, at both widths); `order[p]` vs `p` in each serializer's read loop.

**Surface gate, pre-paid in this part**: `npm run docs:json`, then commit `reports/api.json`.
The diff is the **scope check**: seven symbols moved
(`PackIndexWriterEntry`, `SortedEntry`, `sortPackIndexEntries`, `serializePackIndex`,
`serializePackRevIndex`, `serializeCruftMtimes`, `BuildPackResult`) of which two are outright
removals, and two added (`PackIndexEntries`, `SortedPackIndex`). **Anything else in that diff
means the change leaked past its blast radius.** The huge typedoc-id churn is normal.

### TDD steps

1. **RED** — `test/fixtures/storage/pack-index-entries.ts` plus a rewritten
   `pack-order.test.ts` asserting the four existing cases against `SortedPackIndex`. Fails:
   `PackIndexEntries` / `SortedPackIndex` do not exist.
2. **GREEN** — `pack-order.ts`: add both interfaces, re-type `sortPackIndexEntries` to a
   `Uint32Array` permutation sort over slab ranges, delete `SortedEntry` and
   `PackIndexWriterEntry`.
3. **RED** — each new structural guard as its own test in `pack-writer.test.ts`,
   `rev-index.test.ts`, `cruft-pack.test.ts`, one condition per test, `error.data` asserted
   via try/catch, plus the exactly-on-equality passing case for each `<`. Fails: no guards.
4. **GREEN** — re-type the three serializers, delete the three `presorted ??` fallbacks, add
   the five guards each, rewrite each body to index through `order`. Keep every expected-byte
   literal untouched.
5. **RED** — S2 as a property; the over-allocated-slab `objectCount === count` case in
   `write-pack-artifacts.test.ts`. Fails: `writeSiblingsGiven` still reads `.length`.
6. **GREEN** — `write-pack-artifacts.ts` and `cruft-pack-lifecycle.ts` re-typed;
   `.length` → `.count` at `:200` and `:345`.
7. **RED** — S1 restated in `build-pack.test.ts` at both digest widths. Fails:
   `BuildPackResult.entries` is still an array.
8. **GREEN** — `build-pack.ts`'s slab fill; `index-pack.ts`'s interim
   `slabFromWalkedEntries`; `fetch-pack.ts:181`'s `indexed.count === 0`.
9. **RED/GREEN** — sweep the remaining test files: `pack-fixture.ts`, `arbitraries.ts`,
   `pack-offset-table.properties.test.ts`, `packfile-interop.test.ts` and the three parity
   scenarios. Then `src/domain/storage/index.ts`'s barrel.
10. **REFACTOR** — `npx vitest run --coverage --project unit test/unit/domain/storage/` and
    confirm `pack-order.ts`, `pack-writer.ts`, `rev-index.ts`, `cruft-pack.ts` are still
    100 % on all four metrics. `npm run check:duplicates` (jscpd) to confirm no serializer
    fork. `command grep -rn "PackIndexWriterEntry\|SortedEntry" src test` returns nothing.
    `npm run docs:json`, diff `reports/api.json` against the seven-moved/two-added
    expectation, and **commit it**.

### Gate

```
npx vitest run test/unit/domain/storage/ test/unit/application/primitives/build-pack.test.ts test/unit/application/primitives/internal/write-pack-artifacts.test.ts test/unit/application/primitives/internal/pack-offset-table.properties.test.ts test/unit/application/primitives/fetch-pack.test.ts test/integration/packfile-interop.test.ts \
  && npx vitest run --project parity \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/storage/pack-order.ts src/domain/storage/pack-writer.ts src/domain/storage/rev-index.ts src/domain/storage/cruft-pack.ts src/domain/storage/index.ts src/application/primitives/internal/write-pack-artifacts.ts src/application/primitives/internal/cruft-pack-lifecycle.ts src/application/primitives/build-pack.ts src/application/primitives/internal/index-pack.ts src/application/primitives/fetch-pack.ts test/fixtures/storage/pack-index-entries.ts test/unit/domain/storage/ test/unit/application/primitives/ test/integration/packfile-interop.test.ts test/parity/scenarios/ \
  && npm run check:spelling
```
Plus the pre-paid surface gate: `npm run docs:json && git status --porcelain -- reports/api.json`
(expect it **modified**, review the diff against the seven-moved/two-added expectation, and
commit it in this same commit). Cache bypass:
`npx tsc --noEmit -p tsconfig.typecheck.json`, `npx cspell --no-progress <files>`.

### Commit

`feat(storage)!: pass the oid slab to the idx, rev and cruft serializers`

---

## Part 3 — The typed-array pack record store and its two child indexes

### Context

**Create `src/application/primitives/internal/pack-records.ts`** — pure, I/O-free, no
`Context`, no ports (ADR-787). It is the one genuinely algorithmic component of this change
and it takes the property-test lens the passes cannot.

**It lands wired.** `internal/index-pack.ts`'s `walkFromPending` builds the store from its
`ResolvedEntry[]` and returns **both** shapes — `walkPackEntries` still needs
`ReadonlyArray<WalkedEntry>` (ADR-783) and `indexQuarantinedPack` now takes the store's
`PackIndexEntries` view — in place of Part 2's interim `slabFromWalkedEntries`, which is
deleted here. `ResolvedEntry` (moved to `index-pack.ts` in Part 1) carries
`{ id, type: BaseTypeName, content, crc32, offset }` — oid, type, crc and offset all present,
nothing invented. Map the type with `objectTypeToPackEntryType`
(`src/domain/storage/pack-entry.ts:242`, already public; `BaseTypeName` is structurally
`ObjectType`). Part 4 then moves the store's consumers earlier — pass 1 appends records,
pass 2 fills oids — and `walkFromPending` disappears.

⚠️ **If you deviate and land the module unwired, `npm run check:dead-code` (knip) reports it
as an unused file and the phase-boundary validate goes red.** `knip.json` sets
`project: ["src/**/*.ts"]`, so every `src/` file must be reachable from an entry. Exports
consumed **only by tests** are fine (`DISK_WALK_WINDOW_BYTES` has no `src/` consumer today and
knip is green), but an unreferenced `src/` **file** is not. Do not add a knip ignore entry;
wire it as instructed.

**The record arrays** (design §3). `W = ctx.hash.digestLength`, but the store itself takes
`digestLength` as a constructor argument and imports nothing from `ports/`:

| Array | Type | Bytes/entry | Why |
|---|---|---|---|
| `offsets` | `Float64Array` | 8 | Pack offsets exceed `2^32` for packs > 4 GiB, which the `.idx` v2 large-offset table already contemplates. `Uint32Array` would be a silent 4 GiB cliff |
| `crcValues` | `Int32Array` | 4 | `crc32` is already a signed 32-bit value in `WalkedEntry` |
| `types` | `Uint8Array` | 1 | 3 bits of `PackEntryType` plus a `resolved` flag bit. **An all-zero oid slot is not a usable "unresolved" sentinel** — the zero oid is a legal, if absurd, hash |
| `oids` | `Uint8Array` | 20 / 32 | Flat slab, no per-entry allocation. This is the array Part 2's serializers consume |

Per-delta side tables (`D` deltas, `D_ref` of them REF), **application-owned, never crossing
into a domain signature**: `deltaEntry: Int32Array(D)`, `deltaBaseOffset: Float64Array(D)`
(a sentinel for REF), `refBaseOids: Uint8Array(D_ref × W)`.

Two things deliberately **not** stored, because pass 2 re-derives them from a header re-parse
costing a few varint bytes inside a window it already holds: `dataOffset` and `size`.

**Sizing — ADR-780, and it is a security requirement (R3).** Capacity grows **geometrically**
from a small initial size as entries are actually parsed. `header.objectCount` is a **loop
bound and never an allocation input** — a server-controlled `uint32` where 50 M × 33 B is
1.65 GB claimed by a pack that may hold three entries. The structural clamp
`(totalBytes − 12 − digestLength) / 9` (from the pinned 9-byte minimum pack entry: one
type/size byte plus the 8-byte zlib stream of an empty payload) is kept as a second bound
**underneath** the growth, not instead of it. Cost is a transient 1.5× during each doubling,
bounded by the *real* entry count.

**The hand-over view** (design §3a). Because capacity exceeds `count`, the arrays are
over-allocated by construction. `view(): PackIndexEntries` returns **the same buffers, no copy
and no narrowing `subarray`** — `count` is the only bound, which is exactly what that field is
for. `types` and every delta side table stay behind and never appear in a domain signature.

**The two child indexes**, built once at the end of pass 1:
- **OFS children**: an `Int32Array` of delta ordinals sorted by `deltaBaseOffset`. Lookup is a
  binary search for the first ordinal whose base offset equals a given offset, then a linear
  walk while equal.
- **REF children**: an `Int32Array` of REF-delta ordinals sorted by base-oid bytes
  (`compareBytes` over slices of `refBaseOids`). Same lookup shape.

Both are pure sorts over typed arrays. **No `Map`, no `Set`, and no `arr.push(...children)`**
— a spread over an array sized by object count overflows the call stack near 125 k elements,
well inside the range a real clone reaches. Loop-drain.

**The OFS guard belongs here** (ADR-785), because it is a structural check on a recorded base
offset: `baseOffset < PACK_HEADER_SIZE || baseOffset >= entryOffset` refuses with git's own
reason, `delta base offset is out of bound`, under the unchanged `INVALID_PACK_HEADER` code
via `invalidPackHeader` from `src/domain/storage/error.js`. Today's guard is
`baseOffset < PACK_HEADER_BYTES` only, so a distance of **zero** passes it — the entry names
itself — and falls through to `unresolved entry at offset 37` for a structurally invalid
pack. git refuses the same bytes at the entry. Part 4 wires the call; this part owns the
guard and its tests. A base offset that is in range but lands **mid-entry** is *not* caught
here — it stays an unresolved-delta count, which is the same split git makes.

**Surface — exactly two module exports**, the factory and its interface. Everything else is a
method on the returned object, so the module's export list stays two names wide no matter how
many capabilities the store grows:
```ts
export interface PackRecordStore { … }
export function createPackRecordStore(digestLength: 20 | 32, structuralMaxEntries: number): PackRecordStore
// append(offset, crc32, type) -> ordinal;  setOid(ordinal, bytes);  markResolved(ordinal)
// isResolved(ordinal);  typeOf(ordinal);  offsetOf(ordinal);  oidRangeOf(ordinal)
// recordOfsDelta(ordinal, baseOffset);  recordRefDelta(ordinal, baseOidBytes)
// buildChildIndexes();  ofsChildren(baseOffset);  refChildren(baseOidBytes)
// count;  resolvedCount;  view(): PackIndexEntries
```
Return child lookups as an index range into the sorted ordinal array (`{ start, end }`), not
as a freshly allocated array per call — pass 2 calls this once per resolved entry.

Half these methods have no `src/` caller until Part 4 (`recordOfsDelta`, `recordRefDelta`,
`buildChildIndexes`, `ofsChildren`, `refChildren`, `isResolved`, `typeOf`, `resolvedCount`).
That is fine and is the reason for the two-export shape: knip inspects module exports, not
interface members. In Part 3's wiring, `structuralMaxEntries` is simply the resolved array's
length — the real clamp arrives with pass 1.

**Import paths from `src/application/primitives/internal/`** (three levels up to `src/`):
`compareBytes` (`:37`) and `bytesToHex` (`:5`) from `'../../../domain/objects/encoding.js'`;
`PACK_HEADER_SIZE` (`:60`) and `PackEntryType` / `objectTypeToPackEntryType` from
`'../../../domain/storage/pack-entry.js'`; `invalidPackHeader` from
`'../../../domain/storage/error.js'`; `PackIndexEntries` from
`'../../../domain/storage/pack-order.js'`. Application → domain is the permitted direction;
this module imports nothing from `ports/` and takes no `Context`.

#### Tests

**`test/unit/application/primitives/internal/pack-records.test.ts`** (new). Pure; the `sut` is
the function under test, never the result.

| Area | Cases |
|---|---|
| record store | store and read back `offset`, `crc32`, `type`, `oid` for entry 0, entry N−1 and a middle entry; SHA-1 (20 B) **and** SHA-256 (32 B) widths; the `resolved` flag distinguishing "unresolved" from "resolved to the all-zero oid" |
| growth | capacity crossing **exactly** at the doubling boundary, one below, one above; contents preserved across every growth; the structural clamp binding *before* the declared count does |
| slab hand-over | the exposed `PackIndexEntries` reports `count`, **not** `array.length`, when capacity exceeds `count`; entry `count − 1`'s oid range is the last `digestLength` bytes *within* `count`, never into the over-allocated tail |
| OFS child index | zero children; one; two children of the same base (adjacent ordinals); children of *different* bases interleaved by offset; a base offset present in the delta table but with no matching entry |
| REF child index | the same five shapes over oid bytes; **two entries with equal oids** |
| guard clauses | `baseOffset < PACK_HEADER_SIZE` and `baseOffset >= entryOffset` as **separate** tests, each triggering exactly one condition, each asserting `error.data` via try/catch — never a bare `toThrow(Class)`. The `distance === 0` case is the one that kills `>` in place of `>=` |

**`test/unit/application/primitives/internal/pack-records.properties.test.ts`** (new).
Generators in a sibling `test/unit/application/primitives/internal/arbitraries.ts`; `Given`
reads "Given an arbitrary …"; **never commit a seed**.

| # | Lens | Property | `numRuns` |
|---|---|---|---|
| P1 | round-trip | for an arbitrary list of `(offset, crc32, type, oid)` records, reading index `i` back returns exactly what was written | **200** |
| P2 | compositional matcher | `ofsChildren(k)` returns exactly the ordinals whose recorded base offset equals `k` — empty input returns empty; appending a record with base `k` grows the result by one | 100 |
| P3 | compositional matcher | the same for `refChildren(oid)` over arbitrary oid byte arrays, duplicates included | 100 |
| P4 | counting invariant | `Σ_k \|ofsChildren(k)\| + Σ_o \|refChildren(o)\| = D` for any collection of deltas | 100 |

**Mutation-hazardous constants to write kill tests for up front**: `RECORD_BYTES` and every
field offset — each needs a case whose *output* changes when the constant does; the growth
factor and the `capacity <= needed` comparison, with a case landing exactly on the boundary;
both binary searches' bounds (the classic loop-bound equivalent family — any suppression is
**re-proved against this code**, never carried forward).

#### The two suppressions this part falsifies

`internal/index-pack.ts`'s `walkFromPending` carries, from Part 1:
- `:844`-equivalent, `MethodExpression`: *"the defensive `.slice()` copy cannot change
  behaviour."*
- `:846`-equivalent, `ArithmeticOperator,MethodExpression`: *"the `WalkedEntry` order is
  unobservable (`objectCount` uses `.length`; `serializePackIndex` re-sorts by SHA), so a
  broken comparator — or dropping the `.sort()` entirely — changes nothing downstream."*

**Both are false once the store is fed from that array.** `resolveAllEntries` returns
`[...byOffset.values()]` in *resolution-round* order, not offset order, and the record store's
`offsets` are documented **strictly increasing by construction**. The sort becomes the thing
that upholds that invariant. **Retire both suppressions** and replace them with a test that
the handed-over `PackIndexEntries.offsets` is strictly ascending over a corpus case whose
resolution order differs from its offset order (`ref-delta-before-base` and
`branching-forest` are both such cases). That makes the mutants killable rather than
suppressed. Do not restate the proof — it is not true any more.

### TDD steps

1. **RED** — `pack-records.test.ts`: store and read back one record at each of the three
   positions, both digest widths. Fails:
   `Cannot find module '.../internal/pack-records.js'`.
2. **GREEN** — `pack-records.ts` with the four per-entry arrays, `append`/`setOid`/
   `markResolved`/`isResolved` and fixed initial capacity.
3. **RED** — the growth cases (exactly on the doubling boundary, one below, one above,
   contents preserved) and the structural clamp binding before the declared count. Fails: no
   growth.
4. **GREEN** — geometric growth with the clamp underneath it.
5. **RED** — the slab hand-over cases: `count` not `array.length`, and entry `count − 1`'s oid
   range inside `count`. Fails: `view()` unimplemented.
6. **GREEN** — `view(): PackIndexEntries` over the same buffers, no copy, no `subarray`.
7. **RED** — the ten child-index cases (five OFS shapes, five REF shapes including equal
   oids). Fails: child indexes unimplemented.
8. **GREEN** — the two sorted `Int32Array` indexes and their binary-search-plus-linear-walk
   lookups. Loop-drain, no spread.
9. **RED** — the two OFS guard cases as separate tests, `error.data` asserted via try/catch,
   including `distance === 0`. Fails: no guard.
10. **GREEN** — `baseOffset < PACK_HEADER_SIZE || baseOffset >= entryOffset` with git's reason.
11. **RED** — `pack-records.properties.test.ts` P1–P4 with the new arbitraries. Fails on
    whatever P2/P4 shrink to if a lookup range is off by one.
12. **GREEN** — fix whatever the properties shrink to.
13. **RED** — in `fetch-pack.test.ts`, assert `PackIndexEntries.offsets` is strictly ascending
    for the `ref-delta-before-base` and `branching-forest` corpus cases through
    `fetchPack`'s written `.idx`. Fails only if the sort is dropped — which is the point.
14. **GREEN** — rewire `walkFromPending` to build the store from its `ResolvedEntry[]` and
    return the view; delete Part 2's `slabFromWalkedEntries`; retire the two suppressions.
15. **REFACTOR** — `wc -l` both new modules (< 800). `npm run check:dead-code` to confirm knip
    is quiet. `npm run docs:json && git status --porcelain -- reports/api.json` — expect
    **empty**.

### Gate

```
npx vitest run test/unit/application/primitives/internal/pack-records.test.ts test/unit/application/primitives/internal/pack-records.properties.test.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/primitives/internal/write-pack-artifacts.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/pack-records.ts src/application/primitives/internal/index-pack.ts test/unit/application/primitives/internal/pack-records.test.ts test/unit/application/primitives/internal/pack-records.properties.test.ts test/unit/application/primitives/internal/arbitraries.ts test/unit/application/primitives/fetch-pack.test.ts \
  && npm run check:spelling
```
Plus `npm run check:dead-code` (knip must be quiet on the new module) and
`npm run docs:json && git status --porcelain -- reports/api.json` (expect **empty**).
Cache bypass: `npx tsc --noEmit -p tsconfig.typecheck.json`,
`npx cspell --no-progress <files>`.

### Commit

`feat(fetch-pack): record pack entries in typed arrays behind a pure store`

---

## Part 4 — Two passes replace the pipeline: sequential scan, root-down forest walk

### Context

**The heart of the change, and the largest part.** Everything in
`src/application/primitives/internal/index-pack.ts` between the byte-source seam and the slab
hand-over is replaced. `fetch-pack.ts` is not touched except for its `maxObjectsPerPack`
neighbour; `src/domain/**` is not touched at all.

**Deleted outright**: `PendingEntry`, `ResolvedEntry`, `inflateAllEntries`,
`resolveAllEntries`, `walkFromPending`, `tryResolveEntry`, `resolveDelta`,
`firstUnresolvedError`, `refDeltaBaseId`, `computeLooseObjectId`, and Part 2's interim
`slabFromWalkedEntries` if any trace remains. `isBaseHeader` and `baseTypeName` survive.
`WalkedEntry` survives as `walkPackEntries`' return (ADR-783) and is now **materialised from
the slab** for its one caller, `bundle-verify.ts:78`, which discards it.

#### Pass 1 — sequential scan, retain nothing

Today's `inflateAllEntries` loop with the `out.push` deleted. Same `PackByteSource` seam, same
forward-only window ladder, same trailer and `offset !== trailerStart` guards, same
`PACK_TOO_LARGE` check on `header.objectCount` against
`ctx.config?.maxObjectsPerPack ?? DEFAULT_MAX_OBJECT_COUNT`. For entry `i` at absolute offset
`o`:

1. `header = await source.entryHeader(o)` — type, declared `size`, `dataOffset`, plus
   `baseDistance` (OFS) or `baseId` (REF).
2. `result = await source.inflateEntry(o, header.dataOffset, header.size)`.
   **`bytesConsumed` is why this pass cannot be skipped**: a pack stores no entry lengths, so
   the only way to learn where entry `i+1` starts is to inflate entry `i` and see how many
   input bytes the zlib member consumed. git pays the same cost.
3. `entryEnd = header.dataOffset + result.bytesConsumed`, then
   `crc = await source.entryCrc32(o, entryEnd, result.crcContext)`.
   ⚠️ **`bytesConsumed` is counted from `dataOffset`, not from the entry start** — today's
   loop (`:879`) already does this, and getting it wrong shifts every subsequent offset by the
   header width.
4. Classify:
   - **base** (`COMMIT|TREE|BLOB|TAG`): compute the oid from `result.output`
     **incrementally** — `const h = ctx.hash.createHasher(); h.update(headerBytes);
     h.update(result.output); const hex = await h.digestHex();` — and store it in the record
     slab. `result.output` is then dropped.
   - **OFS delta**: `store.recordOfsDelta(ordinal, o − header.baseDistance)`, which applies
     Part 3's widened guard and refuses here with `delta base offset is out of bound`.
   - **REF delta**: `store.recordRefDelta(ordinal, hexToBytes(header.baseId))`.
5. `o = entryEnd`; loop. `store.buildChildIndexes()` at the end.

Nothing survives step 5 except fixed-width records. **Peak during the pass is one entry's
inflated payload plus the read window.**

`streamInflate` returns a whole buffer, so that one payload is materialised.
`createInflateStream()` would let bytes flow into a hasher without ever existing whole, but it
**does not report `bytesConsumed`**, so it cannot drive a walk that must find the next entry.
Pass 1 stays on `streamInflate`; `largestEntryInflatedBytes` is an irreducible term.

**`computeLooseObjectId` (`fetch-pack.ts:1026` before Part 1) is deleted.** It allocated a full
second copy of every object (`headerBytes ++ content`) purely to hand `ctx.hash.hashHex` one
buffer, and was the largest identified contributor to today's residency exceeding 1.0× on a
delta-free pack. The `HashService` port (`src/ports/hash-service.ts`) already exposes
`createHasher(): Hasher` with `update(data)` / `digest()` / `digestHex()`; a hasher is
**single-use and throws `hashFailed('cannot update after digest')` if reused**.
**Record the adapter asymmetry, do not hide it**: Node's `createHasher` wraps
`crypto.createHash` and is genuinely incremental (`node-hash-service.ts:31`); the memory
(`memory-hash-service.ts:47`) and browser (`browser-hash-service.ts:31`) adapters collect
chunks with `chunks.push(data.slice())` and concatenate at digest time, because SubtleCrypto
has no streaming digest. So this is a clear win on Node and **exactly neutral** elsewhere — it
never regresses, and it removes the copy on the runtime that clones large repositories.

#### Pass 2 — resolve from the roots down

A depth-first walk of the delta forest, rooted at every base entry, with the parent's content
held on an **explicit stack** — never the JS call stack, because depth is uncapped (ADR-786)
and must cost heap, not frames. Every byte read at an arbitrary offset goes through the
existing `PackByteSource` seam and its window ladder (ADR-782) — never a held `FileHandle`,
which `browser-file-system.ts` cannot provide (`openWithNoFollow` throws
`UNSUPPORTED_OPERATION`) and which reopens a descriptor-leak class this repository has already
paid for once.

```
for each entry b with a base type, in increasing offset:        # the forest roots
    content = inflate(b)                                        # one disk re-read
    walkSubtree(oidOf(b), typeOf(b), content, offsetOf(b))

walkSubtree(oid, type, content, offset):                        # explicit stack
    children = ofsChildren(offset) ++ refChildren(oid)
    for each child c in children:
        if resolved(c): continue                                # duplicate-oid guard
        delta        = inflate(c)                               # one disk read
        childContent = applyDelta(content, delta)               # delta dropped here
        childOid     = hash(type, childContent)
        record(c, childOid, type, resolved = true)
        walkSubtree(childOid, type, childContent, offsetOf(c))
        release childContent
    release content                                             # <- the load-bearing line
```

Five properties, each answering a requirement:

- **`release content` is the memory bound.** A parent is released **the moment its last child
  is dequeued**. With an explicit stack the equivalent is a per-frame "children remaining"
  counter, decremented as each child is popped. Get it wrong and residency becomes
  `depth × objectSize` for every chain instead of two objects for a linear one — the
  difference between git's measured 0.39 MB and the 7.99 MB a naive path model predicts.
- **The `resolved(c)` guard is not defensive padding.** A pack may legally carry the *same oid
  twice* — git's default fetch accepts it, `transfer.fsckObjects` defaulting false. A REF
  delta keyed on that oid is then a child of **two** parents; without the guard it would be
  applied twice and `resolvedCount` would overshoot `objectCount`, turning the refusal count
  into nonsense. An entry has exactly one base *reference*, so this is the only way a child is
  reachable twice, and one flag bit closes it.
- **Each entry's payload is read at most twice** (pass 1, pass 2) and **applied exactly once**
  (R8). A base with no children is read once and never revisited.
- **Forward REF references resolve** (R5): roots are enumerated by entry *type*, so a base
  sitting after its dependents is found on the same pass.
- **Cycles are structurally unreachable** (R11): the walk only descends *from* content it
  already holds, so an entry unreachable from a base is simply never visited. Termination is
  structural — each entry visited at most once — not a no-progress counter.

Order the roots by increasing offset so pass 2's *root* reads stay sequential; child reads jump
around, which is unavoidable — the forest's shape is the server's choice.

**Thin packs sit on the same seam.** Every REF child whose base oid matched no in-pack entry is
offered to `externalBaseResolver(baseOid)` before failure is declared. A resolved external base
becomes an extra forest root: its `{ type, content }` is exactly what `walkSubtree` takes, and
`validateDeltaHeader` (`src/domain/storage/delta.ts:145`) already enforces
`base.length === sourceLength`, so a wrong-sized external base refuses rather than producing
garbage. Its content is released when its subtree completes.

Two counting details an implementer would otherwise have to rediscover:

- **A base entry is `resolved` the moment pass 1 computes its oid**, not in pass 2. So
  `resolvedCount` after pass 1 equals the number of base entries and pass 2 only increments it
  per delta. Counting only pass-2 resolutions makes every pack with a base entry refuse.
- **A resolved delta's `types` slot keeps its `OFS_DELTA` / `REF_DELTA` value.** The base type a
  delta's oid is hashed under travels down the walk stack from the root, and `typeOf` is used
  only to enumerate roots. Do not rewrite the slot — `types` never crosses into the
  `PackIndexEntries` view, so nothing downstream reads it.

**The refusal** (ADR-784). After the walk, `resolvedCount < objectCount` means some delta was
never reachable. The reason becomes git's own count:
`` `pack has ${n} unresolved delta${n === 1 ? '' : 's'}` ``, **singular at one**, under the
**unchanged** `INVALID_PACK_HEADER` code, where `n = objectCount − resolvedCount`. No
structured `unresolvedCount` / `firstUnresolvedOffset` fields are added — they were offered and
not taken. Three cases converge on this one message — a REF cycle, an all-deltas pack with no
base entry, and an OFS base offset landing mid-entry — which is exactly what git does on the
same bytes. `TsgitError.data.code` is unchanged, so any consumer branching on the code is
unaffected; a consumer matching the reason *text* sees a new string, and that text was never
git-faithful.

#### The window ladder must learn a backward anchor

`diskPackByteSource`'s ladder is written for a forward-only scan. `windowCovering(anchor)`
reuses the held window only when
`anchor >= window.start && anchor < window.start + window.bytes.length`; a backward anchor
falls through to a fresh `fetchWindow(anchor, initialWindowSize(anchor))`, which is **already
correct**. What must be verified — and is a pass-2 read-pattern test — is that
`withGrowth`'s `rung` / `deliveredAtAnchor` bookkeeping (`isFreshDocumentedWindow`,
`isAnchoredHere`, `nextRung`, `growOrRethrow`) still grows correctly for a **base re-read**
that exceeds one window at a backward offset, which today's ladder only ever exercises
forward.

**The `:716` suppression is falsified and must be retired or re-proved against this code.** It
reads: *"diskPackByteSource has one caller sequence (inflateAllEntries's forward scan,
entryHeader then inflateEntry at the SAME offset), so anchor only ever grows; `anchor <
window.start` never occurs."* Pass 2 reads backwards, so `anchor < window.start` now occurs.
The guard itself is already correct — a non-covering anchor falls through to a fresh fetch —
but the proof is now false and the mutant is **killable**. Retire the suppression and write the
test: a corpus case whose pass-2 root sits before the window pass 1 left held, asserting the
resulting `readSlice` anchor.

**The `:889`/`:891` suppressions** (`entryEnd > trailerStart` unreachable once the trailer has
been accepted, and its message therefore unobserved) survive the rewrite as *verdicts* but
their prose names `inflateAllEntries`. **Restate them against pass 1's loop.**

**The `:939` suppression retires with `firstUnresolvedError`**, which is deleted.

**The `:718` suppression** (a window wrongly deemed to cover an anchor trips
`decodeTypeAndSize`'s own guard and `growOrRethrow` re-fetches) is unaffected — re-read it and
confirm before leaving it in place.

#### Wiring

- `indexPackEntries(ctx, source, externalBaseResolver?): Promise<PackIndexEntries>`
  — module-private core, both passes over one `PackByteSource`.
- `indexQuarantinedPack(ctx, tmpPath, totalBytes, onFailure)` — `diskPackByteSource`.
- `walkPackEntries(ctx, packBytes, externalBaseResolver?)` — `inMemoryPackByteSource`;
  materialises `WalkedEntry[]` from the returned slab with `bytesToHex` over each oid range,
  in emission order.

**Do not add an options parameter here** — Part 5 threads `IndexPackOptions` through these
three signatures when it has something to put in it. An exported interface with no reader is a
knip "unused export" finding.

That `WalkedEntry[]` materialisation is `N × ~490 B` of pure waste on the bundle path, since
`bundle-verify.ts:78` discards the array and uses the call purely as a validation gate.
**It is deliberate and ADR-ratified**: collapsing `walkPackEntries` to a validate-only entry
point was considered and explicitly deferred as available *after* this change, not as a
prerequisite. `fetchPack` never calls `walkPackEntries` and never builds the array. Do not
"fix" it here, and do not let a reviewer's flag turn into an unplanned signature change.

**`RepositoryConfig.maxObjectsPerPack`'s doc comment** (`src/ports/context.ts`, near `:142`)
says it bounds the point "before `fetchPack` allocates per-entry state". After ADR-780 that is
no longer what it does: nothing allocates from the declared count at all. Rewrite the comment
to say it caps the declared object count a pack may claim, and note the record arrays grow
from the real entry count. ⚠️ **`RepositoryConfig` is in `reports/api.json` and typedoc embeds
doc comments — this makes it stale.** Regenerate with `npm run docs:json` and commit it in
this part; the diff must be **only** that comment.

#### Tests

Extend `test/unit/application/primitives/fetch-pack.test.ts` — it already builds synthetic
packs and drives `fetchPack` through a fake negotiator; extend rather than duplicate.

- **The Part 1 equivalence net must go green unchanged.** If a corpus case needs editing to
  pass, that is a divergence, not a test problem — escalate `{ unit, reason, ≤3 options }`.
- **Exactly three existing tests assert the old refusal strings and must be rewritten** — find
  them before writing anything new, because they are where the reason change is observed:

  | Line | Current title / assertion | After |
  |---|---|---|
  | `:638` | `describe('Given an OFS_DELTA pointing before the pack body')` > `it('Then throws INVALID_PACK_HEADER referencing the offset')`, asserting `reason` contains `'OFS_DELTA'` and `'before pack body'` | same verdict, reason is now git's `delta base offset is out of bound` |
  | `:697` | `describe('Given a REF_DELTA whose base is not in the pack')` > `it('Then throws unresolved REF_DELTA')`, asserting `reason` contains `'unresolved'` and the unknown base id | `pack has 1 unresolved delta` — the base id is **no longer named**, so the `unknownBaseId` assertion goes, and the `it` title changes |
  | `:1581` | `describe('Given a pack with an OFS_DELTA whose base offset is itself (distance 0)')` > `it('Then throws "unresolved entry at offset"')`, asserting `'unresolved entry at offset'` and `'12'` | **the defect fix.** Refuses at the entry with `delta base offset is out of bound`. The `it` **title** changes too — it currently quotes the wrong string |

  Every other refusal assertion in the file (`PACK_TOO_LARGE` at `:844`/`:889`/`:933`/`:975`,
  trailer mismatch at `:1021`, the reserved-type-5 header at `:2610`, the
  inflates-past-declared-size cases at `:2682`/`:2774`) is **unchanged** — if one of them
  moves, something is wrong.
- **`:2740` already covers the zero-length declared-size case** (`Given a quarantined pack
  entry with declared size 0 (an empty blob)`). Extend it for the in-memory source rather than
  writing a second one.
- **Every degenerate row as its own case, through both entry points**: empty pack; single base;
  all-deltas-no-base (refuses, `resolvedCount === 0`); zero-length inflated object (accepted —
  `streamInflate(bytes, off, 0)` narrows the cap to 0 and zero output does not *exceed* zero;
  the `<=` vs `<` in that cap is a live mutant and needs its own case); delta whose base is the
  last entry; REF delta whose base is later; duplicate oid; chain depth 1, 50 and 1 000; REF
  cycle; OFS distance 0; OFS base landing mid-entry; an object whose inflated size exceeds one
  read window, **re-read backwards in pass 2**.
- **Pass-2 read pattern.** The existing `requestedLengths` spies (`fetch-pack.test.ts:2339`,
  installed through `withFsPatch(baseCtx, { readSlice })`) pin pass 1's forward ladder. Add
  assertions that pass 2 issues **backward** anchors and that no single requested length
  exceeds one grown window.
- **`walkPackEntries` parity.** `fetch-pack.test.ts:2309`'s in-memory-vs-disk test, extended to
  the corpus cases with deep chains and forward REF references.
- **Thin packs (R7).** Base present → resolves; base absent → refuses; base present but the
  **wrong size** → refuses through `validateDeltaHeader`, not silently. The existing
  `describe('walkPackEntries')` block at `:2827` is the home.
- **Untrusted count (R3).** A pack declaring `objectCount = 50_000_000` with three real
  entries: the call refuses on the first bad inflate and total allocation stays proportional to
  three, asserted through a **spy on the record store's capacity**, not through memory.
- **S3 — the anti-producer-fork oracle** (new, in `fetch-pack.test.ts`). ADR-790 created a
  second slab producer, so the fork risk moved from the serializers to the producers.
  `buildPack` a pack, write those exact bytes, index them through **`indexQuarantinedPack`**
  (not `walkPackEntries`, which still returns `WalkedEntry[]`), then assert the two
  `PackIndexEntries` yield `.idx`, `.rev` and `.mtimes` bytes that are `toEqual`. A
  digest-width mismatch, an off-by-one stride, or a divergent emission order in either producer
  fails **here and nowhere else**.

**Extend `test/integration/index-pack-interop.test.ts`** with the remaining cross-tool rows,
all with git as the peer on the same crafted bytes, all under the shared `beforeAll(…, 60_000)`:

| Given | Then |
|---|---|
| the crafted OFS-distance-0 pack | both refuse; git's reason tail is `delta base offset is out of bound` and tsgit's `data.reason` is the **same string** |
| the crafted REF-cycle pack and the all-deltas pack | both refuse; git says `pack has 2 unresolved deltas` and tsgit's reason is **byte-identical** |
| a pack with exactly **one** unresolvable delta | both say `pack has 1 unresolved delta` — the **singular**, the case a naive `${n} deltas` template gets wrong |
| the crafted forward-REF pack | both accept, same oid set |
| chains at depth 50 / 51 / 1 000 | both accept — no depth cap. Record in the same case that tsgit's own object resolver refuses past `MAX_DELTA_CHAIN_DEPTH = 50` (`object-resolver.ts:327`, `fsck/object-cache.ts:223`) and that this gap stays open deliberately |
| four identical zero-length blobs | git without `--strict` accepts and tsgit accepts; `git index-pack --strict` refuses and the divergence is **recorded, not asserted away** |
| a real thin pack (`pack-objects --thin --revs`) | tsgit refuses without a resolver; with the store's bases available it completes, and `git index-pack --stdin --fix-thin` accepts the same bytes |
| fixture A indexed by tsgit | `git fsck --strict --no-progress` in the resulting repo exits **0** with zero output on both streams |
| fixture A's `.idx` and `.rev` written **from the indexer's own slab** | `git verify-pack -v` and `git show-index` agree with tsgit's records, and `git cat-file --batch-all-objects --batch-check` reads every object back |

⚠️ Crafting these packs by hand: `PACK` + v2 + count, entries, **recomputed SHA-1 trailer**.
Any case corrupting an entry header that skips the trailer recomputation gets
`fatal: pack is corrupted (SHA1 mismatch)` and never reaches the condition under test.
⚠️ `git index-pack` has **no `--no-progress` flag** (`-v` is its only progress switch) — a
probe passing it prints usage and exits without writing an `.idx`. Every git probe must assert
its own output exists (`git show-index < <idx> | wc -l` equals the expected object count)
before its result is believed. This mistake produced three-significant-figure-reproducible
nonsense once already.

**Mutation-hazardous spots to write kill tests for up front**: the **singular/plural** branch
in the refusal message (one-unresolved and two-unresolved packs — a `StringLiteral` mutant on
either arm survives a test that only ever sees the plural); `resolvedCount < objectCount`
versus `!==` (a walk resolving *more* entries than declared is unreachable — **prove the
equivalence or restructure**, never suppress); the `declaredSize`/`maxOutputBytes` cap on a
zero-length object (`<=` vs `<`); the "children remaining" counter's decrement and its
`=== 0` release test.

**File size.** ADR-787 names two new modules. If `index-pack.ts` would exceed 800 lines,
extracting the byte-source seam into `src/application/primitives/internal/pack-byte-source.ts`
is **pre-approved** — it is a mechanical extraction of code that already moved once, not a
new decision. Do not exceed the ceiling and do not silence a line-count check.

### TDD steps

1. **RED** — the singular/plural refusal pair and the OFS-distance-0 case in
   `fetch-pack.test.ts`, `error.data` asserted via try/catch. Fails: today's strings are
   `unresolved REF_DELTA: base … not in pack` / `unresolved entry at offset …`.
2. **GREEN** — pass 1 (record-filling scan, incremental hashing, the widened OFS guard through
   the store) and pass 2 (explicit-stack root-down walk with the `resolved` guard and the
   last-child release), replacing the six deleted functions. `indexPackEntries` returns the
   store's view; `walkPackEntries` materialises `WalkedEntry[]` from it.
3. **RED** — the deep-chain cases (50 / 1 000) and the branching-forest case through both
   entry points, asserting the corpus oracle. Fails if the stack is recursive or the release
   rule is wrong (depth 1 000 is the one that blows a recursive implementation).
4. **GREEN** — explicit stack with the per-frame children-remaining counter.
5. **RED** — thin-pack: base present / absent / present-but-wrong-size, in the `:2827` block.
   Fails: the external seam is not yet wired into pass 2.
6. **GREEN** — offer unmatched REF base oids to `externalBaseResolver` and treat a hit as an
   extra forest root.
7. **RED** — the pass-2 backward-anchor read-pattern assertions and the
   larger-than-one-window base re-read. Fails if the ladder's growth bookkeeping mis-seeds at
   a backward anchor.
8. **GREEN** — fix the ladder if step 7 shows a real defect; **retire the `:716` suppression**
   either way and restate `:889`/`:891` against pass 1.
9. **RED** — the untrusted-count case with a record-store capacity spy. Fails if anything
   sizes from `header.objectCount`.
10. **GREEN** — confirm nothing does; keep `objectCount` as a loop bound only.
11. **RED** — S3, the two-producer `.idx`/`.rev`/`.mtimes` byte equality. Fails on any stride,
    width or emission-order divergence.
12. **GREEN** — fix whichever producer diverges.
13. **RED/GREEN** — extend `test/integration/index-pack-interop.test.ts` with the nine rows,
    each crafted pack carrying a recomputed trailer and each git probe asserting its own
    output exists.
14. **REFACTOR** — delete every dead helper; `wc -l` `index-pack.ts` (< 800, extract the byte
    source if not); rewrite `maxObjectsPerPack`'s doc comment; `npm run docs:json` and commit
    `reports/api.json` with **only** that comment's diff;
    `command grep -rn "computeLooseObjectId\|resolveAllEntries\|walkFromPending\|PendingEntry" src test`
    returns nothing.

### Gate

```
npx vitest run test/unit/application/primitives/fetch-pack.test.ts test/unit/application/primitives/internal/pack-records.test.ts test/unit/application/primitives/internal/pack-records.properties.test.ts test/unit/application/commands/bundle-verify.test.ts test/integration/index-pack-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/index-pack.ts src/application/primitives/internal/pack-records.ts src/ports/context.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/primitives/index-pass-corpus.ts test/integration/index-pack-interop.test.ts \
  && npm run check:spelling
```
Plus the pre-paid surface gate: `npm run docs:json && git status --porcelain -- reports/api.json`
(expect it **modified by the `maxObjectsPerPack` doc comment only** — commit it).
Cache bypass: `npx tsc --noEmit -p tsconfig.typecheck.json`,
`npx cspell --no-progress <files>`.

### Commit

`feat(fetch-pack): index received packs in two bounded-memory passes`

---

## Part 5 — One base cache on a measured budget, and the residency measurement

### Context

**Three jobs: bound an unbounded retention that already exists, add the optimisation git's own
indexer has, and pin its budget with a measurement rather than a guess.**

**First, thread the knob.** `internal/index-pack.ts` gains
`export interface IndexPackOptions { readonly baseCacheMaxBytes?: number }` and an optional
trailing `options?: IndexPackOptions` on `indexPackEntries`, `indexQuarantinedPack` and
`walkPackEntries`, defaulting to `INDEX_PASS_BASE_CACHE_MAX_BYTES`. All three live under
`primitives/internal/`, none is barrelled, none is in `reports/api.json` — this adds no
published surface. ADR-783's "keeps its signature" is honoured: `walkPackEntries`' existing
three parameters are unchanged and `bundle-verify.ts` passes nothing new. Without this there
is **no mechanism** to force the budget to `0`, and R15 is untestable.

#### The cache (ADR-788)

The root-down walk leaves exactly one piece of re-work: **every base entry that has children is
read from disk twice** — once in pass 1 to compute its oid, once in pass 2 as a forest root.
And the thin-pack seam already carries a cache, on the wrong side of the port and
**unbounded**: `src/application/commands/bundle-verify.ts:170-178`'s
`buildExternalBaseResolver` wraps `ExternalBaseResolver` in a
`Map<ObjectId, Awaited<ReturnType<ExternalBaseResolver>>>` that retains every externally
resolved base — **and memoises `undefined` results too** — for the life of the verify.

Collapse both into **one** structure:

| | |
|---|---|
| Shape | a single byte-capped `createLruCache<CachedBase>` inside `internal/index-pack.ts`, keyed on `ctx.session` (never on `Context` identity) |
| Serves | pass-1 base contents carried into pass 2, **and** externally-resolved thin-pack bases |
| Replaces | `bundle-verify.ts:170`'s unbounded `Map`. `buildExternalBaseResolver` is **deleted** and its resolver becomes a plain port call — `resolveExternalBase(ctx, baseOid)` at `:158-168`, kept, with no memo of its own |
| Budget | `INDEX_PASS_BASE_CACHE_MAX_BYTES`, its own named constant, defaulted from the measurement below. **Not a fraction of and not equal to `deltaCacheMaxBytes`** |
| Entry sizer | `content.byteLength + INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES`, paired with `INDEX_PASS_BASE_CACHE_MAX_ENTRIES` — a byte cap without a fixed overhead term and an entry cap undercounts a typical entry by roughly an order of magnitude |

`createLruCache` lives at `src/domain/storage/lru-cache.ts`, is re-exported from
`src/domain/storage/index.js`, and is:
```ts
export function createLruCache<V>(maxSizeBytes: number, maxEntries: number = Number.POSITIVE_INFINITY): LruCache<V>
export interface LruCache<V> {
  get(key: string): V | undefined;  set(key: string, value: V, byteSize: number): void;
  has(key: string): boolean;  delete(key: string): boolean;  clear(): void;
  readonly currentSize: number;  readonly maxSize: number;  readonly entryCount: number;
}
```
⚠️ `set` **throws `new Error('byteSize must be positive')`** when `byteSize <= 0` and silently
no-ops when `byteSize > maxSizeBytes`. A zero-length base object therefore cannot be cached at
its true size — the fixed overhead term is what keeps `byteSize` positive, and that is a
behaviour to test, not to discover.

**`ctx.session`, not `Context` identity.** `Session` is declared in `src/ports/context.ts`
(`export type Session = Readonly<Record<never, never>>`, minted by `createSession()` inside
`createContext`, propagated by `deriveContext` — the only derivation path). A `pull` derives a
Context between its fetch and its merge; nine identity-keyed caches were silently dropped by
exactly that. The house pattern is
`const caches = new WeakMap<Context['session'], LruCache<CachedBase>>()` —
`src/application/primitives/read-head-tree.ts:43` is the closest model, including its
`FLAT_TREE_CACHE_MAX_ENTRIES = 65_536` entry cap.
⚠️ Do **not** copy `read-head-tree.ts`'s `deltaBaseCachingEnabled(ctx)` gate: that gate exists
so fsck's zero-budget audit Context cannot poison a read-path memo, and this cache is on the
write path with its own budget.

**Two key spaces, one cache.** In-pack bases key on `o:<passId>:<offset>`; external bases key on
`x:<oid>`. `passId` is a per-invocation counter: two index passes sharing a session must not
collide on a raw pack offset, and external oids are already globally unique within the
repository. The pass **`clear()`s the cache when it finishes — success or failure** — so the
byte budget is never retained past the pass that needed it. That is what reconciles session
keying with the cache's per-pass nature, and it is safe because dropping a live entry another
pass is using can only cost a re-read, never a different result.

`INDEX_PASS_BASE_CACHE_MAX_BYTES` is a **hard** cap, not a target: a pack crafted to be all
base-with-children fills it and then evicts; it never grows it.

#### The measurement the implementation owes (the gating step)

**Do not invent a number.** The default is not chosen until this runs, and its deliverable is
**`docs/spike/index-pass-base-cache-budget.md`**, committed in this part.

Peak footprint comes from a **child process's kernel high-water mark**. An in-process sampler
cannot see this pipeline's peak: `resolveAllEntries` awaited only already-resolved promises, so
the loop drained as **microtasks** and `setImmediate` never fired during the phase holding the
peak — a sampler reported 6.3 MiB for a path whose true cost was 65 MB. `tooling/bench-memory.ts`
is exactly that kind of sampler (`process.memoryUsage()` on a `setInterval` poller) and must
**not** be reused as-is.

**The instrument, net-new:** a child `node` process runs one workload and reports
`process.resourceUsage().maxRSS` at exit. Node normalises that to **kilobytes** on darwin and
linux alike (verified: 244 336 against a 240.3 MB RSS on darwin). It is a kernel high-water
mark, so it cannot miss the peak, and unlike `/usr/bin/time -l` it is portable — macOS also has
**no `timeout(1)`**, so shell-level probes are not an option. Host it in
`tooling/bench-memory.ts` as new workloads beside the existing clone-quarantine one, which
already drives a real clone through an in-process `git-http-backend` transport
(`buildDeterministicTransport`, `test/bench/support/http-backend-server.ts`) — that is the
right vehicle for driving the receive path end to end. `npm run bench:memory` builds `dist/`
first and profiles the compiled tree; keep that.

**Three quantities per fixture.** The first two come from instrumentation inside the pass, not
from memory sampling:

1. **The demand curve** — `Σ inflatedBytes(b)` over base entries `b` with at least one child:
   the total working set a perfect cache would hold, and the ceiling the sweep approaches.
   Cross-check it against `git verify-pack -v`'s chain listing.
2. **Hit rate against budget** — sweep `baseCacheMaxBytes` over
   `{0, 1, 2, 4, 8, 16, 32, 64} MiB`, recording base re-reads avoided ÷
   base-entries-with-children.
3. **Wall clock and peak footprint at each budget**, median of three, single-threaded.

**On four fixtures, because each isolates something different:**

| Fixture | Shape | Isolates |
|---|---|---|
| **A** | 300-commit text churn, `git -c pack.threads=1 repack -a -d`: 903 objects, 506 635 pack bytes, 45 380 904 inflated, max chain 50, largest object 159 748 | Deep chains over *small* objects — every candidate budget holds many roots |
| **B** | fixture A repacked `--window=0 --depth=0`: 903 objects, 13 376 274 pack bytes, chain 0 | The delta-free control. The cache must be **inert** here — no base has children — so any movement is noise or a bug |
| **C** | `git clone --no-local --bare file:///…/tsgit`: 15 074 objects, 27 744 524 pack bytes, 598 540 715 inflated, max chain 48, **largest object 4 991 842** | A real clone pack. The fixture that discriminates budgets, because a budget below 4.76 MiB cannot hold even one large root |
| **thin** | `pack-objects --thin --revs`, plus a bundle with prerequisites | The external-base half, which C does not exercise at all |

Reuse Part 1's fixture-A generator; fixture B is A repacked; fixture C is a bare clone of the
worktree's own repository.

**What makes a candidate default right:** it sits at the **knee** of the wall-clock curve — the
smallest budget within 5 % of the unbounded-cache wall clock on **both** A and C — and it leaves
fixture C's measured peak inside the target class with headroom.

**What makes it wrong — record an explicit verdict against each:**

- **No knee.** If wall clock keeps improving roughly linearly all the way to the demand curve's
  total, the cache is "retain everything" wearing a budget and the residency claim is hollow.
  The honest response is a **much smaller budget and a documented smaller speed-up**, not a
  bigger budget.
- **Below the largest object.** A budget under `largestEntryInflatedBytes` cannot hold one root
  on fixture C.
- **Peak rises by more than the budget.** Then the entry sizer is wrong, and the constant is
  meaningless until it is fixed.
- **Fixture B moves.** The cache must be inert on a pack with no deltas. Movement there means
  something is being cached that has no children.

**The class R2 asserts against**, from the design's pinned matrix (git 2.55.0,
`--threads=1`, `.idx` existence asserted on every run, same machine):

| | git at `core.deltaBaseCacheLimit=96m` | git at `=0` | tsgit today |
|---|---|---|---|
| fixture A | 11.09 MB | 2.90 MB | 75.4 MB over baseline |
| fixture C | **126.09 MB** | **33.44 MB** | **799.5 MB over baseline** |

R2 is: fixture C's peak over baseline **does not exceed 126 MB** — against a git baseline small
enough (~1.5 MB) that the comparison is fair without subtracting it — and the design **targets
the 33 MB class**. `INDEX_PASS_BASE_CACHE_MAX_BYTES` must be small enough that the design's
`< 24.4 MiB + B` ceiling for fixture C stays well inside that; **this is one of the
measurement's acceptance conditions**, not an afterthought.

Disabling git's cache costs **1.84×** (A) and **2.07×** (C) wall clock — shipping no cache is
not free, it is a deliberate ~2× on clone latency. The residency assertion is a **class with
headroom, never a byte count** — the peer moves by a factor of four on one config key. Publish
every number as a **local sizing measurement**, never as a performance claim; published
performance numbers come only from CI's nightly bench artifact.

#### Tests

- **R15 as a parameterised sweep — this is the test that keeps the cache an optimisation.**
  Every degenerate corpus case, the synthetic deep-chain and branching cases, and both
  thin-pack fixtures run **twice** — `baseCacheMaxBytes: 0` and the default — asserting
  **identical** `WalkedEntry` sets, **byte-identical** `.idx` and `.rev` (feed both slabs
  through `sortPackIndexEntries` + `serializePackIndex` / `serializePackRevIndex` and compare
  buffers), and **identical `TsgitError.data`** on every refusal. Only latency may differ.
  Drive it at `walkPackEntries` / `indexQuarantinedPack`, which take the options object;
  `fetchPack` has no such parameter and must not grow one.
- **Bounded, and observably so.** A pack whose base-with-children content exceeds the budget:
  `cache.currentSize <= cache.maxSize` holds after every insertion. The **entry cap binds
  independently** — a separate case with many tiny bases, since a byte cap alone does not
  defend entry-count overhead.
- **The two key spaces do not collide.** Two index passes on one session, over different packs
  whose entries share a pack offset, must not read each other's bases. Only a test driving two
  passes and asserting distinct content proves the `o:<passId>:<offset>` key.
- **`clear()` on both exits.** Success and failure both leave `cache.currentSize === 0`. The
  failure case matters more: a refusing pack must not leave its bases resident.
- **`bundle verify` keeps its verdicts.** The existing `bundle-verify` tests pass unchanged
  after the `Map` is deleted — **including the case where a prerequisite base is absent**,
  since today's Map memoises that `undefined` and the replacement must still answer `undefined`
  on a repeat lookup rather than throwing.

**The `bundle-verify.ts:76` suppression is falsified.** It reads: *"a 0-prerequisite (complete)
bundle's pack is self-contained, so no REF_DELTA ever reaches the external resolver; always
building it (mutant) only allocates a Map+closure `walkPackEntries` never invokes."* ADR-788
deletes that Map, so the sentence describes code that no longer exists. The **verdict** may
still hold — a 0-prerequisite bundle's pack is still self-contained and the resolver still
never invoked — but **restate the proof against the plain port call, or retire the
suppression**. Do not carry it forward.

#### Benches

- **`test/bench/fetch-pack.bench.ts`** (new) — **wall clock only**, through
  `benchScenario(given, whenThen, build, opts?)` from `test/bench/support/bench-dsl.ts`. The
  two `bench()` names are fixed at `tsgit` / `isomorphic-git` by the summary script and the
  `benchmark-compare` CI job; a tsgit-only scenario simply omits `baseline`. Scenario: pass 1 +
  pass 2 wall clock against today's single pass, so the **second read of every entry is priced
  rather than assumed free**. `vitest.bench.config.ts` sets `testTimeout: 120_000`;
  `npm run test:bench` runs it. `benchmark-compare` is a **non-blocking** CI job here — it
  measures runner noise.
- **`tooling/bench-memory.ts`** — the child-process high-water workloads: the R1/R2 residency
  scenario on fixtures A, B and C, and the eight-point budget sweep on all four. The assertion
  is a **class with headroom** against the design's closed formula
  (`largestEntryInflatedBytes + Σ retained ancestors + N × RECORD_BYTES +
  D × DELTA_RECORD_BYTES + one read window + INDEX_PASS_BASE_CACHE_MAX_BYTES + idxAssembly`),
  never a byte count, and it must be **independent of Σ inflated over the pack**.
- **The gc-path case.** `gc` repacks the whole repository and is the highest object-count write
  path tsgit has — it is the argument ADR-790 turned on, so leaving it unmeasured is the one
  place this change's headline reduction would be unproven. Add a gc residency workload beside
  the existing `maintenance` gc scenarios (2, 3, 4 in `test/bench/maintenance.bench.ts`),
  measured the same way. ⚠️ **The assertion is branch against `main` on the same fixture, not a
  class ceiling** — the index-pass formula does not describe the gc path, `buildPack` still
  returns the whole pack as one `Uint8Array` and `deltifyEntries` still holds its own window,
  and neither is touched here. Use **absolute peaks on both branches**: a self-share or a ratio
  will not survive Amdahl against those two untouched terms. Record both numbers in the spike
  doc and report them; this comparison cannot be a CI assertion.

### TDD steps

1. **RED** — the R15 sweep across the corpus at `baseCacheMaxBytes: 0` and at a provisional
   default, asserting identical `WalkedEntry` sets, byte-identical `.idx`/`.rev` and identical
   `error.data`. Fails: `IndexPackOptions.baseCacheMaxBytes` is not read.
2. **GREEN** — the session-keyed `WeakMap<Context['session'], LruCache<CachedBase>>`, the two
   key spaces, the entry sizer with its fixed overhead term, the entry cap, and `clear()` on both
   exits — behind a **provisional** budget clearly marked as pending the measurement.
3. **RED** — boundedness (`currentSize <= maxSize` after every insertion), the entry cap binding
   independently on many tiny bases, the zero-length-base sizer case, `clear()` on the failure
   path, and the two-passes-one-session key-collision case. Fails on whichever invariant is
   missing.
4. **GREEN** — fix each.
5. **RED** — the existing `bundle-verify` suite with `buildExternalBaseResolver` deleted,
   including the absent-prerequisite repeat-lookup case. Fails: the resolver still memoises.
6. **GREEN** — delete `buildExternalBaseResolver` and its `Map`; `bundleVerify` passes
   `resolveExternalBase`-backed resolver directly; restate or retire the `:76` suppression.
7. **MEASURE (gating)** — land the `tooling/bench-memory.ts` workloads and run the demand curve,
   the eight-point sweep and the wall-clock/peak triples on fixtures A, B, C and thin, median of
   three, single-threaded, child-process `maxRSS`. Every git probe asserts its own output exists
   before its number is believed.
8. **PIN** — write `docs/spike/index-pass-base-cache-budget.md` with the curve, the sweep tables,
   an explicit verdict against **each of the four falsifiers**, and the chosen default. Set
   `INDEX_PASS_BASE_CACHE_MAX_BYTES` to that number and re-run the R15 sweep at the real default.
   If a falsifier fires, the honest response is the smaller budget and the documented smaller
   speed-up — not a bigger budget.
9. **RED/GREEN** — `test/bench/fetch-pack.bench.ts`'s wall-clock scenario and the
   `maintenance.bench.ts` gc residency case; run both branches for the gc pair and record the
   absolute peaks.
10. **REFACTOR** — `wc -l src/application/primitives/internal/index-pack.ts` (< 800; extract the
    byte source if not). `command grep -rn "buildExternalBaseResolver" src test` returns nothing.
    `npm run docs:json && git status --porcelain -- reports/api.json` — expect **empty**.

### Gate

```
npx vitest run test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/bundle-verify.test.ts test/unit/application/primitives/internal/pack-records.test.ts test/integration/index-pack-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/index-pack.ts src/application/commands/bundle-verify.ts tooling/bench-memory.ts test/bench/fetch-pack.bench.ts test/bench/maintenance.bench.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/bundle-verify.test.ts \
  && npm run check:spelling
```
Plus `npm run docs:json && git status --porcelain -- reports/api.json` (expect **empty**) and
`npx cspell --no-progress docs/spike/index-pass-base-cache-budget.md`.
Cache bypass: `npx tsc --noEmit -p tsconfig.typecheck.json`,
`npx cspell --no-progress <files>`.

### Commit

`feat(fetch-pack): bound base re-reads with one measured index-pass cache`
