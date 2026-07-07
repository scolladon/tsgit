# Spike — Streaming `streamInflate` output to relax the whole-member cap

> Brief: 26.10's zero-dependency decoder is whole-member — it buffers the full decoded object in a `GrowableBuffer` and returns `{ output, bytesConsumed }`, guarded by a 2 GiB output cap (ADR-459). Would a *streaming* decoder that emits decoded chunks instead of buffering relax the memory ceiling? **Spike:** scope the `Compressor.streamInflate` port change, and decide whether the memory adapter can bound without materialising each object.
> Surfaced by: 26.10 · relates to ADR-459 · sibling of `design/browser-clone-inflate-cursor.md`
> Status: findings — recommendation is **park** (see §6)

## TL;DR

- **The 2 GiB cap is a safety bound, not a functional blocker.** It guards a single decoded *pack member* against decompression-bomb amplification. It never trips on real git objects — only a genuinely huge single blob decoding past 2 GiB would reach it, and only on the browser/memory adapters (Node's `inflateSync`/`createInflate` carry their own `maxOutputLength`).
- **Streaming `streamInflate`'s output is feasible but load-bearing** — a new chunked port shape, a windowed rewrite of the pure-JS decoder, and a restructured `inflateAllEntries` caller. Scoped in §3–4.
- **The memory adapter cannot bound below the largest object regardless.** SHA-1 turns out *not* to be the obstacle (the `Hasher` port already hashes incrementally, and the uncompressed size is known up front from the pack entry header). The inherent obstacle is **delta-base materialisation**: `applyDelta` needs full random-access base content, and which objects are bases is not known a priori. A pure in-memory adapter has no spill target, so every base — potentially every object — stays fully in heap.
- **"Stream to OPFS" barely applies to the clone path.** `fetch-pack` writes the *compressed* pack verbatim; the inflated bytes are transient (SHA-1 + delta base), never written to OPFS. The path where huge blobs actually flow to the working tree — checkout via `createInflateStream` — is **already** streaming and already unbounded; it does not use the capped `streamInflate` at all.
- **Recommendation: park.** High cost, narrow benefit, and the memory adapter stays bounded by materialisation anyway. Revisit only against a concrete report (§6), where raising the cap knob is the cheaper first lever.

## 1. What is capped, and where

The zero-dependency decoder `inflateZlibMember` (`src/adapters/inflate.ts`) is whole-member: it decodes one zlib member (RFC 1950 header + RFC 1951 blocks + adler32 trailer) into a `GrowableBuffer`, then returns `{ output, bytesConsumed }`. The cap lives in `GrowableBuffer.ensureCapacity`:

```
const MAX_INFLATED_OUTPUT_BYTES = 2 * 1024 * 1024 * 1024;   // inflate.ts:46
// ...
if (required > this.maxBytes) {
  throw decompressFailed('inflated output exceeds safety cap');   // inflate.ts:324-325
}
```

It mirrors `NodeCompressor`'s `MAX_INFLATED_OBJECT_BYTES` (`node-compressor.ts:14`) so all three adapters refuse the same malicious member with the same typed error instead of exhausting memory.

Both browser and memory compressors delegate `streamInflate` straight to this decoder (`memory-compressor.ts:45-46`, `browser-compressor.ts:59-61`). Node uses native `createInflate().bytesWritten` (`node-compressor.ts:60-94`).

## 2. The one caller, and why it buffers

`streamInflate` has exactly one caller: `inflateAllEntries` in `src/application/primitives/fetch-pack.ts` (the clone / index-build path). It walks a received in-memory pack sequentially, and the whole member must be materialised for two independent reasons:

```
const inflate = await ctx.compressor.streamInflate(packBytes, entryHeader.dataOffset);   // :320
const entryEnd = entryHeader.dataOffset + inflate.bytesConsumed;                          // :321 — advance
out.push({ offset, header: entryHeader, inflated: inflate.output, crc32: entryCrc });     // :333 — buffer whole object
```

1. **`bytesConsumed` drives the walk.** The next entry begins at `dataOffset + bytesConsumed`; the compressed length of a member is not known a priori (ADR-459). This is intrinsic to the concatenated-member layout and orthogonal to streaming — it is *why* the separate `createInflateStream` transform (§5) cannot drive this walk.
2. **The whole `inflated` output is retained** for delta resolution and SHA-1, discussed in §4.

Note what `fetch-pack` does **not** do: it never writes inflated objects to disk. `writePackArtifacts` (`:507-527`) writes the *compressed* `packBytes` verbatim plus a generated `.idx`. Inflation exists only to compute each object's SHA-1 for the index and to resolve deltas — the decoded bytes are transient scratch.

## 3. Scoping the port change

`Compressor.streamInflate` today (`src/ports/compressor.ts:36`):

```
readonly streamInflate: (bytes: Uint8Array, offset: number) => Promise<InflateStreamResult>;
//   InflateStreamResult = { readonly output: Uint8Array; readonly bytesConsumed: number }
```

A streaming variant must yield decoded chunks *and* still recover `bytesConsumed` (known only at member end). A callable shape that keeps `bytesConsumed` recoverable:

```
readonly streamInflateChunks: (
  bytes: Uint8Array,
  offset: number,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
) => Promise<{ readonly bytesConsumed: number }>;
```

(Equivalently an `AsyncIterable<Uint8Array>` plus a terminal `bytesConsumed` promise — same information, heavier plumbing.) It is **additive**: the whole-member `streamInflate` stays for callers that want the buffer.

Decoder-side changes to `inflate.ts`:

- **Emit instead of append.** `decodeBlockBody` / `decodeStoredBlock` currently `output.append(...)` into the `GrowableBuffer`. They would instead flush to `onChunk`.
- **Retain a 32 KiB LZ77 window.** Back-references (`copyBackReference`, `inflate.ts:291`) index up to 32 KiB back into already-decoded output. A streaming decoder must keep a sliding 32 KiB window even while emitting everything older. This is the real structural cost — a bounded ring buffer replacing the unbounded `GrowableBuffer` — but it is well-trodden (it is exactly what zlib's own inflate window does).
- **Roll the adler32.** `verifyTrailer` (`:817`) recomputes `adler32(output)` over the whole buffer. adler32 is a rolling checksum, so fold each emitted chunk into a running value and verify at member end — no need to retain output. Compatible with streaming.
- **`bytesConsumed` is unchanged** — `reader.position - offset`, resolved at completion.

Adapter-side: Node can wire `createInflate`'s existing `'data'` events straight through (`node-compressor.ts:71` already sees chunks; it just concatenates them today). Browser/memory **cannot** use `DecompressionStream` here (no consumed-byte cursor, ADR-459 M2) — they must route through the windowed pure-JS decoder above.

## 4. Can the memory adapter bound without materialising? — No

The backlog hypothesis: "the pure in-memory adapter still materialises each object (its SHA-1 + delta-base role need the whole content)." The spike **confirms the conclusion but corrects the reasoning** — SHA-1 is not the obstacle:

- **SHA-1 is streamable.** The `Hasher` port already exposes incremental hashing (`createHasher()` → `update()` / `digest()`), and the git loose-object header `<<type>> <<size>>\0` needs the uncompressed *size*, which the pack entry header already carries (`parsePackEntryHeader`) before any byte is inflated. So one could write the header, then fold decoded chunks through the hasher — no full buffer needed for the hash. `computeLooseObjectId` (`fetch-pack.ts:464-473`) is whole-buffer today, but nothing forces that.

- **Delta bases are the inherent obstacle.** `applyDelta(base: Uint8Array, delta: Uint8Array)` (`src/domain/storage/delta.ts:192`) consumes the **whole base as a random-access array** — copy instructions reference arbitrary `(offset, size)` windows into it. A base cannot be streamed; it must be fully present. And base-ness is not known when an object is decoded: `resolveAllEntries` (`fetch-pack.ts:342-367`) is a **multi-pass fixpoint**, and REF_DELTA can name *any* object in the pack by id. So you cannot decide "this object is safe to discard after streaming" until the whole pack is resolved.

- **The memory adapter has no spill target.** Its entire premise is RAM (`MemoryCompressor`, no filesystem). With every object a potential base, and no OPFS/disk to page a base out to, the working set is bounded below by the largest object — exactly what the 2 GiB cap protects. Streaming the *decode* changes nothing about the *retention*.

The **browser** adapter *could* in principle spill bases to an OPFS scratch file and read `(offset, size)` slices back during `applyDelta` — but that turns `applyDelta`'s `Uint8Array` base into a random-access reader abstraction, adds an OPFS scratch lifecycle inside `resolveAllEntries`, and still buffers non-base objects until the fixpoint proves them non-base. Substantial, and it does not help the memory adapter at all.

## 5. Where "stream to OPFS" actually pays off — not here

The mental model "stream a huge decoded blob to OPFS instead of buffering" is sound, but it belongs to the **read / checkout** path, not the clone path:

- **Checkout already streams.** `createInflateStream()` (`compressor.ts:43`) is consumed by the working-tree write path (`streamBlob` in `src/application/primitives/stream-blob.ts`, via `object-resolver.ts`). It decodes **one complete zlib stream** — a whole loose object, or an index-bounded pack slice — so it needs no `bytesConsumed` and no boundary search. That path is **already unbounded**: a multi-GB blob streams from object store to working-tree file without ever fully buffering. It does not touch the capped `streamInflate`.
- **Clone writes compressed bytes.** As established in §2, `fetch-pack` persists the compressed pack; the inflated bytes never reach OPFS. There is no "final object write" to stream during clone — only transient SHA-1 + delta scratch, which §4 shows stays materialised for delta bases anyway.

So the cap that 26.10a targets guards a path where OPFS streaming has no natural home, while the path where OPFS streaming already lives is already uncapped.

## 6. Recommendation — park

**Do not implement now.** The cost/benefit is lopsided:

- **Cost:** a new chunked port verb (§3), a windowed streaming rewrite of the RFC-1951 decoder with its own 100%-coverage + property-test + Node-oracle burden (mirroring ADR-459's negative consequence), a streaming `computeLooseObjectId`, and — for any real memory relief on the browser — an OPFS spill lifecycle for delta bases inside `resolveAllEntries` with a random-access-base rewrite of `applyDelta`.
- **Benefit:** relaxes a safety cap that never trips on real git objects, on two adapters, and **the memory adapter stays bounded by materialisation regardless** (§4).

**Revisit only against a concrete trigger:** a real user (or interop case) hitting `'inflated output exceeds safety cap'` when cloning a repository with a single genuinely huge (>2 GiB decoded) blob on the browser or memory adapter.

**Cheaper first lever if that trigger arrives:** the cap is a single named constant (`inflate.ts:46`) mirrored in `node-compressor.ts:14`. Making it a configurable ceiling (like `NodeCompressorOptions.maxInflatedBytes` already is, `node-compressor.ts:16-25`) lets a caller opt into a higher bound without any streaming rewrite. Only if that proves insufficient does the full streaming path in §3–5 earn its keep — and even then, browser-only, never for the pure in-memory adapter.

## Appendix — evidence pointers

| Claim | Source |
|---|---|
| Whole-member decode + 2 GiB cap | `src/adapters/inflate.ts:46`, `:324-325`, `:832-847` |
| Cap mirrors Node's | `src/adapters/node/node-compressor.ts:14` |
| Sole `streamInflate` caller buffers whole object | `src/application/primitives/fetch-pack.ts:302-340` |
| Clone writes the *compressed* pack, not inflated objects | `src/application/primitives/fetch-pack.ts:507-527` |
| Delta resolution is a multi-pass fixpoint | `src/application/primitives/fetch-pack.ts:342-367` |
| `applyDelta` needs whole random-access base | `src/domain/storage/delta.ts:192` |
| SHA-1 over whole buffer today (but streamable) | `src/application/primitives/fetch-pack.ts:464-473` |
| Back-references need a 32 KiB window | `src/adapters/inflate.ts:291-308` |
| adler32 trailer (rolling, stream-compatible) | `src/adapters/inflate.ts:817-823` |
| Checkout read path already streams, uncapped | `src/ports/compressor.ts:43`, `src/application/primitives/stream-blob.ts`, `object-resolver.ts:158` |
| `DecompressionStream` has no consumed-byte cursor | ADR-459 (M2) |
