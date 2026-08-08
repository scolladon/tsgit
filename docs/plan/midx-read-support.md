# Plan — multi-pack-index read support (flat + incremental chain)

> Source: design doc `docs/design/midx-read-support.md` · ADRs 592 … 602
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the part schema — the plan phase cannot close without it.

## Sizing

Seven parts. Five carry a `src/` delta with their own tests folded in; two are
test-infra-only (the two cross-tool interop suites, the cross-adapter parity scenario,
the bench) and are standalone by the template's own exception — they have no
implementation part to fold into and each covers behaviour spanning several code parts.

Parts are **sequential in one working tree**; each builds on the last. Four files are
declared by more than one part — `src/application/primitives/pack-registry.ts`
(Parts 2–5), `src/application/primitives/internal/midx-source.ts` (Parts 3–4),
`test/unit/application/primitives/pack-registry.test.ts` (Parts 2–4) and
`test/integration/midx-fixture-helpers.ts` (Parts 6–7) — so `plan-lint`'s
cognitive-locality warning is expected and is not a defect: the reason each pair stays
separate is written out below.

**Why the split falls where it does.**

- **Part 1 is domain-only and has no application consumer yet.** It ships under the
  100 %-coverage / mutation-break-99 `domain` bucket and it is the only part that
  changes `reports/api.json` for a *domain* reason. Folding it into Part 3 would mix a
  byte-format parser with an I/O state machine in one diff and one commit.
- **Part 2 (ADR-597, lazy `.idx`) is deliberately midx-free.** It is a registry
  refactor whose entire correctness claim is *"every existing test stays green"* — a
  claim that is only checkable while no midx exists. It is also the ratification that
  makes §D4.5's unconditional `assertLoadable()` gate affordable, so it must land
  before Part 3, not with it.
- **Parts 3 and 4 both edit `pack-registry.ts` and `midx-source.ts` and are still
  separate.** Part 3's observable behaviour is *degradation* (Tier A throws — loose
  reads included; Tier B warns and discards; the chain is all-or-nothing) and it leaves
  `lookup`'s body untouched. Part 4's observable behaviour is *authority* (a midx hit
  subtracts a pack from the `.idx` loop, and a hit on an unusable pack is a miss for the
  whole registry). Those are the two ratifications that went to the user separately
  (ADR-593 and ADR-592); merging them would fuse ~35 unit rows whose fixtures are
  disjoint into one unreviewable diff, and would make a Tier-A regression and an
  authority regression indistinguishable at bisect.
- **Part 5 (fsck) is not folded into Part 4** even though it consumes Part 4's
  `LoadedMidx`: it adds four public `FsckFinding` variants, a public exit bit, a second
  api.json regeneration and a *second, independent reader* of the same bytes
  (§D11.10 — "reads work" and "fsck is clean" are genuinely independent claims).
- **Parts 6 and 7 are two suites, not one**, because the design pins two disjoint
  matrices against two different git commands (Pins G/H/I/J/D/F/L on the read path,
  Pins N/O/P on `fsck` + `multi-pack-index verify`), and 28.1a set the precedent of
  giving the fsck axis its own interop file.

**No test assertion written by an earlier part is flipped by a later one.** That
constraint drove the ordering, and it is enforced through the **fixtures**, not through
timing:

- Part 3's rows never assert a *lookup answer* under a healthy midx (Part 4 changes
  which pack serves it); Part 3 asserts only that reads still resolve and that faults
  tier correctly. Part 4's rows are the first to assert Pin H's authority answers.
- Part 2's `.idx`-read-count rows use fixtures with **no midx**, so their counts stay
  true after Part 4. Part 4's own read-count row uses a **midx-bearing** fixture and
  asserts a different number. The two rows coexist; neither edits the other.

## Shared conventions (bind every part)

- **Serena is ALREADY ACTIVATED** on this worktree. Do NOT call `activate_project`.
  Use `find_symbol` / `find_referencing_symbols` / `replace_symbol_body` /
  `insert_after_symbol` / `replace_content` as the default for every TypeScript
  read/navigate/edit (test files too); `get_diagnostics_for_file` after each source
  edit. `Read`/`Grep` only for markdown/JSON/generated artefacts. Diagnostics are
  advisory — ground truth is `npm run check:types`. `replace_symbol_body` on a TS
  `export const` arrow can double the `export const` prefix (TS1389): omit the prefix
  in the new body, then diagnose.
- **Test conventions**: `describe('Given <context>')` > `describe('When <action>')` >
  `it('Then <expected>')`; the 2-level `describe('Given …, When …')` shortcut is allowed
  when only one expectation lives under the When. Body is AAA with `// Arrange` /
  `// Act` / `// Assert` comments (a compound `// Arrange + Act` marker trips
  `emptyAaaSection` — keep the sections separate). The system under test is named `sut`
  — the *function or object under test*, never the result (`result` holds the result).
  `buildSeededContext`, `createPackRegistry`, `getPackRegistry`, `createNodeContext`,
  `createMemoryContext`, `withHandleLedger`, `trackedNodeContext` are already on the
  `sutBindsResult` allowlist in `test-pyramid-budgets.json`. **Any NEW fixture factory
  you bind to `const sut` must be added to that allowlist** or `check:test-pyramid`
  fails — prefer not to bind a new factory to `sut` at all.
- **Error assertions**: never `toThrow(TsgitError)` and never `toThrow(ErrorClass)` —
  the pyramid gate's `bareClassToThrow` heuristic is gating. Use `try`/`catch` +
  `expect((caught as TsgitError).data.code)` / `.data.check` / `.data.reason` read
  separately, or `expect(data).toEqual({ code, check, reason })`. A `check` assertion is
  not optional: a wrong `check` is a silent re-tiering (§D4).
- **Isolated-guard rule**: for `if (A || B)`, write one `it` per operand with an
  arrangement that triggers that operand alone. Every matrix row below marked **own
  `it`** is there for this reason; merging two of them returns a mutant to surviving.
- **No provenance refs in code**: never write `ADR-5xx`, `§D4`, `Pin G7`, `28.2`,
  `Phase …` or a backlog id inside `src/` or `test/`. Comments explain *why* in prose
  ("git dies on a structurally self-inconsistent midx, so this fault is not skippable").
  The commit message is the join point.
- **No suppression directives** of any flavour (`@ts-ignore`, `v8 ignore`,
  `stryker-disable`, `biome-ignore`). The **three** pre-existing `// Stryker disable`
  comments in `pack-registry.ts` (`:318` on `nextOffsetForEntry`, `:416` on
  `trackClose`, `:505` on `refresh`'s rejected-scan arm) are **structure-specific
  proofs**: Parts 2–4 change the code around them, so every one a part touches must be
  **re-proved by hand against the new structure** or deleted — a carried-forward proof
  that no longer holds is worse than no comment. Adding a *new* suppression is not an
  available action.
- **Public-surface pre-payment.** Two parts change `reports/api.json` and each must run
  `npm run docs:json` and commit the regenerated file **in the same commit** (the huge
  typedoc-id diff is normal): **Part 1** (`src/domain/index.ts` re-exports
  `src/domain/storage/index.ts`, which is a typedoc entry point) and **Part 5** (the four
  new `FsckFinding` variants, re-exported from `src/application/commands/index.ts`).
  `check:doc-typedoc` is a **prepush** gate, not a `validate` gate — a stale report
  passes local validate and rejects at push.
  **No other surface gate fires**: `grep -c '"PackRegistry"' reports/api.json` is `0`
  (the registry is not in `src/application/primitives/index.ts`), so every registry
  shape change in Parts 2–4 is invisible to api.json; `check:doc-coverage` and
  `audit-browser-surface` parse **only `src/repository.ts`** and this change binds
  nothing new there, so **no `docs/use/` page and no README count bump is owed**;
  `tooling/audit-write-surfaces.ts` needs no `@writes` annotation and no allowlist entry
  (this change writes nothing) and must keep exiting **0** — the one report-level change
  it will show is the interop suites' orphan coverage, which is expected (**S-14**).
- **Coverage and mutation**: `vitest.config.ts` gates **100 % line/branch/function/
  statement on `src/domain/**`** (and ports/adapters/operators) — Part 1's parser is
  inside that set and every branch must be reached by a unit row. `src/application/**`
  is outside the coverage `include`, but Stryker mutates all of `src`, with break
  thresholds **99 for `src/domain/**`** and **95 for `src/application/**`
  (`mutation-budgets.json`)**. The matrices below name their mutants where the mutant is
  the reason the row exists.
- **`check:duplicates` (jscpd, `minLines: 5`, `minTokens: 50`, threshold 5 %).** The
  midx's fanout-narrowed binary search is *structurally* the `.idx` one with a different
  stride, payload and table offset. Write it against the midx's own layout — do not
  copy-paste `compareShaAtIndex` / `lookupPackIndex` — and check the jscpd console output
  in the part gate.
- **`check:spelling` (cspell)**: `LOFF`, `midx`, `OIDF`, `OIDL`, `OOFF`, `PNAM`,
  `fanout` are already in `cspell.json`. Any new term (e.g. a new identifier fragment)
  needs an entry; re-run `npm run check:spelling` fresh before pushing — it cache-skips
  after later-phase edits.
- **Never commit on a red gate. Never `--no-verify`.**
- Blockers escalate as `{ part, reason, ≤3 options }` — never spin, never silently drop
  a row.

## Decision candidates

**None.** All eleven candidates are ratified as ADRs 592 … 602, and the design's
§D1 … §D12.7 fix every mechanism this plan schedules. The shapes below are *derived*
from the design and its ADRs, not chosen by this plan — each is listed with the line
that determines it, so a reviewer can check the derivation rather than re-litigate it.

## Derived shapes (not decisions)

| # | shape | value | derived from |
|---|---|---|---|
| S-1 | `MidxCheck` members | exactly **eleven**: `size` · `signature` · `version` · `hash-version` · `chunk-table` · `required-chunk` · `fanout` · `chunk-length` · `pack-names` · `pack-int-id` · `large-offset`. **`base-files` is not a member.** | §D1's union + requirement 21 + §D4.4 (Pins O20/O21, P21–P23 falsified ADR-599's twelfth member). |
| S-2 | tier map | **B**: `size`, `chunk-table`, `chunk-length`, `hash-version`, plus `FILE_NOT_FOUND` / `PERMISSION_DENIED` on any midx artefact. **A**: the other seven. | §D4.1's table, every row pinned. |
| S-3 | `numChunks === 0` | refused by the **final-chunk-entry-id-must-be-0** rule, `check: 'chunk-table'` (Tier B) — **no separate `numChunks ≥ 1` guard** | Pin G14/O16 is git's *final chunk has non-zero id* line, i.e. git reaches the same rule. A second guard would be a redundant branch with an unreachable-in-practice sibling; house rules forbid dead guards. If a `numChunks ≥ 1` gate is added anyway it MUST carry `check: 'chunk-table'`, never `size`. |
| S-4 | `pack-int-id` / `large-offset` are **deferred** Tier A | raised by `lookupMultiPackIndex` at decode time, not by `parseMultiPackIndex` at load time | §D1 ("the `packIndex` bound is checked at read time") + Pin G10's *partial* reads column + row O28's *contained by the child*. Consequence: `assertLoadable()` does **not** trip on them, which is faithful — G10 lets the pack-0 object read. |
| S-5 | midx exports actually shipped | `parseMultiPackIndex`, `lookupMultiPackIndex`, `allMidxObjectIds`, `MultiPackIndex`, `MidxEntry`, `MidxCheck`, `invalidMultiPackIndex`. **`findMidxByPrefix` is NOT shipped.** | §D1 sketches four functions, but §Out of scope explicitly declines *"prefix/abbreviation resolution through the midx"* and §D11.1 records the resulting divergence as unclaimed — so `findMidxByPrefix` would be public API with no consumer, in a repo whose domain code is gated at 100 % coverage and mutation-break 99. `allMidxObjectIds` **does** have a consumer: §D12.1's pass *"resolves every oid the midx lists"*. Escalate if a reviewer wants the fourth function shipped anyway. |
| S-6 | `MidxLoadResult` shape | `{ set: MidxSet \| undefined; faults: ReadonlyArray<MidxFault>; flatFilePresent: boolean }` | §D2's two fields + §D12.2's `flatFilePresent` (*"a `stat`, not a successful read"*). Shipped complete in Part 3 so the precedence state machine — the riskiest logic in the change — is written and tested **once**; its third field's only consumer arrives in Part 5. |
| S-7 | chain-cap behaviour | a chain file whose leading hex run exceeds `MAX_MIDX_CHAIN_LAYERS` **discards the whole chain** (one Tier-B fault on the chain-file artefact) — it does **not** silently truncate the run | ADR-600 Consequences: *"Exceeding either is a Tier-B discard."* Truncating would build a partial universe and, under ADR-592's authority, answer `missing` for objects a complete read would have found. |
| S-8 | ADR-597's laziness mechanism | `RegisteredPack.index: () => Promise<PackIndex>` (a `createPromiseMemo`); the scan stops loading indexes; **the generation object itself carries a `createPromiseMemo` (`indexed`)** that forces every index and performs today's `isSkippableIdxFault` classification. `all()` / `health()` / `indexFaults()` go through it (membership, fault completeness and warn cardinality identical to today); `lookup()` reaches it **only when it has to fall back to the `.idx` loop**; `assertLoadable()` never reaches it. | ADR-597 Decision + its accepted caveat (*"`health()` forces the loads to restore completeness"*) + §D7 (*"1 midx read + 1 `.idx` read per pack actually touched"*). **Hanging the memo on the generation rather than on the registry is what makes requirement 14 true by construction**: one `await currentGeneration()` yields the midx AND the (lazy) pack view from the *same* scan, so no consumer can ever pair one generation's midx with another's packs. A second registry-level memo would need two awaits with a `refresh()` window between them. It is also the pattern the file already uses for `headerMemo` / `offsetTable` / `handleMemo` — a memo that travels with the object it belongs to. |
| S-9 | disposal + refresh semantics | **unchanged, verbatim.** `currentGeneration()` keeps today's body (`disposed ? (scan.peek() ?? Promise.resolve(EMPTY_GENERATION)) : scan.get()`); `refresh()` and `dispose()` keep iterating `generation.packs`. | falls out of S-8: the `indexed` memo is dropped with its generation, so there is no second slot to clear and no disposed corner to reconcile. `generation.packs` becomes the *candidate* superset (orphans excluded, index-faulted packs still present), which is the **safer** set to close — closing a pack whose `.idx` never loaded is a no-op, missing one would leak. |
| S-10 | path helpers | `multiPackIndexPath(packsDir)`, `multiPackIndexChainPath(packsDir)`, `multiPackIndexLayerPath(packsDir, digest)` in `src/application/primitives/path-layout.ts` | mirrors `commitGraphPath` / `commitGraphChainPath` / `commitGraphLayerPath` (`path-layout.ts:60-68`). They take the **packs directory**, not `gitDir`, unlike their siblings — because §D2 fixes `loadMidxSet(ctx, packsDir)`; say so in the doc-comment. |
| S-11 | fsck trailer algorithm selection | `ctx.hashService.hash(bytes)` directly — no algorithm switch | §D9 H-5 asks for selection from the `hashVersion` byte, but S-2 makes a `hashVersion` whose width disagrees with `digestLength` a **Tier-B discard** before the artefact can ever reach the fsck pass, so by construction the surviving artefact's `hashVersion` agrees with `ctx.hashService.algorithm`. Assert that invariant in a comment, not with a branch a test could never cover (the 100 %-coverage gate would reject an arm no test could reach). |
| S-12 | `midx-entry-unresolved` and the shared id collector | the new variant must be added to `findingIds` in `test/unit/application/commands/fsck-finding-ids.ts` | that helper is consumed by **both** `fsck.test.ts` and `fsck.properties.test.ts`; it exists so a new id-bearing variant updates one place. |
| S-13 | `MidxSet` carries per-layer artefact names | `MidxSet` gains `readonly artefacts: ReadonlyArray<string>`, parallel to `layers`, base-first: `['multi-pack-index']` for the flat form, `['multi-pack-index-<hex>.midx', …]` for a chain (the **last** element is the head) | §D2's sketch has only `layers`, but §D12.3 puts `artefact` on **all four** finding variants *"because in a chain the head and a base layer are different files and P12/P13 make the distinction observable"*, and §D12.4 must hash **the head only**. Without the names, Part 5 would have to re-read the chain file — a second source of truth for the same ordering. |
| S-14 | `interopSurface` on the two new interop suites | keep `interopSurface: multi-pack-index` as the design specifies, and expect `tooling/audit-write-surfaces.ts` to record it as **orphan coverage** (a test claims a surface no `@writes` annotation declares) | §Test strategy names the key; §D8 W-5 forbids adding a `@writes` annotation because this change writes nothing. `check:write-surfaces` runs **without `--blocking`** (ADR-139), so an orphan entry is reported in `reports/write-surface-coverage.json` and the gate still exits **0** — confirm that exit code in the part gate rather than removing the key. |

