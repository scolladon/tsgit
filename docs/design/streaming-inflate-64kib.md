# Design — streaming-inflate-64kib: fix pack-entry reads truncated at 64 KiB

> Brief: packed-path reads fail when a single pack entry's compressed zlib payload
> exceeds `PACK_SLICE_HINT = 1 << 16 = 65536` bytes. Backlog repro: commit a
> ~140 KB random-bytes blob → `git gc` → `repo.primitives.readBlob(id)` throws
> `DECOMPRESS_FAILED: unexpected end of file`. Boundary confirmed empirically at
> 65,365 OK / 67,618 FAIL (matching the 65536-byte hard cap exactly).
> Status: draft → self-reviewed ×3 → ADRs 359/360/361 ratified → revised

## Context

`object-resolver.ts:readEntryHeaderWithChunk` reads a single fixed-size slice
(`PACK_SLICE_HINT = 1 << 16 = 65536` bytes) from the pack file at the entry's
offset, then passes the slice to `ctx.compressor.streamInflate(chunk,
headerEndInChunk)`. The original assumption — "header parse and the zlib stream
both live inside this chunk so a single read covers both" — holds for small
objects but breaks the moment the compressed zlib stream exceeds the space
remaining in the 64 KiB slice. The resolver never retries with a larger slice,
so `streamInflate` receives a truncated mid-stream buffer and Node's zlib
`createInflate` emits `error: unexpected end of file`.

Two structural facts shape the fix (confirmed empirically; recorded in ADR-359):

- The pack-index stores per-entry **offsets** but **not** compressed sizes. A
  single entry's compressed length is not known a priori.
- `InflateStreamResult.bytesConsumed` is consumed in exactly **one** call site:
  `fetch-pack.ts:inflateAllEntries` (sequential walk of a received in-memory
  pack during indexing). `object-resolver` reads a single object via the index,
  which already knows the entry's offset, and **discards** `bytesConsumed`.
  The whole-buffer `inflate(data)` is size-unbounded on **all three** adapters
  (Node: `inflateSync` up to 2 GiB cap; browser/memory: `DecompressionStream`
  over the whole buffer). Only `streamInflate` carries the O(n²)
  progressive-prefix scan and its 64 KiB cap, and only because it must locate a
  member boundary inside a buffer that has trailing bytes from later entries.

## Empirical root-cause confirmation

All probes ran in `mktemp -d` throwaway directories with a scrubbed environment
(`GIT_*` unset, `HOME=/tmp/nonexistent-home`, `GIT_CONFIG_NOSYSTEM=1`,
`GIT_CEILING_DIRECTORIES=/tmp`, `commit.gpgsign=false`).

### Packed path — CONFIRMED FAILING

```
Repository setup:
  143000-byte random-bytes binary file (incompressible)
  git add + git commit → blob SHA ff305fc6f3e964edb7ef435da3dac44ec0086ad5
  git gc

verify-pack output:
  ff305fc6f3e964edb7ef435da3dac44ec0086ad5  blob  143000  143054  132
    (                                        type  inflated compressed  offset)
```

- Pack entry at file offset 132; entry header ≈ 5 bytes; zlib stream starts at
  ~offset 137 and runs for **143054 bytes** (compressed size ≈ inflated for
  random data), ending at byte ~143191.
- `PACK_SLICE_HINT = 65536`: `readSlice(path, 132, 65536)` covers bytes
  132..65668, cutting off the zlib stream at byte 65668 — 77 523 bytes short
  of the stream terminator.
- `NodeCompressor.streamInflate` receives the truncated 65530-byte slice;
  `createInflate` emits `unexpected end of file`.

Vitest integration probe result:
```
FAIL  test/integration/probe-packed-blob.test.ts > Packed blob >64KB probe
TsgitError: DECOMPRESS_FAILED: decompression failed: unexpected end of file
  at Inflate.<anonymous> src/adapters/node/node-compressor.ts:75:16
```

### Loose path — CONFIRMED WORKING

