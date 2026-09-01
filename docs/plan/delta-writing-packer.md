# Plan — delta-writing packer

> Source: design doc `docs/design/delta-writing-packer.md` · ADRs 767, 768, 769, 770, 771,
> 772, 773, 774, 775, 776, 777, 778
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## How to read the design doc

The design's **`## Ratified decisions — authoritative`** section (L122–181) overrides every
contrary statement later in the document, **including the whole `## Decision candidates`
table**. It carries seven inline corrections; this plan already applies them. Where the
design body and an ADR disagree, the ADR wins. Concretely, and contrary to the design body:

| Design body says | The ratified truth this plan implements |
|---|---|
| §3 adds a sibling `PackWriterDeltaEntry` and keeps `PackWriterEntry` (R13 "additive") | ADR-776: `PackWriterEntry` **becomes** the union. Breaking, folded into the pending 4.0.0 |
| §5 / R11 permutes metas back into `input.oids` order | ADR-769: `{ id, crc32, offset }` in **emission order**; the positional contract is deleted |
| §4c / §7 gate residency with `MAX_DELTIFY_BYTES` | ADR-772: no such constant. `pack.windowMemory` bounds window residency |
| §8 config surface is `pack.window` + `pack.depth` | ADR-773: plus `pack.windowMemory` |
| §9 clamps the writer to 49 | ADR-771: fix `walkDeltaChain` to `depth <= MAX_DELTA_CHAIN_DEPTH`; writer clamps to 50 |
| §10 recommends gc-only opt-in | ADR-767: gc ×3 **plus** `pack-objects` **plus** `bundle-create`. `push` stays base-only |
| §6 claims a memory-bounded window would break determinism | Retracted in the corrections; measured byte-identical across runs |

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Public-vs-internal, decided up front

| New symbol | Verdict | Gates tripped (pre-paid in the owning part) |
|---|---|---|
| `serializeDelta`, `encodeDelta` (`src/domain/storage/delta-encode.ts`) | **public** — barrelled from `src/domain/storage/index.ts`, which `src/domain/index.ts` re-exports and typedoc treats as an entry point. Every other codec in this module is barrelled as a pair (`applyDelta`/`parseDelta`, `encodePackEntryHeader`/`parsePackEntryHeader`, `serializePackRevIndex`/`parsePackRevIndex`); leaving the encoder out would make delta the one asymmetric codec | barrel + `npm run docs:json` → commit `reports/api.json` (Part 1) |
| `DeltaIndex`, `createDeltaIndex`, `encodeDeltaFromIndex` | **internal** — implementation detail of the window. Not barrelled. knip does not flag them because `deltify.ts` (Part 6) imports them and `deltify` is reachable from the primitives barrel via `build-pack.ts` | none |
| `PackWriterEntry` re-shaped into a union | **public, breaking** — already in `reports/api.json` (`qualifiedName` rows near L211260) | `npm run docs:json` → commit `reports/api.json` (Part 2). Prepush gate `check:doc-typedoc`, NOT a validate gate: local validate can be green while the push hook rejects |
| `readObjectMetadata` (`src/application/primitives/read-object.ts`) | **internal** — not barrelled, mirroring `readRawObject`/`RawObject`, which `types.ts:84-88` documents as "Internal-only — not re-exported from the primitives barrel". ADR-778's "independently useful to the batch-check read surface" is a future use, not this change | none |
| `ParsedConfig.pack.{window,depth,windowMemory}` | **public (additive)** — `ParsedConfig` is barrelled from `src/application/primitives/index.ts:18` and rides `public-types.ts`'s `export type *` | `npm run docs:json` → commit `reports/api.json` (Part 4) |
| `findFirstInvalidPackInt`, `assertValidPackIntConfig`, `InvalidPackIntEntry` | **public** — sit beside `findFirstInvalidGcAuto` / `assertValidGcAutoConfig`, which are already barrelled from `config-read.js` | barrel + `reports/api.json` (Part 4) |
| `BuildPackResult.entries` element type → `PackIndexWriterEntry` | **public, breaking** — `BuildPackResult` is barrelled (`primitives/index.ts:11`) | `reports/api.json` (Part 5) |
| `BuildPackInput.delta?: boolean` | **public (additive)** | `reports/api.json` (Part 6) |
| `deltify` / `deltifyEntries` (`primitives/internal/deltify.ts`) | **internal** — the whole `primitives/internal/` tree is unbarrelled by construction | none |
| `comparePackEmissionOrder`, `acceptsDeltaEntry`, `resolveDeltaPolicy` (`src/domain/storage/delta-policy.ts`) | **internal to `src/`** — NOT barrelled. Used by `deltify.ts`. knip is satisfied through that import chain; there is no consumer story for a pack-selection comparator | none |
| `objectTypeToPackEntryType` (`src/domain/storage/pack-entry.ts`) | **public** — the exact mirror of the already-public `packEntryTypeToObjectType` (`pack-entry.ts:229`), and barrelling it is what lets `build-pack.ts` delete its private `packEntryTypeFor` duplicate | barrel + `reports/api.json` (Part 6) |

**No new Tier-1 command, no new error code, no new discriminated-union member.** So none of
`check:doc-coverage`, `audit-browser-surface`, the `Repository` facade, the sorted
`Object.keys(sut)` snapshot in `test/unit/repository/repository.test.ts`, the "N Tier-1
commands" README line, nor `src/domain/error.ts`'s exhaustiveness switches are touched.
`configBadNumericValue` with the existing `'invalid unit'` / `'out of range'` reasons is
reused verbatim (ADR-773).

## Repo-wide facts every part needs

