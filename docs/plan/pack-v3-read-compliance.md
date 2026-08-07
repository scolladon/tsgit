# Plan — pack format v3 read compliance

> Source: design doc `docs/design/pack-v3-read-compliance.md` · ADRs 572, 573, 574, 575, 576, 577, 578, 579
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.

5 parts, sequential, one shared working tree. Each part is one atomic conventional commit.

| # | Part | src delta | test delta |
|---|---|---|---|
| 1 | Widen the ingest guard to pack version 2\|3 | `pack-entry.ts`, `pack-writer.ts` | `pack-entry.test.ts` (inversion + sweep), new `pack-entry.properties.test.ts`, `arbitraries.ts` |
| 2 | Local pack-open gate in `lookup` (header + `objectCount`) | `pack-registry.ts` | `pack-registry.test.ts` (Pin C matrix), `pack-fixture.ts`, `handle-ledger.ts`, `object-resolver.test.ts` (compile fix) |
| 3 | Scan-layer per-pack degradation + orphaned-`.idx` exclusion | `pack-registry.ts` | `pack-registry.test.ts` (Pin H6/H7 rows + **three** existing tests reworked) |
| 4 | Twin git/tsgit interop matrix (I-1 … I-14) | — | new `test/integration/pack-version-interop.test.ts` |
| 5 | Cross-adapter parity scenarios | — | 2 new `test/parity/scenarios/*.scenario.ts` + `index.ts` |

### How to read this plan

Every part block is self-contained: exact paths, current signatures, the code shape to
land, the fixtures to extend, the RED oracle per test, and the mutants each test must
kill. The design doc is the authority for *why* — read
`docs/design/pack-v3-read-compliance.md` (§Pinned matrices, §Requirements, §D1–§D9) and
ADRs 572–579 in `docs/adr/` before starting your part. **Never** copy an ADR number,
phase number or backlog id into source or test code — the commit is the join point.

### Planning-time corrections to the design (read before touching anything)

The design's test-strategy section was written before **ADR-579** was ratified, and two
of its statements are stale against the tree. Both are load-bearing.

1. **ADR-579 changes which layer drops an orphaned `.idx`, and that breaks three
   *existing* unit tests.** `scanPacks` will register a pack only when a sibling
   `<name>.pack` appears in the `readdir` listing. Three tests in
   `test/unit/application/primitives/pack-registry.test.ts` stub `ctx.fs.readdir` with
   **`.idx` entries only** — `:72-119` (unsafe pack names), `:121-169` (oversized `.idx`),
   `:220-262` (TOCTOU). Under ADR-579 every one of them is filtered out *before*
   `loadPack` runs, so `stat`/`read` are never called and their assertions collapse. Each
   must gain a sibling `.pack` `DirEntry` in its stubbed listing. The design lists only
   two inversions; **there are three tests to rework**, and the third (`:72-119`) is a
   *listing* fix, not an inversion — its `try`/`catch` and its `statsSeen` assertions must
   survive verbatim (Part 3).
   Consequently the design's **H5 unit row** ("`.idx` with no `.pack` … skip; one warn …
   kills the ENOENT-is-not-skippable mutant on `isSkippableIoFault`") no longer reaches
   the lookup probe at all. The `FILE_NOT_FOUND` operand of `isSkippablePackFault` needs a
   **different** arrangement — a `.pack` present in the listing whose `ctx.fs.readSlice`
   rejects `FILE_NOT_FOUND` (the concurrent-repack race ADR-579 explicitly preserves the
   arm for). That arrangement is specified in Part 2.
2. **`test/unit/domain/storage/arbitraries.ts` already exists** (4.5 KB:
   `arbObjectId` re-export, `buildTestIndex`, `buildDelta`). The design says the
   properties file "creates the directory's first one plus its `arbitraries.ts`" — wrong.
   Part 1 **extends** the existing file; it does not create it.

Path corrections against the design's shorthand: `fetch-pack.ts` lives at
`src/application/primitives/fetch-pack.ts` (**not** `commands/`), `bundle-verify.ts` at
`src/application/commands/bundle-verify.ts:46` (`export const bundleVerify`), and
`fetch-missing.ts` at `src/application/commands/fetch-missing.ts:57` (its unit test is
`test/unit/application/commands/fetch-missing.test.ts`).

### Surface gates — none owed

Verified at planning time against the tree:

- **`src/domain/storage/index.ts` uses explicit named re-exports**, not `export *`. Adding
  `export const GENERATED_PACK_VERSION` / `export const PACK_HEADER_SIZE` to
  `pack-entry.ts` therefore leaks **nothing** to the barrel. Do **not** add them to the
  barrel (design §D1, requirement 8).
- `grep -c 'GENERATED_PACK_VERSION\|SUPPORTED_PACK_VERSIONS\|PACK_HEADER_SIZE'
  reports/api.json` → **0** today and must stay 0. ADR-576 keeps `PackHeader.version` at
  `number`, so no public type moves. **No `npm run docs:json`, no `reports/api.json`
  commit is owed** — the prepush `check:doc-typedoc` gate is untouched.
- `pack-registry.ts` is re-exported from no barrel; `PackRegistry` / `RegisteredPack` /
  `PackOffsetTable` appear zero times in `reports/api.json`. Growing `RegisteredPack` with
  a `header` member is an internal change.
- No new error code (ADR-574 reuses `INVALID_PACK_HEADER`), so no `src/domain/error.ts`
  union edit, no exhaustiveness switch, no barrel-surface test.
- No new Tier-1 command: no `commands/index.ts` entry, no `repository.ts` binding, no
  `repository.test.ts` key list, no `docs/use/commands/*.md`, no README count.

Gates that **do** apply and where they are pre-paid:

- **`tooling/audit-write-surfaces.ts`** — `pack-writer.ts` keeps its header verbatim
  (`surface: packfile · kind: equivalent-under-readback · format: git-packfile-v2`).
  Requirement 6: generation stays version 2, byte for byte. Part 4's `@proves` block
  carries `interopSurface: packfile`, which is additive.
- **`check:test-pyramid`** (gating heuristics: `gwtTitle`, `aaaBody`, `sutNaming`,
  `bareClassToThrow`, `emptyAaaSection`, `underAssertedUnit`, `sutBindsResult`). Current
  shares: unit 80.7 % (target 80), integration 17.2 % (target 15, warn above 25). One new
  integration file and one new unit file keep every tier in band. `test/parity/scenarios/
  *.scenario.ts` is **not** matched by any tier glob (`test/parity/**/*.test.ts` only), so
  scenario files carry no GWT/AAA obligation. `createPackRegistry`, `createMemoryContext`,
  `buildSeededContext`, `withHandleLedger` are already in the `sutBindsResult` allowlist.
- **coverage** — `vitest.config.ts` scopes the 100 % thresholds to `src/domain`,
  `src/ports`, `src/adapters/{node,memory}`, `src/operators`. **`pack-entry.ts` is
  coverage-gated at 100 %** (Part 1 must leave no uncovered line/branch);
  `src/application/**` is not, but `mutation-budgets.json` bucket `application` breaks
  below 95.
- **knip (`check:dead-code`)** — both new `export`s have cross-file consumers in the same
  commit (`GENERATED_PACK_VERSION` → `pack-writer.ts`; `PACK_HEADER_SIZE` →
  `pack-registry.ts` in Part 2 and the unit tests). `SUPPORTED_PACK_VERSIONS` stays a
  module-private `const` — do not export it.
- **ls-lint / biome** — every new file is kebab-case under `src/**` or `test/**`, both
  already whitelisted in `biome.json` `files.includes`.

### Why Parts 2 and 3 both touch `pack-registry.ts`

`plan-lint` emits an advisory cognitive-locality warning when several parts declare the
same file. It is intentional here and the two parts are **not** mergeable — they implement
the two *different* layers git degrades at, and the whole change fails if they are
collapsed:

- **Part 2** is the **lookup** layer: a pack that stays in the generation (its `.idx` is
  fine, `all()` still lists it, `enumerateObjects` still reports its ids) but never serves
  a byte. git's `packs: 1` / `in-pack: 5` on Pin H rows H2–H4.
- **Part 3** is the **scan** layer: a pack that never enters the generation at all, so
  `all()` / `enumerateObjects` / `resolveOidPrefix` / `fsck --full` do not see it. git's
  `packs: 0` / `in-pack: 0` on H6, H7 — and, via ADR-579, H5.

Interop row I-14 fails the moment they are merged into one predicate at one site, which is
precisely why the design ships it. They also have disjoint blast radii: Part 2 changes only
`lookup` and `loadPack`'s member set (plus a compile fix in `object-resolver.test.ts`),
while Part 3 changes only `scanPacks` and reworks three pre-existing tests (two inversions
plus one listing fix). Merging them yields one part carrying 23 unit cases, two new
fixtures, two skip layers and three test reworks — past the size where one agent lands it
in a single spawn.

### Deliberately out of scope for every part

- `src/application/primitives/fetch-pack.ts:45` has its own `const PACK_HEADER_BYTES = 12`,
  a duplicate of the now-exported `PACK_HEADER_SIZE`. Consolidating it is behaviour-neutral
  and belongs to the refactor phase, **not** to any part here.
- SHA-256 pack support (`IDX_SHA_LENGTH = 20` is hard-coded in both `pack-index.ts:10` and
  `pack-writer.ts:63`), `.idx` v1, multi-pack-index, `fsck`-grade integrity reporting, a
  `verifyPack` surface, the pack-vs-index trailer-checksum comparison. All recorded in
  §Out of scope.
- Never branch on `ctx.hashConfig` inside the gate (Pin E, requirement 7). Hash width is
  load-bearing only in **fixtures**, where the trailer digest length must come from
  `ctx.hashConfig.digestLength`, never a literal 20.

### Shared facts every part needs