The same blob written but NOT packed (`git gc` not run):
- `tryLoose` reads the whole file: `ctx.fs.read(path)` → Node
  `readFile` (no size cap) → 143063 compressed bytes.
- `NodeCompressor.inflate` calls `inflateSync(data, { maxOutputLength: 2 GiB })`.

Vitest integration probe result:
```
PASS  test/integration/probe-loose-blob.test.ts > Loose blob >64KB probe
```

**Conclusion on the "both paths fail" backlog claim:** the loose path works
correctly today. Only the packed path is broken. This design scopes the fix
to the packed path only.

## Approach (decided: ADR-359)

Replace the 64 KiB fixed-read guess with **exact-slice reads via the next-entry
offset**. The fix is grounded in a structural property of the v2 pack-index
format: it stores every entry's offset, and git packs have no inter-entry
padding. The exact byte range for entry `i` is therefore `[offset_i, offset_{i+1})`,
with the last (highest-offset) entry bounded by `packFileSize − digestLength`
(the pack trailer start).

`object-resolver` computes the exact range, reads exactly that slice, and
inflates via the size-unbounded whole-buffer `ctx.compressor.inflate`. The
64 KiB ceiling lifts on Node, browser, and memory alike with no inflate
rewrite. `PACK_SLICE_HINT` is deleted (ADR-360) because no first-read hint
remains.

Three alternative strategies were weighed in the original decision candidates
and are retained as historical record at the bottom of this document; all three
are now superseded by the ADR decision and are not open for re-litigation.

### Per-pack sorted-offset table

To derive `nextOffset` for any entry efficiently, each `RegisteredPack` lazily
builds and caches a sorted array of all entry offsets. The array is constructed
once per `RegisteredPack` lifetime using `readOffset(index, i)` for
`i ∈ [0, objectCount)`, sorted numerically. For a given entry at `offset`, the
next offset is `sortedOffsets[rank + 1]` where `rank` is the position of
`offset` in the sorted array; the last entry has no successor and its bound is
`packFileSize − digestLength`.

The pack file size is obtained via `ctx.fs.stat(packPath).size` at table-build
time and cached alongside the sorted offset array. This is one additional
`stat` call per pack per process lifetime (the table is built on first use and
held in the `RegisteredPack` cache that already outlives individual object
lookups).

### Large-offset (>2 GiB) packs

`readOffset(index, i)` already reads the large-offset table for entries whose
small-offset slot has the MSB set (see `pack-index.ts:91`). The sorted-offset
table build must call `readOffset(index, i)` for all `i` — it may not read the
small-offset table directly — so large-offset entries are correctly included.
The sorted array is of type `number[]`; JavaScript `number` represents integers
exactly up to `2^53 − 1`, which covers all plausible pack file sizes. The
existing `readOffset` already enforces this (`high > 0x1fffff` throws
`invalidPackIndex`).

### Corrupt index edge cases

If the sorted offset table contains a `nextOffset <= offset` (e.g., a
duplicate or out-of-order entry in a corrupt index), the read length would be
zero or negative. The resolver must detect this and throw
`invalidPackIndex('next-offset ≤ current offset: corrupt index')` rather than
issuing a zero-byte read or looping. Similarly, if `nextOffset > packFileSize`,
the slice request would exceed the file; the resolver throws the same error.

### Single-entry pack

When `objectCount === 1`, the sorted array has one element, the entry is the
last, and its bound is `packFileSize − digestLength`. This is the normal
last-entry path.

### OFS_DELTA and REF_DELTA chain entries

Each entry in the delta chain — whether a base entry (BLOB, COMMIT, TREE, TAG)
or a delta entry (OFS_DELTA, REF_DELTA) — is itself a pack entry with its own
offset and its own exact slice. `collectDeltaChain` calls
`readEntryHeaderWithChunk` at every step of the chain; the function now derives
`[offset, nextOffset)` at each call. OFS_DELTA entries step `currentHit` by
`currentHit.offset − header.baseDistance`; REF_DELTA entries resolve the base
via `resolveBaseForRefDelta`. Both paths arrive at a new `currentHit` before
the next loop iteration, so each iteration gets its own exact slice.

