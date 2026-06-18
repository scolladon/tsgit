# Design — streaming-inflate-64kib: fix pack-entry reads truncated at 64 KiB

> Brief: packed-path reads fail when a single pack entry's compressed zlib payload
> exceeds `PACK_SLICE_HINT = 1 << 16 = 65536` bytes. Backlog repro: commit a
> ~140 KB random-bytes blob → `git gc` → `repo.primitives.readBlob(id)` throws
> `DECOMPRESS_FAILED: unexpected end of file`. Boundary confirmed empirically at
> 65,365 OK / 67,618 FAIL (matching the 65536-byte hard cap exactly).
> Status: draft → self-reviewed ×3 → ready for ADR conversation

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

The pack-index format (v1 and v2) stores per-entry offsets and CRC32s but
**not** compressed sizes. The next entry's offset is the only way to derive the
compressed length of a given entry, and it requires a second index lookup whose
complexity grows with multi-pack repos. Any fix must cope with the compressed
length being unknown a priori.

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
correctly today. Only the packed path is broken. The 13k-entry-tree repro from
the backlog likely triggers the packed path after `git gc` auto-packs (or the
repo already had a packed large tree); the loose path is unaffected. This design
scopes the fix to the packed path only.

### Node `bytesWritten` contract — CONFIRMED CORRECT

`NodeCompressor.streamInflate` uses `inflate.bytesWritten` to report
`bytesConsumed`. The concern is whether this count is accurate when the input
slice contains trailing bytes from subsequent pack entries (which any fix that
provides a larger slice or the full pack tail would introduce).

Empirical probe with 143051-byte compressed payload followed by 1000 trailing
bytes from a "next entry":

```
compressed size:  143051 bytes
bytesWritten:     143051   ← matches compressed size exactly
trailing bytes:   1000     ← not counted
```

Node's `createInflate` stops at the zlib stream terminator. `bytesWritten` is
the number of compressed-input bytes the decoder fully consumed as part of the
single zlib member — trailing bytes are buffered internally but not reported as
consumed. The `bytesConsumed` output from `streamInflate` is therefore correct
regardless of how many trailing bytes follow the zlib stream in the slice, which
is the load-bearing property for pack-chain offset arithmetic downstream.

The fix is safe: providing a larger slice (or reading to EOF) does not corrupt
`bytesConsumed`.

## Approach

`readEntryHeaderWithChunk` is the single call site that imposes the 64 KiB
ceiling. The fix must ensure the slice it passes to `streamInflate` always
contains the complete zlib member. Three candidate strategies are weighed in the
decision-candidates section; the recommended strategy is **grow-and-retry** (a).

### Recommended fix: grow-and-retry in `readEntryHeaderWithChunk`

`readEntryHeaderWithChunk` reads `PACK_SLICE_HINT` (= 65536) bytes as the
initial slice. If `streamInflate` returns successfully, nothing changes — the
common case (small objects, delta instructions) is unchanged. If the slice is
too short, `streamInflate` throws `DECOMPRESS_FAILED`. On that signal,
`readEntryHeaderWithChunk` re-reads from the same entry offset with a doubled
length, retrying until the stream is complete or the file is exhausted.

The doubling bound is the pack file size less the entry offset. Because both the
node and memory `readSlice` implementations already clamp the returned slice to
the actual file length (`min(offset + length, fileSize)`), the retry loop
naturally terminates when it reaches EOF: the slice stops growing even though
the requested length keeps doubling. The `DECOMPRESS_FAILED` on truncation is
thus the loop's termination signal — it retries only when the underlying cause
was truncation, not a genuinely corrupt stream.

```typescript
// object-resolver.ts — readEntryHeaderWithChunk (revised)
async function readEntryHeaderWithChunk(
  ctx: Context,
  hit: PackLookupHit,
): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }> {
  let sliceLength = PACK_SLICE_HINT;
  for (;;) {
    const chunk = await ctx.fs.readSlice(hit.pack.packPath, hit.offset, sliceLength);
    const header = parsePackEntryHeader(chunk, 0, ctx.hashConfig);
    try {
      return { header, chunk, headerEndInChunk: header.dataOffset };
    } catch {
      // Not reachable here — parsePackEntryHeader throws synchronously.
      // The grow-and-retry loop is driven by the caller (collectDeltaChain)
      // catching DECOMPRESS_FAILED from streamInflate, not here.
    }
    // If the chunk is already at EOF (chunk.length < sliceLength), there
    // is no more data to give — re-throw from the caller's side.
    if (chunk.length < sliceLength) break;
    sliceLength *= 2;
  }
}
```