```ts
// src/domain/storage/error.ts — both factories already exist and are barrel-exported
export const invalidPackHeader = (reason: string): TsgitError => …  // { code: 'INVALID_PACK_HEADER', reason }
export const invalidPackIndex  = (reason: string): TsgitError => …  // { code: 'INVALID_PACK_INDEX',  reason }

// src/domain/error.ts — the union is exported as `TsgitErrorData` (:66); use that name,
// not `TsgitError['data']`. `TsgitError` is `class TsgitError extends Error` with
// `constructor(readonly data: TsgitErrorData)` (:83-89). Factories: fileNotFound(path)
// (:117), permissionDenied(path) (:130), unsupportedOperation(operation, reason) (:133).
| { readonly code: 'FILE_NOT_FOUND';        readonly path: string }
| { readonly code: 'PERMISSION_DENIED';     readonly path: string }
| { readonly code: 'UNSUPPORTED_OPERATION'; readonly operation: string; readonly reason: string }
// Verified: no member of the union declares `reason` as optional, so a
// `'reason' in data` narrowing yields `string`, never `string | undefined`.

// src/ports/logger.ts — sanitizeContext (:58-66) sanitises TOP-LEVEL string values only
// (`typeof value === 'string' ? sanitize(value) : value`). A nested object is forwarded
// as-is, and a readdir entry name is attacker-influenced (isSafePackName forbids
// / \ .. but NOT control bytes).
// => every warn context in this change is FLAT and string-valued. Never log `err.data`.

// src/application/primitives/internal/promise-memo.ts
createPromiseMemo<T>(factory).{ get, peek, clear }   // clears its slot on rejection
```

**Test-shape rules the gating heuristics enforce on every new `it`** (`test-pyramid-budgets.json`):
`Given …` / `When …` describes with an `it('Then …')`, `// Arrange` and `// Assert`
section comments both present and both non-empty, `sut` naming (never `subject` / `cut` /
`systemUnderTest`), and **no bare `toThrow(SomeErrorClass)`** — assert on `.data` via
try/catch, which the house mutation rules require anyway.

## Decision candidates

One, and only because ADR-579 postdates the design's test strategy and created a
scan-time filter that did not exist when requirement 11 was written. **Not decided here.**
Parts 3 and 5 are written to the recommendation and mark the exact spot, so a different
ratification is a one-line source change plus one test row.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-9** | **Does ADR-579's sibling-`.pack` filter emit a `ctx.logger?.warn?.`, or drop the orphaned `.idx` silently?** ADR-579 says `scanPacks` "registers a pack only when its sibling `<name>.pack` appears in the directory listing" and is silent on the logging channel. Requirement 11 binds every place the design declines to *fail*; but this arm has no error object to decline — it is a filter, like `isCandidate`. git's read path is silent on H5; only `count-objects -v` prints `warning: no corresponding .pack` (a reporting surface tsgit does not have) | **(a) Silent filter** — fold the sibling test into the candidate predicate; zero log surface, mirrors `isCandidate` and git's silence on read. **(b) One warn per generation** — `'packRegistry: skipping pack index with no pack file', { idx: entry.name }`; mirrors git's `count-objects` warning and gives the anomaly a diagnosable channel. **(c) Warn per lookup that would have hit it** — no mechanism exists at the scan layer to know that; would require re-introducing the lookup-layer arm ADR-579 narrowed | **(b)** | An orphaned `.idx` is a genuine repository anomaly (git calls it `garbage: 1`), unlike the name-shaped filtering `isCandidate` does — a file that was never a pack. Staying silent makes the one shape where tsgit *deliberately* hides objects undiagnosable, which is exactly what requirement 11 exists to prevent, and ADR-249 puts the logger channel outside the faithfulness boundary so (b) costs no faithfulness. It also gives the new `continue` a second independent oracle beyond `all().length`. (a) is defensible on the narrowest reading of ADR-579 and on "a filter is not a fault"; if ratified, delete the warn call in Part 3 and the warn assertion in its H5-scan row |

## Part 1 — Widen the ingest guard to pack version 2 or 3

### Context

**Decisions this part implements:** requirement 1 (accept 2 and 3 identically), requirement
2 (refuse every other version, `reason` names the observed version), requirement 6
(generation unchanged, byte for byte), requirement 8 (zero public-surface delta),
ADR-576 (`PackHeader.version` stays `number`, returned verbatim), ADR-578 (fixtures crafted
in-test). Design sections: §D1, §D4, §Test strategy → Unit `pack-entry.test.ts`.

**File — `src/domain/storage/pack-entry.ts`.** Current state, verbatim:

```ts
const PACK_MAGIC = 0x5041434b;
const PACK_HEADER_SIZE = 12;                                       // :55-56

export function parsePackHeader(bytes: Uint8Array): PackHeader {   // :58
  if (bytes.length < PACK_HEADER_SIZE) {
    throw invalidPackHeader('truncated: pack header requires 12 bytes');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0);
  if (magic !== PACK_MAGIC) {
    throw invalidPackHeader(
      `invalid magic: expected 0x5041434b, got 0x${magic.toString(16).padStart(8, '0')}`,
    );
  }
  const version = view.getUint32(4);
  if (version !== 2) {                                             // :70  ← widens
    throw invalidPackHeader(`unsupported version: expected 2, got ${version}`);   // :71 ← new wording
  }
  const objectCount = view.getUint32(8);
  return { version, objectCount };
}
```

Land exactly this shape:

```ts
const PACK_MAGIC = 0x5041434b;
/** git's `pack_version_ok` — v3 is reserved and format-identical to v2. */
const SUPPORTED_PACK_VERSIONS: ReadonlySet<number> = new Set([2, 3]);
/** git's `PACK_VERSION` — the only version tsgit ever emits. */
export const GENERATED_PACK_VERSION = 2;
export const PACK_HEADER_SIZE = 12;
```

and, inside `parsePackHeader`, replace only the version guard:

```ts
  const version = view.getUint32(4);
  if (!SUPPORTED_PACK_VERSIONS.has(version)) {
    throw invalidPackHeader(`unsupported version: expected 2 or 3, got ${version}`);
  }
```

Load-bearing details a reviewer will look for:

- **`ReadonlySet<number>`, not `readonly [2, 3]`.** A literal tuple's `.includes` argument
  narrows to `2 | 3` and rejects the `number` under test (TS2345). Design §D1 calls this
  out by name.
- **`SUPPORTED_PACK_VERSIONS` is NOT exported** (module-private; only `parsePackHeader`
  reads it). `GENERATED_PACK_VERSION` and `PACK_HEADER_SIZE` **are** exported but are
  **not** added to `src/domain/storage/index.ts` — that barrel is what typedoc walks into
  `reports/api.json`, and requirement 8 says the report stays byte-identical.
- **`version` is returned verbatim.** A v3 pack reports `version: 3`. Do **not** normalise
  3 → 2; ADR-576 is explicit that "treated identically" is the *absence* of a downstream
  branch, not a rewrite of the field. Verified: no production code reads
  `PackHeader.version` — `fetch-pack.ts` reads only `.objectCount` (`:309`, `:313`,
  `:319`). Do not add a branch on it.
- **Do not add the `objectCount` cross-check here.** ADR-577 places it in the registry,
  which holds the paired index; the domain parser is handed 12 bytes and stays
  context-free (Part 2 owns it).
- **Do not touch** the truncation guard, the magic guard, `serializePackHeader`
  (`:77-84`, whose `version: number` parameter stays wide — the test suite legitimately
  synthesises off-spec headers with it), or anything below `:86`.

**File — `src/domain/storage/pack-writer.ts`.** Current `:45`:

```ts
export function serializePackfile(entries: ReadonlyArray<PackWriterEntry>): PackfileResult {
  const header = serializePackHeader(2, entries.length);
```

becomes `serializePackHeader(GENERATED_PACK_VERSION, entries.length)`, importing it from
the existing `./pack-entry.js` import block (`:17-21`, which already pulls
`serializePackHeader`). **Zero byte change** to the emitted pack — this is a naming move
that makes the read-set / write-set asymmetry visible in three lines. The module's
`@writes` header block (`:1-12`, `format: git-packfile-v2`) stays **verbatim**.

**Tests — `test/unit/domain/storage/pack-entry.test.ts`.** The file already has
`makeHeaderBytes(magic, version, objectCount)` at `:16-23`; reuse it, do not re-declare.

- The malformed `it.each` table at `:48-79` currently carries three rows; its second row
  (`:54-58`) is
  `{ bytes: makeHeaderBytes(0x5041434b, 3, 1), reasonContains: 'version', label: 'an unsupported version (3)' }`.
  **Delete that row from the refusal table** (the other two rows — wrong magic, bytes too
  short — stay untouched) and re-home version 3 as an acceptance case.
- The exact-magic-reason test at `:83-110` is the precedent for the new exact-reason
  assertion; leave it alone.
- The round-trip test at `:112-125` stays.

**Tests — `test/unit/domain/storage/pack-writer.test.ts`.** Do not edit. It must pass
untouched — that is requirement 6's proof that `GENERATED_PACK_VERSION` changed no byte.

**Tests — `test/unit/domain/storage/arbitraries.ts`.** The file **exists**; append two
arbitraries beside `buildTestIndex` / `buildDelta` (`fc` is not imported there today — add
`import fc from 'fast-check';` at the top, matching `test/unit/domain/commit/arbitraries.ts`):

```ts
/** A pack-header version git accepts on read (`pack_version_ok`). */
export const arbSupportedPackVersion = (): fc.Arbitrary<number> => fc.constantFrom(2, 3);

/** Any uint32 outside the accepted set — the complement no finite table enumerates. */
export const arbUnsupportedPackVersion = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 0xffffffff }).filter((v) => v !== 2 && v !== 3);
```

**New file — `test/unit/domain/storage/pack-entry.properties.test.ts`** (the directory's
first properties sibling). Lens 1 (round-trip pair): `serializePackHeader` /
`parsePackHeader` is a genuine encode/decode pair. Budget per ADR-134…136: `numRuns: 200`
for the round-trip property, `numRuns: 50` for the filter-heavy negative property. Never
commit a seed. Same GWT/AAA/`sut` conventions as example tests; `Given` reads "Given an
arbitrary …". Style reference: `test/unit/application/primitives/shallow-file.properties.test.ts`.

### TDD steps

**RED 1 — version 3 is accepted, verbatim.**
In `pack-entry.test.ts`, add beside the existing "version 2 count 42" case
(`describe("Given bytes with magic 'PACK' version 3 count 7")` > `When parsing` >
`it('Then version=3 objectCount=7')`), asserting
`expect(result).toEqual({ version: 3, objectCount: 7 })`.
*Expected failure:* `TsgitError` thrown — `INVALID_PACK_HEADER { reason: 'unsupported version: expected 2, got 3' }`.

**RED 2 — the version sweep, both boundaries.**
`describe('Given pack header bytes stamped with an unsupported version')` > `When parsing`
> one `it.each` over `[0, 1, 4, 99, 0xffffffff]` (the row value interpolates in the **`it`**
title, not the describe) asserting the refusal via try/catch on
`err.data.code === 'INVALID_PACK_HEADER'`, and a second `it.each` over `[2, 3]` asserting
`{ version, objectCount }` round-trips. Rows **1** and **4** are the mutation-critical
ones: without them a `version < 2 || version > 3` boundary mutant survives a table that
only tests 2, 3 and 99.
*Expected failure:* the `[2, 3]` acceptance sweep fails on 3 (same error as RED 1); the
refusal sweep passes already (it is the pin that must survive the widening).