### `fetch-pack.ts` — unchanged

`inflateAllEntries` passes the entire in-memory `packBytes` buffer to
`streamInflate`. It never uses `readSlice`. No truncation is possible. No
change. `streamInflate` and its `bytesConsumed` contract remain intact on the
`fetch-pack` path.

### Cross-adapter notes (reads require no adapter changes)

`ctx.compressor.inflate(data)` is size-unbounded on all three adapters:

- **Node:** `inflateSync(data, { maxOutputLength: 2 GiB })` — confirmed in
  `NodeCompressor.inflate`.
- **Browser:** `BrowserCompressor.inflate` pipes through `DecompressionStream`
  over the full buffer — no size cap.
- **Memory:** `MemoryCompressor.inflate` pipes through `DecompressionStream`
  via `runTransform` — no size cap.

`streamInflate` retains its 64 KiB cap on browser and memory adapters
(`BROWSER_STREAM_INFLATE_MAX_INPUT`, `MEMORY_STREAM_INFLATE_MAX_INPUT`); this
cap is no longer exercised by the `object-resolver` read path. It remains in
force on the `fetch-pack` path (which keeps `streamInflate`).

### Open decision: fetch-pack large-entry inflate (deferred to review time)

`fetch-pack` (browser clone / indexing of a received pack containing a
>64 KiB-compressed entry) still uses `streamInflate` + `bytesConsumed` and
keeps the browser/memory 64 KiB cap. Lifting **that** requires the Option-4
streaming decoder — a zero-dependency pure-JS streaming zlib decoder that
reports consumed bytes accurately. This is a large, perf-critical, byte-exact
subproject, far beyond a targeted read fix.

**This is not silently deferred.** At review time, once the Option-3 diff size
is known, the decision is: **fold in the streaming decoder** (same PR) vs.
**emit a loud written call-out** in the design and PR description that the
fetch-pack path remains capped. No silent follow-up ticket.

## Slices

### Slice 1 — domain helper: `entryOffsets` on `pack-index.ts`

**Why a domain helper:** `readOffset(index, i)` in `pack-index.ts` is
module-internal (not exported, line 91). The application layer needs to build
the sorted offset table from all `objectCount` offsets. The cleanest seam is
an exported domain function that returns all offsets in index order — the
application layer sorts them once and caches the result. Exporting `readOffset`
directly would expose a raw per-index-position accessor whose callers must know
the large-offset contract; wrapping it in `entryOffsets` hides that complexity
and keeps the port seam clean.

**Files:**
- `src/domain/storage/pack-index.ts`

**Current state:**
- `readOffset(index, i)` — module-internal, line 91; handles the large-offset
  table (MSB check, 8-byte read). Returns a JavaScript `number`.
- `PackIndex.objectCount` — exported on the interface, line 13.
- `lookupPackIndex(index, id)` — the only current exported function that calls
  `readOffset`.

**Change:**
Add a new exported function:
```typescript
export function entryOffsets(index: PackIndex): ReadonlyArray<number>
```
It iterates `i ∈ [0, index.objectCount)`, calls `readOffset(index, i)` for
each, and returns the results as a plain array. The sorting and the
`packFileSize − digestLength` boundary are application-layer concerns, not
domain concerns.

**Edge cases:**
- `objectCount === 0`: returns an empty array (valid; an empty pack has no
  entries to read).
- Large-offset entries: covered by the existing `readOffset` implementation.

### Slice 2 — application helper: per-pack offset table in `pack-registry.ts`

**Files:**
- `src/application/primitives/pack-registry.ts`

**Current state:**
- `RegisteredPack` interface: `{ name, index, packPath, idxPath }` (lines 12–17)
- `PackLookupHit`: `{ pack: RegisteredPack, offset: number }` (lines 19–22)
- `createPackRegistry(ctx)`: builds and caches `RegisteredPack[]` (lines 63–99)