- **Part gate** (each part runs it before committing):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`
- `npm run check:types` and `npm run check:spelling` are **wireit-cached**;
  `Ran 0 scripts and skipped 1` reads exactly like a pass. Bypass with
  `npx tsc --noEmit -p tsconfig.typecheck.json` and `npx cspell --no-progress <files>`.
  Never read a gate through a pipe — `… | tail` masks the exit code.
- Coverage gate covers `src/domain/**`, `src/ports/**`, `src/adapters/{node,memory}/**`,
  `src/operators/**` at **100 %** line/branch/function/statement (`vitest.config.ts:80-98`).
  Stryker mutates **all** of `src/`. So `delta-encode.ts` and `delta-policy.ts` are
  coverage-gated *and* mutated; `deltify.ts`, `build-pack.ts`, `config-read.ts`,
  `gc-pipeline.ts` are mutated only — write their tests to the same standard anyway.
- Error assertions assert **data** (`code`, `reason`, `offset`, `value`) via try/catch,
  never a bare `toThrow(Class)`. A guard of the form `if (A || B)` gets one test per
  condition, triggering each alone.
- Test titles: `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA body with
  section comments; the function under test is bound to `sut` (never the result — the result
  goes in `result`).
- `cspell.json` already carries `deltified`, `deltify`, `deltifying` (L238-241). No dictionary
  edit needed.
- **No provenance refs in code or tests** — no `§`, `Phase`, `ADR-`, `R14`, `DC-3`, `Pin W`,
  `X8` markers in any `src/` or `test/` file. Those tokens exist only in this plan and in
  `docs/`. Comments explain *why*, in their own words.
- Real git on this machine is **2.55.0** (`/opt/homebrew/bin/git`). Every state-mutating
  probe runs in a `mktemp -d` throwaway with isolated `HOME`/`XDG_CONFIG_HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, all `GIT_*` scrubbed and signing off —
  `test/integration/interop-helpers.ts` already exports `runGitEnv()`, `git(dir, …)`,
  `runGit`, `GIT_AVAILABLE`, `disableAutoMaintenance(dir)` for exactly this.
- macOS has **no `timeout(1)`**. `rtk grep` truncates at ~200 lines per file — use
  `command grep` for any "find every occurrence" question.

---

## Part 1 — The delta instruction codec

### Context

**Create** `src/domain/storage/delta-encode.ts` — pure domain, zero outward deps, sibling of
`delta.ts`. **There is no delta encoder anywhere in `src/` today**; the grammar to emit is
exactly the one `src/domain/storage/delta.ts` already parses, so read that file first and
write this one as its inverse.

Read-side functions being mirrored, all in `src/domain/storage/delta.ts`:

| Decoder (existing) | Line | Inverse to write |
|---|---|---|
| `readVariableLengthInt(bytes, offset)` — 7 bits/byte, least-significant group first, `0x80` continuation, `MAX_VARINT_BYTES = 5` (`delta.ts:28`), refuses a 6th byte with `invalidDelta('variable-length integer too long')` | 30-60 | `encodeDeltaVarInt(value)` |
| `decodeCopyFields(bytes, pos, cmd)` — offset bits `0x01/0x02/0x04/0x08` (LE bytes 0..3), size bits `0x10/0x20/0x40` (LE bytes 0..2), then **`if (size === 0) size = 0x10000`** | 74-122 | `encodeCopy(offset, size)` |
| `parseDelta`'s insert arm — `cmd` is the literal length, `cmd === 0` throws `'INSERT with N=0 is reserved'` | 244-255 | `encodeInsert(data)` |
| `validateDeltaHeader(base, sourceLength, targetLength)` — requires `base.length === sourceLength` **exactly**; `MAX_TARGET_LENGTH = 2 * 1024**3` (`delta.ts:143`) | 145-152 | header = `encodeDeltaVarInt(sourceLength) ++ encodeDeltaVarInt(targetLength)` |

Error factory: `invalidDelta(reason)` from `src/domain/storage/error.js` →
`new TsgitError({ code: 'INVALID_DELTA', reason })` (`error.ts:83-84`). Reuse it; **no new
error code**.

**Public API of the new module** (exactly four exported names plus one exported type):

```ts
export const DELTA_BLOCK_BYTES = 16;
export const MAX_INSERT_BYTES = 127;
export const MAX_COPY_BYTES = 0xffffff;
export const MAX_CANDIDATES_PER_BUCKET = 6;

export interface DeltaIndex {
  readonly base: Uint8Array;
  readonly heads: Int32Array;   // bucket -> most recent block index, or END_OF_CHAIN
  readonly next: Int32Array;    // block index -> previous block in the same bucket
  readonly mask: number;        // bucketCount - 1 (bucketCount is a power of two)
}

export function serializeDelta(
  sourceLength: number,
  targetLength: number,
  instructions: ReadonlyArray<DeltaInstruction>,   // from './delta.js'
): Uint8Array;

export function createDeltaIndex(base: Uint8Array): DeltaIndex;
export function encodeDeltaFromIndex(
  index: DeltaIndex, target: Uint8Array, maxSize?: number,
): Uint8Array | undefined;
export function encodeDelta(
  base: Uint8Array, target: Uint8Array, maxSize?: number,
): Uint8Array | undefined;   // = encodeDeltaFromIndex(createDeltaIndex(base), target, maxSize)
```

The three-function split is forced by ADR-770: the sliding window builds each member's index
**once on admission** and reuses it against every later target, so the index must be a
first-class value. `encodeDelta` is the convenience entry the round-trip property uses.

**Encoder rules — each one is forced by the decoder above, do not improvise:**

1. `encodeCopy` pushes a byte **only when it is non-zero**, setting the matching `cmd` bit.
   Consequence, and the design's own §Test-strategy row for this is **wrong**: a copy of size
   exactly `0x10000` emits `cmd = 0x80 | 0x40 = 0xc0` and **one** size byte `0x01` — not
   three bytes `00 00 01`. `decodeCopyFields` reconstructs `0 | 0 | (0x01 << 16) = 0x10000`
   through the ordinary path. Assert `0xc0, 0x01`.
2. The `size === 0 → 0x10000` shorthand is **readable but never written**. It is unreachable
   because a zero-length copy is refused (rule 3), so no `if (size === 0x10000)` special case
   exists in the encoder.
3. `serializeDelta` refuses, each as its **own** guard with its **own** isolated test —
   never a combined `if (A || B)`:
   - copy `size === 0` → `invalidDelta('COPY size must be non-zero')`
   - copy `size > MAX_COPY_BYTES` → `invalidDelta(\`COPY size ${size} exceeds ${MAX_COPY_BYTES}\`)`
   - copy `offset` outside `0 .. 0xffffffff` → `invalidDelta(...)`
   - insert `data.length === 0` → `invalidDelta('INSERT with N=0 is reserved')`
   - insert `data.length > MAX_INSERT_BYTES` → `invalidDelta(...)`
   - a length varint needing more than 5 bytes (i.e. `>= 2**35`) →
     `invalidDelta('variable-length integer too long')`, mirroring `readVariableLengthInt`
     verbatim.
   These guard a *caller bug* (a fixture, a future encoder). `encodeDelta` can never trip
   them: it splits literals at `MAX_INSERT_BYTES` and truncates matches at `MAX_COPY_BYTES`
   before calling into the byte emitters.
4. `encodeDeltaVarInt` uses `>>> 7` (unsigned), so a `sourceLength` of `2**32 - 1` round-trips
   through `readVariableLengthInt`'s `>>> 0` accumulation.

**`createDeltaIndex` — ADR-770 is binding on the data structure.** Two `Int32Array`s over
non-overlapping fixed 16-byte blocks (`DELTA_BLOCK_BYTES`), last partial block dropped;
`blockCount = Math.floor(base.length / DELTA_BLOCK_BYTES)`. Block hash is a plain
multiplicative hash over the 16 bytes computed with `Math.imul` — deterministic, no floating
point. `heads` is sized to `nextPowerOfTwo(max(blockCount, 1))`, both arrays filled with an
explicit `END_OF_CHAIN = -1` sentinel; `heads[bucket]` holds the **most recent** block index
and `next[i]` chains backwards. **No `Map`, no `Set`, no per-block object anywhere.**

> **Deliberate divergence from the design's §2b:** there is **no `MAX_INDEX_BUCKETS`
> constant.** The bucket count is already `O(blockCount)` = `base.length / 16` entries, so
> the index is bounded at `~base.length / 2` bytes without a cap, and a cap would introduce
> a constant whose mutant is only observable on a ≥16 MiB base — an unkillable mutant with
> no unit test that can reach it. `MAX_CANDIDATES_PER_BUCKET = 6` **stays** (it is killable:
> a base of ≥8 identical 16-byte blocks makes the 7th-oldest unreachable, which changes the
> chosen match deterministically).

**The match loop** (`encodeDeltaFromIndex`), emitting bytes incrementally and tracking the
emitted length so `maxSize` can abort mid-stream:

1. Emit the header (`sourceLength = index.base.length`, `targetLength = target.length`).
2. Walk `target` from `pos = 0`. With fewer than `DELTA_BLOCK_BYTES` bytes left, everything
   remaining is literal — flush and stop.
3. Hash `target[pos .. pos+16)`, walk that bucket's chain most-recent-first for at most
   `MAX_CANDIDATES_PER_BUCKET` entries. For each candidate block offset, extend **forward**
   while bytes agree (bounded by `MAX_COPY_BYTES` and both buffers' ends) and **backward**
   while bytes agree *and* the backward extension does not cross into already-emitted output
   (this is why pending literals must be a *shrinkable* buffer, not already-emitted bytes).
   Keep the longest; ties break on the **lower base offset**.
4. Best match `< DELTA_BLOCK_BYTES` ⇒ the byte at `pos` is a pending literal, `pos += 1`.
5. Otherwise flush pending literals as `INSERT`s of at most `MAX_INSERT_BYTES`, emit the
   `COPY`, `pos += matchLength`.
6. Return `undefined` the moment emitted length exceeds `maxSize` (including "before any
   instruction", when `maxSize` is smaller than the header itself).

**Totality (the safe domain):** `base.length <= 2**32 - 1` and
`target.length <= MAX_TARGET_LENGTH`. Every position has "emit the byte as a literal" as its
fallback, so `encodeDelta` never throws inside that domain. `DELTA_BLOCK_BYTES` is also the
minimum copy length — do **not** introduce a second `MIN_COPY_BYTES` constant; one constant
serving both roles means one mutant instead of an unkillable duplicated pair.

**Barrel** — add to `src/domain/storage/index.ts`, in the existing `// Delta` block (L9-10,
currently `export type { CopyInstruction, DeltaInstruction, DeltaParsed, InsertInstruction }
from './delta.js';` / `export { applyDelta, parseDelta, readDeltaTargetSize } from
'./delta.js';`):
`export { encodeDelta, serializeDelta } from './delta-encode.js';`
Nothing else from the module is barrelled.

**Tests to write / extend:**

- **New** `test/unit/domain/storage/delta-encode.test.ts` — example tests. Cases:
  `encodeDeltaVarInt` 0 / 127 (1 byte) / 128 (2 bytes, continuation set) / a 5-byte value /
  a 6-byte value refused. `encodeCopy` offset 0 (no offset bytes) / each of the four offset
  byte positions in isolation / each of the three size byte positions in isolation / size
  `0x10000` → `0xc0, 0x01` and `decodeCopyFields` reads it back as `0x10000` /
  `MAX_COPY_BYTES` / `MAX_COPY_BYTES + 1` refused. `encodeInsert` 1 byte / 127 bytes /
  128 bytes refused. `encodeDelta`: identical base and target → one copy and no inserts /
  disjoint content → all inserts / prefix match / suffix match / a match needing **backward**
  extension (an anchor starting mid-block) / target shorter than one block / empty target /
  empty base. Abort: `maxSize` below the header → `undefined` before any instruction;
  `maxSize` crossed mid-stream → `undefined`. `createDeltaIndex`: a base of ≥8 identical
  16-byte blocks exercising `MAX_CANDIDATES_PER_BUCKET`; a base shorter than one block
  (empty index, all-inserts fallback).
- **New** `test/unit/domain/storage/delta-encode.properties.test.ts` — `fast-check`. P1
  `applyDelta(base, encodeDelta(base, target)!) ≡ target`, `numRuns: 200`; P2
  `parseDelta(serializeDelta(src, tgt, instructions)) ≡ { sourceLength, targetLength,
  instructions }`, `numRuns: 200`; P3 `encodeDelta` never throws and always returns a
  `Uint8Array` when `maxSize` is omitted, `numRuns: 200`; P4 the emitted stream carries no
  `cmd === 0` at an instruction boundary and every INSERT length is in `1..127`,
  `numRuns: 100`; P5 `encodeDelta(x, x)!.length < x.length` for `x` longer than
  `DELTA_BLOCK_BYTES * 4`, `numRuns: 100`. **Never commit a seed.**
- **Extend** `test/unit/domain/storage/arbitraries.ts` — this is the shared generator module
  for the family (`fc` is already imported at L1). Add `arbDeltaBaseTarget()`: a `base` plus
  a `target` drawn *either* from independent random bytes *or* from a mutation of `base`
  (splice / duplicate a run / truncate / append), so P1 exercises real matching instead of
  degenerate all-insert cases. Add `arbSerializableInstructions()` for P2 — inserts of
  1..127 bytes, copies with `size` in `1..MAX_COPY_BYTES` and `offset + size <= sourceLength`.
- **Repoint the duplicate serialiser.** `test/unit/domain/storage/arbitraries.ts:118-207`
  already carries a hand-rolled `buildDelta` / `encodeDeltaVarInt` /
  `encodeCopyInstruction` / `encodeInsertInstruction` — a duplicate of what this part puts
  in `src/`. Rewrite `buildDelta` to delegate to `serializeDelta` and delete the three
  private helpers.
  🔴 **Trap that will otherwise break the 100 % branch gate.** The old
  `encodeCopyInstruction` maps `size === 0x10000` to the shorthand (`effectiveSize = 0`, no
  size bytes at all). `serializeDelta` deliberately never emits that shorthand, so
  `decodeCopyFields`'s `if (size === 0) size = 0x10000;` branch (`delta.ts:117-119`) would
  become uncovered. Its only cover today is
  `test/unit/domain/storage/delta.test.ts:143-160` ("Given base >= 64KB and delta with COPY
  size=0 (→ 0x10000)"). Keep that branch covered by giving that one test a literal
  hand-built delta (header varints ++ the single byte `0x80`) instead of a `buildDelta` call
  — the test's stated subject *is* the shorthand byte shape, so a literal is the honest
  fixture. Every other `buildDelta` call site in that file (there are ~25, all with
  inserts ≤ 50 bytes and copies ≤ 200 bytes, verified) stays inside `serializeDelta`'s
  guards and needs no change.
  Note `check:duplicates` runs `jscpd src/` only — it does **not** scan `test/`, so the
  duplication was never gate-visible. Repoint it for correctness-of-oracle, not for the gate.
- **Surface gate:** `npm run docs:json`, then commit the regenerated `reports/api.json`. The
  typedoc-id diff is large and normal.

### TDD steps

1. **RED** — `delta-encode.test.ts`, `serializeDelta` header + one INSERT round-trips through
   `parseDelta`. Fails: `Cannot find module '../../../../src/domain/storage/delta-encode.js'`.
2. **GREEN** — `delta-encode.ts` with `encodeDeltaVarInt`, `encodeInsert`, `serializeDelta`
   over the insert arm only.
3. **RED** — every `encodeCopy` bit-position case, one test per offset byte (`0x01`, `0x02`,
   `0x04`, `0x08`) and per size byte (`0x10`, `0x20`, `0x40`), plus size `0x10000` asserting
   the exact bytes `0xc0, 0x01`. Fails: copy arm unimplemented.
4. **GREEN** — `encodeCopy`, wired into `serializeDelta`.
5. **RED** — each refusal from rule 3 as its own test, asserting `err.data` `{ code:
   'INVALID_DELTA', reason: <exact string> }` via try/catch. Fails: no guards yet.
6. **GREEN** — the six independent guards.
7. **RED** — `createDeltaIndex` over a base of 8 identical 16-byte blocks: assert `heads`
   has one non-sentinel bucket and the `next` chain visits the block indices in
   most-recent-first order. Fails: `createDeltaIndex` unimplemented.
8. **GREEN** — `createDeltaIndex` (two `Int32Array`s, `Math.imul` hash, `END_OF_CHAIN = -1`,
   power-of-two bucket count).
9. **RED** — the `encodeDelta` example matrix (identical / disjoint / prefix / suffix /
   backward-extension / short target / empty target / empty base) plus both abort cases.
   Fails: `encodeDeltaFromIndex` unimplemented.
10. **GREEN** — the match loop with pending-literal buffer, backward extension,
    `MAX_CANDIDATES_PER_BUCKET` cap and the `maxSize` abort.
11. **RED** — `delta-encode.properties.test.ts` P1–P5 with the new arbitraries. P5 is the
    one that fails on a naive block-only matcher; P1 shrinks to a counterexample if backward
    extension crosses emitted output.
12. **GREEN** — fix whatever P1/P5 shrink to.
13. **REFACTOR** — barrel `encodeDelta` + `serializeDelta`; repoint `buildDelta` at
    `serializeDelta` and delete the three private test encoders; convert the `0x10000`
    shorthand case in `delta.test.ts` to a literal delta; run
    `npx vitest run --coverage --project unit test/unit/domain/storage/` and confirm
    `delta.ts` and `delta-encode.ts` are still 100 % branch; `npm run docs:json` and commit
    `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/delta-encode.test.ts test/unit/domain/storage/delta-encode.properties.test.ts test/unit/domain/storage/delta.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/storage/delta-encode.ts src/domain/storage/index.ts test/unit/domain/storage/delta-encode.test.ts test/unit/domain/storage/delta-encode.properties.test.ts test/unit/domain/storage/arbitraries.ts test/unit/domain/storage/delta.test.ts \
  && npm run check:spelling
```
Plus the pre-paid surface gate: `npm run docs:json && git status --porcelain -- reports/api.json`
(expect it modified, and commit it). Cache bypass when a gate reports
`Ran 0 scripts and skipped 1`: `npx tsc --noEmit -p tsconfig.typecheck.json`,
`npx cspell --no-progress <files>`.

### Commit

`feat(storage): add a delta instruction encoder`

## Part 2 — The pack writer entry becomes a union and emits OFS_DELTA

### Context

**This is a gate-sweep part**: `PackWriterEntry` is a published type and the re-shape breaks
every consumer. Every one of them must land in this *same* atomic commit or the gate is red
mid-part.

**Change** `src/domain/storage/pack-writer.ts` (167 lines). Current shapes:

```ts
export interface PackWriterEntry {          // L26-30
  readonly type: BasePackEntryType;         // 1 | 2 | 3 | 4 — structurally excludes 6/7
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
}
export interface PackEntryMeta { readonly crc32: number; readonly offset: number; }  // L32-35
export interface PackfileResult { readonly data: Uint8Array; readonly entries: ReadonlyArray<PackEntryMeta>; }
export function serializePackfile(entries: ReadonlyArray<PackWriterEntry>): PackfileResult;  // L42-60
```

Target shape (ADR-776 — `PackWriterEntry` **becomes** the union; no sibling type, no
`PackWriterInput` alias):

```ts
export interface PackWriterBaseEntry {
  readonly type: BasePackEntryType;
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
}

export interface PackWriterDeltaEntry {
  readonly type: typeof PACK_ENTRY_TYPE.OFS_DELTA;
  /** Inflated length of the DELTA INSTRUCTION STREAM — not the target object. */
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
  /** Index of this delta's base in the SAME entries array; must be < this entry's index. */
  readonly baseIndex: number;
}