Wait — `parsePackEntryHeader` itself does not throw on a truncated slice; it
only throws if bytes required for the header are missing. The growth signal is
therefore not in `readEntryHeaderWithChunk` itself but in the
`streamInflate`calls in `collectDeltaChain`. The cleaner factoring: separate
the header parse from the zlib stream read. The function returns the header and
the chunk; the caller (`collectDeltaChain`) calls `streamInflate(chunk, ...)`;
if that throws `DECOMPRESS_FAILED` and the chunk was smaller than the file (not
yet at EOF), the caller retries with a larger chunk.

The revised shape passes the grow-and-retry responsibility to
`collectDeltaChain`:

```typescript
// object-resolver.ts — readEntryHeaderWithChunk (unchanged signature, revised body)
async function readEntryHeaderWithChunk(
  ctx: Context,
  hit: PackLookupHit,
  sliceLength: number,                         // starts at PACK_SLICE_HINT; callers pass it
): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }> {
  const chunk = await ctx.fs.readSlice(hit.pack.packPath, hit.offset, sliceLength);
  const header = parsePackEntryHeader(chunk, 0, ctx.hashConfig);
  return { header, chunk, headerEndInChunk: header.dataOffset };
}
```

`collectDeltaChain` retries on `DECOMPRESS_FAILED` with a doubled length:

```typescript
for (;;) {          // outer retry loop
  let sliceLength = PACK_SLICE_HINT;
  for (;;) {        // inner entry loop
    const { header, chunk, headerEndInChunk } =
      await readEntryHeaderWithChunk(ctx, currentHit, sliceLength);
    if (isBase(header)) {
      enforcePackBaseCap(targetId, header.size, maxBytes);
      let inflated: InflateStreamResult;
      try {
        inflated = await ctx.compressor.streamInflate(chunk, headerEndInChunk);
      } catch (err) {
        if (isDecompressFailed(err) && chunk.length >= sliceLength) {
          sliceLength *= 2;
          continue;  // retry with doubled slice
        }
        throw;
      }
      return { deltas, baseContent: inflated.output, baseType: header.type };
    }
    // ... delta path, same pattern ...
  }
}
```

Where `isDecompressFailed` checks `err.data?.code === 'DECOMPRESS_FAILED'`.

The loop terminates because:
1. On success: `streamInflate` returns without throwing.
2. On true truncation: `chunk.length < sliceLength` means the adapter returned
   fewer bytes than requested (EOF reached) — re-throw rather than loop.
3. On corrupt data: `streamInflate` throws `DECOMPRESS_FAILED` but the chunk IS
   at `sliceLength` — yet the next doubled slice will also fail (the data is
   corrupt, not truncated). To avoid infinite growth on corrupt packs, a
   maximum retry count (e.g. 8 doublings = 8 MiB slice cap) is the safety
   valve; any object legitimately needing >8 MiB compressed is already
   exceptional.

**Maximum slice:** `PACK_SLICE_HINT << MAX_DOUBLINGS = 65536 << 8 = 16 MiB`.
Beyond that, the loop re-throws the last `DECOMPRESS_FAILED`. Objects whose
compressed representation exceeds 16 MiB are pathological; git itself imposes
no such cap but realistic objects (even binaries) stay under this. If needed,
the constant can be raised.

**Memory note:** the grow-and-retry approach only buffers one slice at a time.
The slice is released between retries. The peak allocation per entry read is the
final sufficient slice (which equals the compressed size plus the entry offset
within the slice — bounded by the existing `MAX_INFLATED_OBJECT_BYTES = 2 GiB`
pre-inflate cap on the inflated output, not the slice itself).

### `PACK_SLICE_HINT` — keep as first-read hint

`PACK_SLICE_HINT = 1 << 16` is retained as the first-attempt slice size. It is
the right starting point: the header is at most ~40 bytes (a varint + 32-byte
SHA-256 digest for `REF_DELTA`); small objects (the majority of pack entries)
fit; only large objects trigger retries. Removing it entirely (i.e., starting at
the full file size) saves at most one read for large objects but wastes memory
for every small object.

### `fetch-pack.ts` — no change required