**Change:**
Extend `RegisteredPack` with a lazily-built, cached offset table:

```typescript
export interface RegisteredPack {
  readonly name: string;
  readonly index: PackIndex;
  readonly packPath: string;
  readonly idxPath: string;
  /** Lazily-built, cached sorted entry offsets + trailer bound for this pack. */
  readonly offsetTable: () => Promise<PackOffsetTable>;
}

export interface PackOffsetTable {
  /** Entry offsets sorted ascending. */
  readonly sortedOffsets: ReadonlyArray<number>;
  /** Pack file size (from stat). */
  readonly packFileSize: number;
  /** Trailer start = packFileSize − digestLength. */
  readonly trailerStart: number;
}
```

`offsetTable()` is a lazy initializer: on first call it runs
`ctx.fs.stat(pack.packPath)` to get `packFileSize`, calls `entryOffsets(pack.index)`
to get the raw offsets, sorts them numerically, and caches the result. Subsequent
calls return the cached value directly (no `stat` or sort again).

**Why lazy:** the pack may be looked up but an object lookup might miss it (the
target id is in a different pack). Building the offset table eagerly for every
pack on registry scan would pay the `stat` + `entryOffsets` cost even for packs
that are never used for a read in the session.

**Lookup helper to add:**
```typescript
export function nextOffsetForEntry(
  table: PackOffsetTable,
  offset: number,
  digestLength: number,
): number
```
Returns the next entry's offset (lower bound in `sortedOffsets` after `offset`),
or `table.trailerStart` for the last entry. Throws `invalidPackIndex` if
`offset` is not in `sortedOffsets` (corrupt or inconsistent index).

**Fixtures to extend:**
- `test/unit/application/primitives/pack-fixture.ts` — add a helper to write a
  two-entry synthetic pack so unit tests of the offset table can verify the
  non-last-entry path.

### Slice 3 — `object-resolver.ts`: exact-slice read, delete `PACK_SLICE_HINT`

**Files:**
- `src/application/primitives/object-resolver.ts`

**Current state:**
- `const PACK_SLICE_HINT = 1 << 16;` — line 28, to be deleted (ADR-360)
- `readEntryHeaderWithChunk(ctx, hit)` — lines 310–322; currently reads
  `PACK_SLICE_HINT` bytes, parses the header, returns `{ header, chunk, headerEndInChunk }`
- `collectDeltaChain(ctx, registry, hit, targetId, maxBytes)` — lines 184–235;
  calls `readEntryHeaderWithChunk` at line 197, then calls `streamInflate` at
  lines 200 and 211 — these two `streamInflate` calls switch to `inflate`

**Changes:**

1. Delete `PACK_SLICE_HINT` (line 28).

2. Change `readEntryHeaderWithChunk` signature to accept the exact slice:
```typescript
async function readEntryHeaderWithChunk(
  ctx: Context,
  hit: PackLookupHit,
  nextOffset: number,           // exclusive end of this entry's exact byte range
): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }>
```
Inside, derive `sliceLength = nextOffset - hit.offset` (throw `invalidPackIndex`
if `sliceLength <= 0`), then `readSlice(hit.pack.packPath, hit.offset, sliceLength)`.
Parse the header. Return `{ header, chunk, headerEndInChunk: header.dataOffset }`.

3. In `collectDeltaChain`, before calling `readEntryHeaderWithChunk`, resolve
`nextOffset` from the pack's offset table:
```typescript
const table = await currentHit.pack.offsetTable();
const nextOffset = nextOffsetForEntry(table, currentHit.offset, ctx.hashConfig.digestLength);
```

4. Replace both `ctx.compressor.streamInflate(chunk, headerEndInChunk)` calls
(lines 200 and 211) with `ctx.compressor.inflate(chunk.subarray(headerEndInChunk))`.
`streamInflate` is no longer needed on this path; `inflate` is size-unbounded
on all adapters.