**RED 3 — exact refusal reason.**
`describe('Given pack header bytes stamped with version 99')` > `When parsing` >
`it('Then the reason names the accepted set and the observed version')` using try/catch +
a direct `.data` assertion (not `toThrow`), pinning
`{ code: 'INVALID_PACK_HEADER', reason: 'unsupported version: expected 2 or 3, got 99' }`.
Kills the `StringLiteral` mutant on the new message. Mirrors the exact-reason precedent at
`:104-107`.
*Expected failure:* reason is `'unsupported version: expected 2, got 99'`.

**RED 4 — properties.**
New file, two properties:
1. `fc.assert(fc.property(arbSupportedPackVersion(), fc.integer({min:0, max:0xffffffff}), (version, objectCount) => { … }), { numRuns: 200 })` —
   `parsePackHeader(serializePackHeader(version, objectCount))` deep-equals
   `{ version, objectCount }`. `sut = parsePackHeader`.
2. `fc.assert(fc.property(arbUnsupportedPackVersion(), fc.nat(), …), { numRuns: 50 })` —
   parsing a serialized off-set version throws with `data.code === 'INVALID_PACK_HEADER'`
   **and** `data.reason` containing `String(version)` (the second conjunct is what stops
   the property from passing against a guard that refuses everything).
*Expected failure:* property 1 shrinks to `version = 3`.

**GREEN.** Land the two constants, the widened guard and the new reason string; switch
`pack-writer.ts` to `GENERATED_PACK_VERSION`.

**REFACTOR.** Confirm the doc-comments read as *why* (`git's pack_version_ok` / `git's
PACK_VERSION`), that the two constants sit adjacent so the read-set / write-set asymmetry
is visible in three lines, and that `npm run test:coverage -- --project unit` keeps
`pack-entry.ts` at 100 % line/branch/function/statement.

### Gate

```
npx vitest run test/unit/domain/storage/pack-entry.test.ts test/unit/domain/storage/pack-entry.properties.test.ts test/unit/domain/storage/pack-writer.test.ts test/unit/application/primitives/fetch-pack.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/storage/pack-entry.ts src/domain/storage/pack-writer.ts test/unit/domain/storage/pack-entry.test.ts test/unit/domain/storage/pack-entry.properties.test.ts test/unit/domain/storage/arbitraries.ts
```

### Commit

```
feat(storage): accept pack header version 3 alongside version 2
```

## Part 2 — Gate local pack open on the 12-byte header

### Context