`inflateAllEntries` passes the entire in-memory `packBytes` buffer to
`streamInflate`. It never uses `readSlice`. No truncation is possible. No
change.

### Cross-adapter parity

The `bytesConsumed` contract (`src/ports/compressor.ts`) is:

> The number of input bytes consumed, counted from `offset`.

`NodeCompressor.streamInflate` already honours this (empirically confirmed
above). The grow-and-retry fix is entirely in `object-resolver.ts`, which is
adapter-agnostic. Neither `BrowserCompressor` nor `MemoryCompressor` is touched
by this change.

However, both the browser and memory adapters have an existing 64 KiB input cap
on `streamInflate` (`BROWSER_STREAM_INFLATE_MAX_INPUT = MEMORY_STREAM_INFLATE_MAX_INPUT = 64 * 1024`).
This is an intentional guard: their O(n²) progressive-prefix scan is impractical
beyond small test-sized packs. The fix does not change their contract — the
object-resolver retry loop would hit their cap, get a `DECOMPRESS_FAILED`, and
interpret it as "corrupt stream" rather than "truncated slice" on the final
retry (when `chunk.length === sliceLength` but both adapters refused to process
the large input). To prevent misinterpretation:

- The retry-termination condition checks `chunk.length < sliceLength` (physical
  EOF), not the error type. An adapter cap error fires when `chunk.length ===
  sliceLength` (the adapter received a full slice but refused it). The loop
  would double again, and the next `readSlice` would return the same capped
  result, loop forever.
- **Resolution:** the retry grows until either (a) success or (b) physical EOF
  (`chunk.length < sliceLength`). An adapter that refuses a large input but is
  not at EOF needs to be distinguished. The correct guard: track whether the
  most-recent read actually returned a *new, larger* slice vs the previous one.
  If `chunk.length === previous chunk.length` (no growth), re-throw — the
  adapter is not able to provide more.

In practice: `MemoryCompressor.streamInflate` is used only in unit tests with
small synthetic packs. The unit tests for the grow-and-retry path use a spy over
`NodeCompressor.streamInflate` (or a fake `InflateStreamResult`), not
`MemoryCompressor`, so the adapter cap is never exercised in the retry context.
The browser and memory adapter caps remain as explicitly documented "production
= Node" guards.

**Flagged warning for user decision (scope):** The 64 KiB cap in
`MemoryCompressor` and `BrowserCompressor` is documented as intentional (O(n²)
progressive-prefix scan). For the browser OPFS use case to ever support large
objects in pack files, `BrowserCompressor.streamInflate` would need a different
implementation (e.g., using `DecompressionStream` in a truly streaming fashion
once the platform supports consumed-byte reporting). This is a separate,
larger change; the user must decide whether it belongs in this PR or is a
flagged follow-up. It does NOT block the fix: the browser adapter explicitly
documents that it does not support production-sized packs. Raising this now so
the user can decide; this design marks it as **in scope only if the user
confirms** (i.e., it is not silently deferred — see scope directive).

## Slices

### Slice 1 — `readEntryHeaderWithChunk` grow-and-retry

**Files:**
- `src/application/primitives/object-resolver.ts`

**Current signatures / constants:**
- `const PACK_SLICE_HINT = 1 << 16;` (line 28)
- `async function readEntryHeaderWithChunk(ctx, hit)` → returns `{ header, chunk, headerEndInChunk }` (line 310–322)
- `collectDeltaChain(ctx, registry, hit, targetId, maxBytes)` — the consumer
  calling `readEntryHeaderWithChunk` at lines 197, then `streamInflate` at lines
  200 and 211.

**Changes:**
1. Add `const MAX_SLICE_DOUBLINGS = 8;` (giving a max slice of 16 MiB).
2. Extend `readEntryHeaderWithChunk` to accept `sliceLength: number`.
3. In `collectDeltaChain`, wrap the `readEntryHeaderWithChunk` +
   `streamInflate` calls in a grow-and-retry loop as described above.

**Helper to add:**
```typescript
function isDecompressFailed(err: unknown): boolean {
  return (
    err instanceof TsgitError &&
    (err.data as { code?: string }).code === 'DECOMPRESS_FAILED'
  );
}
```

**Fixtures to extend:**
- `test/unit/application/primitives/pack-fixture.ts` — no change needed;
  `buildSyntheticPack` already supports base + delta entries.

### Slice 2 — unit tests in `object-resolver.test.ts`