5. Update the return shape from the base branch accordingly:
```typescript
// was:   const inflated = await ctx.compressor.streamInflate(chunk, headerEndInChunk);
//        return { ..., baseContent: inflated.output, ... }
// now:
const baseContent = await ctx.compressor.inflate(chunk.subarray(headerEndInChunk));
return { deltas, baseContent, baseType: header.type };
```

**Corrupt-index guard already addressed in Slice 2** (`nextOffsetForEntry` throws
`invalidPackIndex` for an offset not in the sorted table or a next-offset beyond
the file). The resolver propagates this error without catching it.

### Slice 4 — unit tests

**Files:**
- `test/unit/application/primitives/object-resolver.test.ts`
- `test/unit/domain/storage/pack-index.test.ts` (extend for `entryOffsets`)
- `test/unit/application/primitives/pack-registry.test.ts` (extend for
  `offsetTable` + `nextOffsetForEntry`)

**Context:**
- `buildSeededContext` — `test/unit/application/primitives/fixtures.ts`
- `buildSyntheticPack`, `writeSyntheticPack`, `EntrySpec` —
  `test/unit/application/primitives/pack-fixture.ts`
- `stubRegistry` — defined locally in `object-resolver.test.ts` (lines 57–82)

**New test cases for `pack-index.test.ts` (GWT/AAA/sut):**
```
Given a pack index with N entries
  When entryOffsets is called
  Then returns N offsets matching readOffset(index, i) for all i

Given a pack index with one entry using the large-offset table
  When entryOffsets is called
  Then returns the large offset correctly
```

**New test cases for `pack-registry.test.ts`:**
```
Given a registered pack and its offset table
  When nextOffsetForEntry is called with a non-last offset
  Then returns the next entry's offset

Given a registered pack and its offset table
  When nextOffsetForEntry is called with the last (highest) offset
  Then returns trailerStart (packFileSize − digestLength)

Given a registered pack and its offset table
  When nextOffsetForEntry is called with an offset not in the table
  Then throws invalidPackIndex

Given offsetTable() is called twice on the same RegisteredPack
  When the stat+sort work is done
  Then it is executed exactly once (lazy cache invariant)
```

**New test cases for `object-resolver.test.ts`:**
```
Given a packed base blob whose compressed stream fits in its exact slice
  When resolveObject is called
  Then inflate is called once with exactly chunk.subarray(headerEndInChunk)
  Then the correct content is returned

Given a packed base blob larger than 64 KiB
  When resolveObject is called
  Then inflate is called with the full compressed member
  Then no streamInflate is called on this path

Given a packed OFS-delta entry
  When resolveObject is called
  Then each entry in the chain reads its own exact slice
  Then the delta chain resolves correctly

Given a corrupt index where nextOffset ≤ offset
  When resolveObject is called
  Then throws invalidPackIndex (not an infinite loop or corrupt read)

Given a single-entry pack
  When resolveObject is called
  Then the entry's slice is [offset, packFileSize − digestLength)
```

**Mutation-resistant patterns:**
- Assert that `ctx.compressor.inflate` is called with the exact expected bytes
  (kills mutants that pass the wrong subarray offset).
- Assert that `ctx.compressor.streamInflate` is NOT called on the
  `object-resolver` path after this change (kills mutants that fall back to
  the old path).
- Use try/catch + direct `.data` assertions for `invalidPackIndex` checks
  (not bare `toThrow(ErrorClass)`).
- Separate test for base-entry and each delta-type entry.

### Slice 5 — interop test: large packed blob + two-blob next-offset fixture

**Files:**
- `test/integration/large-object-pack-interop.test.ts` (new file)

**Shape:** twin-repo pattern from `interop-helpers.ts` (`makePeerPair`,
`initBothRepos`, `runGit`, `GIT_AVAILABLE`).

**Fixtures (ADR-361):**