export type PackWriterEntry = PackWriterBaseEntry | PackWriterDeltaEntry;
```

`PackEntryMeta` and `PackfileResult` are **unchanged**. `serializePackfile`'s signature text
is unchanged (`ReadonlyArray<PackWriterEntry>`) but its meaning widens.

**Why `baseIndex` and not `baseDistance`**: the distance depends on the byte layout the
writer is producing (the base's offset plus every intervening entry header, one of which is
the delta's own header). `serializePackfile` already tracks `currentOffset` (L47); it records
each emitted entry's offset and computes `baseDistance = currentOffset - offsets[baseIndex]`
at the moment it writes the delta. There is **no fixed-point problem**: `currentOffset` is
the delta's own entry start, known before a single header byte is emitted.

**Emitted delta entry bytes**, in order — this is what the crc32 covers:
`encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, uncompressedSize)` ++
`encodeOfsDistance(baseDistance)` ++ `compressedData`.
Both helpers already exist and are exported from `src/domain/storage/pack-entry.ts`:
`encodePackEntryHeader` (L184-204), `encodeOfsDistance` (L206-219 — the exact inverse of the
private `decodeOfsDistance` at L123-147, already round-tripped by
`test/unit/domain/storage/pack-entry.properties.test.ts`). `PACK_ENTRY_TYPE.OFS_DELTA === 6`
(L10). The existing `crc32(entryBytes)` call (L52) needs no change; `entryBytes` simply gains
the distance varint.

**Refusals** — reuse `invalidPackEntry(offset, reason)` from `./error.js`
(`error.ts:80-81` → `{ code: 'INVALID_PACK_ENTRY', offset, reason }`). `offset` is the delta
entry's **own** byte offset, which is what the reader-side factory means by it. **Three
independent guards, three isolated tests** (never one combined `if (A || B || C)`):

| Condition | `reason` |
|---|---|
| `baseIndex >= i` (forward or self reference) | `` `OFS_DELTA base index ${baseIndex} is not before entry ${i}` `` |
| `baseIndex < 0` | `` `OFS_DELTA base index ${baseIndex} out of range` `` |
| `!Number.isInteger(baseIndex)` | `` `OFS_DELTA base index ${baseIndex} out of range` `` |

The mutation-killer for the first guard is `baseIndex === i` (self-reference): `>= i` vs
`> i` only differ there.

**`@writes` block** (`pack-writer.ts:1-12`) is read by `npm run check:write-surfaces`
(`tooling/audit-write-surfaces.ts`); the three keys
`surface: packfile` / `kind: equivalent-under-readback` / `format: git-packfile-v2` **stay
exactly as they are** — `equivalent-under-readback` becomes *more* true, not less. Only the
prose changes: the sentence "emits the v2 pack body (header + entries)" widens to name delta
entries, and "delta selection are implementation-defined" becomes literally true of tsgit
rather than merely of the format. The audit only inspects modules that already carry the tag,
so nothing new needs one.

**Every consumer, swept in this commit:**

| File | Site | What changes |
|---|---|---|
| `src/application/primitives/build-pack.ts` | L41 `const writerEntries: PackWriterEntry[]`, L55 `encodeEntry(...): Promise<PackWriterEntry>` | Both still compile against the union (the base member is assignable). Narrow the annotations to `PackWriterBaseEntry` so the non-delta assembler stays honest about what it produces |
| `test/unit/domain/storage/pack-writer.test.ts` | L13 import, L19-21 `makeEntry(type: 1\|2\|3\|4, data)` | `makeEntry` keeps returning a base entry; add a `makeDeltaEntry(baseIndex, data)` sibling |
| `test/integration/packfile-interop.test.ts` | L26 import, L69 `const writerEntries: PackWriterEntry[]` | Narrow to `PackWriterBaseEntry` for the existing scenario; add the new delta scenario below |
| `test/parity/scenarios/pack-pair.ts` | imports `serializePackfile` from `src/domain/storage/index.ts` | Verify it still type-checks; it builds a single base entry, so no edit is expected |
| `src/domain/storage/index.ts` | L82-87 `export type { PackEntryMeta, PackfileResult, PackIndexWriterEntry, PackWriterEntry }` | Add `PackWriterBaseEntry`, `PackWriterDeltaEntry` |

**Tests:**

- **Extend** `test/unit/domain/storage/pack-writer.test.ts` inside the existing
  `describe('pack-writer') > describe('serializePackfile')` block (L49-149; existing
  `describe`s: "Given 1 entry (BLOB)", "Given 1 entry", "Given 3 entries", "Given 0 entries").
  Add: a two-entry pack whose second entry is an `OFS_DELTA` on the first — assert the
  emitted distance bytes equal `encodeOfsDistance(offset1 - offset0)`, and that
  `parsePackEntryHeader(result.data, offset1, hashConfig)` returns
  `{ type: 6, baseDistance: offset1 - offset0 }`; a delta entry's crc32 recomputed over the
  exact `header ++ distance ++ payload` slice; the three refusals, each isolated, asserting
  `err.data` `{ code, offset, reason }` via try/catch.
- **Extend** `test/integration/packfile-interop.test.ts` (its `@proves` header at L9-14 is
  `surface: packfile / bucket: cross-tool-interop / interopSurface: packfile`). Add one
  scenario: build a two-entry pack by hand — a base blob and an `OFS_DELTA` whose payload is
  `deflate(encodeDelta(baseContent, targetContent)!)` — drop the `.pack`/`.idx` pair into the
  peer repo's `.git/objects/pack/` exactly as the existing scenario does, and assert
  `git fsck --strict` exits 0 and `git cat-file -p <targetOid>` returns the target bytes.
  This is what makes the union's delta arm real rather than merely typed, and it folds the
  interop proof into the part whose code it exercises.

**Surface gate:** `npm run docs:json` and commit `reports/api.json` — `PackWriterEntry`,
`PackWriterEntry.type`, `.uncompressedSize`, `.compressedData` and `serializePackfile` all
appear there today (`reports/api.json` rows near L22572, L52453, L211260). This is a
**prepush** gate (`check:doc-typedoc` = `git diff --exit-code -- reports/api.json`), not a
validate gate: local validate can be green while the push hook rejects.

### TDD steps

1. **RED** — `pack-writer.test.ts`: two-entry pack, second is `OFS_DELTA` on the first;
   assert `parsePackEntryHeader` at the second offset yields `type: 6` and
   `baseDistance === offset1 - offset0`. Fails: `PackWriterEntry` has no `baseIndex`, so the
   fixture does not type-check.
2. **GREEN** — split `PackWriterEntry` into the union; in `serializePackfile`, record each
   entry's offset in a local `offsets: number[]` and narrow on `entry.type` to prepend
   `encodeOfsDistance(currentOffset - offsets[entry.baseIndex])` for the delta arm.
3. **RED** — the delta entry's crc32 recomputed over `header ++ distance ++ payload`. Should
   pass immediately if step 2 concatenated before hashing; if it fails, the concat order is
   wrong.
4. **RED** — three isolated refusal tests (`baseIndex === i`, `baseIndex === -1`,
   `baseIndex === 0.5`), each asserting `err.data`. Fails: no guards.
5. **GREEN** — three independent guards.
6. **REFACTOR** — sweep the consumers in the table above; narrow `build-pack.ts` to
   `PackWriterBaseEntry`; extend `src/domain/storage/index.ts`; rewrite the two `@writes`
   docblock prose sentences; add the `packfile-interop.test.ts` delta scenario; run
   `npm run docs:json` and commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/pack-writer.test.ts test/integration/packfile-interop.test.ts test/unit/application/primitives/build-pack.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/storage/pack-writer.ts src/domain/storage/index.ts src/application/primitives/build-pack.ts test/unit/domain/storage/pack-writer.test.ts test/integration/packfile-interop.test.ts \
  && npm run check:spelling
```
Plus `npm run check:write-surfaces` (the `@writes` block was edited) and the pre-paid
`npm run docs:json` + commit of `reports/api.json`.

### Commit

`feat(storage)!: let the pack writer emit offset-delta entries`

## Part 3 — `readObjectMetadata`: type and size without materialising content

### Context

Delta selection must sort by `(typeRank, uncompressedSize DESC, oid ASC)` **before** reading
any content, and the sort key must be a property of the object's *content*, never of how it
is stored — gc rewrites exactly the packs a stored-size key would depend on, so a stored-size
key would change the pack sha on the next run over an unchanged object set and silently break
the three gc identity pins. There is no cheap metadata primitive today: `catFileBatch`
(`src/application/commands/cat-file-batch.ts:20-26`) calls `readObject` and computes
`payloadByteLength` from a fully-materialised object.

**Add** `readObjectMetadata` to `src/application/primitives/read-object.ts` (~160 lines
today). **Internal — do NOT barrel it** from `src/application/primitives/index.ts` (see the
public-surface table; `readRawObject` and `RawObject` set the precedent, documented at
`src/application/primitives/types.ts:84-88`).

```ts
export interface ObjectMetadata {
  readonly type: ObjectType;        // from '../../domain/objects/index.js'
  readonly uncompressedSize: number; // bytes of content, after the `<type> <size>\0` header
}
export async function readObjectMetadata(ctx: Context, id: ObjectId): Promise<ObjectMetadata>;
```

It returns the **domain** `ObjectType` (`'commit' | 'tree' | 'blob' | 'tag'`), not a pack
entry type — a primitive speaks the domain's vocabulary. Part 6's sort key wants the pack
entry numbering, and converts with `objectTypeToPackEntryType`, which Part 6 adds to
`src/domain/storage/pack-entry.ts` as the mirror of the existing `packEntryTypeToObjectType`.
Nothing about that conversion belongs in this part.

**The three routes (ADR-778), cheapest first:**

1. **Packed base entry** — zero inflate. `registry.lookup(id)` → `PackLookupHit`;
   `table = await hit.pack.offsetTable()`; `nextOffset = nextOffsetForEntry(table, hit.offset)`
   (re-exported from `src/application/primitives/pack-registry.ts:64`);
   `readEntryHeaderWithChunk(ctx, hit, nextOffset)` (exported,
   `src/application/primitives/object-resolver.ts:575-593`) → `header`. When
   `isBase(header)` (exported, `object-resolver.ts:558`), the answer is
   `{ type: packEntryTypeToObjectType(header.type), uncompressedSize: header.size }`.
   `packEntryTypeToObjectType` is exported from `src/domain/storage/pack-entry.ts:229`.
2. **Packed delta entry** — one inflate of the **delta instruction stream** (not the object).
   `inflated = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk))`, exactly the
   shape `collectDeltaChain` uses at `object-resolver.ts:395`, then
   `uncompressedSize = readDeltaTargetSize(inflated)` (exported from
   `src/domain/storage/delta.ts:186`). **Do not use `ctx.compressor.streamInflate`'s
   `maxOutputBytes`** to "bound" this: that parameter makes the adapter *throw*
   `DECOMPRESS_FAILED` when output exceeds the cap (`src/ports/compressor.ts:32-42`), so it
   cannot express "read the first ten bytes". The delta instruction stream is already the
   smallest representation of the object; a full inflate of it is the bounded read ADR-778
   means.
   The **type** comes from walking base links through entry headers only, never inflating a
   base: `OFS_DELTA` → `ofsDeltaBaseOffset(id, currentHit.offset, header.baseDistance)`,
   `REF_DELTA` → `registry.lookup(header.baseId)`, until `isBase(header)`. Both
   `ofsDeltaBaseOffset` (`object-resolver.ts:438-445`, currently **private** — export it) and
   `assertChainDepthWithinCap` (`object-resolver.ts:324-328`, currently **private** — export
   it) must be reused rather than re-derived, so this third walker cannot drift from the two
   that exist. Increment depth per hop and call `assertChainDepthWithinCap(depth)`; it throws
   `deltaChainTooDeep(depth)` past `MAX_DELTA_CHAIN_DEPTH`.
   ⚠️ `jscpd` (`npm run check:duplicates`, `jscpd src/`, threshold 5 %, `minLines: 5`,
   `minTokens: 50`) will flag a copy-pasted walk. Reuse, do not duplicate.
3. **Loose object** — full inflate is permitted. `await readRawObject(ctx, id)` →
   `{ type, content }`; return `{ type, uncompressedSize: content.length }`. This also
   inherits the partial-clone lazy-fetch retry for free.

⚠️ Between this part and Part 6 nothing in `src/` imports `readObjectMetadata`, so
`npm run check:dead-code` (knip) would flag it as unused. That gate runs at **`validate`**,
i.e. the phase boundary, by which point `deltify.ts` imports it — do not barrel it just to
silence a knip run you should not be doing here. The part gate does not include knip.

Wrap the whole thing in `withLazyFetchRetry(ctx, id, registry, …)`
(`read-object.ts:104-126`) so a partial clone behaves identically to `readObject` and
`readRawObject` — `read-object.ts:98-102` documents that this parity is deliberate. Route:
`registry.lookup(id)` first; `undefined` ⇒ the loose route. A pack that claims the id but
whose entry is corrupt must **throw** (fail loud) — this is a sort key, not an fsck report,
so the degrade-to-`untyped` posture of `fsck/object-cache.ts` is explicitly *not* wanted here.

**Tests — new** `test/unit/application/primitives/read-object-metadata.test.ts`.
`test/unit/application/primitives/pack-fixture.ts` already provides everything needed to plant
each route: `buildSyntheticPack(ctx, entries)` with `BaseEntrySpec { kind: 'base', type,
content }`, `OfsDeltaSpec { kind: 'ofs-delta', baseIndex, targetContent }` and
`RefDeltaSpec { kind: 'ref-delta', baseId, baseUncompressed, targetContent }`, plus
`writeSyntheticPack(ctx, …)` and a `PackBuildResult { packBytes, idxBytes, ids, offsets }`.
`buildSeededContext()` lives in `test/unit/application/primitives/fixtures.ts:156`.
Cases: loose blob / loose commit / loose tree / loose tag (four types, so the
`packEntryTypeToObjectType` mapping and the loose route are both exercised); a packed base
entry (assert **no** inflate happens — wrap `ctx.compressor.inflate` in a counting spy and
assert zero calls, the same wrapping style `build-pack.test.ts:216-247` uses for `deflate`);
a packed `OFS_DELTA` (size from `readDeltaTargetSize`, type walked back to the base);
a packed `REF_DELTA`; a chain deeper than `MAX_DELTA_CHAIN_DEPTH` → `DELTA_CHAIN_TOO_DEEP`
asserted on `err.data.depth`; an absent oid → `OBJECT_NOT_FOUND`.