**Files:**
- `test/unit/application/primitives/object-resolver.test.ts`

**Context:**
- `buildSeededContext` is in `test/unit/application/primitives/fixtures.ts`.
- `buildSyntheticPack`, `writeSyntheticPack`, `EntrySpec` are in
  `test/unit/application/primitives/pack-fixture.ts`.
- `stubRegistry` is defined locally in `object-resolver.test.ts` (lines 57–82).
- The memory compressor's 64 KiB cap means unit tests must use small synthetic
  blobs for the normal path and a spy/fake for the grow-and-retry path.

**New test cases (GWT/AAA/sut convention):**

```
Given a packed base blob whose compressed stream spans exactly PACK_SLICE_HINT bytes
  When resolveObject is called
  Then returns the blob (boundary at the slice edge — no retry needed)

Given a packed base blob whose compressed stream exceeds PACK_SLICE_HINT by 1 byte
  When resolveObject is called
  Then retries once with a doubled slice and returns the blob

Given a packed OFS-delta whose instructions exceed PACK_SLICE_HINT bytes
  When resolveObject is called
  Then retries and resolves the delta chain correctly

Given a packed entry whose compressed stream exceeds the maximum retry cap (MAX_SLICE_DOUBLINGS doublings)
  When resolveObject is called
  Then throws DECOMPRESS_FAILED (corrupt or pathologically large stream)

Given a packed entry where the streamInflate spy confirms the first call receives PACK_SLICE_HINT bytes
  and the second call receives 2 * PACK_SLICE_HINT bytes
  When resolveObject resolves after one retry
  Then the spy call sequence proves exactly one retry occurred
```

The "exceeds slice by 1 byte" test requires a spy over `ctx.compressor.streamInflate`
that (a) returns `DECOMPRESS_FAILED` when called with a slice shorter than the
full compressed length, and (b) returns the real result when called with a
sufficient slice. This is testable via `MemoryCompressor` or a stub that records
call lengths.

**Mutation-resistant patterns to apply:**
- Assert `bytesConsumed` value in the spy (kills a mutant that mis-reports
  the consumed count).
- Use separate tests for base-entry retry and delta-entry retry (kills a mutant
  that handles only one branch).

### Slice 3 — interop test: large packed blob + large packed tree

**Files:**
- `test/integration/large-object-pack-interop.test.ts` (new file)

**Shape:** twin-repo pattern from `interop-helpers.ts` (`makePeerPair`,
`initBothRepos`, `runGit`, `GIT_AVAILABLE`).

**Fixtures:**