| # | Setup | Test | Asserts |
|---|---|---|---|
| **P1** | commit 140 KB random-bytes blob in peer repo; `git gc` to pack it; copy `.git/objects/pack/*` into ours | `readBlob(ours, blobId)` | `blob.content.length === 140000`; content byte-identical to peer's `git cat-file -p` output |
| **P2** | same pack, read via `resolveObject` with `verifyHash: true` | succeeds | no `OBJECT_HASH_MISMATCH` |
| **P3** | pack with two adjacent large blobs (140 KB + 80 KB, both >64 KiB compressed) to exercise the **next-offset boundary for a NON-last large entry**; the first blob's exact slice ends at the second blob's offset | read both blobs | both content byte-identical to `git cat-file -p` |
| **P4** | loose 140 KB blob (same blob, no gc) | `readBlob(ours, blobId)` | succeeds (regression guard: loose path must not break) |

**P3 rationale (ADR-361):** a single-blob pack only reads the last entry
(bounded by the pack trailer) and never exercises the `[offset, nextOffset)`
path for a non-last entry. Two adjacent large entries are required to prove the
sorted-offset table correctly identifies a non-last boundary and that the read
slice ends exactly at the second entry's start. An off-by-one or mis-sorted
table silently hands `inflate` a truncated or over-read member without raising
an error.

**How to place the pack in `ours`:** copy pack files directly into
`ours/.git/objects/pack/` after `git gc` creates them in the peer; run
`git fsck --strict` on `ours` to verify pack acceptance before tsgit reads it.

**Scrubbed-env discipline:** all `git` calls via `runGit` (`SAFE_ENV`).
`GIT_CONFIG_NOSYSTEM=1`, `HOME=ISOLATED_HOME`. `commit.gpgsign=false` via
`git -C dir config commit.gpgsign false`. Two distinct seeds for the random
blobs in P3 to ensure they produce different object ids.

## Decision candidates

### Decided (ADR-359/360/361)

| # | Decision | Chosen | ADR |
|---|---|---|---|
| **1 — Fix strategy** | How to ensure the slice passed to inflate contains the complete zlib member | **Exact-slice via next-entry offset** — derive `[offset, nextOffset)` from the pack index; read exactly that slice; inflate via the size-unbounded `inflate`. No grow-and-retry, no read-to-EOF. | ADR-359 |
| **2 — `PACK_SLICE_HINT`** | Keep as first-read hint or remove | **Remove** — with exact-slice reads there is no first-read hint step; the constant's only consumer is replaced. | ADR-360 |
| **3 — Two-blob interop fixture (P3)** | Include or skip | **Include** — pins next-offset boundary arithmetic on a real pack/filesystem; the only failure mode that silently mis-reads objects. | ADR-361 |

### Open decision (deferred to review time)

| # | Decision | Status |
|---|---|---|
| **4 — `fetch-pack` large-entry inflate** | Whether to fold in the Option-4 streaming decoder (lifting the browser/memory `streamInflate` 64 KiB cap for received packs) in the same PR. | **Deferred to review time** — decide fold-in vs. loud written call-out once the Option-3 diff size is known. Not a silent follow-up. |

### New decision candidate surfaced by this revision

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| **5 — Domain-helper seam for per-entry offsets** | Where to place the logic that iterates all pack offsets. | **(a) Export `entryOffsets(index)` from `pack-index.ts`:** domain function returns raw offsets in index order; application layer sorts and caches. **(b) Export raw `readOffset(index, i)` from `pack-index.ts`:** application layer calls it in a loop. **(c) Build the sorted table directly in `pack-registry.ts` by duplicating the large-offset read logic.** | **(a) `entryOffsets`** | (a) keeps the large-offset table contract (MSB check, high/low word read) inside the domain, where it already lives in `readOffset`. Exposing raw `readOffset` (b) pushes the large-offset contract knowledge to the application layer. Duplicating the logic (c) violates DRY and drifts from the domain's `readOffset` implementation. `entryOffsets` is a minimal seam: one loop, one export, no new contract surface. |

## Test strategy

Mutation-resistant per project conventions:
- `invalidPackIndex` assertions: try/catch + `.data` assertions, not bare
  `toThrow(ErrorClass)`.
- `inflate` call-argument assertions via spy (kills mutants that pass wrong
  subarray offset).