## Part 1 — the domain midx parser and its refusal code

### Context

**Goal.** §D1 + ADR-595/596/599 + requirements 1–4, 20, 21 and threat rows T-3/T-4: a
context-free, hash-generic parser over midx bytes, and a refusal carrying a closed
`check` discriminant so the application layer never re-derives a tier from a message.
No application code consumes it yet.

**New file:** `src/domain/storage/midx.ts`. Mirror `src/domain/storage/pack-index.ts`
(221 lines) in shape so the two read as siblings, and `src/domain/commit/commit-graph.ts`
(315 lines) for the **chunk-table** idiom — that file already implements
`readChunkTable` / `requireChunk` / `validateChunkSize` over a `ChunkRange` map for
`CGPH`, and is the closest existing prior art. Do not import from it (different format,
different error family); read it, then write the midx's own.

Current shapes you are extending (line numbers are point-in-time — verify):

- `src/domain/storage/error.ts` (28 lines) — `StorageError` is a five-member union
  (`INVALID_PACK_HEADER`, `INVALID_PACK_INDEX`, `INVALID_PACK_ENTRY`, `INVALID_DELTA`,
  `DELTA_CHAIN_TOO_DEEP`) with one factory each, all `new TsgitError({ … })`.
- `src/domain/storage/index.ts` (51 lines) — grouped, comment-headed barrel; the
  `// Pack index` block at `:39-41` is where the `// Multi-pack index` block goes
  (alphabetical inside its own block, blocks in file order).
- `src/domain/error.ts` — `TsgitErrorData` at `:66` unions `StorageError`;
  `extractDetail(data)` at `:178` has a fall-through case group returning `data.reason`
  which already lists `INVALID_PACK_INDEX` (`:189`).
- `test/unit/domain/exhaustiveness.ts` (208 lines) — `assertExhaustiveSwitch(data)`, one
  `case` per code, `never`-checked default. `INVALID_PACK_INDEX` is at `:23`.
- `test/unit/domain/storage/error.test.ts` (122 lines) — one
  `describe("Given <factory>(…)") > describe('When checking error.data…') > it('Then …')`
  group per factory, asserting `result.data` with `toEqual`, plus a trailing
  `assertExhaustiveSwitch` block.
- `test/unit/domain/storage/arbitraries.ts` (180 lines) — exports `arbObjectId`
  (re-exported from `../objects/arbitraries.js`), `arbSupportedPackVersion`,
  `arbUnsupportedPackVersion`, `TestIndexEntry`, `buildTestIndex(entries)`, `buildDelta`.
  **`buildTestIndex` is the model for the new `buildMidx`** — a writer that emits the
  literal on-disk layout so the parser (reader) has a non-tautological oracle.
- `test/unit/domain/storage/pack-entry.properties.test.ts` (60 lines) — the only
  `*.properties.test.ts` in the directory: `fc.assert(fc.property(…), { numRuns: 200 })`
  for the round-trip, `{ numRuns: 50 }` for the refusal property, `const sut = <fn>`
  bound before `fc.assert`.

**The shapes to land** (§D1, with S-1 and S-5 applied):

```ts
export interface MultiPackIndex {
  readonly version: 1 | 2;
  readonly hashVersion: 1 | 2;
  readonly digestLength: number;
  readonly numBaseFiles: number;      // read, exposed, NEVER gated (requirement 21)
  readonly objectCount: number;
  readonly packNames: ReadonlyArray<string>;   // PNAM verbatim: `pack-<hex>.idx`
  readonly oidFanoutOffset: number;
  readonly oidLookupOffset: number;
  readonly objectOffsetsOffset: number;
  readonly largeOffsetsOffset: number | undefined;  // undefined ⇒ no LOFF chunk
  readonly largeOffsetCount: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}
export interface MidxEntry { readonly packIndex: number; readonly offset: number; }

export function parseMultiPackIndex(bytes: Uint8Array, digestLength: number): MultiPackIndex;
export function lookupMultiPackIndex(midx: MultiPackIndex, id: ObjectId): MidxEntry | undefined;
export function allMidxObjectIds(midx: MultiPackIndex): ReadonlyArray<ObjectId>;
```

```ts
// src/domain/storage/error.ts
export type MidxCheck =
  | 'size' | 'signature' | 'version' | 'hash-version' | 'chunk-table'
  | 'required-chunk' | 'fanout' | 'chunk-length' | 'pack-names'
  | 'pack-int-id' | 'large-offset';
// … added to StorageError:
| { readonly code: 'INVALID_MULTI_PACK_INDEX'; readonly reason: string; readonly check: MidxCheck }
export const invalidMultiPackIndex = (check: MidxCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_MULTI_PACK_INDEX', check, reason });
```

**Parse order — each step gated on the previous. This ordering *is* requirement 1**
(no `DataView` read at an offset not already proved in-bounds; a `RangeError` escaping
the parser is a defect, not an error path — T-4):

1. `bytes.length >= MIDX_HEADER_SIZE (12)` → else `size`.
2. signature `MIDX` (`0x4d494458`) → `signature`; version ∈ {1, 2} → `version`;
   `hashVersion` ∈ {1, 2} **and** its implied width (`1 → 20`, `2 → 32`, via a named
   const map — §D9 H-2) equals the `digestLength` argument → `hash-version`.
   **`numBaseFiles` is read into the value and never gated** (requirement 21, §D4.4).
3. chunk table fits: `12 + (numChunks + 1) * 12 <= bytes.length - digestLength` →
   `chunk-table`.
4. read `numChunks + 1` entries. Offsets **strictly increasing**, `>=` the table's own
   end, `<= bytes.length - digestLength`; the final entry's id must be `0` →
   `chunk-table`. (G7 and G14/O16 are exactly these two checks; S-3.)
5. required chunks present: `PNAM`, `OIDF`, `OIDL`, `OOFF` → `required-chunk`, **one
   isolated guard per chunk**.
6. `OIDF` length is exactly `1024` (`chunk-length`) and monotonic non-decreasing
   (`fanout`); `objectCount = F[255]`.
7. `OIDL.length === objectCount * digestLength` and `OOFF.length === objectCount * 8`
   → `chunk-length`.
8. `PNAM` splits into exactly `numPacks` NUL-terminated non-empty names, remainder
   `<= 3` NUL padding bytes → `pack-names`; **for version 1 only**, strictly increasing
   (Pin D7/D8).
9. `LOFF`, if present: length is a multiple of 8 → `chunk-length`;
   `largeOffsetCount = len / 8`.

**Offset decode — the Pin F rule, stated as code** (requirement 4; do **not** reuse
`readOffset` from `pack-index.ts:95-111`, whose large table is always present where the
midx's `LOFF` is optional — that reuse is exactly F2's silent-corruption path):

```ts
const raw = view.getUint32(objectOffsetsOffset + i * 8 + 4);
if (midx.largeOffsetsOffset === undefined || (raw & 0x80000000) === 0) return raw >>> 0;
const row = raw & 0x7fffffff;
if (row >= midx.largeOffsetCount) throw invalidMultiPackIndex('large-offset', `…`);
const high = view.getUint32(midx.largeOffsetsOffset + row * 8);
if (high > 0x1fffff) throw invalidMultiPackIndex('large-offset', `…safe integer…`);
return high * 0x100000000 + view.getUint32(midx.largeOffsetsOffset + row * 8 + 4);
```

`packIndex` bound (`< packNames.length`) is checked **at read time** in
`lookupMultiPackIndex` → `pack-int-id` (S-4, reproducing G10 as a refusal, not a crash).

`lookupMultiPackIndex` is a fanout-narrowed binary search over `OIDL` with stride
`digestLength`, byte-comparing against `hexToBytes(id)` (`domain/objects/encoding`),
then reading `OOFF[i]`'s two words. `allMidxObjectIds` walks `OIDL` and
`bytesToHex(subarray)` per entry, exactly as `allObjectIds` (`pack-index.ts:184`) does.

**Surface gates this part pre-pays** (`src/domain/index.ts:28` does
`export * from './storage/index.js'`, and `src/domain/index.ts` is a typedoc entry
point, so every new barrel export is public API):

1. `src/domain/storage/index.ts` — new `// Multi-pack index` block exporting the types
   and the three functions of S-5, plus `MidxCheck` and `invalidMultiPackIndex` in the
   existing `// Errors` block.
2. `src/domain/error.ts` — add `INVALID_MULTI_PACK_INDEX` to `extractDetail`'s
   `return data.reason` case group.
3. `test/unit/domain/exhaustiveness.ts` — add the `case`; without it `check:types` fails
   at the `never` default (**this is a legitimate RED**).
4. `test/unit/domain/storage/error.test.ts` — a factory group asserting
   `{ code, check, reason }` with `toEqual`.
5. `npm run docs:json` + commit `reports/api.json` **in this commit** (prepush gate).

**Mutation traps for this file** (`domain` bucket, break 99): equivalent mutants are
expected on the fanout `lo` narrowing — `pack-index.ts:124` and `:165` carry the proven
comment for the identical shape, and the design is explicit that it **must be re-proved
against the midx's stride, not copied**. Do not paste that comment forward.

### TDD steps

RED first. The gate runs `npm run check:types`, so a test importing a symbol that does
not exist is a compile error — that **is** the RED.