### TDD steps

1. **RED** — loose blob: `readObjectMetadata(ctx, blobId)` returns
   `{ type: 'blob', uncompressedSize: 3 }`. Fails: the export does not exist.
2. **GREEN** — the loose route via `readRawObject`, wrapped in `withLazyFetchRetry`.
3. **RED** — a packed base entry planted with `buildSyntheticPack` + `writeSyntheticPack`:
   correct type and size **and** zero `ctx.compressor.inflate` calls. Fails: the loose route
   inflates.
4. **GREEN** — the packed-base route via `registry.lookup` + `nextOffsetForEntry` +
   `readEntryHeaderWithChunk` + `isBase`.
5. **RED** — a packed `OFS_DELTA` whose target is longer than its base: size equals the
   target's length, type equals the base's type. Fails: `isBase` is false and there is no
   delta arm.
6. **GREEN** — the delta arm: inflate the instruction stream for the size, walk base links
   for the type, reusing the now-exported `ofsDeltaBaseOffset` and
   `assertChainDepthWithinCap`.
7. **RED** — a packed `REF_DELTA`; then a chain past `MAX_DELTA_CHAIN_DEPTH` asserting
   `err.data` `{ code: 'DELTA_CHAIN_TOO_DEEP', depth }`; then an absent oid asserting
   `OBJECT_NOT_FOUND`.
8. **GREEN** — the `REF_DELTA` hop through `registry.lookup` and the depth assertion.
9. **REFACTOR** — check the walk shares one loop with no duplicated arithmetic; run
   `npm run check:duplicates` to confirm jscpd stays under threshold.

### Gate

```
npx vitest run test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/read-object.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/read-object.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/read-object-metadata.test.ts \
  && npm run check:spelling
```
Plus `npm run check:duplicates`. No `reports/api.json` change is expected (nothing barrelled)
— run `npm run docs:json` and confirm the file is **unmodified**.

### Commit

`feat(primitives): read object type and size without materialising content`

## Part 4 — The `pack.window` / `pack.depth` / `pack.windowMemory` config surface

### Context

Three new integer keys, following the established pattern in
`src/application/primitives/config-read.ts` exactly — a lenient `readConfig` merge plus a
cold-path finder plus an eager assertion. **No new error code and no new reason string**
(ADR-773): `configBadNumericValue(key, source, value, reason)` from
`src/domain/commands/error.js` (imported at `config-read.ts:1`) with the existing
`'invalid unit'` / `'out of range'` reasons.

**Prior art to copy, not reinvent:**

- `findFirstInvalidGcAuto` (`config-read.ts:611-631`) — the **first-invalid** finder shape:
  walk the cached tokens, track `inSection` via `matchesSection(token.section,
  token.subsection, 'gc', undefined)`, skip non-entry tokens, `parseGitInt(token.value)`,
  `continue` when `parsed.ok && parsed.value >= GIT_C_INT_MIN && parsed.value <=
  GIT_C_INT_MAX`, otherwise return `{ key, source, value: token.value ?? '', reason }`.
- `assertValidGcAutoConfig` (`config-read.ts:637-642`) — throws `configBadNumericValue`.
- `findLastInvalidMaxTreeDepth` (`config-read.ts:666-698`) — the **last-write-wins** family.
  `pack.*` is **NOT** in that family; do not copy it.
- `parseGitInt` (`src/domain/config/config-ini.ts:750-777`) — git's `strtoimax` base-0
  grammar: decimal / `0x` hex / leading-`0` octal / sign / a single `k`/`m`/`g` unit ×1024ⁿ,
  bounded to int64. **`parseGitInt(null)` already returns `{ ok: false, reason: 'invalid
  unit' }`** (its `(value ?? '')` fallback at L755), so a valueless key needs no special case
  — pass `token.value` straight through the way `findFirstInvalidGcAuto` does.
- `GIT_C_INT_MIN = -2_147_483_648` / `GIT_C_INT_MAX = 2_147_483_647`
  (`config-ini.ts:786-787`) — the C-`int` narrowing layered on top of `parseGitInt`'s int64
  bounds.