- Explicit negative assertion that `streamInflate` is not called on the
  `object-resolver` path (kills a mutant that falls back to the old code path).
- Separate tests for base-entry, OFS_DELTA, and REF_DELTA paths (kills
  mutants that handle only one entry type).
- `nextOffsetForEntry` boundary assertions: separate tests for last entry vs.
  non-last entry (kills off-by-one mutants in the sorted array lookup).

### Unit tests

- `pack-index.test.ts` — `entryOffsets` for standard + large-offset entries.
- `pack-registry.test.ts` — `offsetTable` laziness; `nextOffsetForEntry` for
  last entry, non-last entry, offset-not-in-table.
- `object-resolver.test.ts` — exact-slice base blob (small); large base blob;
  OFS_DELTA chain; REF_DELTA chain; corrupt-index (nextOffset ≤ offset);
  single-entry pack.

### Integration tests (`large-object-pack-interop.test.ts` — new)

- P1: single 140 KB random blob, packed, read via `readBlob` → byte-identical.
- P2: same, with `verifyHash: true` — no `OBJECT_HASH_MISMATCH`.
- P3: two adjacent large blobs in same pack → both read correctly (next-offset
  boundary for the non-last entry).
- P4: 140 KB loose blob (no gc) → `readBlob` succeeds (regression guard).

## Non-goals

- Changing the `InflateStreamResult` port interface.
- Changing `fetch-pack.ts` or its `streamInflate` usage (see open decision 4).
- Adding a streaming (non-buffering) inflate path to `object-resolver.ts`:
  that is Option 4 in ADR-359, explicitly deferred.
- Changing `BrowserCompressor.streamInflate` or `MemoryCompressor.streamInflate`:
  these are unchanged; their 64 KiB cap is no longer reachable from the
  `object-resolver` read path.
- Exposing `compressedSize` in the pack-index domain model: the v2 format does
  not store it per entry.

## Self-review log

### Pass 1 (original draft) → Pass 2

- Initial draft had grow-and-retry logic inside `readEntryHeaderWithChunk`
  itself. Refined: the `streamInflate` calls live in `collectDeltaChain`, so
  the retry loop wraps the caller's `streamInflate` call.
- Added the growth-termination invariant distinguishing physical EOF from
  adapter cap from corrupt data.
- Confirmed empirically that `bytesWritten` is correct for large random
  payloads with trailing bytes.

### Pass 2 → Pass 3 (original)

- Added the cross-adapter parity section with the flagged warning for the
  browser/memory 64 KiB `streamInflate` cap.
- Added P3 (two-blob offset test) to the interop fixture design.
- Clarified the `isDecompressFailed` helper requirement.
- Decision candidate table reformatted to include ADR numbers.

### Pass 3 → final (original)

- Confirmed the loose-path repro from the backlog brief. Scoping statement
  updated.
- `MAX_SLICE_DOUBLINGS = 8` choice justified.

### Revision pass (post-ADR ratification: ADRs 359/360/361 accepted)

The ADR conversation ratified Option 3 (exact-slice via next-entry offset),
replacing Option 1 (grow-and-retry) as the decided approach. This revision
rewrites the design from the ground up to describe the decided approach only.

Key changes from the grow-and-retry design:

- **Context section:** added the two structural facts from ADR-359 that motivate
  Option 3; retained the empirical probes unchanged (root cause is the same).
- **Approach section:** replaced the grow-and-retry narrative with exact-slice
  reads; described the per-pack sorted-offset table, the `packFileSize − digestLength`
  trailer bound, large-offset pack handling, corrupt-index guard, single-entry
  pack, and delta-chain entry handling.
- **Cross-adapter notes:** updated to confirm `inflate` is size-unbounded on all
  three adapters (reads need no adapter changes); noted that `streamInflate` caps
  are untouched and no longer reachable from the `object-resolver` path.
- **Open fetch-pack decision:** surfaced explicitly as "deferred to review time
  — not a silent follow-up" (per ADR-359 scope boundary).