| # | Setup | Test | Asserts |
|---|---|---|---|
| **P1** | commit 140 KB random-bytes blob in peer repo; `git gc` to pack it; copy `.git/objects/pack/*` into ours | `readBlob(ours, blobId)` | `blob.content.length === 140000`; content byte-identical to peer's `git cat-file -p` output |
| **P2** | same pack, read via `resolveObject` with `verifyHash: true` | succeeds (no `OBJECT_HASH_MISMATCH`) | hash-verified round-trip |
| **P3** | pack with two adjacent large blobs (to exercise offset arithmetic post-retry: `bytesConsumed` must be exact or the second entry's read offset is wrong) | read both blobs | both content byte-identical to peer |
| **P4** | loose 140 KB blob (same blob, no gc) | `readBlob(ours, blobId)` | succeeds (regression guard: loose path must not break) |

**How to place the pack in `ours`:** use `git clone --local` or copy the pack
files directly into `ours/.git/objects/pack/` and run `git fsck --strict` on
`ours` to verify the pack is accepted before tsgit reads it.

**Scrubbed-env discipline:** all `git` calls via `runGit` (SAFE_ENV).
`GIT_CONFIG_NOSYSTEM=1`, `HOME=ISOLATED_HOME`. `commit.gpgsign=false` via
`git -C dir config commit.gpgsign false`.

**Size choice:** 140 000 bytes random data → compressed ≈ 143 000 bytes, well
above the 65 536-byte cap. Two distinct blobs (140 000 and 80 000 bytes, both
>64 KiB compressed) for P3, placed in the same pack in offset order, to stress
the `bytesConsumed` offset arithmetic.

## `PACK_SLICE_HINT` keep-vs-remove decision

The constant is retained as the first-read hint (Decision candidate 2). See that
section for alternatives.

## Decision candidates

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| **1 — Fix strategy for `readEntryHeaderWithChunk`** (ADR-359) | How to ensure the slice passed to `streamInflate` always contains the complete zlib member, given that the compressed length is unknown a priori. | **(a) Grow-and-retry:** start at `PACK_SLICE_HINT`; on `DECOMPRESS_FAILED` + not-at-EOF, double the slice and retry (bounded by `MAX_SLICE_DOUBLINGS = 8`; max slice 16 MiB). **(b) Read-to-EOF-from-offset:** a single `readSlice(path, offset, fileSize - offset)` providing the full pack tail from the entry. **(c) True streaming from the pack file:** open the pack file and feed bytes incrementally into `createInflateStream()` until the zlib member terminates, tracking consumed input via `bytesWritten`. | **(a) Grow-and-retry** | (a) is the smallest changeset: one retry loop in `collectDeltaChain`, no new port surface, no change to `readEntryHeaderWithChunk`'s signature contract, no fileSize stat. Small objects (<64 KiB compressed, the common case) pay zero extra cost; large objects pay O(log(compressed\_size/64KiB)) extra reads — at most 2 reads for objects up to 4 MiB compressed, 3 reads up to 16 MiB. (b) is simpler to implement but buffers `fileSize - offset` bytes per entry for the first entry near the pack start — a 2 GB pack with a large object at offset 132 buffers ~2 GB. This collides with the existing `MAX_INFLATED_OBJECT_BYTES = 2 GiB` memory contract in a non-obvious way (compressed >> inflated for binary objects). (c) is the most faithful to the "streaming inflate" performance priority but requires a new read-loop over an open `FileHandle`, a changed `Compressor` port contract for incremental chunk feeding, and significant implementation surface — the blast radius exceeds the scope of a targeted bug fix. |
| **2 — `PACK_SLICE_HINT`: keep as first-read hint vs remove** (ADR-360) | Whether to retain `PACK_SLICE_HINT = 1 << 16` as the first-read slice or replace it with a different initial size. | **(a) Keep at 65536:** most pack entries (commits, trees, small blobs) compress to well under 64 KiB; the first read succeeds with no retry for the common case. **(b) Raise to 512 KiB or 1 MiB:** reduces retries for medium-sized objects (100–512 KiB compressed) at the cost of reading more bytes upfront for every pack entry, even tiny ones. **(c) Remove the constant, start at `fileSize - offset`:** eliminates retries entirely at the cost of the memory concern described in candidate 1(b). | **(a) Keep at 65536** | The 64 KiB first-read is empirically the right trade-off: it covers commits (typically < 1 KiB), tree objects (typically < 10 KiB), small blobs, and all delta instructions (git limits delta chains so individual instruction sets are small). Large blobs are uncommon enough that paying one extra read for them is the right local-optimum. Raising to 512 KiB would wastefully buffer ~500 KiB for every small object read — a significant regression for hot paths like `log` and `status` that read many small pack entries. |
| **3 — Interop fixture scope: two-blob offset test (P3)** (ADR-361) | Whether to include a two-large-blob pack interop test (P3) that specifically validates `bytesConsumed` offset arithmetic after a retry. | **(a) Include P3:** creates a pack with two adjacent large blobs (≥64 KiB compressed each); reads both; asserts byte-identical content. Kills a mutant where `bytesConsumed` is mis-computed after a retry, silently misaligning the next entry's offset. **(b) Skip P3, cover by a unit spy:** the unit test (slice 2) already asserts the `bytesConsumed` value via a spy; P3 duplicates that with a real pack at integration level. **(c) Defer P3 to a follow-up:** ship P1/P2/P4 now; add P3 later. | **(a) Include P3** | The offset-arithmetic correctness (bytesConsumed accuracy post-retry) is the highest-risk correctness property of the fix — a mis-reported `bytesConsumed` silently reads the wrong object for every subsequent entry without any error. The unit spy confirms the spy returns the right number; P3 confirms that `object-resolver.ts` threads it correctly into the offset calculation in a real pack on a real file system. The test is small (one extra `randomBytes` fixture generation and one extra `readBlob` call) and the two-blob scenario is not reachable from P1/P2 alone. Deferring (c) accepts a residual correctness gap until a follow-up that may never ship. |

## Test strategy

Mutation-resistant per project conventions:
- `DECOMPRESS_FAILED` assertions: try/catch + `.data.code`, not bare
  `toThrow(TsgitError)`.
- Retry-count assertions: spy on `ctx.compressor.streamInflate`; assert exact
  call count (1 = no retry, 2 = one retry). Kills a mutant that retries on
  every call regardless of truncation.
- `bytesConsumed` exact-value assertions in spy.

### Unit tests (`object-resolver.test.ts` — extend)

- Base blob fitting in `PACK_SLICE_HINT`: succeeds on first call, spy count = 1.
- Base blob overflowing by 1 byte: first call returns `DECOMPRESS_FAILED`, second call succeeds, spy count = 2, content correct.
- OFS-delta whose instructions overflow: same spy pattern, chain resolves.
- Corrupt entry (DECOMPRESS_FAILED regardless of slice size): throws after `MAX_SLICE_DOUBLINGS` retries, not infinite loop.
- REF_DELTA whose base is a large packed entry: base grows-and-retries, delta applies, result correct.

### Integration tests (`large-object-pack-interop.test.ts` — new)

- P1: single 140 KB random blob, packed, read via `readBlob` → byte-identical to `git cat-file -p`.
- P2: same, with `verifyHash: true` — no `OBJECT_HASH_MISMATCH`.
- P3: two adjacent large blobs in same pack → both read correctly (offset arithmetic stress test).
- P4: 140 KB loose blob (no gc) → `readBlob` succeeds (regression guard).

## Non-goals

- Fixing `BrowserCompressor.streamInflate` to handle production-sized packs:
  requires a different streaming approach and is a separate change (see
  flagged warning above).
- Adding a streaming (non-buffering) inflate path to `object-resolver.ts`:
  that is Decision candidate 1(c), explicitly deferred as out of scope here.
- Changing the `InflateStreamResult` port interface.
- Changing `fetch-pack.ts`: it already passes the full in-memory buffer.
- Exposing a `compressedSize` field in the pack-index domain model to avoid the
  grow-and-retry: the v2 pack-index format does not store compressed size per
  entry, and adding a pre-read pass to derive it from adjacent offsets is more
  complex than the retry loop.

## Self-review log

### Pass 1 → Pass 2

- Initial draft had grow-and-retry logic inside `readEntryHeaderWithChunk`
  itself, catching and re-throwing from inside that function. Refined: the
  `streamInflate` calls live in `collectDeltaChain`, not in
  `readEntryHeaderWithChunk`, so the retry loop must wrap the caller's
  `streamInflate` call, not the slice read. The function signature change
  (`sliceLength` param) is the minimal surface.
- Added the "growth termination" invariant — distinguishing physical EOF from
  adapter cap from corrupt data. Without this the loop could grow forever
  against a non-truncation error.
- Confirmed empirically that `bytesWritten` is correct for large random payloads
  with trailing bytes; added that to the context section.

### Pass 2 → Pass 3

- Added the cross-adapter parity section with the explicit flagged warning for
  the browser/memory 64 KiB `streamInflate` cap — the fix is self-contained in
  the node path, but the interaction (retry loop + adapter cap = potential
  infinite growth) needed explicit addressing.
- Added P3 (two-blob offset test) to the interop fixture design. Without it,
  `bytesConsumed` accuracy post-retry is only proven at the spy level, not at
  the file-system level.
- Clarified the `isDecompressFailed` helper requirement — the retry condition
  requires distinguishing `DECOMPRESS_FAILED` from other error codes
  (`OBJECT_NOT_FOUND`, `FILE_NOT_FOUND`, etc.) to avoid masking unrelated errors.
- Decision candidate table reformatted to include ADR numbers (359–361).

### Pass 3 → final

- Confirmed the loose-path repro from the backlog brief. Static analysis shows
  `tryLoose` uses `ctx.fs.read` (unbounded) + `NodeCompressor.inflate`
  (`inflateSync` with 2 GiB cap). Verified empirically. Scoping statement
  updated to match.
- `MAX_SLICE_DOUBLINGS = 8` choice justified: 65536 × 2^8 = 16777216 = 16 MiB.
  Objects whose compressed representation exceeds 16 MiB would be genuine
  outliers (a 16 MiB compressed object implies the original is likely >16 MiB
  uncompressed for binary data, i.e., a very large asset). Git itself places no
  hard cap here but `MAX_INFLATED_OBJECT_BYTES = 2 GiB` already enforces an
  upper bound on what the inflate path can accept; the 16 MiB slice cap is
  strictly below that and can be raised trivially if a legitimate need arises.