**Pinned against git 2.55.0 in a `mktemp` throwaway (isolated `HOME`/`XDG_CONFIG_HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, all `GIT_*` scrubbed), by appending the line to
`.git/config` and running `git repack -a -d`:**

| Key | Value | git's output | exit |
|---|---|---|---|
| `pack.depth` / `pack.window` | valueless, `abc`, `5.0` | `fatal: bad numeric config value '<v>' for 'pack.depth' in file .git/config: invalid unit` | 128 |
| `pack.depth` / `pack.window` | `2147483648`, `4294967296`, `-2147483649`, `99999999999999999999` | `…: out of range` | 128 |
| `pack.depth` / `pack.window` | `2147483647`, `4095`, `4096`, `100000`, `1m` | accepted (`4096`+ prints `warning: delta chain depth <n> is too deep, forcing 4095`) | 0 |
| `pack.depth` / `pack.window` | **`0`**, **`-1`** | silent — this is git's own delta-disable switch | 0 |
| `pack.depth` / `pack.window` | `1k`, `0x20`, `050`, `+50`, `" 50 "` | silent — 1024 / 32 / 40 / 50 / 50 | 0 |
| `pack.windowMemory` | **`-1`** | `fatal: bad numeric config value '-1' for 'pack.` + the all-lowercase key + `' in file .git/config: invalid unit` | **128** |
| `pack.windowMemory` | valueless, `abc` | `…: invalid unit` | 128 |
| `pack.windowMemory` | `0`, `8k`, `1g`, `16g`, `2147483648`, `4294967296`, `9223372036854775807`, `18446744073709551615` | accepted | 0 |
| `pack.windowMemory` | `99999999999999999999`, `18446744073709551616`, `17179869184g` | `…: out of range` | 128 |

Four consequences, all binding:

1. **`pack.windowMemory` is unsigned** — a negative value is `invalid unit`, not
   `out of range`, and its magnitude bound is git's `unsigned long`, not the C `int`.
   `pack.window` / `pack.depth` are C-`int` bounded and accept `-1`.
2. **git lowercases the key in its message.** For `pack.windowMemory` it prints the key
   all-lowercase, exactly as tsgit's existing finders already build it — from a lowercase
   constant (`` `gc.${GC_AUTO_KEY}` ``, `` `core.${MAX_TREE_DEPTH_KEY}` ``). So the three
   qualified keys are `'pack.'` prefixed to the lowercase key constants `'window'`,
   `'depth'` and the all-lowercase spelling of `windowMemory`.
   🔴 That all-lowercase spelling is **not** in `cspell.json`'s word list (`windowMemory`
   passes only because cspell splits it on the capital). Add it to `cspell.json` in this
   part, or `npm run check:spelling` goes red the moment the constant is written.
3. **First-malformed-line-is-fatal, in file order.** Both orders die (a valid `depth = 50`
   before *or* after `depth = abc` still refuses). These keys are in the `core.compression`
   family, not the `core.maxTreeDepth` last-write-wins family.
   `git config --get pack.depth` *is* last-write-wins and returns the valid line — it is
   **not** the semantics `repack` uses, so never pin the refusal through `--get`.
4. > **Documented divergence, must be written down in the part's own commit body-free
   > comment and in Part 8's doc pass:** `parseGitInt` is int64-bounded
   > (`GIT_INT_MIN`/`GIT_INT_MAX`), so tsgit reports `out of range` for a
   > `pack.windowMemory` in `[2**63, 2**64)` that git accepts. Those are byte budgets above
   > 9 exabytes. Reproducing git's `unsigned long` grammar would mean a second integer
   > parser, which ADR-773 explicitly forecloses ("no new mechanism"). Accept the
   > divergence; do not build a uint64 parser.

**Edits to `src/application/primitives/config-read.ts` — five declaration sites carry the
`pack` shape today, found with `command grep -n "writeReverseIndex"`:**

| Line | Current |
|---|---|
| 116-117 | `/** \`pack.writeReverseIndex\` … */` `readonly pack?: { readonly writeReverseIndex?: boolean };` — the **public** `ParsedConfig` |
| 727 | `pack?: { writeReverseIndex?: boolean };` — `MutableParsedConfig` |
| 1140 | `const mergePack = (acc: { pack?: { writeReverseIndex?: boolean } }, sec: IniSection): void =>` |
| 1322 | `pack?: { writeReverseIndex?: boolean };` — `FinalizeOut` |
| 1403 | `pack?: { writeReverseIndex?: boolean };` — `finalize`'s local `out` type |

Introduce `type MutablePack = { writeReverseIndex?: boolean; window?: number; depth?: number;
windowMemory?: number };` beside the existing `type MutableGc` (`config-read.ts:1149`) and use
it at 727 / 1140 / 1322 / 1403; widen the public `ParsedConfig.pack` at 116-117 with three
`readonly` optional numbers, each with its own one-line doc comment naming git's default
(`window` 10, `depth` 50, `windowMemory` unlimited).

`mergePack` (L1140-1147) currently handles only `writereverseindex`. Extend it with an
`applyPackEntry`-style arm mirroring `applyGcAutoEntry` (`config-read.ts:1150-1155`):
`window` / `depth` → `parseGitInt`, accepted only when `ok` and within `GIT_C_INT_MIN..MAX`;
the window-memory key → `parseGitInt`, accepted only when `ok` and `>= 0`. An invalid value merges
as **absent** (lenient) — the refusal is the finder's job, exactly as `gc.auto` splits it.

**New exports** (barrelled from `src/application/primitives/index.ts` beside the existing
`config-read.js` exports at L18-24):

```ts
export interface InvalidPackIntEntry {
  readonly key: string;
  readonly source: string;
  readonly value: string;
  readonly reason: 'invalid unit' | 'out of range';
}
export const findFirstInvalidPackInt = async (ctx: Context): Promise<InvalidPackIntEntry | undefined>;
export const assertValidPackIntConfig = async (ctx: Context): Promise<void>;
```

`findFirstInvalidPackInt` walks the cached `[pack]` (subsectionless) tokens **in file order**
and returns the **first** `window` / `depth` / window-memory entry that fails. The three keys
have two different range rules — keep them as two small predicates so each is independently
mutation-killable, not one merged condition.

**No clamp constant for 4095.** git accepts `pack.depth` above 4095 and clamps with a
warning at exit 0; tsgit accepts it silently and the writer's own
`min(depth, MAX_DELTA_CHAIN_DEPTH)` (Part 6) already makes anything above 50 indistinguishable.
Adding a `4095` constant would be an unobservable branch and a guaranteed surviving mutant.
The observable contract is *acceptance*, which the interop row below asserts.

**Tests:**

- **Extend** `test/unit/application/primitives/config-read.test.ts` (find the existing
  `findFirstInvalidGcAuto` / `assertValidGcAutoConfig` describes and mirror their structure).
  Cases per key: valueless → `invalid unit` with `value: ''`; `abc` → `invalid unit`; `5.0` →
  `invalid unit`; `2147483648` → `out of range` (window/depth); `-2147483649` → `out of
  range` (window/depth); `-1` accepted for window/depth but `invalid unit` for
  `pack.windowMemory`; `0` accepted for all three; `1k` / `0x20` / `050` / `+50` accepted;
  malformed-**first** and malformed-**last** both refused (the two-line ordering test, which
  is what pins the first-invalid family); a valid file → `undefined`. `readConfig` returns
  `pack.window === 1024` for `1k`, and `pack.window === undefined` for `abc` (lenient merge).
  Every refusal asserts `err.data` `{ code: 'CONFIG_BAD_NUMERIC_VALUE', key, source, value,
  reason }` via try/catch.
- **No interop file in this part.** The finder and the assert are pure functions over a
  config file, fully covered by the unit tests above; the *command-level* refusal cannot
  exist until Part 7 wires `assertValidPackIntConfig` into `runGcTask`, `packObjects` and
  `bundleCreate`. The cross-tool parity rows therefore live in Part 7's
  `test/integration/delta-pack-interop.test.ts` (rows X8/X9/X10). Do not create a second
  interop file for them.
  🔴 When Part 7 writes those rows: `readConfig` reads the **local**
  `${commonGitDir}/config` only, deliberately (`config-read.ts:143-152`), while git resolves
  `pack.depth` across system/global/local. That gap is pre-existing and repository-wide.
  Set these keys with local `git config` or a direct file append, **never**
  `git config --global`, or the test pins a scope divergence that has nothing to do with the
  packer.

**Surface gate:** three new public names + a widened public `ParsedConfig` ⇒
`npm run docs:json`, commit `reports/api.json`.

### TDD steps

1. **RED** — `config-read.test.ts`: `pack.window = abc` in the config makes
   `findFirstInvalidPackInt` return `{ key: 'pack.window', value: 'abc', reason: 'invalid
   unit' }`. Fails: the export does not exist.
2. **GREEN** — `MutablePack`, the widened `ParsedConfig.pack`, `findFirstInvalidPackInt`
   over `window` only.
3. **RED** — the same for `pack.depth`, then `pack.windowMemory` with `-1` → `invalid unit`
   and `2147483648` → accepted. Fails: the window-memory key is unrecognised, or the C-int
   rule is misapplied to it.
4. **GREEN** — the two range predicates (C-int for window/depth, non-negative for
   windowMemory).
5. **RED** — the two-line ordering pair (malformed first, malformed last) for each key.
   Fails if the finder was written last-write-wins.
6. **RED** — `assertValidPackIntConfig` throws `CONFIG_BAD_NUMERIC_VALUE` with the exact
   `{ key, source, value, reason }`. Fails: not implemented.
7. **GREEN** — `assertValidPackIntConfig`, mirroring `assertValidGcAutoConfig`.
8. **RED** — `readConfig` lenient-merge cases: `1k` → `1024`; `abc` → `undefined`; `0` → `0`
   (not `undefined` — `0` is a legal value that means "no deltas", and merging it as absent
   would silently re-enable a feature the user turned off).
9. **GREEN** — the `mergePack` arm.
10. **REFACTOR** — barrel the three names; confirm `config-read.properties.test.ts` still
    passes (it property-tests the config grammar and a widened `pack` shape can perturb it);
    `npm run docs:json` and commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/config-read.properties.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/index.ts test/unit/application/primitives/config-read.test.ts \
  && npm run check:spelling
```
Plus the pre-paid `npm run docs:json` + commit of `reports/api.json`.

### Commit

`feat(config): read pack.window, pack.depth and pack.windowMemory`

## Part 5 — `buildPack` metas become identified triples

### Context

**This is a gate-sweep part**: it deletes `buildPack`'s positional-alignment contract and
must update **every** call site in the same atomic commit, or the gate is red mid-part.
Behaviour-preserving — the emitted pack bytes are byte-identical before and after.

Current (`src/application/primitives/build-pack.ts:29-38`):

```ts
export interface BuildPackResult {
  readonly bytes: Uint8Array;
  readonly sha: string;
  readonly objectCount: number;
  /** Per-entry crc32/offset, in `input.oids` order — … */
  readonly entries: ReadonlyArray<PackEntryMeta>;
}
```

Target (ADR-769):

```ts
export interface BuildPackResult {
  readonly bytes: Uint8Array;
  readonly sha: string;
  readonly objectCount: number;
  /** One `{ id, crc32, offset }` triple per object, in EMISSION order. Each meta
   *  carries its own identity, so a caller keys on `id` and can never pair a
   *  checksum with the wrong object. */
  readonly entries: ReadonlyArray<PackIndexWriterEntry>;
}
```

`PackIndexWriterEntry` already exists — `src/domain/storage/pack-order.ts:3-7`,
`{ readonly id: string; readonly crc32: number; readonly offset: number }` — and is exactly
what every downstream writer already takes. Re-export it from `build-pack.ts` or import it
from `../../domain/storage/index.js` (it is barrelled there). `PackEntryMeta`
(`{ crc32, offset }`) and `serializePackfile`'s return shape are **unchanged**:
`serializePackfile` never sees oids. `buildPack` zips its own emission-order oid list with
`packfile.entries` to produce the triples.

**Every call site, swept in this commit:**

| File | Line | Current | After |
|---|---|---|---|
| `src/application/commands/internal/gc-pipeline.ts` | 446-451 | `function indexEntriesFor(oids, entries) { return oids.map((id, i) => ({ id, crc32: entries[i]!.crc32, offset: entries[i]!.offset })); }` | **delete the function** — `pack.entries` is already `ReadonlyArray<PackIndexWriterEntry>` |
| ″ | 484-489 | `buildAndWriteNormalPack`: `entries: indexEntriesFor(oids, pack.entries)` | `entries: pack.entries` |
| ″ | 527-532 | `buildAndWritePromisorPack`: same | `entries: pack.entries` |
| ″ | 560-566 | `buildAndWriteCruftPack`: `entries: indexEntriesFor(survivors, pack.entries)` | `entries: pack.entries` |
| `src/application/commands/pack-objects.ts` | 82-89 | `const indexEntries = oids.map((id, i) => ({ id, crc32: pack.entries[i]!.crc32, offset: pack.entries[i]!.offset }));` plus the comment "`buildPack` produces exactly one entry per oid, in the same order — the non-null assertion documents that invariant" | delete both; pass `pack.entries` to `writePackArtifacts` and delete the now-false comment |
| `src/application/commands/bundle-create.ts` | 310 | uses only `pack.bytes`, `pack.objectCount`, `pack.sha` | **no change** — verify by reading |
| `src/application/commands/push.ts` | 353 | uses only `pack.bytes` | **no change** — verify by reading |

🔴 **Do NOT remove `toNormalPack.sort()` (`gc-pipeline.ts:412`) or the
`[...ownedPromisor].sort()` (`gc-pipeline.ts:853`), and do not touch their pinned comments in
this part.** They look inert once metas carry ids, but they are not: when delta emission is
off — the default, and also what `pack.window = 0` / `pack.depth = 0` select — emission order
is still the caller's array order, so those sorts still pin the pack sha. Part 7 amends their
comments by one clause; that is the only change they get.

**Sibling artefacts need no change.** `serializePackIndex`, `serializePackRevIndex`,
`writeCruftPack`'s `.mtimes` and the midx all run their entry set through
`sortPackIndexEntries` (`src/domain/storage/pack-order.ts:20-29`) first, so they are
oid-ordered regardless of emission order. `writePackArtifacts` / `writePackArtifactsViaQuarantine`
(`src/application/primitives/internal/write-pack-artifacts.ts:231, 298`) and `writeCruftPack`
(`src/application/primitives/internal/cruft-pack-lifecycle.ts:228-255`) all take
`ReadonlyArray<PackIndexWriterEntry>` already.

**Tests to update** — `test/unit/application/primitives/build-pack.test.ts` (248 lines):

- L192-214, `describe('Given mixed types (blob + tree)') > describe('When buildPack returns')
  > it('Then entries matches serializePackfile crc32/offset metas, order preserved')` —
  rewrite to assert each meta's `id` matches the oid at that emission position and that
  offsets increase, rather than positional alignment to `input.oids`.
- Add: an input whose oid order differs from emission order still yields one meta per oid,
  with `new Set(result.entries.map(e => e.id))` equal to the input oid set (identity, not
  position). At this point emission order still *is* input order, so the assertion is written
  set-wise so Part 6 does not have to rewrite it again.
- `test/unit/application/commands/maintenance.test.ts` and `pack-objects` tests: run them —
  they assert on written `.idx` contents, not on `buildPack`'s array shape, so no edit is
  expected. Fix only what actually breaks.

**Surface gate:** `BuildPackResult` is barrelled (`src/application/primitives/index.ts:11`)
and rides `public-types.ts`'s `export type *` ⇒ `npm run docs:json`, commit
`reports/api.json`.

### TDD steps

1. **RED** — `build-pack.test.ts`: `result.entries[0]!.id` equals the first input oid.
   Fails: `PackEntryMeta` has no `id` (type error, then assertion failure).
2. **GREEN** — `buildPack` builds `{ id, crc32, offset }` triples by zipping its
   emission-order oid list against `packfile.entries`; `BuildPackResult.entries` becomes
   `ReadonlyArray<PackIndexWriterEntry>`; update the docblock to state emission order and
   that callers key on `id`.
3. **RED** — set-wise identity test (every input oid appears exactly once among
   `result.entries` ids).
4. **GREEN** — nothing new; this should pass once step 2 lands.
5. **REFACTOR** — delete `indexEntriesFor` and its three uses; simplify `pack-objects.ts`'s
   `indexEntries` to `pack.entries` and delete the stale comment; read `bundle-create.ts` and
   `push.ts` to confirm they touch only `bytes`/`sha`/`objectCount`; run the full unit
   project plus `test/integration/maintenance-interop.test.ts` to confirm byte-for-byte
   behaviour preservation; `npm run docs:json` and commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/primitives/build-pack.test.ts test/unit/application/commands/maintenance.test.ts test/unit/application/commands/pack-objects.test.ts test/integration/maintenance-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/build-pack.ts src/application/commands/internal/gc-pipeline.ts src/application/commands/pack-objects.ts test/unit/application/primitives/build-pack.test.ts \
  && npm run check:spelling
```
Plus the pre-paid `npm run docs:json` + commit of `reports/api.json`.

### Commit

`refactor(primitives)!: identify pack entry metas by object id`

## Part 6 — The deltify window, delta emission, and the fsck depth fix

### Context

Two new modules plus a `buildPack` option plus a one-character reader fix. This is where the
feature actually turns on — behind an option that defaults to **off** (ADR-767: "a
capability, not a policy — callers choose, `buildPack` never infers from context"). No
caller opts in until Part 7.

#### 6a. `src/domain/storage/delta-policy.ts` — the pure decisions (new file)

ADR-768 puts "the ordering comparator and the acceptance predicate" in the domain. They live
in their own module rather than inside `delta-encode.ts` so each file stays a single concern
and the two parts do not collide on one file.

```ts
export const DELTA_ACCEPT_RATIO = 0.5;
/** The widest `encodeOfsDistance` output the reader will accept: `decodeOfsDistance`
 *  refuses more than 4 continuation bytes, so 5 bytes total. */
export const MAX_OFS_OVERHEAD_BYTES = 5;
export const DEFAULT_PACK_WINDOW = 10;
export const DEFAULT_PACK_DEPTH = 50;

export interface PackEmissionKey {
  readonly id: string;
  readonly type: BasePackEntryType;   // typeRank IS the pack entry type numbering (1..4)
  readonly uncompressedSize: number;
}
/** Total order: (type ASC, uncompressedSize DESC, id ASC). No two distinct objects
 *  compare equal, because oids are unique — which is what makes the sort stable
 *  regardless of the input array's order. */
export function comparePackEmissionOrder(a: PackEmissionKey, b: PackEmissionKey): number;

/** A delta is stored only when it is strictly smaller on disk. Ties go to the base. */
export function acceptsDeltaEntry(deflatedDeltaLength: number, deflatedContentLength: number): boolean;
//  => deflatedDeltaLength + MAX_OFS_OVERHEAD_BYTES < deflatedContentLength

export interface DeltaPolicy {
  readonly enabled: boolean;
  readonly window: number;
  readonly maxDepth: number;
  /** 0 = unlimited, matching git's `pack.windowMemory` unset/0. */
  readonly windowMemoryBudget: number;
}
export function resolveDeltaPolicy(config: {
  readonly window?: number; readonly depth?: number; readonly windowMemory?: number;
}): DeltaPolicy;
```

`resolveDeltaPolicy` rules, each pinned against git in Part 4's table:

- `window = config.window ?? DEFAULT_PACK_WINDOW`, `depth = config.depth ?? DEFAULT_PACK_DEPTH`.
- `enabled = window > 0 && depth > 0`. Either key at `0` **or** `-1` disables delta emission
  entirely — that is git's own switch, not a tsgit escape hatch. **There is no clamp-to-1**:
  clamping a legal `0` up to `1` would silently re-enable a feature the user turned off.
  Write it as two separate comparisons with two separate tests (one per condition alone), not
  one merged predicate.
- `maxDepth = Math.min(depth, MAX_DELTA_CHAIN_DEPTH)` — imported from `./delta.js`, value 50.
  No `WRITER_MAX_CHAIN_DEPTH`, no `-1`, no 4095 constant.
- `windowMemoryBudget = config.windowMemory ?? 0`.
- **No `MAX_WINDOW` cap.** The window is grown lazily (see 6c), so a pathological
  `pack.window` costs a longer candidate scan bounded by the objects actually admitted, never
  a giant allocation.

**Degenerate inputs, all of which must keep working and all of which get a test:**
`oids: []` still produces the existing empty-pack result (the sort of an empty array is
empty and `serializePackfile([])` is unchanged). A single object has no candidates and is
emitted as a base. A corpus of one object type is one candidate pool. A **duplicate oid** in
`input.oids` — which no current caller produces — makes two emission keys compare equal, so
the order between them falls to `Array.prototype.sort`'s stability, which the language
guarantees; the result is still deterministic, and the duplicate `.idx` entry that follows is
pre-existing behaviour this change neither creates nor fixes. A very small object gets
`searchBound = floor(size * 0.5)` below the two-byte delta header, so `encodeDeltaFromIndex`
aborts before emitting anything — correct and cheap; do not "fix" it with a floor.

Domain module ⇒ **100 % line/branch/function/statement coverage is gated**. Not barrelled.

**One supporting domain addition.** `readObjectMetadata` (Part 3) speaks the domain
`ObjectType`; `PackEmissionKey.type` is the pack entry numbering. Add
`objectTypeToPackEntryType(type: ObjectType): BasePackEntryType` to
`src/domain/storage/pack-entry.ts`, immediately beside the existing
`TYPE_TO_OBJECT_TYPE` map / `packEntryTypeToObjectType` (L221-231) whose exact mirror it is,
and barrel it from `src/domain/storage/index.ts` in the `// Pack entry` value block
(L57-65). Then **delete** `build-pack.ts`'s private `packEntryTypeFor` (L69-86) and use the
domain function at its one call site — the duplicate exists only because the domain had no
forward map. A `switch` over the four-arm `ObjectType` union stays exhaustive by the type
checker; a `Record<ObjectType, BasePackEntryType>` lookup, mirroring `TYPE_TO_OBJECT_TYPE`
exactly, is the shape to prefer since it is the one already there.

#### 6b. `walkDeltaChain` off-by-one (ADR-771)

`src/application/commands/internal/fsck/object-cache.ts:214-245`:

```ts
for (let depth = 0; depth < MAX_DELTA_CHAIN_DEPTH; depth += 1) {
```

becomes `depth <= MAX_DELTA_CHAIN_DEPTH`. Today this loop accepts **49** delta hops (one
iteration is spent on the base entry itself) while `collectDeltaChain`
(`src/application/primitives/object-resolver.ts:330-407`, via `assertChainDepthWithinCap` at
L324-328, `depth > MAX_DELTA_CHAIN_DEPTH`) accepts **50**. The disagreement is latent only
because tsgit has never written a delta; a writer honouring `pack.depth = 50` activates it
immediately — an object readable by `readObject` but reported untyped by `fsck` with
`'delta chain exceeds max depth'`. Fix it here, in the same commit that first makes a
50-hop chain writable.
Its `untypedFault(ctx, id, 'delta chain exceeds max depth')` return (L244) stays — it is now
reached at 51 hops, not 50. The existing coverage lives in
`test/unit/application/commands/fsck.test.ts` (the only test file matching
`command grep -rln "delta chain exceeds max depth" test`); extend it there. Plant a synthetic
chain of exactly `MAX_DELTA_CHAIN_DEPTH` hops via `buildSyntheticPack`'s `OfsDeltaSpec`
(`test/unit/application/primitives/pack-fixture.ts:40-57`, `baseIndex` + `targetContent`) and
assert the object types cleanly, plus one of `MAX_DELTA_CHAIN_DEPTH + 1` asserting the
untyped degrade — the `<` vs `<=` mutant dies only if **both** exist.

#### 6c. `src/application/primitives/internal/deltify.ts` — the lazy window (new file)

The only piece that reads objects. Not barrelled (the whole `primitives/internal/` tree is
unbarrelled by construction).

```ts
export interface DeltifiedEntry {
  readonly id: ObjectId;
  readonly entry: PackWriterEntry;   // the union from Part 2
}
export async function deltifyEntries(
  ctx: Context, oids: ReadonlyArray<ObjectId>, policy: DeltaPolicy,
): Promise<ReadonlyArray<DeltifiedEntry>>;
```

Pipeline:

1. **Metadata pass.** `boundedMapFor(ctx, 'ioBound', oids, (id) => readObjectMetadata(ctx, id))`
   — `boundedMapFor` is exported from `src/application/primitives/internal/concurrency.ts:53-58`
   and has `Promise.all` semantics: it returns results **in input order regardless of
   completion order**, which is what keeps this pass deterministic under concurrency.
2. **Sort** the `(id, type, uncompressedSize)` triples with `comparePackEmissionOrder`.
   `git`'s packer additionally sorts by a path-derived name hash; **tsgit's gc path has no
   paths** (`enumerateObjects` returns bare oids; `ClosureObject.path` is documented as not
   populated by the bitmap tier, which is `pack-objects`' default), so size-adjacency is the
   clustering signal available. That is *equivalent* for an evolving-file corpus and weaker
   for a many-distinct-files corpus; it is an accepted, measured cost, not a bug.
3. **Window pass**, one object at a time in sorted order:
   - `content = (await readRawObject(ctx, id)).content`.
     🔴 **`readRawObject`, not `readObject` + `serializeObject`.** Today
     `build-pack.ts:55-67` parses each object into a `GitObject`, re-serialises it and strips
     the header. `readRawObject` hands the content over directly (`types.ts:89-95`:
     "The object's content, after its `<type> <size>\0` header"), skipping a parse and a
     re-serialise per object. For a well-formed object the two are byte-identical — the oid
     *is* the hash of exactly those bytes. They differ only for an object whose stored bytes
     are not what tsgit's serialiser would emit, where the parse-and-re-emit path silently
     canonicalises and the raw path preserves. The raw path is the git-faithful one (git's
     packer copies stored bytes). Name this in the commit-adjacent comment: it means the pack
     sha can change for a repository holding such an object, independently of deltas.
     ⚠️ `content` "may alias the object cache (`ctx.deltaCache` or a loose-read buffer) —
     treat both as immutable and copy before mutating" (`types.ts:84-95`). The window holds
     those references for up to `W` iterations. Nothing in this path may write through a
     retained reference.
   - `searchBound = Math.floor(content.length * DELTA_ACCEPT_RATIO)`.
   - Candidates = window members, **most-recently-added first**, filtered to the same object
     type (git refuses cross-type deltas) and `chainDepth < policy.maxDepth`.
   - For each candidate `C`:
     `maxSize = best === undefined ? searchBound : Math.min(searchBound, best.delta.length - 1)`;
     `d = encodeDeltaFromIndex(C.index, content, maxSize)`; `undefined` ⇒ `continue`.
     Take `d` when `best === undefined` **or** `d.length < best.delta.length` **or**
     (`d.length === best.delta.length` and `C.chainDepth < best.chainDepth`). Both
     comparisons are strict `<`, so a candidate tying on length *and* depth loses —
     "earlier-visited wins" over a fixed-order list is itself a total, deterministic rule and
     needs no oid tie-break. **Do not add one**: it would be a branch with no reachable
     state, which mutation testing correctly flags as dead.
   - **Acceptance.** `deltaBytes = await ctx.compressor.deflate(best.delta)` and
     `baseBytes = await ctx.compressor.deflate(content)` (the latter is computed anyway — it
     is the fallback entry). Emit the delta iff
     `acceptsDeltaEntry(deltaBytes.length, baseBytes.length)`. The real distance is unknown
     at this point (offsets are assigned inside `serializePackfile`), so
     `MAX_OFS_OVERHEAD_BYTES` makes the test conservative in the safe direction. The entry's
     own type/size header is ignored because it can only help: a delta entry's header encodes
     the instruction stream's length, which is smaller than the content length the base
     entry's header encodes.
   - Emitted delta entry:
     `{ type: PACK_ENTRY_TYPE.OFS_DELTA, uncompressedSize: best.delta.length, compressedData:
     deltaBytes, baseIndex: <the base's emission index> }`. `uncompressedSize` is the
     **inflated delta instruction stream's** length, never the target object's — this is
     exactly what `git verify-pack` checks.
   - `chainDepth` = `0` for a base entry, `base.chainDepth + 1` for a delta. Because a
     candidate at `chainDepth >= policy.maxDepth` is never offered as a base, the emitted
     maximum chain length is exactly `policy.maxDepth` by construction, with no post-hoc check.
   - **Admission and residency.** After emitting, the object becomes a window member carrying
     `{ id, type, chainDepth, content, index: createDeltaIndex(content), emissionIndex }`.
     The index is built **once, on admission**, and dropped on eviction — that is the whole
     reason the window is a window. Bounds, both enforced on admission:
     * count: evict the **oldest** while `members.length >= policy.window`;
     * bytes (only when `policy.windowMemoryBudget > 0`): evict **oldest-first** while
       `residentBytes + content.length > budget` and the window is non-empty; and if
       `content.length > budget`, **skip admission entirely** — a candidate larger than the
       whole budget is never admitted alone.
     `residentBytes` counts **content bytes only** (ADR-772: "the total bytes of base content
     the window holds"). The window is an array used as a FIFO (`push` / `shift`), grown
     lazily — never pre-allocated to `policy.window` slots.
4. **Determinism is structural, and these are the review's grep list.** No `Date.now()`, no
   `performance.now()`, no `Math.random()`, no `Promise.race`, and no `Map`/`Set` iteration
   anywhere in the selection path. The only container that decides anything is an array or an
   `Int32Array`. Every input to the emitted bytes is a pure function of (object set, config,
   adapter). Determinism is required **per adapter**, not across them —
   `ctx.compressor.deflate` already differs between Node and the Web `CompressionStream`
   adapter, which is exactly why the pack surface is declared `equivalent-under-readback`.

#### 6d. `src/application/primitives/build-pack.ts` — the option

```ts
export interface BuildPackInput {
  readonly oids: ReadonlyArray<ObjectId>;
  /** Emit OFS_DELTA entries where a delta is strictly smaller on disk. Default false. */
  readonly delta?: boolean;
}
```

`delta !== true` ⇒ **exactly today's loop, unchanged**: one base entry per oid, in
`input.oids` order, via `readObject` + `serializeObject`. `delta === true` ⇒ read
`(await readConfig(ctx)).pack` **once per `buildPack` call** (`readConfig` is memoised;
never re-read mid-pass, or a concurrent config write could change the policy halfway through
one pack) and `resolveDeltaPolicy(...)`; when `policy.enabled` is false, take the **same
unchanged base-only path** (no metadata pass, no sort, no window — a disabled config must
cost nothing and must reproduce the pre-change bytes byte-for-byte); otherwise
`deltifyEntries` and `serializePackfile(entries.map(e => e.entry))`, zipping the
emission-order ids with `packfile.entries` into the Part 5 triples.

Note the consequence of the `readRawObject` switch: on the **enabled** path base entries come
from raw stored bytes, on the **disabled** path from `readObject` + `serializeObject`. For a
well-formed object they are byte-identical (the oid *is* the hash of exactly those bytes), so
the disable-path byte-identity assertion holds; they diverge only for an object whose stored
bytes are not canonical, and there the raw path is the git-faithful one.

The module docblock (`build-pack.ts:1-12`) currently promises the pack is "self-contained: no
REF_DELTA references, no OFS_DELTA back pointers, no thin-pack assumptions". Rewrite: the
pack is still **self-contained** and still carries **no REF_DELTA and no thin-pack
assumption** — every delta's base precedes it in the same pack — but OFS_DELTA back pointers
are now emitted when the caller opts in. The self-containment half is what the push path
depends on and it survives; only the "no back pointers" clause changes.

**Tests** — extend `test/unit/application/primitives/build-pack.test.ts` and add
`test/unit/domain/storage/delta-policy.test.ts` plus
`test/unit/application/primitives/internal/deltify.test.ts`:

- `delta-policy.test.ts`: `comparePackEmissionOrder` — type ascending, then size **descending**,
  then id ascending; a totality check that no two distinct keys compare 0.
  `acceptsDeltaEntry` — strictly smaller accepted; **exactly equal rejected** (the `<` vs
  `<=` mutant dies only here); one byte larger rejected; the `MAX_OFS_OVERHEAD_BYTES` term
  proved by a pair that flips verdict when it is dropped.
  `resolveDeltaPolicy` — defaults 10/50; `window = 0` alone disables; `window = -1` alone
  disables; `depth = 0` alone disables; `depth = -1` alone disables (four separate tests —
  one merged test lets a flipped `&&`/`||` survive); `depth = 250` ⇒ `maxDepth === 50`;
  `depth = 10` ⇒ `maxDepth === 10`; `windowMemory` absent ⇒ budget `0`.
- `deltify.test.ts`: a corpus of near-identical blobs emits at least one `OFS_DELTA` whose
  `baseIndex` is a strictly earlier emission index; a corpus of incompressible unrelated
  blobs emits **zero** deltas; `policy.window = 1` tries at most one candidate; a
  chain-forcing corpus emits no chain longer than `policy.maxDepth`, verified by walking the
  emitted back-pointers; `windowMemoryBudget` smaller than one object's content ⇒ that object
  is never admitted and never becomes a base; a budget that fits two of three objects ⇒ the
  oldest is evicted first. Plus the degenerate set: `oids: []` ⇒ `[]`; a single oid ⇒ one
  base entry; a corpus of one object type. Use a spy over `ctx.compressor.deflate` to prove
  the two-deflate acceptance rule runs only for objects that won a search.
- `build-pack.test.ts`: **determinism (the first of ADR-775's two tests)** — two `buildPack`
  calls with `delta: true` over the same oid set return byte-identical `bytes` and equal
  `sha`; and a call over a **shuffled** oid array returns the same pack body bytes as the
  sorted one, since emission order is sort-derived. **Disable path** — with
  `pack.window = 0` (and again with `pack.depth = 0`), `buildPack(ctx, { oids, delta: true })`
  returns bytes byte-identical to `buildPack(ctx, { oids })`. **Depth cap** — a synthetic
  chain-forcing corpus resolves every object through `readObject` and emits no chain longer
  than `maxDepth`. **Acceptance** — an incompressible corpus emits zero delta entries and the
  pack is not larger than the same corpus written base-only.
  Reset the config cache between config-mutating cases with
  `__resetConfigCacheForTests()` (already imported at `build-pack.test.ts:12`).

**Surface gate:** `BuildPackInput` gains an optional field and is barrelled ⇒
`npm run docs:json`, commit `reports/api.json`.

> **Why this part shares `src/application/primitives/build-pack.ts` and
> `test/unit/application/primitives/build-pack.test.ts` with Parts 5 and 7:** Part 5 changes
> the *result* contract with no behaviour change; this part adds the *input* option and the
> selection engine; Part 7 flips callers. Merging them would make one commit that both
> re-shapes a published type and turns on a new packing algorithm — untestable as a unit and
> unreviewable as a diff.

### TDD steps

1. **RED** — `delta-policy.test.ts`: `comparePackEmissionOrder` orders `(type ASC, size DESC,
   id ASC)`. Fails: module missing.
2. **GREEN** — `delta-policy.ts` comparator.
3. **RED** — `acceptsDeltaEntry` equal-lengths-rejects and the `MAX_OFS_OVERHEAD_BYTES`
   flip-verdict pair. Fails: predicate missing.
4. **GREEN** — `acceptsDeltaEntry`.
5. **RED** — the six `resolveDeltaPolicy` cases (defaults, four independent disable cases,
   `maxDepth` clamp). Fails: resolver missing.
6. **GREEN** — `resolveDeltaPolicy`.
7. **RED** — `deltify.test.ts`: near-identical blobs produce an `OFS_DELTA` with an earlier
   `baseIndex`. Fails: `deltify.ts` missing.
8. **GREEN** — `deltifyEntries`: metadata pass, sort, window, search, acceptance, emission.
9. **RED** — the remaining `deltify.test.ts` cases (zero deltas on incompressible input,
   `window = 1`, depth cap, the two `windowMemory` cases).
10. **GREEN** — window bounds and the depth filter.
11. **RED** — `build-pack.test.ts`: `buildPack(ctx, { oids, delta: true })` emits at least one
    delta entry. Fails: `BuildPackInput` has no `delta`.
12. **GREEN** — the option, the policy read, the disabled short-circuit, the `readRawObject`
    switch on the delta path.
13. **RED** — determinism ×2 (repeat call byte-equal; shuffled input byte-equal) and the two
    disable-path byte-identity cases.
14. **RED** — fsck: a synthetic chain of exactly `MAX_DELTA_CHAIN_DEPTH` hops types as
    `typed`. Fails on the current `depth < MAX_DELTA_CHAIN_DEPTH`.
15. **GREEN** — `depth <= MAX_DELTA_CHAIN_DEPTH` in `walkDeltaChain`; add the
    `MAX_DELTA_CHAIN_DEPTH + 1` case asserting `untyped` so the `<`/`<=` mutant dies.
16. **REFACTOR** — rewrite `build-pack.ts`'s module docblock; check `deltify.ts` stays under
    the file-size and function-size ceilings (extract the search loop if needed);
    `npm run docs:json` and commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/storage/delta-policy.test.ts test/unit/application/primitives/internal/deltify.test.ts test/unit/application/primitives/build-pack.test.ts test/unit/application/commands/fsck.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/storage/delta-policy.ts src/application/primitives/internal/deltify.ts src/application/primitives/build-pack.ts src/application/commands/internal/fsck/object-cache.ts test/unit/domain/storage/delta-policy.test.ts test/unit/application/primitives/internal/deltify.test.ts test/unit/application/primitives/build-pack.test.ts \
  && npm run check:spelling
```
Plus `npx vitest run --coverage --project unit test/unit/domain/storage/` to confirm
`delta-policy.ts` is 100 %, and the pre-paid `npm run docs:json` + commit of
`reports/api.json`.

### Commit

`feat(primitives): select and emit offset deltas behind a per-call option`

## Part 7 — Callers opt in, and the cross-tool interop suite

### Context

Turn the option on for the five call sites ADR-767 names, wire the eager config refusal, and
pin the whole thing against real git. **`push` stays base-only** — its pack crosses the wire
and `ofs-delta` would have to survive `selectPushCapabilities`'s intersection with the
server's advertisement (`src/application/commands/internal/receive-pack-client.ts:39-51`,
`src/domain/protocol/capabilities.ts:17-23`). Leaving it alone keeps `receive-pack-client.ts:31-33`'s
"tsgit never advertises `thin-pack` because it emits non-delta packs" comment true.

**Call-site edits (all `delta: true`):**

| File | Line | Call |
|---|---|---|
| `src/application/commands/internal/gc-pipeline.ts` | 484 | `buildAndWriteNormalPack` → `buildPack(ctx, { oids, delta: true })` |
| ″ | 527 | `buildAndWritePromisorPack` → same |
| ″ | 560 | `buildAndWriteCruftPack` → `buildPack(ctx, { oids: survivors, delta: true })` |
| `src/application/commands/pack-objects.ts` | 82 | `buildPack(ctx, { oids, delta: true })` |
| `src/application/commands/bundle-create.ts` | 310 | `buildPack(ctx, { oids: closure.objects, delta: true })` |
| `src/application/commands/push.ts` | 353 | **unchanged** |

**Eager config refusal — three sites, one per opt-in command.** Faithful: real git's
`repack` *and* `pack-objects` both die on a malformed `pack.depth`, and a refused value must
never be silently read back as absent-and-defaulted.

- `runGcTask` (`gc-pipeline.ts:769`): add `await assertValidPackIntConfig(ctx);` immediately
  beside the existing `await assertValidBooleanConfig(ctx, 'gc', undefined, ['cruftPacks']);`
  at L797 — before `readConfig`, and well before the
  `// --- every write starts here; every refusal above leaves the store untouched ---`
  boundary. Placing it here rather than inside `buildPack` is what makes an **empty**
  repository still refuse, matching git; `buildAndWriteNormalPack` returns early on
  `oids.length === 0` and would otherwise never reach the packer.
- `packObjects` (`pack-objects.ts`): add it after `await assertOperationalRepository(ctx);`.
- `bundleCreate` (`bundle-create.ts`): add it after `await assertOperationalRepository(ctx);`.

Three sites, each independently observable by a test — do **not** add a fourth call inside
`buildPack`, which would be provably redundant and a guaranteed surviving mutant.

**Comment amendments (prose only, no behaviour):**

- `gc-pipeline.ts:404-411` — the comment beginning "`buildPack` writes entries in ARRAY
  order and does not sort them itself". Add one clause: with delta emission on, `buildPack`
  sorts internally, so the array order governs only the delta-disabled path — which is
  exactly why `toNormalPack.sort()` (L412) stays.
- `gc-pipeline.ts:847-853` — the same clause for `toPromisorPack`.
- `pack-objects.ts`'s `PackObjectsResult.packId` docblock ("object order inside the pack is
  the closure's own order, which differs between tiers"): this becomes **more** true, not
  less — the pack order is now a function of the object *set*, not of the closure's traversal
  — say so.
- `test/integration/maintenance-interop.test.ts:6-11` — the header paragraph "Pack-internal
  byte layout is NOT compared (tsgit's packer is non-delta; git's is not …)". The parenthesis
  is now false; the *conclusion* (byte layout is not the faithfulness surface) still holds.
- `test/bench/maintenance.bench.ts:1-22` — the docblock justifies the delta-chain scenario
  with "`buildPack` is base-only … so every run re-inflates every delta and re-emits it as a
  full object". That sentence is exactly what this change falsifies. The scenario **stays**
  (it now measures the deltifying path's cost, which is the interesting number); rewrite the
  justification. Add a second scenario over `MEDIUM_FIXTURE`'s barely-deltifiable shape to
  bound the *wasted* search cost — the case where the window finds nothing and every
  candidate is a thrown-away encode. Published numbers come from CI's nightly bench artifact,
  never a local run.

**New** `test/integration/delta-pack-interop.test.ts`, at `test/integration/` root (the
`cross-tool-interop` bucket's `directoryRules` in `test-pyramid-budgets.json:189` allow only
`root`). Header:

```
 * @proves
 *   surface:        packfile
 *   bucket:         cross-tool-interop
 *   unique:         a tsgit gc-written delta pack is indexed, verified and fsck'd clean by real git, and every chain resolves through both readers
 *   interopSurface: packfile
```

`describe.skipIf(!GIT_AVAILABLE)`, **one shared `beforeAll` repo** and a **60 s timeout** (the
known interop load→validate flake), `runGitEnv()` / `git(dir, …)` from
`test/integration/interop-helpers.ts`.

**Shared helpers to extract, not duplicate.** `test/integration/fsck-pack-accessibility-interop.test.ts`
already carries `verifyPackRows(dir, idxPath)` (L1032, over the `VerifyPackRow` interface at L1024 — parses `git verify-pack -v`'s
5-field base lines and 7-field delta lines into `{ oid, sizeInPackfile, offset, isDelta }`)
and `flipEntryBodyByte(packBytes, entryOffset, entryEnd)` (L1049 — flips one byte inside an
entry's compressed body, located via `parsePackEntryHeader`'s own `dataOffset`, so the
corruption never lands in the header). `pseudoRandomBytes(length, seed)` (L1058) is the
deterministic incompressible-content generator the negative-acceptance rows want. Move all
three into the existing shared module
`test/integration/pack-fixture-helpers.ts` (which already exports `sha1`, `restampPackVersion`,
`restampIdxForPack`, `trailerOf`, `countObjects`, `packStemPaths`) and import them from both
files. jscpd does not scan `test/`, so this is for correctness of oracle, not for a gate.

**Rows — every one is a pinned oracle, measured on git 2.55.0:**

| # | Given | Then |
|---|---|---|
| X1 | a repo tsgit `gc`'d | the pack contains at least one **`OFS_DELTA`** and **zero** `REF_DELTA`. Oracle: `git show-index < <idx>` for every object's pack offset, then read the type nibble `(packBytes[offset] >> 4) & 7` in the `.pack`. **Not** `verify-pack` — see the trap below. Runs first; every row below is vacuous without it |
| X2 | the same `.pack` copied into a scratch dir **outside any repository** | `git index-pack --strict -v <pack>` exits **0**, prints the pack's own sha **bare** on stdout, stderr carries `Indexing objects: 100% (…)` + `Resolving deltas: 100% (…)`, and it writes both `<stem>.idx` **and** `<stem>.rev` beside the pack |
| X3 | the same repo | `git fsck --strict --no-progress` exits **0** with **zero output on both streams** |
| X4 | the same repo | `git cat-file --batch-all-objects --batch-check='%(objectname)' \| git cat-file --batch` exits **0**, and the `--batch-check` listing equals the oid/type/size set that went in |
| X5 | a tsgit-written delta pack | `git verify-pack -v`'s `chain length = N: M objects` histogram shows every `N <= maxDepth`, and the 7-field lines' chain-depth column agrees |
| X6 | a corpus deliberately built to reach `maxDepth` | tsgit's own `fsck` reports **no** delta-chain finding, and `readObject` resolves every oid — both readers, which is what pins the Part 6b widening |
| X7 | the design's F1 text-churn shape (one ~500-line file, 200 commits, 5 lines edited + 1 appended each — the ×9.10 fixture whose max chain saturates the default depth) gc'd by tsgit and repacked by `git -c pack.threads=1 repack -a -d` | tsgit's pack size is within the recorded size **class** of git's, with generous headroom — never a byte count, never a ratio threshold |
| X8 | `pack.depth`/`pack.window` = `abc`, `2147483648`, valueless, each as the **first** and as the **last** of two lines | tsgit refuses with `CONFIG_BAD_NUMERIC_VALUE` carrying the pinned key/source/value/reason **in both orders**, and real `git repack -a -d` refuses the same value with the same reason tail at exit 128 |
| X9 | `pack.depth` = `2147483647`, `100000`, `4095` | tsgit accepts, no refusal — matching git's accept-and-clamp |
| X10 | `pack.depth = 0`, `pack.depth = -1`, `pack.window = 0`, `pack.window = -1`, each alone | no delta entry is emitted, the pack is byte-identical to the pre-change writer's output for the same oid set, and real `git repack` with the same config also emits zero deltas. **The migration-safety case** |
| X11 | `pack.window = 1` | chains stay shallow and git still accepts the pack |
| X12 | a bundle written by tsgit `bundleCreate` over a deltifiable closure | `git bundle verify` exits **0** and `git clone <bundle> <dir>` produces a repository whose object set equals the closure — the bundle path's only cross-tool proof |
| X13 | a pack written by tsgit `packObjects` over a deltifiable closure | contains at least one `OFS_DELTA` and zero `REF_DELTA` (same show-index + type-nibble oracle as X1), and `git index-pack --verify` exits 0 |
| X14 | **push stays base-only** — a pack built on the push path | contains **zero** type-6 and zero type-7 entries. This is the regression guard for the one caller ADR-767 deliberately excludes; without it, a later "make it consistent" edit silently turns deltas on across the wire |

**Corruption oracles — three cases, because the same corruption yields three different exit
codes:**

| Corruption | Oracle | Expected |
|---|---|---|
| one byte flipped inside an `ofs-delta` **payload** of a tsgit-written pack | `git index-pack --strict -v` | exit **128**, `error: inflate: data stream error (incorrect data check)` then `fatal: pack has bad object at offset <n>: inflate returned -3` |
| the same pack | `git verify-pack -v <idx>` | exit **1** — *not* 128 — stdout tail `<pack>: bad` |
| the same pack installed in a repo | `git fsck --strict` | exit **6**, with `pack checksum mismatch` / `index CRC mismatch` / `failed to unpack compressed delta` on stderr |

A test asserting merely "non-zero" would pass on the wrong failure. Pin each code.

🔴 **Four traps this suite must respect:**

1. **`git verify-pack -v` cannot tell `OFS_DELTA` from `REF_DELTA`.** It prints the
   *resolved* type: a base is a 5-field line, a delta is a 7-field line, and the OFS-vs-REF
   distinction is invisible in both. X1's oracle is `git show-index` + the type nibble.
2. **`git cat-file --batch-check` is not a content oracle.** On a pack with corrupt delta
   payloads it still exits **0** and prints every line, because it reads type and size from
   headers without inflating delta payloads. X4 must be the full pipe.
3. **Any test that corrupts an entry *header* (not a payload) must recompute the pack's
   20-byte trailer**, or git answers `fatal: pack is corrupted (SHA1 mismatch)` and never
   reaches the condition under test. A payload flip does not need it, because inflate fails
   during the indexing pass, before the trailer check. `restampIdxForPack` /
   `trailerOf` in `pack-fixture-helpers.ts` are the existing tools.
4. **Any size comparison against git must pin `-c pack.threads=1` and assert a tolerance
   band, never an equality.** Measured: the same repository repacked three times under
   default threading spread 81 946 … 85 078 bytes — 3.8 % on identical input — because the
   threaded search partitions the object list. Single-threaded git is reproducible *and*
   ~12.5 % smaller. tsgit's deltify pass is single-threaded by design, so it inherits git's
   better branch; that stricter determinism is a deliberate divergence in tsgit's favour, not
   an accident.

**Extend** `test/integration/maintenance-interop.test.ts`:

- **The second of ADR-775's two determinism tests, and the ADR-769/775 identity pins:** run a
  full `gc` twice over an unchanged repository and assert the **same** normal, promisor and
  cruft pack checksums, and the same no-op branch. The three assertions already exist in the
  codebase as gc's own identity keys — `existingCruftShas.has(pack.sha)` /
  `existingNormalNames.has('pack-'+pack.sha)` (`gc-pipeline.ts:492-496`),
  `reusedExistingName` (`:538`), and the cruft short-circuit (`:561`). The
  `buildPack` spies in `test/unit/application/commands/maintenance.test.ts:1906-1930` already
  express the shape ("Then buildPack is never invoked — the noop shortcut skips the rebuild
  entirely") and must still pass.
- The directional size assertion, inverted: on the delta-chain fixture `packBytesAfter` is now
  **within the recorded class of** `packBytesBefore` rather than multiples above it. Assert a
  class with headroom, never a threshold.

### TDD steps

1. **RED** — `maintenance-interop.test.ts`: after a tsgit `gc`, the written pack contains at
   least one entry whose type nibble is 6. Fails: gc still writes base-only.
2. **GREEN** — `delta: true` at the three gc call sites.
3. **RED** — `pack-objects` and `bundle-create` equivalents (a delta entry appears in the
   written pack / in the bundle's embedded pack). Fails: those two still base-only.
4. **GREEN** — `delta: true` at both.
5. **RED** — `maintenance({ tasks: ['gc'] })` on an **empty** repository with
   `pack.depth = abc` rejects with `CONFIG_BAD_NUMERIC_VALUE`; and the same for
   `packObjects` and `bundleCreate`. Fails: no eager assert wired.
6. **GREEN** — `assertValidPackIntConfig` at the three entry points.
7. **RED** — `delta-pack-interop.test.ts` X1 (show-index + type nibble, zero REF_DELTA), then
   X2/X3/X4 acceptance oracles, then the three corruption oracles with their three distinct
   exit codes.
8. **GREEN** — fix whatever git refuses. The most likely failure is a `baseDistance`
   off-by-one, which `git index-pack --strict` reports as
   `delta base offset is out of bound` or `pack has N unresolved deltas`.
9. **RED** — X5/X6 (chain histogram within `maxDepth`; tsgit `fsck` clean and `readObject`
   resolving every oid on a corpus built to reach the cap), then X9/X10/X11, then X7's size
   class with `-c pack.threads=1`.
10. **GREEN** — whatever the depth or disable path gets wrong.
11. **RED** — `maintenance-interop.test.ts`: gc run twice reproduces the same normal /
    promisor / cruft pack checksums and takes the same no-op branch. Fails if any
    non-determinism leaked into the selection path — grep the deltify path for `Date.now`,
    `performance.now`, `Math.random`, `Promise.race`, `Map`, `Set` before debugging further.
12. **REFACTOR** — move `verifyPackRows` and `flipEntryBodyByte` into
    `test/integration/pack-fixture-helpers.ts` and repoint
    `fsck-pack-accessibility-interop.test.ts`; apply the five comment amendments; add the
    `MEDIUM_FIXTURE` bench scenario and rewrite the bench docblock; invert the
    `maintenance-interop` size assertion.

### Gate

```
npx vitest run test/integration/delta-pack-interop.test.ts test/integration/maintenance-interop.test.ts test/integration/fsck-pack-accessibility-interop.test.ts test/unit/application/commands/maintenance.test.ts test/unit/application/commands/pack-objects.test.ts test/unit/application/commands/bundle-create.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/gc-pipeline.ts src/application/commands/pack-objects.ts src/application/commands/bundle-create.ts test/integration/delta-pack-interop.test.ts test/integration/pack-fixture-helpers.ts test/integration/maintenance-interop.test.ts test/bench/maintenance.bench.ts \
  && npm run check:spelling
```
Plus `npm run check:test-pyramid` (a new integration file with a `@proves` header),
`npm run check:assert-tier` (new test files are classified against
`tooling/audit-assert-tier.allowlist.json`) and `npm run check:write-surfaces` (a second
prover for `surface: packfile`). No `reports/api.json` change is expected — run
`npm run docs:json` and confirm the file is unmodified.

### Commit

`feat(gc): write delta-compressed packs from gc, pack-objects and bundle-create`

## Part 8 — Retire the inflation note

### Context

Docs-only. **No `src/` delta**, which is what makes this legitimately standalone: there is no
implementation part to fold it into, and the numbers it publishes can only be measured once
every code part has landed.

Four places record ADR-732's accepted size trade, and all four are evidence-bearing rather
than decorative:

| Where | What it says today | What it becomes |
|---|---|---|
| `docs/use/commands/maintenance.md` §"The size trade" (L210-222) | "tsgit's pack writer emits every object as a full base entry — it does not write delta chains. Consolidating a repository that git had delta-compressed therefore **inflates** it … ×1.29 … ×6.91 … ×3.17 on tsgit's own real history" | Rewritten from the new measurements. **This is the only user-facing copy and the one that must not lag.** It must also record the two documented divergences: `pack.depth` above 50 is clamped silently (git warns and clamps at 4095; tsgit clamps further, observable only as smaller-than-expected compression, never as an error), and `pack.windowMemory` values in `[2**63, 2**64)` are refused as `out of range` where git accepts them |
| `docs/design/perf-remediation-2026-08.md` §"The size trade, measured" (L3078, with "**The follow-up that retires it.** ⏭️ …" at L3117) and the DC-17 row (L3448) | the ×1.29 / ×3.17 / ×6.91 table and "the single change that would take all three rows of the table above to ×1.00" | A pointer line to `docs/design/delta-writing-packer.md` plus the re-measured ratios. **The old table stays** as the historical baseline it is |
| `docs/design/perf-remediation-2026-08.md` §Out of scope (L3546, "**A delta-capable pack writer.** ⏭️ **The follow-up that retires ADR-732's size trade**") | "A delta-capable pack writer. ⏭️ The follow-up that retires ADR-732's size trade" | struck through and pointed here, in the same style that entry already uses for the two items ADR-731/732 moved into scope |
| `docs/adr/732-gc-consolidates-existing-packs.md` §Consequences (L42) | "…a delta-writing pack writer becomes the highest-value follow-up to this command" | **Not rewritten** — it was true when ratified. ADRs 767-778 already refine it; ADR-767's own header records the supersession |

**What counts as evidence.** Not "deltas are now written" — a size table, over **both**
corpus families, because they are not the same claim:

1. **The original three** the ×1.29 / ×3.17 / ×6.91 figures were taken over — the
   `DELTA_CHAIN_FIXTURE` shape, tsgit's own full history, and the `MEDIUM_FIXTURE` shape.
   Both fixtures are generated by `test/bench/support/fixture-generator.ts`. Only
   re-measuring *those* retires *those* numbers; a new table over new fixtures would be a
   different claim wearing the same clothes.
2. **The design's F1/F2/F3 fixtures** (§1d of `docs/design/delta-writing-packer.md`): F1
   text-churn (one ~500-line file, 200 commits, 5 lines edited + 1 appended each — 603
   objects), F2 many-small-files (300 unique high-entropy 12-line files over 50 commits — 403
   objects), F3 wide-tree-churn (150 files in 10 nested dirs, 80 commits touching 3-5 files —
   1 096 objects). Recorded delta-free vs deltified `.pack` sizes on git 2.55.0:
   F1 653 400 → 71 817 (×9.10, max chain **50** — it saturates the default cap);
   F2 234 294 → 55 112 (×4.25); F3 246 551 → 127 996 (×1.93).

**Measurement recipe** — every number is taken the same way, in a `mktemp -d` throwaway with
isolated `HOME`/`XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, all `GIT_*` scrubbed
and signing off:

- Denominator: `git -c pack.threads=1 repack -a -d`. **Never default threading** — it is not
  reproducible (3.8 % spread on identical input) and it is ~12.5 % larger.
- Numerator: tsgit `maintenance({ tasks: ['gc'] })`, reading
  `MaintenanceResult.packBytesBefore` / `packBytesAfter` — those fields keep their meaning
  exactly and need no change; the ratio a caller computes from them simply approaches 1.
- `git repack -a -d` **reuses existing deltas** by default (`--reuse-delta`); it does not
  re-search unless the repository is loose-only at repack time or `-f` is passed. Control for
  that when comparing, exactly as the original measurements did.
- The assertion style everywhere is a **class with headroom**, never a byte count. The perf
  design's own note that a 5×-moving number is a flake generator applies just as much to a
  shrinking one, and the peer itself moves.

**Backlog** — tick `docs/BACKLOG.md` **30.4** (L566), summarising the shipped scope the way
30.2 and 30.3 summarise theirs, and including what the design discovered that the entry did
not anticipate: the two readers' one-hop disagreement on delta-chain depth, and the absence of
path hints on the gc path (so the emission order is size-adjacency, not git's name-hash
adjacency). Leave 30.5 (L567) untouched; its "sequenced after 30.4 if the packer work
reshapes the shared pack-write/read seams" note is now answerable — `serializePackfile` still
takes a materialised array and `baseIndex` is array-relative, so a streaming writer
re-implements exactly one arithmetic (`baseIndex` → byte distance) and nothing else; and
`buildPack` gained a metadata pass structurally similar to the read-side indexer's first
pass, worth unifying later but not speculatively.

⚠️ The backlog file is edited concurrently by other work. Change **only** the 30.4 line and
its checkbox; `git commit --only docs/BACKLOG.md …` semantics — never `git add -A`.

### TDD steps

Docs-only: the "test" is the measurement, and the failure mode is publishing a number that
cannot be reproduced.

1. **RED (measurement)** — build the three original corpora
   (`DELTA_CHAIN_FIXTURE`, tsgit's own history, `MEDIUM_FIXTURE` via
   `test/bench/support/fixture-generator.ts`) in a throwaway, run tsgit `gc` on each, and
   record `packBytesBefore` / `packBytesAfter`. The current published ratios (×1.29 / ×3.17 /
   ×6.91) must **not** reproduce — if they do, the delta path is not actually on for gc and
   Part 7 regressed.
2. **RED (measurement)** — build F1/F2/F3 per the design's §1d shapes, gc each with tsgit and
   repack each with `git -c pack.threads=1 repack -a -d`, and record both sizes. tsgit's
   number must land inside the ×1.9 … ×9.1 savings class, shape-dependent; anything outside
   it is a defect to escalate, not a number to publish.
   ⚠️ There is **no committed F1/F2/F3 generator** in the repo despite the design's wording.
   Write the generator as a throwaway script in the scratchpad and delete it. Committing a
   new fixture generator would be scope creep and would need its own tests, budgets and
   pyramid classification.
3. **GREEN** — rewrite `docs/use/commands/maintenance.md` §"The size trade" from the measured
   table, including the two documented divergences.
4. **GREEN** — add the pointer line and re-measured ratios to
   `docs/design/perf-remediation-2026-08.md` §"The size trade, measured" (L3078/L3117) and the
   DC-17 row (L3448); strike through the §Out of scope entry (L3546) and point it here.
5. **GREEN** — tick `docs/BACKLOG.md` 30.4 with the shipped-scope summary.
6. **REFACTOR** — `npm run check:doc-links` and `npm run check:spelling` over the edited docs;
   confirm no `docs/adr/732-*.md` edit crept in.

### Gate

```
npm run check:spelling && npm run check:doc-links
```
No `vitest` target, no `check:types` and **no `biome check`**: this part touches no `.ts`
file, and biome does not process markdown — pointing it at `docs/` would be a no-op that
reads like a pass. `check:doc-links` runs `lychee` against the network; a transient link
failure is not a reason to change the docs. Finish with one `npm run validate` to confirm the
whole tree is green before the phase boundary. Cache bypass:
`npx cspell --no-progress docs/use/commands/maintenance.md docs/design/perf-remediation-2026-08.md docs/BACKLOG.md`.

### Commit

`docs(maintenance): retire the pack size-inflation note with measured ratios`