**Decisions this part implements:** ADR-572 (the gate sits in `lookup`, between the index
hit and the returned hit; `all()` stays ungated), ADR-573 (pack-scoped skip → log →
continue), ADR-574 (reuse `INVALID_PACK_HEADER { reason }` verbatim), ADR-577 (cross-check
the header's `objectCount` against the paired index), requirements 4, 5, 9, 11, 12, 14.
Design sections: §D2 (table), §D2.1, §D3, §D6, §D7, §D9.5, §D9.6, §D9.9,
§Test strategy → Unit `pack-registry.test.ts`.

**File — `src/application/primitives/pack-registry.ts`.** Current imports at `:5-17`
(abridged for orientation — the storage-barrel import is multi-line in the file, so do not
try to string-match this block):

```ts
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import { invalidPackIndex } from '../../domain/storage/error.js';
import { entryOffsets, lookupPackIndex, type PackIndex, parsePackIndex } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { createPromiseMemo } from './internal/promise-memo.js';
import { commonGitDir, packsDir } from './path-layout.js';
import { exceedsMaxPackIdxBytes, REASON_PACK_IDX_EXCEEDS_MAX } from './validators.js';
```

Widen `:7` to `import { invalidPackHeader, invalidPackIndex } from '../../domain/storage/error.js';`
and add a **deep import** (not via the barrel — the house precedent is `:7` itself):

```ts
import {
  PACK_HEADER_SIZE,
  type PackHeader,
  parsePackHeader,
} from '../../domain/storage/pack-entry.js';
```

**1 — the two discriminators.** Place them beside the existing `isUnsupportedOperation`
(`:24-30`), whose comment already states the house rule this inherits: recognise the
*expected* fault by code, let everything else surface, because `mapErrno` folds
unrecognised errnos (`EMFILE`, `EIO`, …) into `UNSUPPORTED_OPERATION { operation: 'filesystem' }`
and a transient `EMFILE` must never read as "this pack has no objects".

```ts
function isSkippableIoFault(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    (err.data.code === 'FILE_NOT_FOUND' || err.data.code === 'PERMISSION_DENIED')
  );
}

// The pack file itself is unusable: bad signature, short file, version outside
// 2|3, or a header/index object-count disagreement. Scoped to the lookup layer
// ONLY — INVALID_PACK_INDEX is deliberately absent, because nextOffsetForEntry
// and buildOffsetTable throw it for a MID-READ corruption, and folding those in
// would turn a detected corruption into a silent miss after the gate passed.
function isSkippablePackFault(err: unknown): boolean {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_HEADER') ||
    isSkippableIoFault(err)
  );
}
```

`isSkippableIdxFault` belongs to Part 3 — do not add it here. **Never union the two
predicates** (design §D9.9): `isSkippableIoFault` is the only shared helper they may have.

**2 — the flat warn context.** Both layers need one; land it here.

```ts
// Flat and string-valued on purpose: the Logger port sanitises TOP-LEVEL string
// values only, and a pack name comes from a readdir entry an attacker with repo
// write access controls. Nesting `err.data` would route it round the sanitiser.
const faultContext = (data: TsgitErrorData): Readonly<Record<string, string>> =>
  'reason' in data ? { code: data.code, reason: data.reason } : { code: data.code };
```

`TsgitErrorData` comes from the existing `'../../domain/error.js'` import at `:5` — widen
it to `import { TsgitError, type TsgitErrorData } from '../../domain/error.js';`. No
member of the union declares `reason` as optional, so `data.reason` narrows to `string`.
The two arms are covered by distinct tests (an `INVALID_PACK_HEADER` row and a
`FILE_NOT_FOUND` row), which is what kills the `ConditionalExpression` mutants.
`faultContext` is **not** a discriminator — §D9.9's "do not merge them" warning is about
`isSkippablePackFault` / `isSkippableIdxFault`, and does not apply here.

**3 — `RegisteredPack.header`.** Add to the interface (`:38-54`), after `idxPath` and
before `offsetTable`:

```ts
  /**
   * Memoised 12-byte header read + validation — git's `open_packed_git_1` gate.
   * Rejects with `INVALID_PACK_HEADER` for a bad signature, a short file, a
   * version outside 2|3, or a header/index `objectCount` disagreement. One read
   * per pack per successful validation; a rejection clears the memo, so a
   * refused pack is re-probed on the next lookup that hits its index.
   */
  readonly header: () => Promise<PackHeader>;
```

While in the interface, add the §D9.6 durability doc-comments (prose only, no ADR number):
on `offsetTable` and on `readSlice`, state that **callers must hold a `PackLookupHit` from
`lookup`** — the gate's completeness rests on every pack-byte read passing through
`lookup` first, and nothing structurally forces that to stay true.

**4 — the memo inside `loadPack`** (`:95-177`). `loadPack` already builds
`offsetTable` (`:115`) and `handleMemo` (`:123`) with `createPromiseMemo`; add a third,
after `const index = parsePackIndex(idxBytes);` and its `packPath` derivation
(`:98-100`), before `buildOffsetTable`:

```ts
  const headerMemo = createPromiseMemo(async (): Promise<PackHeader> => {
    const header = parsePackHeader(await ctx.fs.readSlice(packPath, 0, PACK_HEADER_SIZE));
    if (header.objectCount !== index.objectCount) {
      throw invalidPackHeader(
        `object count disagrees with index: pack ${header.objectCount}, index ${index.objectCount}`,
      );
    }
    return header;
  });
```

and extend the returned literal at `:176` to
`{ name, index, packPath, idxPath, header: headerMemo.get, offsetTable, readSlice, close }`.

Load-bearing details:

- **`ctx.fs.readSlice`, NOT the pack's own `readSlice`** (§D7). Routing the probe through
  `pack.readSlice` would open — and memoise — the persistent `FileHandle` as a side effect
  of a lookup, so a lookup that never reads an entry (`fetch-missing.ts:57` does exactly
  that) would leave a handle open until `dispose()`. It also avoids a recursive definition
  and keeps `header()` clear of the `retired` / `inFlight` / `close()` state machine.
  Requirement 9: this gate opens **no** disposable.
- **A short pack needs no extra code.** `ctx.fs.readSlice` returns fewer than 12 bytes for
  a truncated file (memory adapter: `stored.slice(offset, end)`), and `parsePackHeader`'s
  existing truncation guard fires. That reproduces Pin D's third row for free.
- **`INVALID_PACK_HEADER`, not `INVALID_PACK_INDEX`, for the count mismatch** (ADR-574 +
  ADR-577): the gate's refusals get one condition with one representation, and the
  disagreeing party this gate observes is the header — `index.objectCount` parsed clean.
  The reason names **both** counts so the log line is diagnosable without a second field.
- **Do not touch**: `readSlice` (`:131-160`) — including the multi-line `// NOTE:`
  equivalent-mutant proof inside its `finally` block (`:147-157`), which must survive
  **byte-for-byte**: do not reflow, re-wrap, re-indent or reword it, and do not move the
  `inFlight.delete(read)` statement it documents. Also untouched: `close` (`:162-174`),
  `bisectLeft`, `nextOffsetForEntry` and its line-anchored
  `// Stryker disable next-line ConditionalExpression,EqualityOperator:` directive at
  `:196`, which must remain the line immediately above its `if`. `readBoundedIdx`,
  `isSafePackName`, `isCandidate`, `scanPacks` (Part 3 owns it), `refresh`, `dispose`.

**5 — the gate in `lookup`.** Current body (`:274-283`):

```ts
    async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
      const packs = await allPacks();
      for (const pack of packs) {
        const offset = lookupPackIndex(pack.index, id);
        if (offset !== undefined) {
          return { pack, offset };
        }
      }
      return undefined;
    },
```

becomes:

```ts
    async lookup(id: ObjectId): Promise<PackLookupHit | undefined> {
      const packs = await allPacks();
      for (const pack of packs) {
        const offset = lookupPackIndex(pack.index, id);
        if (offset === undefined) continue;          // pack never opened (Pin C1)
        try {
          await pack.header();                       // git's is_pack_valid (Pin C2/C3/C4)
        } catch (err) {
          if (!isSkippablePackFault(err)) throw err;
          ctx.logger?.warn?.('packRegistry: skipping unusable pack', {
            pack: pack.name,
            ...faultContext((err as TsgitError).data),
          });
          continue;
        }
        return { pack, offset };
      }
      return undefined;
    },
```

Consequences to keep in mind while testing, each matching a pinned git row:

- **C1** — a pack whose index does not claim the oid is never opened: zero I/O, zero output.
- **C2** — a refused pack is skipped and the loop continues, so a sibling pack still serves.
- **C3/C4** — when no pack survives, `lookup` returns `undefined` and
  `object-resolver.ts:74-75` raises the ordinary `objectNotFound(id)`. *Missing*, not
  *corrupt* — exactly git.
- **C5** — the promise memo clears on rejection, so the next lookup hitting the same bad
  pack re-probes and re-warns. git keeps no negative cache either. This is the pinned
  semantics, not an optimisation gap.

**Compile fix the type-checker will demand.** `test/unit/application/primitives/object-resolver.test.ts`
builds **five** `RegisteredPack` object literals — `:94`, `:1154`, `:1206`, `:1267`,
`:1324` — each shaped
`{ name, index, packPath, idxPath, offsetTable, ...stubPackHandle(ctx, packPath) }`.
Every one needs a `header` member. These stubs implement their own `lookup` and never
invoke it, so a constant stub is honest:
`header: async () => ({ version: 2, objectCount: fillerIndex.objectCount }),`
(at `:1154` the local index variable may be named differently — read the surrounding
`const` and use whatever `PackIndex` that literal already assigns to `index`).

**Test fixtures to extend.**

`test/unit/application/primitives/pack-fixture.ts` — `buildSyntheticPack` / `writeSyntheticPack`
already write **both** `<base>.pack` and `<base>.idx` under
`${ctx.layout.gitDir}/objects/pack/pack-<name>`, and `writeSyntheticPack` returns the
entry ids. Append one exported helper (ADR-578: crafted in-test, digest length from the
context's hash config, never a literal 20):

```ts
export interface PackHeaderOverride {
  readonly magic?: number;
  readonly version?: number;
  readonly objectCount?: number;
}

/**
 * Rewrite a written pack's 12-byte header in place and re-stamp its trailer over
 * `bytes[0 .. len − digestLength)`, so the only thing wrong with the pack is what
 * the caller asked for.
 */
export async function restampPackHeader(
  ctx: Context,
  packPath: string,
  override: PackHeaderOverride,
): Promise<void> { … }
```

Implementation notes: `ctx.fs.read` on the memory adapter returns a copy
(`stored.slice()`), so mutating and writing back is safe. Use
`new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)` +
`setUint32(0|4|8, …)`, then
`bytes.set(hexToBytes(await ctx.hash.hashHex(bytes.subarray(0, bytes.length - ctx.hashConfig.digestLength))), bytes.length - ctx.hashConfig.digestLength)`,
then `ctx.fs.write(packPath, bytes)`. `hexToBytes` is already imported at `:14`.
For the short-pack row the test writes `bytes.subarray(0, 8)` directly — no helper needed.

`test/unit/application/primitives/handle-ledger.ts` — the ledger already counts
`openWithNoFollow`, `readdir`, `readSlice` and closes. `perCallReads()` cannot distinguish
a 12-byte header probe from an entry read, so add an accessor beside it:

```ts
export interface SliceCall {
  readonly path: string;
  readonly offset: number;
  readonly length: number;
}
// on HandleLedger:
/** Every ctx.fs.readSlice call, in order — lets a test separate the 12-byte
 *  header probe from an entry read on the same pack. */
readonly slices: () => ReadonlyArray<SliceCall>;
```

recorded inside the existing `readSlice` wrapper (`:126-129`). Tests count probes as
`ledger.slices().filter((s) => s.path === pack.packPath && s.offset === 0 && s.length === PACK_HEADER_SIZE)`,
importing `PACK_HEADER_SIZE` from `src/domain/storage/pack-entry.js` rather than writing
`12` (no magic values).

**Regression checks — verified at planning time, keep them true.** The two existing
`perCallReads()` assertions (`:734`, `:1459`) go through `all()` + `pack.readSlice`
directly and never call `lookup`, so the probe does not perturb them. The two existing
`lookup` call sites (`:64` missing pack dir → `undefined`; `:1089` eight concurrent
lookups over v2 synthetic packs) stay green because a synthetic pack's header is valid and
its `objectCount` matches its index.

**Warn injection.** `createMemoryContext()` wires no logger, so
`buildSeededContext()` yields `ctx.logger === undefined`. Precedent
(`read-sparse-checkout.test.ts:284`): `const warn = vi.fn(); const ctx: Context = { ...base, logger: { warn } };`
Compose with the ledger as `withHandleLedger({ ...seeded, logger: { warn } })` so both the
counters and the logger are on the same context. Assert with
`expect(warn).toHaveBeenCalledTimes(n)` plus a `warn.mock.calls[0]` destructure for the
message and the flat context — never `toHaveBeenCalledWith(expect.anything())`.

**Imports this part must add to `pack-registry.test.ts`.** The file already imports
`permissionDenied`, `type TsgitError` and `unsupportedOperation` from
`'../../../../src/domain/error.js'` (`:8-12`); add **`fileNotFound`** to that list. Also
add `readObject` from `'../../../../src/application/primitives/read-object.js'` (the
design's matrix asserts `OBJECT_NOT_FOUND` at the `readObject` level) and
`PACK_HEADER_SIZE` from `'../../../../src/domain/storage/pack-entry.js'` (so probe counting
uses the constant, not a literal `12`).

**Scan-order determinism (C2 row).** `scanPacks` iterates raw `ctx.fs.readdir` order
(`:212-218`). A C2 test that silently degrades into "the good pack answered first" passes
with the gate deleted. The fixture must (a) wrap `readdir` to return an explicitly ordered
array with the **bad** pack first, and (b) assert that observed order in the Arrange
section — never assume the adapter sorts.

**§D9.5 trap.** tsgit probes the delta cache, then loose, then packs
(`object-resolver.ts:60-75`); git probes packs first. A "laziness" test that requests a
**loose** object proves nothing about the gate — it never reaches the registry. The C1
arrangement must make the requested oid absent **everywhere**.

### TDD steps

All new `it`s go in `test/unit/application/primitives/pack-registry.test.ts`; `sut` is the
registry from `createPackRegistry(...)` (already in the `sutBindsResult` allowlist).

**RED 1 — a v3 pack reads normally.** One synthetic pack, `restampPackHeader(ctx, packPath, { version: 3 })`;
`sut.lookup(id)` returns a hit and `readObject(ctx, id)` returns the seeded content.
*Expected failure:* passes **before** the gate exists (nothing reads the header) — so land
it as a *pin*, and make its RED the compile error from `RegisteredPack.header` not
existing when the test also asserts `await hit.pack.header()` resolves to
`{ version: 3, objectCount: 1 }`.

**RED 2 — C1, laziness.** v99 pack only (`restampPackHeader(…, { version: 99 })`); request
an oid present in **neither** the pack index nor loose. Assert `sut.lookup(id)` resolves
`undefined`, **no** slice call on the `.pack` (`ledger.slices()` filtered by
`pack.packPath` is empty) and `warn` was never called.
*Expected failure (post-gate regression oracle):* fails if the gate is moved out of the
`offset === undefined` guard.

**RED 3 — C2, a sibling pack serves it.** Two packs indexing the **same oid**, the bad one
scanned first (order pinned *and* asserted). Make the two packs **distinguishable**, or
the test is not falsifiable: a v99 pack's entries are intact, so pre-gate the bad pack
answers with perfectly valid bytes and a content-equality assertion is green either way.
Use `BaseEntrySpec.idOverride` (`pack-fixture.ts:31-36`, which exists precisely to "plant a
packed object whose bytes don't hash to its indexed id"): the **bad** pack carries content
`B` indexed under `oid(A)`; the **good** pack carries content `A` under its real id. Then
assert `readObject(ctx, oidA)` returns `A` (`readObject` verifies the hash by default) and
exactly one warn naming the bad pack. Kills the `continue`-after-`catch` mutant — without
the `continue`, the loop returns the bad hit and the read fails.
*Expected failure:* pre-gate the bad pack answers first and `readObject` rejects with
`OBJECT_HASH_MISMATCH`; and `warn` was never called.

**RED 4 — C3/C4, nothing else serves it.** v99 pack only, oid present only there. Assert
`readObject` rejects with `.data` deep-equal `{ code: 'OBJECT_NOT_FOUND', id }` (assert on
`.data`, never `toThrow(Class)`), plus exactly one warn. Isolated-guard rule: RED 3 and
RED 4 must be separate `it`s — one test exercising both arms proves neither.

**RED 5 — C5, no negative cache.** v99 pack only, two `sut.lookup(id)` calls. Assert
**two** header probes in `ledger.slices()` and **two** warns.

**RED 6 — positive memoisation.** v2 pack, two lookups → exactly **one** header probe.
The contrast row that proves the memo holds on success.

**RED 7 — bad signature.** `restampPackHeader(…, { magic: 0x50414358 })` (`PACX`). Same
skip path; the warn's `reason` contains `'magic'`.

**RED 8 — short pack.** Overwrite the `.pack` with its first 8 bytes. Same skip path; the
warn's `reason` contains `'truncated'`.

**RED 9 — H3, the `objectCount` cross-check, its own `it`.** A **version-2** pack whose
header count is `index.objectCount + 1`, trailer re-stamped
(`restampPackHeader(…, { objectCount: n + 1 })`). Assert `OBJECT_NOT_FOUND` on `.data` and
a warn whose `reason` names **both** counts
(`'object count disagrees with index: pack 2, index 1'`). **Mandatory as its own test**
(ADR-577 + the isolated-guard rule): a row that also breaks the version would pass with
the comparison deleted, so its single `EqualityOperator` mutant would survive.

**RED 10 — H4, `.pack` unopenable.** Wrap `ctx.fs.readSlice` to reject
`permissionDenied(path)` for `path.endsWith('.pack')`. Assert skip → `OBJECT_NOT_FOUND` →
one warn. Isolates the `PERMISSION_DENIED` operand of `isSkippableIoFault`.

**RED 11 — the concurrent-repack race (`FILE_NOT_FOUND` operand).** The `.pack` is listed
in `readdir` (so ADR-579's Part-3 sibling check passes) but `ctx.fs.readSlice` rejects
`fileNotFound(path)` for it — the `.pack` unlinked between scan and probe. Assert skip →
`OBJECT_NOT_FOUND` → one warn. **This replaces the design's H5 unit row**, which ADR-579
moved to the scan layer; without this arrangement the `FILE_NOT_FOUND` operand of
`isSkippableIoFault` has no isolated killer at this layer.

**RED 12 — the negative half of the allow-list.** `ctx.fs.readSlice` on the `.pack`
rejects `unsupportedOperation('filesystem', 'EMFILE')`. Assert `sut.lookup(id)` **rejects**
with `.data` deep-equal `{ code: 'UNSUPPORTED_OPERATION', operation: 'filesystem', reason: 'EMFILE' }`
and that `warn` was never called. Without this row, widening `isSkippablePackFault` to a
blanket `catch` survives. `permissionDenied` / `unsupportedOperation` are already imported
in this test file (`:8-12`).

**RED 13 — handle ledger (requirement 9).** Reuse RED 3's two-pack arrangement so the run
both **skips** one pack and **serves** from another, then `await sut.dispose()` and assert
`ledger.opens() === 1` (only the served pack ever opened a handle — the probe owns no
disposable) **and** `ledger.outstanding() === 0`. A skip-only arrangement would report 0
outstanding trivially and prove nothing.

**GREEN.** Land the discriminators, `faultContext`, the header memo, the `RegisteredPack.header`
member + doc-comments, the `lookup` gate, the `handle-ledger` `slices()` accessor, the
`restampPackHeader` fixture, and the five `object-resolver.test.ts` stub literals.

**REFACTOR.** Re-read §D9.9: confirm `isSkippablePackFault` does **not** mention
`INVALID_PACK_INDEX`, and that `isSkippableIoFault` is the only thing it shares with
anything. Confirm no branch on `ctx.hashConfig` reached the gate. Confirm the `readSlice`
`finally` NOTE block and the `nextOffsetForEntry` Stryker directive are byte-identical to
`origin/main`.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/commands/fetch-missing.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/pack-fixture.ts test/unit/application/primitives/handle-ledger.ts test/unit/application/primitives/object-resolver.test.ts
```

### Commit

```
feat(pack-registry): gate local pack open on the 12-byte header
```

## Part 3 — Degrade per pack when an .idx is unreadable, unparseable or orphaned

### Context

**Decisions this part implements:** ADR-575 (full per-pack degradation: a `.idx` that
fails to read or parse skips **that pack** instead of rejecting the whole memoised scan),
ADR-579 (an orphaned `.idx` is excluded at scan time via the sibling-`.pack` check),
requirements 5, 11, 12, 13. Design sections: §D2 (layer table), §D2.2, §D3 (before/after
table + the six interactions), §D8 T-7, §D9.7, §D9.8, §D9.10,
§Test strategy → "The scan layer — new rows, and two inversions".

**Why this is a separate layer from Part 2, and why neither subsumes the other.** git
degrades per pack at *two* layers, and the layer decides pack-set membership (Pin H):
idx-layer faults (H5, H6, H7) drop the pack out of the *generation* — `packs: 0`,
`in-pack: 0`; pack-open-layer faults (H2, H3, H4) leave it **in** the generation with its
index intact — `packs: 1`, `in-pack: 5` — but it never serves a byte. `enumerateObjects`
(`enumerate-objects.ts:42-45`) and `resolveOidPrefix` read `registry.all()` without ever
calling `lookup`, so the two layers land on opposite sides of that boundary. Collapsing
them into one predicate is the bug this part exists to avoid.

**File — `src/application/primitives/pack-registry.ts`.** Current `scanPacks` (`:209-219`)
has **no** fault arm: one `loadPack` rejection rejects the whole memoised scan, so one bad
`.idx` fails **every** read through that `Context` — loose objects included.

Add the third discriminator beside the two from Part 2:

```ts
// Scan layer: the .idx cannot be turned into a PackIndex (H6, H7). Deliberately
// NOT unioned with isSkippablePackFault — INVALID_PACK_INDEX is skippable only
// here, where the parse happens; at the lookup layer it also means a mid-read
// corruption, which must never be laundered into "this pack has no objects".
function isSkippableIdxFault(err: unknown): boolean {
  return (
    (err instanceof TsgitError && err.data.code === 'INVALID_PACK_INDEX') ||
    isSkippableIoFault(err)
  );
}
```

and land `scanPacks` as:

```ts
  const scanPacks = async (): Promise<ReadonlyArray<RegisteredPack>> => {
    const dir = packsDir(commonGitDir(ctx));
    if (!(await ctx.fs.exists(dir))) return NO_PACKS;
    const entries = await ctx.fs.readdir(dir);
    // git registers a pack only when its .pack exists by name — an orphaned
    // .idx is `garbage`, never a pack. The listing already in hand is the same
    // data, so the check costs no I/O.
    const fileNames = new Set(
      entries.filter((entry) => entry.isFile).map((entry) => entry.name),
    );
    const packs: RegisteredPack[] = [];
    for (const entry of entries) {
      if (!isCandidate(entry)) continue;
      const name = entry.name.slice(0, -'.idx'.length);
      if (!fileNames.has(`${name}.pack`)) {
        // ---- DC-9 recommendation (b). If (a) is ratified, delete this warn ----
        ctx.logger?.warn?.('packRegistry: skipping pack index with no pack file', {
          idx: entry.name,
        });
        continue;
      }
      try {
        packs.push(await loadPack(ctx, dir, entry.name));
      } catch (err) {
        if (!isSkippableIdxFault(err)) throw err;
        ctx.logger?.warn?.('packRegistry: skipping unreadable pack index', {
          idx: entry.name,
          ...faultContext((err as TsgitError).data),
        });
      }
    }
    return packs;
  };
```

Four things this placement settles — state them to yourself before editing:

- **Everything `loadPack` does is idx work.** It reads the `.idx` under the existing bound
  (`readBoundedIdx`, `:80-93`), parses it, and derives paths; it never touches the
  `.pack`. So the whole body is inside the layer the `catch` is scoped to, and the catch
  cannot accidentally swallow a pack-file fault — there is none to swallow at that point.
- **The pre-allocation bound is untouched** (§D8 T-7). `readBoundedIdx`'s `stat` guard
  still runs *before* `ctx.fs.read`, and its post-read guard still runs before
  `parsePackIndex`. Only the **disposition** of their `INVALID_PACK_INDEX` changes. No
  guard is relaxed, no allocation widened, no extra byte parsed.
- **`FILE_NOT_FOUND` here is a real race, not tidiness.** `readdir` lists the `.idx`; a
  concurrent repack can unlink it before `stat`/`read`. Today that rejects the whole scan.
- **One warn per skipped idx per *generation*** — not per lookup. That is the honest,
  named divergence from git's per-consultation `error:` line, and it is a logging-channel
  difference only (§D3, §D9.7).

**Do not touch**, in this part: `lookup` (Part 2 owns it), `refresh`, `dispose`,
`allPacks`, `trackClose`, `drainPendingCloses`, `readBoundedIdx`, `loadPack`'s body
(the single exception is the one-line `packBaseName` extraction in the REFACTOR step),
`isSafePackName`, `isCandidate`, and both Stryker `disable next-line` directives in the
file (`:229` on `trackClose`, `:269` on `refresh`'s rejection arm, plus the
`nextOffsetForEntry` one) — they must stay the line immediately above the statement they
document.

**The scan memo now resolves where it used to reject** (§D9.8). A repo whose every `.idx`
is faulty produced a *rejecting*, self-clearing memo (each `all()` re-scanned and
re-threw); it now resolves to `[]` and is memoised for the generation — i.e. it looks
exactly like a repo with no packs, which is what git reports (`packs: 0`). A `.idx`
repaired mid-process is picked up by `refresh()`, the same contract every other cached
scan already has. Registry-scan failure is no longer a store-integrity signal; requirement
11's logger channel is the mitigation.

### Existing tests to rework — three, not two

All three live in `test/unit/application/primitives/pack-registry.test.ts` and stub
`ctx.fs.readdir` with **`.idx` entries only**. Under ADR-579 every one is filtered out
before `loadPack` runs. The file already has a `dirEntry(name)` helper at `:19-24` and a
`makeStat()` helper at `:26-40`.

1. **`:72-119` — "Given a readdir entry whose name contains a %s" (a LISTING fix, NOT an
   inversion).** Its `readdir` returns `[dirEntry(badName), dirEntry('pack-good.idx')]`.
   Add `dirEntry('pack-good.pack')` so the good entry still reaches `loadPack` and
   `statsSeen` is still populated. **Everything else survives verbatim**: the `try`/`catch`
   around `sut.all()`, both `statsSeen` assertions, the three-row `it.each` (each bad name
   carrying exactly one forbidden substring), and the explanatory comment at `:80-84`.
   Note what this test now *also* proves for free: its stubbed `read` throws a **plain
   `Error`**, which neither allow-list recognises, so it still propagates — free evidence
   that a non-`TsgitError` is not skippable, and the killer for the
   `err instanceof TsgitError` operand in both discriminators. Do **not** add a sibling
   `.pack` for the *bad* names — they must stay filtered by `isSafePackName`.

2. **`:121-169` — "an `.idx` whose stat reports > MAX_PACK_IDX_BYTES … throws
   INVALID_PACK_INDEX without issuing a read" (INVERSION).** Add a sibling
   `pack-bomb.pack` entry to the stubbed listing. New shape: `all()` **resolves**, the
   oversized pack is **absent** from the result, and exactly one warn carries
   `reason: REASON_PACK_IDX_EXCEEDS_MAX`. Rewrite the title accordingly
   (`Then the pack is skipped without issuing a read`).
   **`expect(reads).toEqual([])` must survive verbatim** — the whole point of that test is
   that the `stat` guard fires *before* a multi-GiB allocation, and ADR-575 does not change
   that. The exact-reason assertion survives too, **moved from the thrown error to the warn
   context**: without it the pre-read guard is indistinguishable from `parsePackIndex`
   rejecting bad magic. Keep the comment at `:124-126` (retargeted to the warn).
   `REASON_PACK_IDX_EXCEEDS_MAX` is already imported at `:7`.

3. **`:220-262` — TOCTOU (stat lies small, `read` returns oversized bytes) (INVERSION).**
   Add a sibling `pack-toctou.pack` entry. Same inversion: `all()` resolves without that
   pack, exactly one warn whose `reason` is **exactly** `REASON_PACK_IDX_EXCEEDS_MAX`.
   That exact-reason assertion is what distinguishes the post-read length guard from a
   downstream magic failure and kills the `ConditionalExpression -> false` /
   `BlockStatement -> {}` mutants the original comment at `:255-258` names — keep the
   comment, retargeted.

**Not affected, verified at planning time:** the gated-`readdir` tests at `:1131`, `:1196`
(`fail(0, permissionDenied(…))`), `:1231`, `:1271`, `:1299` all fail **`ctx.fs.readdir`
itself**, which is *outside* the new `try`, so those rejections still propagate unchanged.
Every test using `writeSyntheticPack` is safe because that fixture writes both `.pack` and
`.idx`.

### TDD steps

New `it`s in `test/unit/application/primitives/pack-registry.test.ts`; `sut` is the
registry. A "garbage `.idx`" fixture is written directly with
`ctx.fs.write(`${gitDir}/objects/pack/pack-<name>.idx`, bytes)` plus a sibling
`.pack` (any bytes) so the ADR-579 filter is not what is being measured — the exception is
the orphan row, which is exactly the absence of the sibling.
Use **full-length garbage** for the parse-fault shape (Pin I row 2): random-looking bytes of a
plausible idx length. It is the shape that survives a naive length check and forces the
parser arm. `parsePackIndex` will reject it on the v2 magic.

**RED 1 — H6, corrupt `.idx` with a good sibling pack.** A garbage `.idx` (+ its sibling
`.pack`) and one real `writeSyntheticPack` holding the requested oid. Assert `readObject`
**returns the object**, `sut.all()` lists **only** the good pack (length 1, `name`
matching), and exactly one warn naming the skipped idx.
*Expected failure:* `all()` rejects with `INVALID_PACK_INDEX`, so `readObject` throws.

**RED 2 — H6, corrupt `.idx`, the rest of the store still usable.** Garbage `.idx` +
sibling `.pack`; one object seeded **loose** via `buildSeededContext({ objects: [...] })`.
Assert `enumerateObjects(ctx)` resolves and contains the loose oid.

**Do not write this row as `readObject(looseOid)`** — it would be green before the fix and
prove nothing. §D9.5's probe-order trap applies to the scan layer too, harder:
`resolveObjectBytes` (`object-resolver.ts:60-72`) checks the delta cache, then `tryLoose`,
and **returns before ever calling `registry.lookup`** — so a loose read in a repo with a
corrupt `.idx` never touches the scan and succeeds today. The surfaces that *do* consult
`registry.all()` are `enumerateObjects` (`enumerate-objects.ts:42-45`), `resolveOidPrefix`
and `fsck`; use one of them. `enumerateObjects` is the cheapest and its result names the
loose oid directly, which is what "the store is still readable" means here.
*Expected failure:* `enumerateObjects` rejects with `INVALID_PACK_INDEX` out of the
memoised scan.

**RED 3 — H6, corrupt `.idx` and nothing else.** Assert `readObject` rejects with `.data`
deep-equal `{ code: 'OBJECT_NOT_FOUND', id }` and `await sut.all()` deep-equals `[]`.

**RED 4 — H7, unreadable `.idx`.** Wrap `ctx.fs.read` to reject `permissionDenied(path)`
for `path.endsWith('.idx')`. Same skip; one warn with `code: 'PERMISSION_DENIED'`.
Isolates that operand of `isSkippableIoFault` at *this* layer.

**RED 5 — the `.idx` vanishes after `readdir`.** `readdir` lists it (with its sibling
`.pack`), `ctx.fs.stat` rejects `fileNotFound(path)` for the `.idx`. Same skip; one warn
with `code: 'FILE_NOT_FOUND'`. The concurrent-repack race.

**RED 6 — every `.idx` faulty.** Two garbage idx files, each with a sibling `.pack`.
Assert `await sut.all()` deep-equals `[]`, **two** warns, and that `all()` **does not
throw** — the §D9.8 shape change.

**RED 7 — unrecognised scan fault propagates.** `ctx.fs.read` on the `.idx` rejects
`unsupportedOperation('filesystem', 'EMFILE')`. Assert `sut.all()` **rejects** with `.data`
deep-equal to that error's data and that `warn` was never called. The `EMFILE` guardrail;
without it, replacing `isSkippableIdxFault` with a blanket `catch` survives.

**RED 8 — warn cardinality contrasts the two layers.** One garbage `.idx` (+ sibling) and
**three** `sut.lookup(...)` calls. Assert exactly **one** warn — the scan memo holds — in
deliberate contrast with Part 2's C5 row, where the lookup layer re-warns per hit.

**RED 9 — H5, the orphaned `.idx` (ADR-579).** Arrange **two** packs via
`writeSyntheticPack`, then `ctx.fs.rm(orphanPackPath)` so one `.idx` is left orphaned.
Assert, in one `it`:
(i) `sut.all()` has length **1** and its `name` is the surviving pack — the orphan is out
of the *generation*, matching git's `packs: 0` / `garbage: 1`;
(ii) `readObject(ctx, orphanOid)` rejects with `.data` deep-equal `{ code: 'OBJECT_NOT_FOUND', id }`;
(iii) `readObject(ctx, survivorOid)` returns its content — the filter drops exactly one
entry, not the directory;
(iv) under **DC-9(b)**, exactly one warn `'packRegistry: skipping pack index with no pack file'`
carrying `{ idx: '<orphan>.idx' }`. **If DC-9 lands on (a), drop only assertion (iv).**
The two-pack arrangement is what makes (i) falsifiable: with a single orphan, `all()` is
`[]` both before and after — the pre-fix scan rejects and a `[]` assertion would never be
reached, while a `MethodExpression` mutant dropping the whole filter loop would also
produce `[]`.

**RED 10 — the sibling check requires a FILE, not a directory.** Stub `readdir` to return
a **directory** entry named `pack-x.pack` alongside a valid-looking `pack-x.idx`. Assert
the pack is still excluded from `all()`. This kills the `MethodExpression` mutant that
drops `.filter((entry) => entry.isFile)` from the `fileNames` construction — the only
mutant on that clause that no other row reaches, because every other row's sibling is a
real file.

**GREEN.** Land `isSkippableIdxFault`, the sibling-`.pack` filter and the `try`/`catch`
inside `scanPacks`; rework the three existing tests.

**REFACTOR.** Two things, then stop.

1. `scanPacks` now derives `entry.name.slice(0, -'.idx'.length)` and so does `loadPack`
   (`:99`). Extract one module-level `const packBaseName = (idxEntryName: string): string =>
   idxEntryName.slice(0, -'.idx'.length);` and call it from both — a single source for the
   `.idx` → base-name rule, which is what the sibling check and the pack path both depend
   on. Keep `loadPack`'s remaining body untouched.
2. Re-read §D9.9: `isSkippableIdxFault` and `isSkippablePackFault` must still differ by
   exactly one code each, sharing only `isSkippableIoFault`. Confirm the happy path of
   `scanPacks` is the old statements plus one `Set` construction, one membership test and
   one `try` — §D7 says the scan layer costs nothing, and V8 does not penalise a `try`
   block nothing throws through.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/commands/fsck.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts test/unit/application/primitives/pack-registry.test.ts
```

### Commit

```
feat(pack-registry): degrade per pack when an idx is unreadable or orphaned
```

## Part 4 — Twin git/tsgit interop matrix for pack version and degradation

### Context

**What this part pins:** requirements 3, 3a, 4, 5, 13, 14 — the faithfulness authority for
everything Parts 1–3 landed. Per ADR-226 the interop harness is the **only** faithfulness
authority; parity (Part 5) proves adapter agreement, not faithfulness. Design section:
§Test strategy → "Integration / interop", rows I-1 … I-14, plus §D6's two condition tables.

It is one part rather than folded into Parts 1–3 because the 14 rows span all three
behaviours and share one `beforeAll` base repo; splitting one new file across three agents
would rebuild that setup three times.

**New file — `test/integration/pack-version-interop.test.ts`.**

`@proves` header block (the audit parses it; `integrationProof` is non-gating today but
must still be correct — `surfaceRegex` is `^[a-z][a-zA-Z0-9.-]{1,40}$`, `unique` is 12–200
chars, and bucket `cross-tool-interop` requires the file to live at `test/integration/`
root, which it does):

```
 * @proves
 *   surface:        pack.readVersion
 *   bucket:         cross-tool-interop
 *   unique:         pack header version 2|3 accept-set and per-pack degradation match canonical git
 *   interopSurface: packfile
```

**Isolation discipline — non-negotiable.** Every `git` invocation goes through the helpers
in `./interop-helpers.js`, which scrub **all** `GIT_*` from the child env (a hook-invoked
`validate` exports `GIT_DIR`, and `-C <path>` does **not** override it), point `HOME` at a
deterministic non-existent path, and set `GIT_CONFIG_NOSYSTEM=1`. Never call
`execFileSync('git', …)` with the ambient env. Signing is off by construction (isolated
`HOME`); pass `-c commit.gpgsign=false` anyway on the seed commit.

Helpers available (verified signatures):

```ts
GIT_AVAILABLE: boolean
runGit(args: ReadonlyArray<string>, opts?): string
runGitEnv(): NodeJS.ProcessEnv
git(dir, ...args): string                    // = runGit(['-C', dir, ...args])
gitAsync(dir, ...args): Promise<string>      // use for anything that could block the loop
tryRunGitWithExit(args, opts?): { stdout, stderr, exitCode }   // for the refusal rows
tryRunGit(args, opts?): { ok, stdout, stderr }
makePeerPair(slug): Promise<{ peer, ours, dispose }>
initBothRepos(peer, ours, branch?): void
```

tsgit side (precedent: `test/integration/large-object-pack-interop.test.ts`,
`test/integration/fsck-interop.test.ts`):

```ts
import { createNodeContext } from '../../src/adapters/node/node-adapter.js';
import { bundleVerify } from '../../src/application/commands/bundle-verify.js';
import { enumerateObjects } from '../../src/application/primitives/enumerate-objects.js';
import { walkPackEntries } from '../../src/application/primitives/fetch-pack.js';
// getPackRegistry and readObject come from ONE module — biome merges split imports
import { getPackRegistry, readObject } from '../../src/application/primitives/read-object.js';
const sut = createNodeContext({ workDir: dir });     // already in the sutBindsResult allowlist
```

`getPackRegistry(ctx)` returns the **same** registry `readObject` uses, so `all()`
assertions and read assertions observe one generation.

**Shape: one shared `beforeAll`, 60 s budget** (heavy git-spawning interop tests time out
hook-default budgets under `validate`'s concurrency). Structure:

```ts
describe.skipIf(!GIT_AVAILABLE)('pack version + per-pack degradation interop', () => {
  beforeAll(async () => { … }, 60_000);
  afterAll(async () => { … });
```

`beforeAll` builds the *one* baseline and keeps its bytes in memory:

1. `mkdtemp` a base dir; `runGit(['init','-q','-b','main', base])`; set `user.name` /
   `user.email` (or reuse `initBothRepos`).
2. Write 5 small files; `git(base,'add','-A')`;
   `git(base,'-c','commit.gpgsign=false','commit','-m','seed')`.
3. `git(base,'repack','-adq')` — the pack git actually produces.
4. `readdir` `${base}/.git/objects/pack`, read the single `pack-<sha>.pack` and its `.idx`
   into `Buffer`s. Record `objectCount` from the header (`readUInt32BE(8)`).
5. Record a **packed** oid: `git(base,'rev-parse','HEAD:<file1>')`.
6. Record a **loose-only** oid written *after* the repack:
   `git(base,'hash-object','-w','--stdin')` with fresh content, and keep its loose path so
   cases can copy it in.

Then a per-case factory that `mkdtemp`s a fresh repo, `git init -q`s it, and drops in
exactly the artefacts that row needs. Fresh repos are cheap; the expensive part (commit +
repack) happens once.

**The crafting recipe every v99 / mutation row depends on** (design §Test strategy;
digest length is `20` for SHA-1 here because `IDX_SHA_LENGTH` makes the whole pack
subsystem SHA-1-only — read it from a named local constant, not an inline literal):

```
buf.writeUInt32BE(version, 4);                                            // pack header, u32 BE @4
sha1(buf.subarray(0, len - digestLength)).copy(buf, len - digestLength);  // re-fix the pack trailer
// only when a matching .idx is needed WITHOUT running index-pack (the v99 cases):
packTrailer.copy(idx, idx.length - 2 * digestLength);                     // idx's recorded pack checksum
sha1(idx.subarray(0, idx.length - digestLength)).copy(idx, idx.length - digestLength);
```

For the **v3** rows the `.idx` is produced by `git index-pack -o <abs>.idx <abs>.pack` run
with `-C <dir>` — which sidesteps the re-stamp *and doubles as the I-1 ingest assertion*.
The idx re-stamp is required only for v99, where git refuses to build one; Pin D proves it
is not strictly needed for the version assertion (the version check precedes the checksum
check), but it is needed for the test to prove the version is the **only** thing wrong.

**The bundle row (I-7) uses a shifted origin.** A bundle is `<header text>\n\n<packfile>`,
so the pack does **not** start at offset 0. Locate `start` = the index of the `PACK`
signature (`0x50 0x41 0x43 0x4b`) in the bundle bytes, then
`buf.writeUInt32BE(3, start + 4)` and re-hash the trailer over
`buf.subarray(start, len - digestLength)` — Pin G's exact recipe. Using the plain-pack
recipe (origin 0) here produces a trailer over the header text too and the bundle fails
for the wrong reason.

Corrupt-`.idx` fixtures: overwrite the idx with random bytes of the **same length**
(Pin I row 2 — the shape that survives a naive length check and forces the parser arm), and
truncate a real idx to 8 bytes for the short arm. Neither needs the pack-checksum
re-stamp; the idx never gets far enough to be compared. For I-12 the `.pack` is simply
deleted after the repack, leaving git's own `.idx` untouched — that fixture carries no
manipulation at all.

**Per ADR-249, assert conditions, not transcripts.** git's `error: packfile … is version
99 …` is presentation tsgit never emits; assert git's **exit code** and **which objects
resolve**, and where a message is asserted at all, assert it on the *git* side only.

### TDD steps

Each row is its own `it` under a `Given …` / `When …` describe pair; `sut` is the tsgit
`Context` (or the registry, per row). Every row asserts **both** columns — git's observable
outcome and tsgit's structured outcome — so a divergence in either direction fails.

*Expected failure before Parts 1–3 exist:* I-1/I-7/I-8 fail on the widened accept-set
(`INVALID_PACK_HEADER: expected 2, got 3`); I-4/I-5/I-6/I-13 fail because tsgit parses a
v99 pack as v2; I-9…I-12/I-14 fail because one bad or orphaned `.idx` rejects the whole
scan. This part lands *after* them, so it is written as the pin — run it once with
`git stash` of `src/` if you want to see red, then restore.

| # | `it` | git column | tsgit column |
|---|---|---|---|
| I-1 | ingest v3 | `index-pack -o out.idx v3.pack` exit 0 | `walkPackEntries(ctx, v3Bytes)` resolves with `length === objectCount` |
| I-2 | ingest v99 | `tryRunGitWithExit` → exit 128, stderr contains `pack version 99 unsupported` | `walkPackEntries` rejects `.data` = `{ code: 'INVALID_PACK_HEADER', reason: 'unsupported version: expected 2 or 3, got 99' }` |
| I-3 | local read v3 | `git cat-file -p <oid>` returns the payload, exit 0 | `readObject` returns byte-identical content |
| I-4 | local read v99, object nowhere else | `cat-file --batch-check` → `<oid> missing`, exit **0** | `readObject` rejects `.data` = `{ code: 'OBJECT_NOT_FOUND', id }` |
| I-5 | v99 **+ good pack**, object in both | `cat-file -p` returns the payload, exit 0 | `readObject` returns byte-identical content |
| I-6 | v99 present, object in a **second good pack**, absent from the bad pack's index | `cat-file -p` succeeds with **empty stderr** (Pin C1) | `readObject` succeeds |
| I-7 | bundle carrying a v3 pack | `git bundle verify` → stdout contains `is okay`, exit 0 | `bundleVerify(ctx, { path })` resolves; `prerequisitesPresent === true` |
| I-8 | **one accept-set (requirement 3a)** — see the note below | `git cat-file -p <oid>` reads the same oid out of the same repo, exit 0 | **one** `Uint8Array` of v3 pack bytes drives **both** surfaces inside a single `it`: `walkPackEntries(ctx, bytes)` accepts it, and `readObject` reads an oid out of a repo holding those exact bytes |
| I-9 | corrupt `.idx`, object nowhere else (H6) | `--batch-check` → `missing`, exit 0; `count-objects -v` → `packs: 0`, `in-pack: 0` | `readObject` → `OBJECT_NOT_FOUND`; `getPackRegistry(ctx).all()` is `[]` |
| I-10 | corrupt `.idx` + loose object (H6) | `cat-file -p <loose>` → payload, exit **0** | `readObject` returns byte-identical content **and** `enumerateObjects(ctx)` resolves containing that oid — see the note below |
| I-11 | corrupt `.idx` + good sibling pack (H6) | `cat-file -p <oid in sibling>` → payload, exit 0 | content identical; `all()` has length **1** |
| I-12 | orphaned `.idx`, `.pack` deleted (H5) | `--batch-check` → `missing`, exit 0; `count-objects -v` → `packs: 0`, `garbage: 1` | `readObject` → `OBJECT_NOT_FOUND`; **`all()` is `[]`** (ADR-579 ratified DC-8 option (c), so the enumeration half **is** asserted); a loose object in the same repo still reads |
| I-13 | pack/idx `objectCount` disagreement (H3) | `--batch-check` → `missing`, exit 0; `count-objects -v` → `packs: 1`, `in-pack: <M>` | `readObject` → `OBJECT_NOT_FOUND`; `all()` **still lists** the pack (length 1) |
| I-14 | **enumeration parity across the two layers** | `count-objects -v` on the v99 repo (`packs: 1`) vs the corrupt-idx repo (`packs: 0`, `in-pack: 0`) | `all().length` reproduces both — 1 and 0 |

**Why I-10 carries a second tsgit assertion.** A tsgit loose read short-circuits in
`resolveObjectBytes` **before** `registry.lookup` (`object-resolver.ts:60-72`), so
`readObject(looseOid)` succeeds whether or not the scan degrades — it is a correct *parity*
row against git's column, but on its own it is not falsifiable on the tsgit side. Adding
`enumerateObjects`, which reads `registry.all()`, gives the row a tsgit-side oracle. The
same caveat applies to any future "loose still works" row: state the surface that touches
the registry, or the row proves nothing.

**Why I-8 is shaped that way, and not as a fetch.** Requirement 3a is *"the version set
honoured at ingest and the version set honoured at local open are the same set"*. A
literal round trip would need a transport (`fetchPack` is the only surface that persists a
downloaded pack, via `materializePack`), and spawning git against an in-process HTTP
server from a **sync** helper deadlocks — the known trap. It is also unnecessary: that
`materializePack` writes `download.packBytes` **verbatim** to
`pack-<sha>.pack` (`fetch-pack.ts:158-175`) is a *code* fact the design already
establishes, not something a test must re-derive. What no code fact establishes is that
the two `parsePackHeader` call sites agree — and driving **the same byte array** through
`walkPackEntries` (ingest) and through a repo `readObject` (local open) inside one `it` is
exactly that assertion. Do not split it into two `it`s; the shared byte array *is* the
proof.

I-4 and I-5 are the pair that makes ADR-573 falsifiable (propagation would fail I-5).
I-13 and I-14 are the pair that makes the **layer placement** falsifiable: move the idx arm
to `lookup` and I-9's `all()` assertion fails; move the header arm to `scanPacks` and
I-13's does. Neither pair may be merged into one `it`.

**REFACTOR.** Keep every `git` call through the scrubbed helpers; keep the crafting
functions (`restampPackVersion`, `restampIdxForPack`, `corruptIdxSameLength`,
`setHeaderObjectCount`) file-local, small, and named for *what they craft*. Confirm the
whole suite fits the 60 s `beforeAll` budget and that `afterAll` removes every `mkdtemp`
directory.

### Gate

```
npx vitest run test/integration/pack-version-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/integration/pack-version-interop.test.ts
```

### Commit

```
test(interop): pin pack version accept-set and per-pack degradation against git
```

## Part 5 — Cross-adapter parity scenarios

### Context

**What this part proves, and what it does not.** Per ADR-226 parity is **cross-adapter
agreement only** — never faithfulness (Part 4 owns that). Two scenarios earn their place
for two different reasons (design §Test strategy → Parity):

1. The header probe is the registry's first use of `ctx.fs.readSlice` **on this path**, and
   it must behave identically on node, memory and browser (OPFS).
2. Both discriminators key on `FILE_NOT_FOUND` / `PERMISSION_DENIED` / `INVALID_PACK_INDEX`
   — **port-level** codes each adapter produces independently (node via `mapErrno`, memory
   via an explicit `fileNotFound` throw at `memory-file-system.ts:75`, browser via
   `resolveFileHandle`). If one adapter surfaced a raw `Error` or a different code, the
   skip would silently become a hard failure there and nowhere else. That is exactly the
   class of bug the parity tier exists for.

**Mechanics.** `test/parity/scenarios/*.scenario.ts` files export a
`Scenario<TResult>` (`./types.ts`):

```ts
export interface Scenario<TResult> {
  readonly name: string;
  readonly inputs: ScenarioInputs;          // { files, author, message } from '../fixtures.ts'
  readonly expected: TResult;               // the golden — same for every adapter
  readonly run: (repo: Repository, inputs: ScenarioInputs) => Promise<TResult>;
  readonly unsupportedRuntimes?: readonly string[];
}
```

Every scenario must be registered **twice** in `test/parity/scenarios/index.ts`: an
`import` line (alphabetical among the others) and an entry in the `SCENARIOS` array. The
three drivers consume it automatically — `test/parity/node.test.ts`,
`test/parity/memory.test.ts`, and `test/browser/parity.spec.ts` (which looks scenarios up
**by name** through `test/browser/parity-scenarios.bundle.ts` and has a guard test
asserting the browser registry exposes *exactly* the `SCENARIOS` list; forgetting the
`index.ts` entry fails that guard).

Scenario files are **not** matched by any `test-pyramid` tier glob (`test/parity/**/*.test.ts`
only), so they carry no GWT / AAA / `sut` obligation — but they must still be small,
`readonly`, and project to **deterministic** fields only. House convention: counts,
booleans and decoded strings; **never an oid** in the golden.

Raw filesystem access inside a scenario is available and precedented
(`bundle.scenario.ts:47-52`): `repo.ctx.fs.write(...)`, `repo.ctx.layout.gitDir`,
`repo.ctx.layout.workDir`, `repo.ctx.hash.hashHex(...)`, `repo.ctx.hashConfig.digestLength`,
`repo.ctx.compressor.deflate(...)`, `repo.ctx.fs.rm(...)`.

**Scenario A — new file `test/parity/scenarios/pack-v3-read.scenario.ts`.**
`buildPack` (`src/application/primitives/build-pack.ts`) returns `{ bytes, sha, objectCount }`
with **no idx**, so the scenario assembles both from the domain writers directly:

```ts
import { hexToBytes } from '../../../src/domain/objects/encoding.ts';
import type { ObjectId } from '../../../src/domain/objects/index.ts';
import { PACK_HEADER_SIZE } from '../../../src/domain/storage/pack-entry.ts';
import { computeLooseObjectPath } from '../../../src/domain/storage/loose-path.ts';
import {
  PACK_ENTRY_TYPE,
  serializePackfile,
  serializePackIndex,
} from '../../../src/domain/storage/index.ts';
```

(Scenario files use `.ts` specifiers for `src` imports — see `fsck.scenario.ts:12`. Runtime
imports from `src` are fine: the browser driver bundles these files through
`test/browser/parity-scenarios.bundle.ts`, and every symbol above is pure and
platform-free.)

`run()` recipe — **the step order is load-bearing**: stamp the version *before* computing
the trailer, and compute the idx's recorded pack-checksum *from that same trailer*, so the
fixture's only anomaly is the version:

1. `await repo.init()`; `await repo.add(...)`; `await repo.commit(...)` — the seed, so the
   repo is a real repo on every adapter.
2. `const id = await repo.primitives.writeObject({ type: 'blob', id: '' as ObjectId, content })`
   (`writeObject` returns the `ObjectId`; `id: '' as ObjectId` means "compute it" — the
   documented contract mirrored by `fsck.scenario.ts` and `write-pipeline.scenario.ts`).
3. `const { data, entries } = serializePackfile([{ type: PACK_ENTRY_TYPE.BLOB, uncompressedSize: content.length, compressedData: await repo.ctx.compressor.deflate(content) }])`.
   `data` is header + entries, **without** a trailer; `entries[0]` carries `{ crc32, offset }`.
4. **Stamp version 3 first:** `new DataView(data.buffer, data.byteOffset, data.byteLength).setUint32(4, 3)`.
5. `const trailer = await repo.ctx.hash.hash(data)`; `packBytes = data ++ trailer`. No
   re-hash step is needed because the version was already stamped, and
   `trailer.length === repo.ctx.hashConfig.digestLength` by construction — never a literal 20.
6. `const idxBody = serializePackIndex([{ id, crc32: entries[0].crc32, offset: entries[0].offset }], trailer)`,
   then `idxBytes = idxBody ++ hexToBytes(await repo.ctx.hash.hashHex(idxBody))` — the
   writer emits only the pack-checksum half of the 40-byte trailer, exactly as
   `test/unit/application/primitives/pack-fixture.ts:140-145` documents.
7. Write both to `${repo.ctx.layout.gitDir}/objects/pack/pack-parity-v3.{pack,idx}`.
8. `await repo.ctx.fs.rm(`${repo.ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`)`
   — otherwise the loose probe answers first (`object-resolver.ts:60-75`), the pack is
   never consulted, and the scenario would pass with the gate deleted. This step is the
   scenario's whole point; do not skip it.
9. Probe the header through the port under test:
   `const head = await repo.ctx.fs.readSlice(packPath, 0, PACK_HEADER_SIZE);` then
   `new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(4)`.
   This is the *reason* the scenario exists — a 12-byte `readSlice` at offset 0 must return
   the same bytes on node, memory and OPFS.
10. `const blob = await repo.primitives.readBlob(id)` — `readBlob` reaches the registry
    through `blob-source.ts`'s `registry.lookup`, so it passes the same gate `readObject`
    does, and it hands back `{ content }` without a union narrow.

Golden: `{ probedVersion: 3, readBackContent: 'packed via v3\n' }`. No oid, no byte count,
no path — nothing that can differ between adapters for a reason unrelated to this change.

**Scenario B — new file `test/parity/scenarios/pack-degraded-idx.scenario.ts`.** No pack
assembly needed; it exercises the *scan* layer.

1. `await repo.init()`; `add`; `commit` — the seed commit and its tree/blob are the loose
   objects that must keep reading.
2. Write a **corrupt** `.idx` of plausible length plus a sibling `.pack` (any bytes) —
   `parsePackIndex` rejects it on the v2 magic → `INVALID_PACK_INDEX` on every adapter,
   which is the scan-layer skip.
3. Write an **orphaned** `.idx` (no sibling `.pack`) under a second name — the ADR-579
   scan-time exclusion.
4. `const object = await repo.primitives.readObject(commitId)` — the seed commit still
   reads. This is the row that pins "one bad idx no longer fails every read".
5. `const result = await repo.fsck()` — `fsck` walks `enumerateObjects`, which reads
   `registry.all()`. If either bad pack had survived the scan, its (nonexistent) object ids
   would surface as findings; if the *scan* had rejected instead of degrading, `fsck` would
   throw. So a healthy `fsck` result over a repo with two planted bad packs is the direct
   cross-adapter proof of requirement 13's `packs: 0` half.

Golden: `{ readBackType: 'commit', fsckExitCode: 0, fsckMissingCount: 0, fsckRootCount: 1 }`
— the same shape `fsck.scenario.ts` already proves is adapter-deterministic (read its
`expected` block for the exact field semantics, including why `missingCount` is 0 despite
the reflog's null-oid sentinel).

**`unsupportedRuntimes`.** Do not set it speculatively. Neither scenario feeds
`DecompressionStream` a truncated prefix (the reason `bundle.scenario.ts` excludes
`workers`), so both should run everywhere. If a runtime-parity job disagrees, add the
runtime with a one-sentence in-file reason — never silence the driver.

### TDD steps

**RED 1 — Scenario A registered and failing.** Add the file + both `index.ts` entries with
the golden filled in. Run `npx vitest run --project parity`.
*Expected failure (against a tree without Parts 1–2):* `readObject` rejects with
`INVALID_PACK_HEADER: unsupported version: expected 2, got 3` on both drivers. Against the
current tree (Parts 1–3 landed) it must go green immediately — that is the pin; verify the
golden by running both drivers and confirming they agree **before** committing.

**RED 2 — Scenario B registered and failing.** Same shape.
*Expected failure (against a tree without Part 3):* both drivers reject from `all()` with
`INVALID_PACK_INDEX`, so the seed commit read fails.

**GREEN.** Both drivers green on the identical golden. If node and memory disagree, that
is the parity bug the tier exists to catch — fix the adapter, never the golden.

**REFACTOR.** Confirm no oid appears in either `expected` block, that both scenarios read
`repo.ctx.hashConfig.digestLength` rather than 20, and that
`npx playwright test test/browser/parity.spec.ts` (or the CI browser job) sees both names
in the registry guard.

### Gate

```
npx vitest run --project parity \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/parity/scenarios/pack-v3-read.scenario.ts test/parity/scenarios/pack-degraded-idx.scenario.ts test/parity/scenarios/index.ts
```

### Commit

```
test(parity): pin v3 pack reads and degraded pack sets across adapters
```

## Phase-boundary gate

```
npm run validate
```

Expected at the boundary, and each is a *finding* if it does not hold:

- `reports/api.json` **unchanged** — the two new constants never reach
  `src/domain/storage/index.ts`, and ADR-576 keeps `PackHeader.version` at `number`.
  Nothing to regenerate, nothing to commit. (`check:doc-typedoc` runs at **prepush**, not
  in `validate`; a green cached `validate` can still precede a red prepush, so re-run
  `check:spelling` fresh and confirm `reports/api.json` is untouched before pushing.)
- `tooling/audit-write-surfaces.ts` green with **no** annotation and **no** allowlist edit
  (requirement 6).
- Coverage 100 % on `src/domain/storage/pack-entry.ts`.
- `check:test-pyramid` in band: unit and integration each move by one file.
- Every existing packfile golden, interop and parity expectation passes untouched —
  generation is byte-identical (requirement 6).