- **Slices:** all five slices redesigned for Option 3 (domain helper, registry
  offset table, resolver rewrite, unit tests, interop tests); pre-chewed context
  blocks updated with exact file paths and current signatures.
- **P3 interop rationale:** updated from "bytesConsumed after retry" (grow-and-retry
  framing) to "next-offset boundary correctness for a NON-last large entry"
  (exact-slice framing), per ADR-361.
- **Decision candidates:** table split into decided (1–3) and open (4); new
  decision candidate 5 (domain-helper seam for `entryOffsets`) surfaced with
  recommendation (a).
- **Non-goals:** removed the grow-and-retry-specific non-goals; added the
  fetch-pack non-goal with the pointer to open decision 4.

### Self-review pass 1 (post-revision)

- Verified `readOffset` at line 91 is not exported in `pack-index.ts`; the
  `entryOffsets` helper is the correct minimal export. Confirmed by reading
  the file.
- Verified `RegisteredPack` has no `offsetTable` field today; the extension is
  additive.
- Verified `inflate` is confirmed size-unbounded on all three adapters by reading
  `node-compressor.ts:39`, `browser-compressor.ts:27`, and
  `memory-compressor.ts:29`.
- Checked that `fetch-pack.ts:335-336` is the only call site for `streamInflate`
  + `bytesConsumed` after the resolver change; confirmed by grep.
- Confirmed `ctx.hashConfig.digestLength` is the correct field (not
  `ctx.hash.digestLength`) from `context.ts:102` and `hash-config.ts:2`.
- Open decision 4 language aligned with ADR-359's exact wording ("deferred to
  review time — not filed as a silent follow-up").

### Self-review pass 2 (post-revision)

- Unstated assumption surfaced: `nextOffsetForEntry` must binary-search (or
  binary-lookup) the sorted array to find `offset`'s rank, not do a linear
  scan. For very large packs (millions of entries) a linear scan would be
  O(n) per object lookup. The design now states "lower bound in `sortedOffsets`
  after `offset`" which implies a binary search; this is the correct
  implementation signal.
- Corrupt-index guard: a `nextOffset > packFileSize` (not just `> trailerStart`)
  is also corrupt — the slice would read beyond the file. The Slice 2 guard
  description updated to throw on both `nextOffset <= offset` and
  `nextOffset > packFileSize`.
- Checked that the lazy-table design in Slice 2 correctly describes that
  `offsetTable()` is a closure over `ctx.fs.stat` — which requires `ctx` to be
  in scope when the table is built. Since `RegisteredPack` is constructed inside
  `loadPack(ctx, ...)`, capturing `ctx` in the closure is correct and safe
  (the registry is per-Context already).
- P3 blob sizes confirmed adequate: 140 KB and 80 KB random-bytes are both
  well above 65536 bytes compressed for incompressible data.

### Self-review pass 3 (post-revision)

- Edge case completeness check against the required list:
  - Last/highest-offset entry → `trailerStart` bound — covered in Slice 2 and
    Slice 3.
  - Single-entry pack → is a last entry, same path — covered.
  - Large-offset (>2 GiB) packs → `entryOffsets` calls `readOffset` which
    handles the large-offset table — covered in Slice 1.
  - Multi-pack repos → sorted offsets are per `RegisteredPack` (already
    per-pack in the registry) — noted in approach.
  - OFS_DELTA / REF_DELTA chain entries — each step derives its own exact slice
    — covered in approach and Slice 3.
  - Corrupt index: `nextOffset <= offset` or `nextOffset > packFileSize` →
    `invalidPackIndex` — covered in Slice 2 with unit test in Slice 4.
- No contradictions found between the slice pre-chewed contexts and the actual
  source files (verified against current `object-resolver.ts:310–322`,
  `pack-registry.ts:12–17`, `pack-index.ts:91`).
- Fetch-pack open decision: confirmed it is stated as "deferred to review time"
  with an explicit "not a silent follow-up" — no information lost.
- Self-review converged. No further contradictions or unstated assumptions.