1. **RED** — extend `test/unit/domain/storage/arbitraries.ts` with the builder and its
   generators, then write the refusal + accept matrix in a new
   `test/unit/domain/storage/midx.test.ts`. Expected first failure:
   `TS2307`/`TS2305` on `parseMultiPackIndex` from `../../../../src/domain/storage/midx.js`.

   **Builder** (`buildMidx(spec): Uint8Array`, plus `MidxSpec`), emitting the Pin B
   layout: header (`MIDX`, version, hashVersion, numChunks, numBaseFiles, u32BE
   numPacks), chunk table `(numChunks+1) × 12`, `PNAM` (NUL-terminated `.idx` names
   padded to ×4), `OIDF` (256 × u32BE), `OIDL` (sorted oids), `OOFF` (u32BE packInt +
   u32BE offset), optional `LOFF`, trailer of `digestLength` zero bytes (**the parser
   never reads the trailer — ADR-602 — so the builder need not hash**; say so in its
   doc-comment or a later reader will "fix" it). Every negative row is the builder plus
   **one named mutation**, so the only thing wrong with a fixture is what the row claims.

   | group | rows | Then |
   |---|---|---|
   | accept | v1; v2; 0 packs / 0 objects; 1 pack; 3 packs; `hashVersion: 2` + `digestLength: 32` (the H-1 genericity row) | parsed fields equal the spec's |
   | accept — `numBaseFiles` | values **1**, **2**, **255** — **own `it` each** | **parses**, and `numBaseFiles` is exposed unchanged. A refusal row here would re-introduce the divergence O20 disproved; the reason lives in the test title |
   | header refusals | short file (11 B) → `size`; signature → `signature`; version **0**, **3**, **255** — own `it` each → `version`; `hashVersion` **0**, **3** — own `it` each → `hash-version`; `hashVersion: 2` against `digestLength: 20` → `hash-version` | `.data.check` **and** `.data.reason` asserted |
   | chunk table | offsets non-increasing; an offset past `len − digestLength`; an offset before the table's end; final entry id non-zero; `numChunks` byte = 0 — **own `it` each** | `chunk-table` |
   | required chunks | `PNAM` id clobbered; `OIDF` id clobbered; `OIDL` absent; `OOFF` absent — **one `it` per chunk** (ADR-575's isolated-guard rule) | `required-chunk` |
   | chunk content | `OIDF` non-monotonic **at index 0** and **at index 255** (two rows — a loop-boundary mutant survives a single-index test) → `fanout`; `OIDF` length ≠ 1024 → `chunk-length`; `OIDL` length ≠ `objectCount·digestLength` → `chunk-length`; `OOFF` length ≠ `objectCount·8` → `chunk-length`; `LOFF` length not a multiple of 8 → `chunk-length` | |
   | `PNAM` | fewer names than `numPacks`; more names than `numPacks`; an empty name; > 3 padding bytes; **v1 out of order → `pack-names`, and the same bytes with version 2 → accepted** (the D7/D8 pair, two rows on one fixture) | |
   | lookup | first / last / middle oid; an oid below `OIDL[0]`; an oid above `OIDL[n-1]`; an oid whose fanout bucket is empty; `packIndex` out of range → `pack-int-id` | `MidxEntry` or `undefined` |
   | large offsets | `LOFF` present + bit 31 set → the 64-bit value; **`LOFF` absent + bit 31 set → the literal `0x80000000`** (Pin F2's direction); row index ≥ `largeOffsetCount` → `large-offset`; `high` word past the safe-integer bound → `large-offset` | |
   | `allMidxObjectIds` | 0 objects → `[]`; 3 objects → the sorted spec ids | |
   | exhaustiveness | one row per `MidxCheck` member — **eleven** | so the tier table in Part 3 cannot gain an unreachable arm or lose a reachable one without a test moving |

   Every refusal row uses `try`/`catch` + direct `.data.check` and `.data.reason` reads.

2. **RED** — `test/unit/domain/storage/midx.properties.test.ts`:
   - round-trip: `parseMultiPackIndex(buildMidx(spec), digestLength)` recovers `spec`'s
     packs, oids and offsets over pack counts 0–8, object counts 0–64, arbitrary
     offsets — `{ numRuns: 200 }`.
   - lookup: equals `spec`'s mapping for every oid in `spec`, `undefined` for arbitrary
     oids outside it — `{ numRuns: 100 }`.
   - **totality (the highest-value test in the file)**: over arbitrary byte strings up
     to 4 KiB, `parseMultiPackIndex` either returns or throws
     `INVALID_MULTI_PACK_INDEX` — **never** a `RangeError`, and a returned value's
     chunk offsets all lie inside the buffer — `{ numRuns: 200 }`. This is requirement 1
     and T-4 made executable.
   Generators live in the directory's existing `arbitraries.ts`, not in the test file.
3. **RED** — add the `case` to `test/unit/domain/exhaustiveness.ts` and the factory
   group to `error.test.ts`. Expected failure before the union widens:
   `TS2678: Type '"INVALID_MULTI_PACK_INDEX"' is not comparable to type …`.
4. **GREEN** — land `midx.ts`, the error member + factory, the barrel block, the
   `extractDetail` case.
5. **REFACTOR** — re-read the parse function against the nine ordered steps; confirm no
   `getUint32` precedes its bounds proof; confirm 100 % coverage (`npm run test:coverage`
   — `src/domain` is gated at 100/100/100/100 and an unreached guard fails the build);
   check the jscpd console output for a clone against `pack-index.ts`; run
   `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/midx.test.ts test/unit/domain/storage/midx.properties.test.ts test/unit/domain/storage/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/midx.ts src/domain/storage/error.ts src/domain/storage/index.ts src/domain/error.ts test/unit/domain/storage/midx.test.ts test/unit/domain/storage/midx.properties.test.ts test/unit/domain/storage/arbitraries.ts test/unit/domain/storage/error.test.ts test/unit/domain/exhaustiveness.ts
```

Plus, in this part: `npm run test:coverage` (100 % on the new domain file),
`npm run check:dead-code` (knip — the barrel-exported `allMidxObjectIds` and
`lookupMultiPackIndex` have no `src/` consumer until Parts 5 and 4; they are reachable
from the `src/domain/index.ts` entry point and must not be reported) and
`npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`feat(storage): parse the multi-pack-index chunked format`

## Part 2 — a pack index is loaded only when the pack is touched

### Context

**Goal.** ADR-597 + §D7's scan term: `RegisteredPack.index` becomes
`() => Promise<PackIndex>` and the scan stops reading every `.idx` eagerly. **No midx
code lands here.** The whole correctness claim of this part is *every existing test
stays green*, and that claim is only checkable while no midx exists — which is why this
part is midx-free and comes before Part 3. It is also what makes §D4.5's unconditional
`assertLoadable()` gate affordable in Part 3 (before this part, that gate would force
P whole-file `.idx` reads onto every loose-only read).

**File to change:** `src/application/primitives/pack-registry.ts` (548 lines). Current
shape by symbol name-path (line numbers point-in-time — verify):

- `isUnsupportedOperation` (`:29`), `isSkippableIoFault` (`:37`), `isSkippablePackFault`
  (`:49`, `INVALID_PACK_HEADER` ∪ io), `isSkippableIdxFault` (`:61`,
  `INVALID_PACK_INDEX` ∪ io). **Reuse verbatim; do NOT union them** — a DRY pass that
  merged them would make a mid-read `INVALID_PACK_INDEX` from `nextOffsetForEntry`
  skippable at the lookup layer, converting a detected corruption into a silent miss.
- `faultContext(data)` (`:70`) → `{ code, reason }` or `{ code }` — flat and
  string-valued because the Logger port sanitises **top-level string values only**.
- `faultReason(data)` (`:74`, exported) — consumed by `internal/fsck/pack-health.ts:42`.
- `interface RegisteredPack` (`:83`) — `name`, **`index: PackIndex`**, `packPath`,
  `idxPath`, `header()`, `offsetTable()`, `readSlice()`, `close()`.
- `interface UnusablePack` (`:127`), `PackHealth` (`:134`), `PackRegistry` (`:139`) —
  `all`, `lookup`, `refresh`, `dispose`, `health`, `indexFaults`.
- `isSafePackName` (`:175`), `isCandidate` (`:184`), `packBaseName` (`:190`),
  `readBoundedIdx` (`:192`, `stat` → bound → `read` → re-bound, both against
  `exceedsMaxPackIdxBytes`).
- `loadPack` (`:207`) — `readBoundedIdx` + `parsePackIndex` **eagerly**, then
  `headerMemo` (`:214`, whose body cross-checks `header.objectCount !== index.objectCount`),
  `buildOffsetTable` (`:224`, `entryOffsets(index)`), `handleMemo` (`:245`), `readSlice`
  (`:253`), `close` (`:284`).
- `PackGeneration` (`:330`), `EMPTY_GENERATION` (`:335`), `PackCandidateOutcome` (`:340`),
  `loadCandidatePack` (`:353`, three outcomes: `orphaned` / `index-fault` / `registered`),
  `unusableEntry` (`:378`).
- `createPackRegistry` (`:384`) — `scanPacks` (`:385`), `scan = createPromiseMemo(scanPacks)`
  (`:407`), `disposed` / `pendingCloses` / `trackClose` (`:414`) / `drainPendingCloses`
  (`:422`), `currentGeneration` (`:437`, terminal-disposal aware), `allPacks` (`:441`),
  `indexFaultsOf` (`:447`), `indexFaultEntries` (`:450`), `probeHeader` (`:458`),
  `computeHealth` (`:472`), `healthMemo` (`:488`), and the returned object (`:490`).

**The edit** (S-8, S-9):

1. `RegisteredPack.index` becomes `() => Promise<PackIndex>`, built in `loadPack` as
   `createPromiseMemo(async () => parsePackIndex(await readBoundedIdx(ctx, idxPath)))`.
   `loadPack` becomes non-throwing for index faults — it no longer reads the `.idx`.
   `headerMemo`'s body and `buildOffsetTable` each `await index()` before their
   cross-check / `entryOffsets` call.
2. `loadCandidatePack` loses its `index-fault` arm and its `try`/`catch` (nothing left in
   it can throw a skippable idx fault); it keeps the **orphan** arm verbatim, warn
   included, and returns `RegisteredPack | undefined`. `PackCandidateOutcome` disappears.
3. **`PackGeneration` gains the memo, and its `packs` become the candidate superset:**
   ```ts
   interface IndexedPacks {
     readonly packs: ReadonlyArray<RegisteredPack>;   // index loaded and parsed
     readonly indexFaults: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }>;
   }
   interface PackGeneration {
     readonly packs: ReadonlyArray<RegisteredPack>;   // candidates with a sibling .pack
     readonly indexed: PromiseMemo<IndexedPacks>;     // created inside scanPacks
   }
   ```
   `scanPacks` builds the candidate list (no `.idx` I/O), then returns
   `{ packs, indexed: createPromiseMemo(() => resolveIndexes(packs)) }`. Part 3 adds the
   third field. `EMPTY_GENERATION` must be built the same way (its memo resolves to empty)
   and can no longer be a module-level frozen constant if the memo is per-instance — make
   it a small factory and keep the frozen arrays inside it.
4. `resolveIndexes` is the single site that now performs today's scan-layer
   classification, **sequentially**, in candidate order:
   ```ts
   for (const pack of packs) {
     try { await pack.index(); indexed.push(pack); }
     catch (err) {
       if (!isSkippableIdxFault(err)) throw err;
       ctx.logger?.warn?.('packRegistry: skipping unreadable pack index',
         { idx: `${pack.name}.idx`, ...faultContext(err.data) });
       indexFaults.push({ name: pack.name, data: err.data });
     }
   }
   ```
   The warn message string and its `idx` key are **unchanged from today** — existing rows
   assert them. One memo run per generation is what keeps ADR-580's one-warn-per-generation
   property; a per-lookup re-classification would break it.
5. `all()`, `indexFaults()`, `computeHealth()` and (for now) `lookup()` each do **one**
   `await currentGeneration()` and then `await generation.indexed.get()`, so membership,
   fault completeness and warn cardinality are byte-identical to today.
   **`currentGeneration()`, `refresh()` and `dispose()` keep their current bodies
   verbatim** (S-9) — the `indexed` memo is dropped with its generation, so there is no
   second slot to clear.
6. Doc-comment on `RegisteredPack.index`: memoised, one bounded read per pack, a
   rejection is **not** memoised, and the ONE site that classifies an index fault is the
   generation's `indexed` memo — never a call site.

**What this part does and does not buy.** It buys nothing measurable on its own: today's
scan is already behind a `createPromiseMemo`, so the `.idx` reads simply move from *scan
time* to *first `all`/`lookup`*, and `lookup` still forces all of them through
`indexed`. The win arrives in Part 4, where a midx hit returns before `indexed` is ever
touched. That is why this part's commit type is `refactor`, not `perf` — do not claim a
speed-up here.

**Blast radius outside the file (verified — do not rediscover).**

- `src/application/primitives/enumerate-objects.ts:57` — `allObjectIds(pack.index)` →
  `allObjectIds(await pack.index())`; `collectPackedObjectIds` becomes `async` and its
  call site at `:35` gains an `await`.
- `src/application/primitives/resolve-oid-prefix.ts:43` — `findByPrefix(pack.index, prefix)`
  → `findByPrefix(await pack.index(), prefix)`; `scanPacks` there is already `async`.
- **Five** hand-built `PackRegistry` literals need no change in this part (they never
  build a `RegisteredPack`): `test/unit/application/primitives/object-resolver.test.ts`
  `:119`, `:1170`, `:1229`, `:1293`, `:1353`. Any literal that *does* build a
  `RegisteredPack` must switch `index: someIndex` → `index: async () => someIndex`.
  Grep `index:` inside those files before editing.
- No `src/` consumer of `.index` exists outside the registry, `enumerate-objects.ts` and
  `resolve-oid-prefix.ts` (verified). `grep -c '"RegisteredPack"' reports/api.json` is
  `0`, so **no api.json regeneration in this part**.

**Test file:** `test/unit/application/primitives/pack-registry.test.ts` (3096 lines).
Existing top-level describes you will be running against: `pack-registry` (`:74`),
`PackRegistry.scan — per-pack idx degradation and orphan exclusion` (`:353`),
`PackRegistry.health — per-pack accessibility` (`:664`), `RegisteredPack.offsetTable`
(`:1528`), `PackRegistry.refresh` (`:1949`), `PackRegistry.dispose` (`:1974`),
`PackRegistry — single-flight scan` (`:2135`), `PackRegistry — read path after dispose`
(`:2450`), `PackRegistry.lookup — header gate` (`:2629`).
Fixtures already imported there: `buildSeededContext` (`./fixtures.js`),
`writeSyntheticPack` / `restampPackHeader` (`./pack-fixture.js`), `withHandleLedger`
(`./handle-ledger.js` — accessors `opens()`, `closes()`, `outstanding()`,
`readdirCalls()`, `perCallReads()`, `slices()` (ordered `{path, offset, length}` — this
is how a 12-byte header probe is told apart from an entry read), `readdirGate`), the
fs-wrapper fault-injection idiom at `:430-462`, `permissionDenied` / `fileNotFound` /
`unsupportedOperation` from `src/domain/error.js`, `REASON_PACK_IDX_EXCEEDS_MAX` from
`validators.js`.

**The three `// Stryker disable` comments in this file are structure-specific proofs.**
`:318` (`nextOffsetForEntry`) is untouched by this part. `:416` (`trackClose`) and `:505`
(`refresh`'s rejected-scan arm) sit in code this part edits — re-read each against the
edited structure and either keep it with a re-proof or delete it. A carried-forward
proof that no longer holds is worse than none.

### TDD steps

1. **RED** — add a new top-level `describe('PackRegistry — lazy pack-index loading', …)`
   after `:353`'s block. Expected first failure: `TS2349: This expression is not
   callable` / `TS2739` on `pack.index` in the new rows.

   | row | arrangement | Then |
   |---|---|---|
   | no read at scan | two healthy packs; `createPackRegistry(ctx)` and **nothing else** | the ledger records **zero** `readdir` and **zero** `.idx` reads (the scan memo is still cold) |
   | scan without index loads — **own `it`** | two healthy packs; `assertLoadable`-shaped probe is not available yet, so drive it with `lookup` and inspect **ordering**: the `readdir` precedes every `.idx` read | proves the `.idx` load left `scanPacks` |
   | lookup still forces every index — **own `it`** | two healthy packs, **no midx**; `lookup(idInPackA)` | **two** `.idx` reads. Deliberate: the fallback loop goes through `indexed`. This fixture has no midx, so the count stays 2 after Part 4 too — Part 4 asserts 1 on its **own**, midx-bearing fixture. Say that in the title so no later part edits this row |
   | memoised | `lookup` twice for two different oids in the same pack | exactly one `.idx` read for that pack |
   | `all()` membership unchanged | one healthy pack + one same-length-garbage `.idx` | `all()` lists **only** the healthy pack — identical to today |
   | `indexFaults()` complete — **own `it`** | same fixture, call `indexFaults()` **without** any prior `lookup`/`all` | one entry, `layer: 'index'`, `INVALID_PACK_INDEX` — the ADR-597 caveat made executable |
   | warn cardinality | same fixture; `all()` then `indexFaults()` then `health()` | the `'packRegistry: skipping unreadable pack index'` warn fires **exactly once** |
   | oversize `.idx` | the stat-lying wrapper at `:208-256` | `indexFaults()` reports `REASON_PACK_IDX_EXCEEDS_MAX` **and the recorded read list is `[]`** — the pre-read allocation guard survives |
   | rejection not memoised — **own `it`** | make `read` reject `permissionDenied` for `*.idx`, call `all()`, repair, call `refresh()`, call `all()` | the pack returns to `accessible`; the ledger shows a second `.idx` read |
   | unrecognised idx fault | `read` rejects `unsupportedOperation('filesystem', …)` for `*.idx` | `all()` **rejects**; `try`/`catch` + `.data` asserted exactly |
   | header cross-check still fires | `restampPackHeader(…, { objectCount: index.objectCount + 1 })` | `health()` reports `layer: 'pack'` with a reason naming **both** counts — proves `header()` still awaits `index()` |
   | `offsetTable` still works | healthy pack; read a packed object end to end | bytes unchanged |
   | dispose then all | healthy pack; `lookup(id)`, `dispose()`, `all()` | the retired set, **no new `readdir`** |
   | dispose with no read | `createPackRegistry` then `dispose()` then `all()` | empty; **no `readdir` at all** |

2. **GREEN** — land the memo, the `resolveIndexes` classification, the consumer edits in
   `enumerate-objects.ts` and `resolve-oid-prefix.ts`, and the doc-comment updates on
   `RegisteredPack.index` (say plainly: memoised, rejection not memoised, the ONE site
   that classifies an index fault is the registry's `resolveIndexes`).
3. **REFACTOR** — re-run the **whole** unit suite for the registry, resolver, enumerate,
   resolve-oid-prefix and fsck files; every pre-existing assertion must pass unchanged.
   Re-prove or delete the two `// Stryker disable` comments this part's edits touch.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/enumerate-objects.properties.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/enumerate-objects.ts src/application/primitives/resolve-oid-prefix.ts test/unit/application/primitives/pack-registry.test.ts
```

### Commit

`refactor(pack-registry): load a pack index only when the pack is touched`

## Part 3 — discover, tier and degrade the multi-pack-index

### Context

**Goal.** §D2 + §D4.1 … §D4.5 + ADR-593/594/598/600/602 + requirements 5, 6, 7, 10, 11,
12, 13, 14, 20: find the midx (flat first, chain second, `try` semantics — Pin J), load
a chain all-or-nothing (Pin I), classify every fault into git's two tiers (Pin G), and
make Tier A deny **loose** reads too (§D4.5). `lookup`'s selection logic is **not
touched** in this part — a healthy midx changes no answer yet. That is Part 4.

**Files to change:** new `src/application/primitives/internal/midx-source.ts`;
`src/application/primitives/pack-registry.ts` (the scan step, the per-generation warn,
`assertLoadable()`); `src/application/primitives/validators.ts` (the two bounds);
`src/application/primitives/path-layout.ts` (three path helpers);
`src/application/primitives/object-resolver.ts` (the §D4.5 gate, one line). Test files:
new `test/unit/application/primitives/internal/midx-source.test.ts`, plus rows in
`test/unit/application/primitives/pack-registry.test.ts`,
`test/unit/application/primitives/object-resolver.test.ts`,
`test/unit/application/primitives/validators.test.ts` and
`test/unit/application/primitives/path-layout.test.ts`.

**New file:** `src/application/primitives/internal/midx-source.ts` (~180 lines). `internal/`
already holds exactly this class of building block (`promise-memo.ts` 44 L,
`bounded-reader.ts` 68 L, `read-commit-graph.ts` 288 L). **Read
`src/application/primitives/internal/read-commit-graph.ts` first** — it is the same
problem one format over: `tryRead`/`tryReadUtf8` (`exists`-gated read with a
`FILE_NOT_FOUND` catch for the TOCTOU window, `:79-97`), `parseChainLayerHashes`
(`:99`), `loadChain` (`:111`, *"a chain that references a missing layer is treated as an
ABSENT graph"*), `computeLayerOffsets` (`:132`), and the single-file-before-chain order
in `loadGraphUncached` (`:151`). The midx differs in three load-bearing ways and each
difference is a pinned row, not a style choice:
**(a)** the flat file wins only if it *loads*, not if it merely exists (Pin J5);
**(b)** a chain line must be exactly `2 × digestLength` lowercase hex and the run
**stops at the first line that is not** (Pin I10) — `read-commit-graph`'s
`filter(line.length > 0)` is the wrong shape here;
**(c)** faults are **tiered**, not uniformly swallowed.

**The shapes to land** (§D2, with S-6 and S-7 applied):

```ts
export interface MidxSet {
  readonly layers: ReadonlyArray<MultiPackIndex>;   // base first
  readonly kind: 'flat' | 'chain';
}
export interface MidxFault {
  readonly artefact: string;          // 'multi-pack-index' | 'multi-pack-index-<hex>.midx' | 'multi-pack-index-chain'
  readonly data: TsgitErrorData;
}
export interface MidxLoadResult {
  readonly set: MidxSet | undefined;  // undefined ⇒ fall back to the .idx scan
  readonly faults: ReadonlyArray<MidxFault>;
  readonly flatFilePresent: boolean;  // a stat, not a successful read (S-6)
}
export async function loadMidxSet(ctx: Context, packsDir: string): Promise<MidxLoadResult>;
```

**Algorithm** (`packsDir` is the directory `scanPacks` has already proved exists, so the
registry's early return still fires first):

1. **Flat.** `stat` `multi-pack-index`; record `flatFilePresent`. If present: bound
   (`MAX_MIDX_BYTES`) → `read` → re-bound → `parseMultiPackIndex(bytes, ctx.hashConfig.digestLength)`.
   Success → `{ layers: [midx], kind: 'flat' }` and **return — the chain is never
   touched** (J2/J3/J4/P19; the ledger row is what proves it). A **Tier-B** fault →
   record and fall through to the chain (J5/P17). A **Tier-A** fault → **propagates out
   of `loadMidxSet` unchanged**: the chain is not tried and no fault is recorded (J6/P18).
2. **Chain.** `readUtf8` `multi-pack-index.d/multi-pack-index-chain`. Absent, empty or
   unreadable → `{ set: undefined }`, **silently** (I5/I6). Split on `\n`; take the
   **leading run** of lines matching `/^[0-9a-f]{N}$/` with `N = 2 × digestLength`,
   stopping at the first that does not (I10). Run longer than
   `MAX_MIDX_CHAIN_LAYERS` → discard the whole chain with one Tier-B fault on the
   chain-file artefact (S-7).
3. Per digest, in chain order: read + parse `multi-pack-index-<digest>.midx`, bounded the
   same way. **Any** missing / unreadable / Tier-B layer discards the **whole** set
   (I2/I4/I8, P2–P8) with one fault. A **Tier-A** layer propagates, base layer included
   (I3, P9/P10/P11).
4. `{ layers, kind: 'chain' }`.

The hex-only line shape **is** the path-safety check (T-2): that regex admits no `/`,
`\`, `.` or NUL, so `multi-pack-index-<line>.midx` is confined to the chain directory by
construction. The leading-run rule means no line past the first bad one is ever used.
**The trailer is never hashed on this path** (ADR-602, requirement 20) — say so in the
module doc-comment, or a later reader will add it.

**The tier map — one total function over the closed union, living in this file:**

```ts
type MidxTier = 'A' | 'B';
const tierOf = (check: MidxCheck): MidxTier => { switch (check) { … } };   // exhaustive
export const isTierBMidxFault = (err: unknown): err is TsgitError => …;
```

`tierOf` must be a `switch` with **no `default`** so a future `MidxCheck` member is a
compile error, not a runtime surprise. The discriminator is written as a **positive test
for Tier B** and everything else rethrows — never `if (isTierA(err)) throw err`, which
would silently swallow a member the map forgot:

```ts
try { return parseMultiPackIndex(bytes, digestLength); }
catch (err) { if (!isTierBMidxFault(err)) throw err; record(err); return undefined; }
```

`isTierBMidxFault` admits `INVALID_MULTI_PACK_INDEX` **with `tierOf(check) === 'B'`**
plus the two io codes (`FILE_NOT_FOUND`, `PERMISSION_DENIED`) on a midx artefact — and
nothing else (§D4.1's third row).

**New bounds** in `src/application/primitives/validators.ts` (200 lines, ADR-600 — **not**
`domain/engine-limits.ts`), beside `MAX_PACK_IDX_BYTES` (`:129`) and
`REASON_PACK_IDX_EXCEEDS_MAX` (`:122`), following the file's own doc-comment convention
(*"predicates exported and tested in isolation with a just-under / at / just-over
triple; reason strings exported as `const` so tests reference them by identity"*):

```ts
export const REASON_MIDX_EXCEEDS_MAX = '…' as const;
export const REASON_MIDX_CHAIN_TOO_LONG = '…' as const;
export const MAX_MIDX_BYTES = …;              // sized for the repo class the feature exists for
export const MAX_MIDX_CHAIN_LAYERS = …;
export function exceedsMaxMidxBytes(size: number): boolean;
export function exceedsMaxMidxChainLayers(count: number): boolean;
```

Both bounds raise `invalidMultiPackIndex('size', REASON_…)` — `size` is Tier B, which is
correct: a bound is tsgit policy, not a git structure git refuses (ADR-600's
Consequences). Extend `test/unit/application/primitives/validators.test.ts` with the
just-under / at / just-over triple for each predicate.

**New path helpers** in `src/application/primitives/path-layout.ts` (S-10), beside
`commitGraphPath` / `commitGraphChainPath` / `commitGraphLayerPath` (`:60-68`).

**Registry integration in this part** (`src/application/primitives/pack-registry.ts`):

- `scanPacks` gains **one step, outside the per-candidate loop** — `midxLoad = await
  loadMidxSet(ctx, dir)` — and `PackGeneration` gains `readonly midxLoad: MidxLoadResult`
  beside Part 2's `packs` and `indexed`. Placement is load-bearing, not incidental: a
  midx load placed *inside* the candidate loop would be swallowed by
  `isSkippableIdxFault` into "skip one pack", which is the exact hazard ADR-599 chose a
  distinct error code to prevent. Write that reason as a comment.
  **`midxLoad` has no reader until Part 4** — that is intentional; the *load* is this
  part's observable behaviour (Tier A throws out of the scan memo, Tier B warns), not
  the field.
- **One `ctx.logger?.warn?.` per recorded fault**, emitted inside `scanPacks` — so
  "once per generation" falls out of the memo running once, as ADR-580 requires.
  Payload `{ artefact, ...faultContext(fault.data) }`, flat and string-valued (T-7:
  never nest a name inside `err.data`, that routes it round the sanitiser).
- **New `assertLoadable(): Promise<void>`** on the `PackRegistry` interface:
  `await currentGeneration()` for its rejection, result discarded. It returns `void` on
  purpose — it must not become a second way to reach the packs. It must **not** touch
  `generation.indexed` (that would force every `.idx` and destroy §D4.5's affordability
  argument, which is the whole reason Part 2 landed first).
- `src/application/primitives/object-resolver.ts:56` — `await registry.assertLoadable()`
  as the **first** statement of `resolveObjectBytes`, **before** the empty-tree
  short-circuit (`:57`) and before the `deltaCache` probe (`:60`), because git dies during
  object-store setup, ahead of both. `enumerateObjects` and `resolveOidPrefix` need **no**
  gate: both already `await registry.all()` and therefore already reject.
- The **five** hand-built `PackRegistry` literals in
  `test/unit/application/primitives/object-resolver.test.ts` (`:119`, `:1170`, `:1229`,
  `:1293`, `:1353`) each gain `assertLoadable: async () => {}`. Keep that file in this
  part's gate.

**Why the Tier-A fault crosses the registry — verify, do not assume.** The registry's
discriminators are allow-lists over `TsgitError.data.code`:
`isSkippableIdxFault` (`INVALID_PACK_INDEX` ∪ io), the header-gate allow-list inside
`probeHeader` (`INVALID_PACK_HEADER` ∪ io), and the new `isTierBMidxFault`. None admits
a Tier-A `INVALID_MULTI_PACK_INDEX`. **Requirement 7 demands this be a test row, not an
inspection** — see the TDD matrix.

**Test files:** new
`test/unit/application/primitives/internal/midx-source.test.ts` (the directory already
holds 25 sibling suites including `read-commit-graph.test.ts` — model the fixture style
on it), plus new rows in `pack-registry.test.ts`, `object-resolver.test.ts` and
`validators.test.ts`. `withHandleLedger`'s `slices()` / `perCallReads()` / the
instrumented-`Context` wrapper in `fixtures.ts` (`instrumentedContext(base)` → `calls()`
returning ordered `{ method, path }`) are the two call ledgers; **`instrumentedContext`
is the right one for `midx-source`**, because the rows that matter assert *which paths
were opened*, not fd counts.

### TDD steps

1. **RED** — `midx-source.test.ts`, over `buildSeededContext()` (memory adapter) with the
   midx bytes written by a local `writeMidx(ctx, dir, name, bytes)` helper built on
   Part 1's `buildMidx`. Expected first failure: `TS2307` on
   `../../../../../src/application/primitives/internal/midx-source.js`.

   | row | arrangement | Then |
   |---|---|---|
   | no midx at all | packs dir with two `.idx` only | `set` undefined, `faults` empty, `flatFilePresent` false, **no read of any midx path** |
   | flat, healthy | flat file only | `kind: 'flat'`, one layer, `flatFilePresent` true |
   | chain, healthy — 1 / 2 / 3 layers | chain file + layers | `kind: 'chain'`, layers **base first**, count matches |
   | **flat suppresses a broken chain** — **own `it`** | loadable flat **+** a chain whose base layer has a bad signature (Tier A) | resolves; **no throw**; the ledger shows **no read of the chain file or any layer** (J4/P19 — asserted by the ledger, never by an outcome) |
   | Tier-B flat rescued by a chain — **own `it`** | flat truncated to 8 B + intact chain | `kind: 'chain'`, one fault on `multi-pack-index`, `flatFilePresent` **true** (J5/P17) |
   | Tier-A flat | flat with a flipped signature | **rejects** with `check: 'signature'`; `faults` unreachable; the chain is **not** read (J6/P18) |
   | chain file absent / empty / unreadable — **own `it` each** | | `set` undefined, **no fault**, silent (I5/I6) |
   | missing layer file | chain lists a digest with no file | `set` undefined, one fault, one warn (I2/I8) |
   | Tier-B layer | one layer truncated to 8 B | `set` undefined, one fault (I4/P8) |
   | Tier-A **base** layer / Tier-A **head** layer — **own `it` each** | bad signature | **rejects** (I3/P9/P10) |
   | malformed chain line at the end / mid-list — **own `it` each** | a `garbage` line appended / inserted second | leading run only: end → all layers load; mid-list → only the layers before it (I10) |
   | chain over the cap | `MAX_MIDX_CHAIN_LAYERS + 1` valid hex lines | `set` undefined, one fault whose reason is `REASON_MIDX_CHAIN_TOO_LONG` (S-7) |
   | oversize flat / oversize layer — **own `it` each** | stat-lying wrapper | Tier-B fault, reason `REASON_MIDX_EXCEEDS_MAX`, **and the recorded read list contains no read of that file** |
   | hostile chain line — **own `it`** | a line `../../../../etc/passwd` and a line containing NUL | terminates the run; the ledger shows **no `ctx.fs` call outside the chain directory** (T-2) |
   | trailer never hashed | healthy flat whose trailer bytes are wrong | loads normally; no hashing call (ADR-602) |
   | tier map totality | parameterised over all **eleven** `MidxCheck` values | `isTierBMidxFault` returns the S-2 verdict for each; **eleven rows, one per member** |

2. **RED** — `validators.test.ts`: just-under / at / just-over for
   `exceedsMaxMidxBytes` and `exceedsMaxMidxChainLayers`, plus identity assertions on the
   two `REASON_*` constants.
3. **RED** — `pack-registry.test.ts`, new top-level
   `describe('PackRegistry — multi-pack-index degradation', …)`:

   | row | arrangement | Then |
   |---|---|---|
   | **allow-list audit (requirement 7)** — parameterised over all eleven `MidxCheck` values | an `INVALID_MULTI_PACK_INDEX` error per member | `isSkippableIdxFault(err)` is `false` **and** the header-gate discriminator is `false` for every member. A new member cannot be added without appearing here |
   | Tier A escapes the scan — **own `it`** | Tier-A flat midx **beside a perfectly healthy pack** | `lookup` **rejects** with `INVALID_MULTI_PACK_INDEX` and the matching `check`; the healthy pack is **not** silently dropped from a successfully-returned generation (that is what a swallowed Tier-A fault would look like) |
   | Tier B does not escape — **one `it` per Tier-B member** | `size`, `chunk-table`, `chunk-length`, `hash-version` (isolated) | `lookup` resolves; **one** warn; answers served from the `.idx` scan |
   | io fault on the midx — **own `it` each** | `read` rejects `fileNotFound` / `permissionDenied` for the midx path | Tier B: resolves, one warn |
   | unrecognised fault | `read` rejects `unsupportedOperation('filesystem', …)` for the midx | `lookup` **rejects**; `.data` asserted exactly |
   | **loose reads are denied (§D4.5)** — **own `it`** | repo whose object is **loose**, plus a Tier-A midx | `readObject` **rejects** |
   | its control — **own `it`** | the same repo with a **Tier-B** midx | the loose object **reads**. Without both rows the gate can be present-and-inert or absent-and-untested |
   | gate ordering — **own `it`** | Tier-A midx; read the **empty-tree oid** | **rejects** — proves the gate precedes the empty-tree short-circuit |
   | gate ordering, cache — **own `it`** | Tier-A midx; warm `deltaCache` with an oid, then read it | **rejects** — proves the gate precedes the `deltaCache` probe |
   | **no memoised rejection (§D4.3)** — **own `it`** | Tier-A flat midx; call `lookup` three times | three rejections **and three `ctx.fs` read attempts on the midx** in the ledger — the ledger is what proves re-attempt rather than a replayed memo |
   | recovery without `refresh()` — **own `it`** | continue the row above: repair the file **without** calling `refresh()` | the fourth call **succeeds**. This assertion is the whole argument of §D4.3 |
   | one generation, one midx | `refresh()` between two `lookup`s | midx and packs drop together; a `lookup` racing a `refresh` never sees one generation's midx against another's packs |
   | `assertLoadable` does not force indexes — **own `it`** | two healthy packs + a healthy midx; read a **loose** object only | the ledger records the `readdir` + one midx read and **zero** `.idx` reads — §D4.5's cost claim made executable |
   | handle lifecycle | any midx row | `opens() − closes() === 0` after `dispose()`; the midx contributes **no** `FileHandle` (requirement 13) |
   | no midx, no regression | repo with no midx | at most **two extra `exists`/`stat` calls per `Context`** (flat, then chain) and no behaviour change (§D7's regression guard) |

4. **GREEN** — land `midx-source.ts`, the validators, the path helpers, the scan step,
   the per-generation warn, `assertLoadable()` and the `object-resolver.ts` gate.
5. **REFACTOR** — re-read `tierOf` against §D4.1's table row by row; confirm the
   `switch` has no `default`; confirm no `catch {}` anywhere in the new file; confirm the
   flat/chain precedence reads as *flat-then-return*, not *flat-or-chain*; run
   `npm run check:dead-code` (knip) — `midx-source.ts` is not an entry point, and its
   exports must all be reachable from `pack-registry.ts` or a test.

### Gate

```
npx vitest run test/unit/application/primitives/internal/midx-source.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/validators.test.ts test/unit/application/primitives/path-layout.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/midx-source.ts src/application/primitives/pack-registry.ts src/application/primitives/validators.ts src/application/primitives/path-layout.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/internal/midx-source.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/validators.test.ts
```

Plus in this part: `npm run check:dead-code`.

### Commit

`feat(pack-registry): load and tier the multi-pack-index like git`

## Part 4 — the midx is authoritative for the packs it names

### Context

**Goal.** §D3 + ADR-592 + requirements 8, 9 and Pin H's eight rows: `lookup` consults
the midx first; a hit resolves to a `RegisteredPack` and passes the **unchanged** header
gate; a hit on an **unusable or unbound** pack is a **miss for the whole registry**; and
the `.idx` loop is filtered to packs the midx does **not** claim. `all()`, `health()` and
`indexFaults()` keep their current shapes and their current membership.

**File to change:** `src/application/primitives/pack-registry.ts` — Part 3 left the scan
carrying a `MidxLoadResult`. This part derives the binding and rewires `lookup`.

```ts
interface LoadedMidx {
  readonly set: MidxSet;
  /** layerIndex → packIndex → the registered pack, or undefined when PNAM names nothing on disk. */
  readonly packsByLayer: ReadonlyArray<ReadonlyArray<RegisteredPack | undefined>>;
  /** Names the midx claims — the ADR-592 subtraction set, `.idx`-suffixed as PNAM stores them. */
  readonly claimedNames: ReadonlySet<string>;
}
```

**The binding runs over the `readdir` listing the scan already holds, at zero extra
I/O**, exactly as ADR-579's sibling-`.pack` rule does. A `PNAM` entry that **(a)** fails
`isSafePackName` (`:175`) or **(b)** names no `.idx` the scan registered binds to
`undefined` **and its name is not added to `claimedNames`** — that is precisely Pin H7:
an unresolvable `PNAM` entry drops out of the midx's universe, so the real pack of that
name, if any, is scanned normally.

**T-1 is the highest-severity threat row in the whole change and the mitigation is
structural rather than a validation step:** `PNAM` entries **never construct a path**. They are
matched **by exact string equality** against the listing, and only a match yields a
`RegisteredPack` whose `packPath` came from the already-audited `packBaseName` rule. Do
not write `` `${dir}/${name}` `` anywhere in this part. The test row asserts it via the
call ledger, not by reading the code.

`LoadedMidx` is derived inside `scanPacks`, in the same memo body, from Part 3's
`midxLoad` and the `readdir` listing. `PackGeneration` **keeps `midxLoad` and gains**
`readonly midx: LoadedMidx | undefined` — `lookup` reads the second, Part 5 reads
`midxLoad.faults` and `midxLoad.flatFilePresent` from the first. `midx` is `undefined`
exactly when `midxLoad.set` is.

**`lookup(id)` becomes, in order. The await sequence is the perf claim** — step 2 must
return without ever touching `generation.indexed`:

1. `const generation = await currentGeneration();` — **one** await, so the midx and the
   pack view provably come from the same scan (requirement 14; S-8).
2. If `generation.midx !== undefined`: walk `midx.set.layers` **newest-first** (§D2 records the
   choice: git's writer de-duplicates across layers so the direction is unobservable in a
   git-written chain, and newest-first matches the spec's pseudo-pack ordering rule for a
   hand-written or future compacting writer) and take the first
   `lookupMultiPackIndex(layer, id)` hit. `pack-int-id` is **layer-local** (Pin C), so a
   hit is `(layerIndex, packIndex, offset)` resolved through **that layer's own**
   `packsByLayer[layerIndex][packIndex]`.
   - **bound** → run the existing `probeHeader(pack)` (ADR-572/577 unchanged); pass →
     return `{ pack, offset }`; fault → **return `undefined`** (this single branch *is*
     Pin H2–H4).
   - **unbound** (`undefined`) → fall to step 3 (Pin H7).
   - **miss** → step 3.
3. `const { packs } = await generation.indexed.get();` then the existing loop, **skipping
   any pack whose `${name}.idx` is in `claimedNames`**. A pack the midx does not name is
   served exactly as today. Reaching `indexed` from the **captured** generation — never
   from a second `currentGeneration()` call — is what keeps requirement 14 true across
   the two awaits.

The midx-derived offset feeds the **unchanged** downstream (`resolvePackChain` →
`pack.offsetTable()` → `nextOffsetForEntry` → `pack.readSlice`) — an offset is a pack
offset in both worlds, which is what keeps the blast radius one function wide.

**Deferred Tier A (S-4).** `lookupMultiPackIndex` can throw `pack-int-id` or
`large-offset` — Tier A — from **inside** `lookup`, not from the scan. It must **not** be
caught: no allow-list admits it, and `assertLoadable()` deliberately does not trip on it
(faithful — Pin G10's reads column is *partial*, not *all fail*).

**Three edges this ordering settles, each matching a pinned git row** (write each as a
row, not as a comment):

- A `PNAM` entry naming a pack the scan **excluded** (an orphaned `.idx`, ADR-579, or one
  whose index failed, ADR-575) binds to `undefined`, falls to step 3, and finds nothing
  there either because that pack is not in the indexed generation → **missing**. Pin H3.
- A **claimed** pack holding an oid the midx does not list: step 3 skips it → missing.
  Unreachable in a git-written midx, reachable by mutation, and it is git's answer.
- A pack written **after** the midx is in `packs` and not in `claimedNames` → step 3
  serves it. Pin H8/L4, and the property `materializePack` (`fetch-pack.ts:158-175`)
  depends on (§D8 W-2).

**What must NOT change** (requirement 9, and each is a row):
`all()` is **not** filtered by `claimedNames` — it stays the "packs present on disk"
view, which is git's *enumeration* universe (Pin K), keeping `enumerateObjects` faithful
and `resolveOidPrefix` on its (deliberately unclaimed, §D11.1) divergence.
A midx fault is **not** a `PackHealth` entry — `UnusablePack.layer` is `'pack' | 'index'`
and widening it would make every existing `health()` consumer, including
`runPackHealthPass`'s bit-4 and bit-64 arms, start reporting midx faults as pack faults.

**Perf property this part delivers** (§D7, and the row that proves it): with a healthy
flat midx, a `lookup` that hits reads **one** `.idx` — the pack the answer lands in, via
`probeHeader` → `header()` → `await index()`. It must **not** reach Part 2's
`indexedGeneration` memo at all.

### TDD steps

1. **RED** — extend `pack-registry.test.ts` with
   `describe('PackRegistry.lookup — multi-pack-index authority', …)`. Fixtures: two or
   three synthetic packs via `writeSyntheticPack`, a midx over them via Part 1's
   `buildMidx` (the `DUP` shape — **the same blob written into two packs, the midx naming
   one of them — is the only shape that can tell authority from acceleration apart**).
   Expected first failure: the duplicate-blob row returns a hit where the row expects
   `undefined`.

   | row | arrangement | Then | pin |
   |---|---|---|---|
   | same answer, healthy | 3 packs + healthy midx | `lookup` returns the **same** `{ pack, offset }` the `.idx` loop returns for every packed oid | requirement 8 at unit scale |
   | one `.idx` read per hit — **own `it`** | 3 packs + healthy midx; one `lookup` | the ledger records **one** `.idx` read (the hit pack), not three | §D7 |
   | **authority: unusable bound pack** — **own `it`** | `DUP`; midx assigns the blob to pack A; pack A's header gate fails (`restampPackHeader(…, { version: 99 })`) | `lookup` returns **`undefined`**, and pack B — which holds the same oid — is **not** consulted | H2–H4 |
   | its control — **own `it`** | the same repo with the **midx removed** | `lookup` returns the hit from pack B | H5/H6 |
   | unclaimed pack still served — **own `it`** | midx names packs A and B; pack C written after | an oid only in C resolves normally | H8/L4 |
   | unresolvable `PNAM` falls through — **own `it`** | `PNAM`[0] renamed to a name no file has, same length | the real pack of that name is scanned normally and the oid **resolves**; one warn | H7 |
   | `PNAM` failing `isSafePackName` — **own `it`** | a `PNAM` entry containing `/` and one containing `..` (two rows) | binds to `undefined`; **no path is constructed** — asserted via the ledger showing no `ctx.fs` call naming that string | T-1 |
   | claimed pack skipped in the loop — **own `it`** | midx claims pack A but omits an oid pack A holds | `lookup` returns `undefined` | §D3 edge 2 |
   | `PNAM` names a scan-excluded pack — **own `it`** | orphaned `.idx` named by `PNAM` | missing | H3 |
   | layer-local `pack-int-id` | 2-layer chain, each layer naming a different pack | an oid in layer 2 resolves through **layer 2's** `packNames`, not a global list | Pin C |
   | newest-first | hand-built chain where **both** layers list the same oid at different offsets | the **newest** layer's entry wins | §D2 |
   | `pack-int-id` out of range — **own `it`** | midx whose `OOFF` names pack 5 of 3 | `lookup` **rejects** with `check: 'pack-int-id'` — a deferred Tier A, not a miss | G10, S-4 |
   | `large-offset` out of range — **own `it`** | `LOFF` row index ≥ `largeOffsetCount` | `lookup` **rejects** with `check: 'large-offset'` | O28, S-4 |
   | `all()` unfiltered | midx claiming every pack | `all()` still lists them all | requirement 9 |
   | `enumerateObjects` unchanged | same fixture | the id set equals the no-midx run's | Pin K |
   | `health()` unchanged | midx + one v99 pack | the same `PackHealth` as without the midx; **no midx entry** | §D3 |
   | header memo shared | midx hit then a second `lookup` in the same pack | **one** 12-byte `readSlice` in total | ADR-572 unchanged |

2. **GREEN** — land `LoadedMidx`, the binding over the scan's listing, the newest-first
   layer walk and the three-step `lookup`.
3. **REFACTOR** — extract the layer walk into a small named function so `lookup` stays
   under 20 lines and its three steps read as three steps; re-read the binding for any
   accidental string concatenation of a `PNAM` value; confirm `all()` / `health()` /
   `indexFaults()` bodies are unchanged.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/resolve-oid-prefix.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/midx-source.ts test/unit/application/primitives/pack-registry.test.ts
```

### Commit

`feat(pack-registry): serve lookups from the multi-pack-index authoritatively`

## Part 5 — `fsck` reports the multi-pack-index

### Context

**Goal.** §D12 + ADR-601/602 + requirements 19a–19d and 20: four finding variants, exit
bit 32, one new registry accessor, and trailer verification at fsck time and nowhere
else. This part joins the vocabulary ADRs 581–591 established for pack accessibility
rather than inventing one beside it.

**The governing fact is §D12.1: git's fsck midx pass is a child process**
(`git multi-pack-index verify --object-dir <dir> --no-progress`, Pin N1). That process
boundary is what makes ADR-593 and ADR-601 compose instead of collide, and tsgit models
it exactly:

| where the Tier-A fault is reached | git | tsgit |
|---|---|---|
| the parent's own object-store load (signature, version, required chunk, fanout, `PNAM` order) | parent `die()`s → exit 128, stdout empty, child never runs | `enumerateObjects` at `fsck.ts:35` awaits the same generation → **`fsck` rejects**, no `FsckResult` |
| inside the pass only (`large-offset`, row O28) | child `die()`s, parent survives → bit 32 | `runMidxHealthPass` **contains** the throw → one `midx-unusable` finding + bit 32 |

The reject arm is **not** an invention — it is ADR-590's shape, already shipped, and it
falls out of `fsck.ts`'s existing pass ordering for free. The containment arm **is**
deliberate and is the **one** place in this change where a Tier-A fault is caught: the
catch is scoped to the pass body, discriminated on `data.code` (never `catch {}`), and
anything that is not a `TsgitError` still propagates — a `RangeError` from the parser
remains the defect T-4 forbids, not a finding. **A contained throw ends the walk**: the
pass returns the findings already collected **plus** the `midx-unusable` verdict, so the
finding set is a prefix of the healthy walk's, never a reordering.

**Files to change.**

- `src/application/primitives/pack-registry.ts` — new `midxHealth(): Promise<MidxHealth>`
  accessor, **memoised per generation** exactly as `healthMemo` (`:488`) is, and reset by
  `refresh()` with the scan. It is a **sibling** of `health()`, not a widening of it
  (§D3's reason). Unlike `healthMemo`, its memo is **not** cleared on a fault, because
  its whole content *is* the fault set.
  ```ts
  export interface MidxHealth {
    readonly artefact: string | undefined;      // the artefact IN USE: flat file, or chain head
    readonly faults: ReadonlyArray<MidxFault>;  // Tier-B faults the read path discarded
    readonly flatFilePresent: boolean;          // the verdict gate (Pin O rule 2)
    readonly unresolvedPacks: ReadonlyArray<{ readonly position: number; readonly pack: string }>;
    readonly unresolvedEntries: ReadonlyArray<ObjectId>;
    readonly checksumOk: boolean | undefined;   // undefined when there is no artefact to hash
  }
  ```
  `position` is **chain-global**, computed `Σ layers[0..k−1].numPacks + packIndex`
  (P14 = position 1 for the newest layer's only pack, P15 = 0 for the base layer's);
  layer-local `pack-int-id` is the parser's numbering and must not leak into a finding.
  `pack` carries the `PNAM` name **with the `.idx` suffix stripped**, to match ADR-584's
  documented "pack base name" contract, and inherits the same `isSafePackName` vetting
  (T-1); an entry failing that vetting still produces the finding, with the name replaced
  by its safe-rendered form, and must never reach the logger or a path without that vetting.
  `artefact` comes from **S-13**'s `MidxSet.artefacts[layerIndex]`; the *in-use*
  artefact (`MidxHealth.artefact`, and the trailer-verification target) is
  `artefacts[artefacts.length - 1]` — the flat file, or the chain **head**.
  `checksumOk` needs **no re-read**: the head layer's `MultiPackIndex._bytes` is the whole
  file, so it is `ctx.hashService.hash(_bytes.subarray(0, len - digestLength))` compared
  to the trailing `digestLength` bytes (**S-11** — no algorithm switch). `undefined` when
  `artefact` is `undefined`. `MidxHealth` is exported from `pack-registry.ts` and
  barrelled **nowhere**, exactly like `PackHealth` / `UnusablePack`, so it adds nothing to
  `reports/api.json`.

  **Deriving the two unresolved sets — this is what makes O22 / O23 / O24 / O25 differ,
  and getting it wrong collapses two variants into one:**
  - `unresolvedPacks` — for every layer `k` and every `packIndex` whose
    `LoadedMidx.packsByLayer[k][packIndex]` is `undefined`, one entry with the
    chain-global `position` and the `PNAM` base name. This is *"the `PNAM` entry resolves
    to no pack at all"* (O22 / O23 / O24, where the pack is renamed or fully gone).
  - `unresolvedEntries` — walk `allMidxObjectIds(layer)` per layer and, for each oid,
    resolve the entry: `lookupMultiPackIndex` → `packsByLayer[k][packIndex]` → and then
    **actually try to serve it**: `await pack.index()` and the header gate. An oid counts
    as unresolved when the pack is `undefined` **or** when serving it faults. **Row O25 is
    the whole reason for the second step**: with the `.pack` present and the `.idx`
    deleted, the pack *is* bound (`unresolvedPacks` stays empty) but every entry fails, so
    `midx-entry-unresolved` fires **without** `midx-pack-unresolved`. A derivation that
    only checks the binding produces neither finding there and silently passes O25.
  That walk is also what makes row O28 reachable at all — it is the same
  `fill_midx_entry` loop git's child process runs, and it is why the pass, not the read
  path, is where a `large-offset` throw is contained.
  Widening the `PackRegistry` **interface** again breaks the same five hand-built
  registry literals Part 3 already touched —
  `test/unit/application/primitives/object-resolver.test.ts` `:119`, `:1170`, `:1229`,
  `:1293`, `:1353`. Add `midxHealth: async () => ({ artefact: undefined, faults: [],
  flatFilePresent: false, unresolvedPacks: [], unresolvedEntries: [], checksumOk:
  undefined })` to each, and keep that file in this part's gate.
- `src/application/commands/internal/fsck/types.ts` (126 lines) — four variants appended
  to `FsckFinding` (which today ends with `pack-rev-index-unusable` at `:78-83`), and the
  `FsckResult.exitCode` doc-comment (`:119-124`) gains `32=multi-pack-index verification
  failure`:
  ```ts
  | { readonly type: 'midx-unusable';          readonly artefact: string; readonly reason: string }
  | { readonly type: 'midx-checksum-mismatch'; readonly artefact: string }
  | { readonly type: 'midx-pack-unresolved';   readonly artefact: string;
      readonly position: number; readonly pack: string }
  | { readonly type: 'midx-entry-unresolved';  readonly artefact: string; readonly id: ObjectId }
  ```
  `midx-checksum-mismatch` carries **no `reason`** — there is exactly one way to fail it.
  `midx-entry-unresolved` carries the **oid**, not git's `oid[i]` index: the index is a
  position in the midx's own `OIDL` ordering, fully reconstructable by the interop test,
  and per ADR-249 an index into a rendered list is presentation.
  `artefact` is on **every** variant because in a chain the head and a base layer are
  different files and P12/P13 make the distinction observable.
- `src/application/commands/internal/fsck/exit-codes.ts` (22 lines) — one constant in the
  file's existing pinned-comment convention, and the header comment gains bit 32 to the
  **2.55.0** group rather than widening the 2.54.0 claim:
  ```ts
  // bit 32 = multi-pack-index verification failure (git's ERROR_MULTI_PACK_INDEX)
  export const EXIT_MULTI_PACK_INDEX = 32;
  ```
- **New** `src/application/commands/internal/fsck/midx-health.ts`, mirroring
  `internal/fsck/pack-health.ts` (60 lines) exactly — same import set
  (`Context`, `getPackRegistry` from `../../../primitives/read-object.js`, the exit
  constant, `FsckFinding`/`FsckOptions`), same return shape:
  ```ts
  export async function runMidxHealthPass(
    ctx: Context, opts: FsckOptions,
  ): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
  ```
  **`opts` is taken for symmetry and the pass ignores it.** Pin N's mode table is flat:
  bit 32 fires identically under default, `connectivityOnly`, `full: false` and `strict`.
  That is ADR-586's *ungated* shape (bit 64), not ADR-585's gated one (bit 4). Say so in
  the doc-comment, because a reviewer arriving from `runPackHealthPass` — where `opts`
  carries two different gates — will expect a gate here. `core.multiPackIndex` is git's
  only gate (N3) and tsgit has no such config key (§Out of scope), so the pass is
  unconditional.
- `src/application/commands/fsck.ts` (100 lines) — **three lines**, beside the three
  `runPackHealthPass` already occupies at `:71`, `:91` and `:97`: call it, spread its
  findings, OR its bit. Pass order does not affect the result (findings concatenate, bits
  OR), but the pass must sit **after** `enumerateObjects` (`:35`) has already succeeded —
  which it does by construction, and which is what implements the reject arm.
- `test/unit/application/commands/fsck-finding-ids.ts` (18 lines) — `findingIds` must
  return the oid for `midx-entry-unresolved` (**S-12**; that helper is shared with
  `fsck.properties.test.ts`, which is why it exists).

**The `midx-unusable` predicate, spelled out** — the subtlest logic in the pass, and each
of its inputs is pinned:

```
emit midx-unusable  ⟺  artefact === undefined  &&  flatFilePresent
```

| shape | `artefact` | `flatFilePresent` | emit? | row |
|---|---|---|---|---|
| Tier-B flat, no chain | undefined | true | **yes** | O7–O9, O16–O18 |
| Tier-B flat, chain loads | chain head | true | **no** | P17 |
| dropped chain, no flat file | undefined | false | **no** | P2–P8, P20 |
| broken chain, loadable flat | flat file | true | **no** | P19 |
| no midx at all | undefined | false | **no** | O2 |

`flatFilePresent` is a **stat**, not a successful read — which is why O18's `chmod 000`
file still counts as present and still emits, exactly as git's stat-then-`error()` does.
The one emission that does **not** come from this predicate is O28's, which arrives from
the contained throw; both produce the same variant, so the finding set stays uniform.

**Trailer verification (§D12.4, ADR-602).** Once, over **exactly one** artefact: the flat
file, **or the chain head — never a base layer** (P12 silent vs P13 `incorrect checksum`;
verifying base layers would be a stricter-than-git divergence, and stricter is still a
divergence). The digest covers `[0, len − digestLength)` and is compared to the trailing
`digestLength` bytes, via `ctx.hashService.hash(...)` (**S-11** — no algorithm switch).
It is **not** the `<hex>`-filename correspondence check either: git checks neither.

**The single most important negative in this part:** **no finding and no bit for a
dropped chain** (P2–P8, P20 all exit 0). §D2's per-generation warn remains the only
report. Every `--incremental` repo mid-maintenance would otherwise score bit 32.

**Row O25 is the composition row** and is not a duplicate-finding bug: a midx-named
pack whose `.idx` is deleted yields `pack-index-unusable` + `pack-rev-index-unusable`
from `runPackHealthPass` (bits 4 | 64) **and** `midx-entry-unresolved` findings from
`runMidxHealthPass` (bit 32), for the same pack, in the same run — the first says "this
pack's index is unusable", the second says "the midx routed these oids to it anyway".
git emits both families too. **O25 also forbids collapsing `midx-entry-unresolved` into
`midx-pack-unresolved`**: there the pack resolves (its `.pack` is on disk) but the entry
cannot be filled, so the second fires **without** the first.

**Test file:** `test/unit/application/commands/fsck.test.ts` (4337 lines, 117 top-level
`Given …` describes). Local helpers you will reuse: `initBareCtx()` (`:88`),
`packFilePath` / `idxFilePath` (`:2544-2546`), `onePackEntry(content)` (`:2549`),
`withWarnLog(ctx)` (`:3208`), plus `writeSyntheticPack` / `buildSyntheticPack` /
`restampPackHeader` from `../primitives/pack-fixture.js` and `withHandleLedger`.
The pack-pass describes at `:2553`–`:2837` and `:3494`–`:4295` are the shape to mirror.

**Surface gates this part pre-pays:** `FsckFinding` occurs 9× in `reports/api.json`, so
the four variants **and** the widened `exitCode` doc-comment change it →
`npm run docs:json` + commit `reports/api.json` in this commit.

### TDD steps

1. **RED** — `describe('fsck — multi-pack-index reporting', …)` in `fsck.test.ts`.
   Expected first failure: `TS2339` on `runMidxHealthPass` / `EXIT_MULTI_PACK_INDEX`.

   **Write the two negatives first — they are what a naive implementation gets wrong,
   and both are trivially easy to implement as findings:**

   | row | arrangement | Then | git row |
   |---|---|---|---|
   | dropped chain — **own `it` per cause**: missing layer, unreadable layer, bogus digest line, Tier-B layer, chain over the cap | no flat file | **no finding, `exitCode` bit 32 absent** | P2–P8, P20 |
   | Tier-B flat **rescued by a loadable chain** — **own `it`** | truncated flat + intact chain | **no finding**, bit absent | P17 |
   | broken chain + loadable flat — **own `it`** | | **no finding**, bit absent; the chain was never opened | P19 |

   then the positives:

   | row | arrangement | Then | git row |
   |---|---|---|---|
   | healthy / no midx | | no finding, exit 0 | O1, O2, P1 |
   | version 2 · `numBaseFiles` ≠ 0 · in-range `LOFF` — **own `it` each** | | no finding, exit 0 | O6, O20, O27, P21–P23 |
   | Tier-B flat, no chain — **one `it` per Tier-B member** | `size`, `chunk-table`, `chunk-length`, `hash-version` | one `midx-unusable` whose `reason` names the check; bit 32 | O7–O9, O16–O18 |
   | `chmod 000` / permission-denied flat — **own `it`** | `read` rejects for the flat path, `stat` succeeds | one `midx-unusable`; `flatFilePresent` still true | O18 |
   | trailer flipped, **flat** — **own `it`** | | one `midx-checksum-mismatch`; bit 32 | O10 |
   | trailer flipped, **chain head** — **own `it`** | | one `midx-checksum-mismatch` | P13 |
   | trailer flipped, **chain base layer** — **own `it`** | | **no finding**, exit 0 — the row that stops a well-meaning implementation verifying every layer | P12 |
   | `PNAM` unresolvable | | one `midx-pack-unresolved` (`position`, `pack` base name) **+** one `midx-entry-unresolved` per affected oid; bit 32 | O22 |
   | chain-global position — **own `it` each** for base layer and newest layer | 2-layer chain | `position` 0 and 1 respectively | P15, P14 |
   | midx-named pack deleted | | the same two families **plus** the ordinary connectivity findings; bit `32 \| 2 \| 8` | O23, O24 |
   | **`midx-entry-unresolved` WITHOUT `midx-pack-unresolved`** — **own `it`** | midx-named pack's `.idx` deleted, `.pack` kept | exactly that; plus the pack pass's two findings; bits `32 \| 4 \| 64` | O25 |
   | `large-offset` out of range — **own `it`** | `LOFF` row index ≥ `largeOffsetCount` | one `midx-unusable`, bit 32, **`fsck` resolves** — the contained Tier-A throw | O28 |
   | **the reject arm** — **own `it` per Tier-A member** | signature, version, required chunk, fanout, `PNAM` order (v1) | `fsck` **rejects**; `try`/`catch` on `.data.code` **and** `.data.check`; **no partial `FsckResult`** | O3–O5, O11–O15, P9–P11, P18 |
   | **mode is ungated** — every finding-producing row repeated under `connectivityOnly`, `full: false` and `strict` | | an **identical** bit and finding set. This is the direct counterpart of the pack pass's gated rows and the contrast is the point | Pin N |
   | bit composition, differential — **own `it`** | one repository, `fsck` with the midx and then with the midx file removed | `42` then `10`; only the difference proves bit 32 is the midx's own contribution | O23 vs O26 |
   | bit set once | a midx producing four findings | bit 32 appears once in `exitCode` | O22 |
   | `findingIds` | a `midx-entry-unresolved` finding | returns its oid | S-12 |

2. **GREEN** — land `midxHealth()`, `midx-health.ts`, the four variants, the exit
   constant, `fsck.ts`'s three lines and the `findingIds` arm.
3. **REFACTOR** — re-read `runMidxHealthPass` against §D12.7's row table line by line;
   confirm the contained `catch` is discriminated on `data.code` and that a non-`TsgitError`
   propagates; confirm the trailer is hashed **once** and never for a base layer; confirm
   `opts` is genuinely unread and the doc-comment says why; run `npm run docs:json` and
   stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck.properties.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fsck.ts src/application/commands/internal/fsck/midx-health.ts src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/exit-codes.ts src/application/primitives/pack-registry.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck-finding-ids.ts test/unit/application/primitives/object-resolver.test.ts
```

Plus in this part: `npm run docs:json` with `reports/api.json` staged in the same commit.

### Commit

`feat(fsck): report multi-pack-index findings and exit bit 32`

## Part 6 — cross-tool interop: the read path

### Context

**Goal.** The twin pins — every row asserting **both** git's observable outcome and
tsgit's structured outcome from the **identical on-disk state**. Requirements 8, 9 and 7.
Test-infra only — **no `src/` delta**.

**New shared helper module:** `test/integration/midx-fixture-helpers.ts`, sibling of
`test/integration/pack-fixture-helpers.ts` (174 lines, SHA-1 hard-coded at
`DIGEST_LENGTH = 20` because the `.idx` reader/writer both fix a 20-byte digest — keep
that doc-comment's honesty). Both interop suites in this plan import it, so the one byte
recipe that must stay identical cannot drift:

```ts
export function writeMultiPackIndex(dir: string): void;            // git multi-pack-index write
export function writeMidxChain(dir: string, appends: number): void;// … --incremental, N times
export function midxPaths(dir: string): { flat: string; chainDir: string; chainFile: string };
export function readChainDigests(dir: string): readonly string[];
export function mutateMidxOrThrow(path: string, op: MidxMutation): void;  // re-stamps the trailer
export function craftLoffMidx(bytes: Buffer, opts: { row: number; count: number }): Buffer;
```

**Two mutation disciplines are mandatory and both come from a row that lied before it
was fixed:** git writes chain layer files **`0444`** (the flat `multi-pack-index` is
`0644`), so **`chmod -R u+w` before every chain-layer mutation**; and the mutation helper
**throws on a failed write** rather than returning silently. The first Pin P run without
these measured four *healthy* repos and reported them as Tier-A rows, which would have
inverted Pin I3. `mutateMidxOrThrow` is the shared home for both.

`mutateMidxOrThrow` re-stamps the trailer over `[0, len − digestLength)` with the
algorithm the `hashVersion` byte selects, so the only thing wrong with a fixture is the
mutation the row named — except on the rows that deliberately corrupt the trailer.

**New file:** `test/integration/midx-interop.test.ts`, with the `@proves` block the audit
parses (`tooling/test-pyramid/parse-proves-header.ts`; `unique` must be 12–200 chars and
unique across the repo; bucket `cross-tool-interop` requires the file to sit **directly
in `test/integration/`**):

```
 * @proves
 *   surface:        pack.readMultiPackIndex
 *   bucket:         cross-tool-interop
 *   unique:         multi-pack-index reads, precedence and degradation match canonical git
 *   interopSurface: multi-pack-index
```

**Imports and idioms** — model on `test/integration/pack-version-interop.test.ts`
(545 lines): `GIT_AVAILABLE`, `git`, `gitAsync`, `runGit`, `runGitEnv`,
`tryRunGitWithExit` from `./interop-helpers.js` (every git spawn goes through them —
they strip **every** `GIT_*` from the env, point `HOME` at a non-existent path, set
`GIT_CONFIG_NOSYSTEM=1` and `GIT_CEILING_DIRECTORIES`; `git -C <dir>` alone does **not**
override an inherited `GIT_DIR`, and the husky pre-push hook leaks one),
`createNodeContext` from `src/adapters/node/node-adapter.js`, `readObject` /
`getPackRegistry` / `disposePackRegistry`, `enumerateObjects`. Wrap everything in
`describe.skipIf(!GIT_AVAILABLE)(…)`. `sut` = the tsgit `Context`
(`const sut = createNodeContext({ workDir: dir })` — on the `sutBindsResult` allowlist).
Follow `fsck-pack-accessibility-interop.test.ts`'s registry-leak oracle: a module-level
`liveContexts` array + a tracked context factory + `afterEach` disposing them.

**Five harness rules, each of which has already cost a false result once:**

1. One shared `beforeAll` **per fixture shape** with a named `const SETUP_TIMEOUT = 60_000`
   used as `beforeAll(async () => {…}, SETUP_TIMEOUT)` — heavy git-spawning interop
   suites time out hooks under `validate`'s concurrency.
2. **Build the tsgit `Context` *after* the last `git` subprocess has written.**
   Per-`Context` caches (the pack registry generation, the loose-object fanout cache) are
   invalidated only by tsgit's own writes; a `Context` created before a `git
   multi-pack-index write` holds a memoised generation that predates it. This suite
   mutates between the two tools constantly — it is a hard rule, not a note (§D5).
3. `chmod -R u+w` before every chain-layer mutation; `mutateMidxOrThrow` for every write.
4. Per-row repos, not one shared mutated repo.
5. Delete each fixture's `.rev` files before mutating, or the reverse-index axis
   contaminates the rows.

**Fixture recipes** (§Pinned matrices' method, reproduced so no row re-derives them):

- **`BASE`** — 3 packs, 9 packed objects, 1 unreferenced loose blob (`LOOSE`), one blob
  per pack (`OID1`, `OID2`, `OID3`), flat midx. Multi-pack shape is built by
  `git repack -adq` for the first pack, then `git repack -dq` with `.keep` files on the
  existing packs so each commit lands in its own pack.
- **`DUP`** — 2 packs where **the same blob is in both**; the midx assigns it to pack A.
  **The only fixture that can distinguish "midx is an accelerator" from "midx is
  authoritative"** — without it the whole ADR-592 axis is untested.
- **`CHAIN`** — an incremental chain built one `--incremental` append at a time, in the
  `DUP` shape for the layered rows. **Two layers is the deepest this recipe reaches at
  this repo size** — a third append collapses the chain into a flat file and empties
  `multi-pack-index.d/`. Rows needing three layers are absent by construction.

**Rows.** The healthy twin (requirement 8: every object, with and without a midx,
byte-for-byte through `readObject` and through `git cat-file -p`); **Pin G**'s 17 rows;
**Pin H**'s 8 rows on `DUP`; **Pin I**'s 10 rows; **Pin J**'s 6 rows; **Pin D**'s read
rows (D4–D8); **Pin F**'s two rows; **Pin L5**. Label each `it`'s Given with its pin id
(`(row G7)`) as `fsck-pack-accessibility-interop.test.ts` labels `(row K-1)`.

**Assertion discipline.**

- **Tier-A rows assert a refusal on both sides**: git's exit 128 with the object
  unserved, and tsgit's thrown `INVALID_MULTI_PACK_INDEX` with the matching `check`.
  **The `LOOSE` blob is read in every Tier-A row** — that is §D4.5's cross-tool proof and
  it cannot be made at unit scale, because only real git can confirm the loose read
  genuinely fails there too.
- Per ADR-249 the git stderr transcripts (`error:` / `warning:` / `fatal:`) are
  **reconstructed inside the test** from tsgit's structured fields and compared to git's;
  the library emits no such line. Message **cardinality** is presentation — assert
  occurrence, never whole-stderr equality.
- Rows G8 and O10's condition (a wrong trailer) must show the midx is **still used** on
  the read path in both tools — that is ADR-602's whole point and it is easy to get
  backwards.

### TDD steps

1. **RED** — create `midx-fixture-helpers.ts` and the suite skeleton with the `@proves`
   block, the three fixture builders and the healthy twin row. Expected first failure:
   `TS2307` on the helper module, then a real mismatch on the twin row if any fixture
   builder is wrong.
2. **RED** — write the Pin G, H, I, J, D, F and L5 rows, one `it` each, each with its own
   repo. Expected failure mode on a mistake: a row reports a **healthy** repo on both
   sides (exit 0, object reads) — that is the signature of a skipped `chmod` or a
   swallowed mutation, not a passing row. `mutateMidxOrThrow` exists to make that
   impossible; if a row still shows it, the helper was bypassed.
3. **GREEN** — iterate until every row matches on both sides. **A mismatch is a finding
   about the implementation, not about the test**: fix `src/` in this part's commit, or
   escalate `{ part, reason, ≤3 options }`. Resolve every divergence in favour of git
   (prime directive).
4. **REFACTOR** — factor the per-row "fresh repo + fixture shape + one mutation" into one
   local helper so each row reads as arrangement → git assertion → tsgit assertion.
   Confirm `npm run check:test-pyramid` is happy (integration share rises toward its 15 %
   target; the `overMockedIntegration` heuristic forbids `vi.mock`/`vi.fn`/`vi.spyOn` in
   this tier) and that `tooling/audit-write-surfaces.ts` needs no `@writes` edit.

### Gate

```
npx vitest run test/integration/midx-interop.test.ts test/integration/pack-version-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/midx-interop.test.ts test/integration/midx-fixture-helpers.ts
```

Plus in this part: `npm run check:test-pyramid` and `npm run check:write-surfaces`
(**S-14** — the new `interopSurface: multi-pack-index` is recorded as orphan coverage
and the gate must still exit **0**; do not "fix" it by adding a `@writes` annotation,
which §D8 W-5 forbids).

### Commit

`test(pack): pin multi-pack-index reads against real git`

## Part 7 — cross-tool interop for `fsck`, cross-adapter parity, and the bench

### Context

**Goal.** The executable form of Pins N, O and P; proof that the three adapters agree;
and the measurement that carries §D7's claim. Test-infra only — **no `src/` delta**.
Three deliverables, one commit.

**(a) New file:** `test/integration/midx-fsck-interop.test.ts` — a **separate** file from
Part 6's read-path twin, following 28.1a's precedent of giving the fsck axis its own
suite. `@proves`:

```
 * @proves
 *   surface:        fsck.multiPackIndex
 *   bucket:         cross-tool-interop
 *   unique:         fsck multi-pack-index findings and exit bits match canonical git
 *   interopSurface: multi-pack-index
```

Imports Part 6's `midx-fixture-helpers.ts` verbatim — including `mutateMidxOrThrow` and
the `chmod -R u+w` discipline, which this suite needs more than Part 6 does (it mutates
chain layers on almost every row). Same five harness rules, same `SETUP_TIMEOUT = 60_000`,
same fresh-`Context`-after-every-`git`-subprocess rule.

**Rows:** all **28** Pin O rows and all **23** Pin P rows, each asserting **both**
`git fsck`'s exit integer and tsgit's `FsckResult.exitCode`, plus the finding set against
§D12.7's table. The Pin N mode table is a fourth axis over the six shapes it names
(healthy · flat Tier-B · trailer flipped · `PNAM` unresolvable · midx-named pack deleted ·
`LOFF` out of range) × (default · `--connectivity-only` · `--no-full` · `--strict`).

Three assertions that are the reason this suite exists:

- **Assert the exit integer, reconstruct the transcript.** The integer is data the prime
  directive binds; the `error:` / `warning:` / `fatal:` lines **and their cardinality**
  are presentation (Pin O rule 5 — the same cause line appears three times under `fsck`
  and once under `verify`), so they are rebuilt from tsgit's structured findings and
  compared, never emitted by the library.
- **The differential pair (O23 vs O26) runs as one row over one repository**, the midx
  removed between the two halves, because only the difference isolates bit 32
  (`42 = 2|8|32` vs `10 = 2|8`).
- **The `verify` cross-check.** Every row also records
  `git multi-pack-index verify --object-dir … --no-progress`'s exit, and the suite
  asserts the Pin N mapping directly: **verify non-zero ⟺ fsck gains bit 32, whenever the
  parent survives.** This is a cheap invariant over the whole matrix and it would catch a
  future git changing the child-process arrangement — the one assumption §D12.1 rests on.
  Row **O28**'s `--connectivity-only` **128** is the *parent* dying (that mode decodes the
  offending offset in the parent walk), not the pass behaving differently: assert it as
  the parent/child split, with a comment, or it reads as a contradiction of the mode
  table.

Rows P9–P11 and O3–O5/O11–O15/P18 are the reject rows: `fsck` **rejects** with
`.data.code === 'INVALID_MULTI_PACK_INDEX'` and the matching `.data.check`, and **no
partial `FsckResult`** — asserted with `try`/`catch`, against git's exit 128 and empty
stdout.

**(b) New parity scenario:** `test/parity/scenarios/midx-read.scenario.ts`, registered in
`test/parity/scenarios/index.ts` (import + append to `SCENARIOS`, currently 38 entries).
Model it on `test/parity/scenarios/pack-v3-read.scenario.ts` (59 lines — read it whole;
it is the template) and use `writeScenarioPackPair(repo, { name, content, version? })`
from `./pack-pair.ts` to plant packs, then hand-write a flat midx over them with Part 1's
builder logic ported into the scenario (parity scenarios import with **`.ts`** extensions
and are bundled for the browser by `tooling/build-parity-bundle.ts`).

Contract, from `scenarios/types.ts`: `{ name, inputs: { files, author, message },
expected, run(repo, inputs), unsupportedRuntimes? }`. **`expected` must be a
deterministic projection with no oids** (`npm run check:parity-fixtures` runs
`detectNondeterministic` over the directory and exits 1 on any finding). The docblock ends
with a `Surfaces closed:` list, and `run` carries `// Arrange` / `// Act` / `// Assert`
comments.

Legs the scenario must run, and why each earns its place:
1. a **healthy** flat midx — `readBlob` returns the packed content on every adapter;
2. a **stale** midx (a named pack removed) — the read **misses** identically on every
   adapter, which is ADR-592's authority verified where each adapter produces its own
   `FILE_NOT_FOUND`/`PERMISSION_DENIED` codes;
3. a **Tier-B** midx — the read succeeds from the `.idx` scan;
4. `repo.fsck()` over the stale fixture — the projected finding-type census and
   `exitCode`.
Project to counts, type names, booleans and the caught `.data.code`/`.data.check` —
never an oid.

The browser adapter has no `openWithNoFollow`, but the midx path uses `ctx.fs.read`
only, so the fallback machinery is never exercised — **that is itself the assertion**.
`npm run test:parity` (in `validate`) runs the **node and memory** drivers only; the
**browser** leg is `test/browser/parity.spec.ts` under Playwright (`npm run test:e2e`,
**not** part of `validate`) and CI is its authority — do not chase a local browser run.
If the workers runtime-parity job diverges, the designed escape hatch is the scenario's
`unsupportedRuntimes: ['workers']` field **with the reason documented in the scenario** —
never a weakened expectation. Treat that as a blocker to surface, not a silent edit.

**(c) Bench:** `test/bench/midx-lookup.bench.ts` plus a fixture extension.

- `test/bench/support/fixture-generator.ts` (509 lines) exports `FixtureSpec`
  (`label`, `strategy`, `commits`, `blobs`, `blobBytes`, `deltaDepth?`, `deltaWindow?`,
  `commitGraph?`), the named specs, `ScaledFixture` and
  `ensureScaledFixture(spec): Promise<ScaledFixture>` (cached under
  `~/.cache/tsgit-bench` behind a `FixtureMeta` sidecar — **bump its `version` field**, or
  a stale cache serves a fixture without packs). Add a `packs?: number` and a
  `midx?: boolean` field plus a `'many-pack'` strategy that builds P packs by the
  `repack -adq` / `.keep` / `repack -dq` recipe and then runs
  `git multi-pack-index write`. `commitGraph?` is the existing precedent for a
  "run one more git command after the build" flag — follow it exactly.
- `tooling/gen-bench-fixture.ts` (48 lines, CLI
  `node --experimental-strip-types tooling/gen-bench-fixture.ts <medium|large|delta-chain>`,
  wired as `npm run bench:fixture -- large`) gains the new label in its map and its usage
  string.
- The bench file uses `benchScenario(given, whenThen, build, opts?)` from
  `test/bench/support/bench-dsl.ts`. **`BenchComparison.baseline` is optional — omit
  it.** The two `bench()` names inside `benchScenario` are exactly `tsgit` and
  `isomorphic-git`, and `tooling/bench-summarize.ts`, `tooling/bench-to-snapshot.ts` and
  the `benchmark-compare` CI job all key on them, so a "with vs without midx" comparison
  must be **two separate `benchScenario` givens**, never a re-labelled baseline.
- **Three rows, not one** (§D7's regression guard): P = 1 with **no** midx; P = 1
  **loose-only** (the §D4.5 `assertLoadable` gate in isolation); the many-pack win, as a
  with-midx given and a without-midx given over the same fixture, for a
  hit-in-the-first-pack and a hit-in-the-last-pack workload.
- `resolveScaledContext` already skips when `STRYKER_MUTANT_ID` is set — do not add a
  second guard. **Published numbers must come from the CI nightly `bench.yml` artefact,
  never a local run**: local measurement under session load has been shown to bias
  syscall-heavy paths by up to 2.4×. This part asserts nothing about wall-clock; it lands
  the instrument.

### TDD steps

1. **RED** — write `midx-fsck-interop.test.ts` with the Pin O rows first (flat form,
   simpler mutations), one `it` per row, then the Pin P rows (chain form). Expected first
   failure: a row-by-row exit-integer mismatch the first time the suite runs. Write the
   `chmod -R u+w` step into the shared per-row helper so no row can forget it.
2. **RED** — add the Pin N mode table as its own `describe`, four modes × six shapes,
   asserting an identical bit and finding set per shape.
3. **RED** — add `midx-read.scenario.ts` and register it; run
   `npx vitest run --project parity`. Expected first failure: the `expected` literal does
   not match the computed projection — fill it from the node run, then confirm the memory
   driver agrees **without** touching the expectation.
4. **RED** — add the fixture spec, the CLI label and `midx-lookup.bench.ts`; run
   `npm run test:bench` once to confirm the scenarios register and the fixture builds.
   Expected first failure: `ensureScaledFixture` serving a cached fixture with no packs —
   the signature that the `FixtureMeta` version was not bumped.
5. **GREEN** — resolve every mismatch in favour of git. A divergence here is a finding
   about Parts 3/4/5 and fixing it belongs in this part's commit, or is escalated as
   `{ part, reason, ≤3 options }`.
6. **REFACTOR** — collapse repeated fixture crafting into local helpers; verify
   `npm run check:parity-fixtures`, `npm run check:browser-surface` and
   `npm run check:test-pyramid` all pass, and that the scenario's `expected` carries
   **no oid**.

### Gate

```
npx vitest run test/integration/midx-fsck-interop.test.ts && npx vitest run --project parity && npm run check:types && ./node_modules/.bin/biome check test/integration/midx-fsck-interop.test.ts test/integration/midx-fixture-helpers.ts test/parity/scenarios/midx-read.scenario.ts test/parity/scenarios/index.ts test/bench/midx-lookup.bench.ts test/bench/support/fixture-generator.ts
```

Plus in this part: `npm run check:parity-fixtures`, `npm run check:browser-surface`,
`npm run check:test-pyramid`. Note `tooling/gen-bench-fixture.ts` is **not** in
`biome.json`'s `files.includes` whitelist, so biome does not lint it — but
`npm run check:types` does type-check it (`tooling/**/*.ts` is in that gate's file set).

### Commit

`test(midx): pin fsck parity, cross-adapter agreement and the lookup bench`

## Phase gate

```
npm run validate
```

Then, before any push: re-run `npm run check:spelling` **fresh** and confirm
`reports/api.json` is regenerated and committed — a green wireit-**cached** `validate`
can still precede a red prepush, because `check:spelling` and `check:doc-typedoc`
cache-skip after later-phase edits, and `check:doc-typedoc` is a **prepush-only** gate
that `validate` never runs.

`npm run test:mutation` is not part of `validate` or `prepush`; it gates the PR in its
own phase. The two mutation hotspots this change creates are named in Parts 1 and 2:
the midx fanout binary search's `lo` narrowing (an equivalent mutant whose proof must be
**re-derived against the midx's stride**, never copied from `pack-index.ts`), and the
three pre-existing `// Stryker disable` comments in `pack-registry.ts`, whose proofs are
structure-specific and are falsified by Part 2's restructuring of the code around them.
