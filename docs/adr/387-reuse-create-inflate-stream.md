# ADR-387: Streaming inflate reuses the existing `Compressor.createInflateStream` as-is

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-383](383-stream-blob-primitive.md)

## Context

The `Compressor` port already declares `createInflateStream(): TransformStream<Uint8Array,
Uint8Array>`, implemented on all three adapters (`node`, `browser`, `memory`) and covered
by the port contract test — but it is **dead production code** (zero callers outside the
port/adapter definitions, confirmed by grep). Its doc comment names exactly this use:
"Used for large packfile entries to avoid buffering entire objects." `streamBlob` needs a
streaming inflate seam; the question is whether to use this one as-is, reshape it, or add
a new port method.

The key enabler: 24.10's exact-slice pack read means the bytes handed to inflate are
*exactly one complete zlib member* (loose: the whole compressed file; base pack entry:
`chunk.subarray(dataOffset)` of `[offset, nextOffset)`). So no "bytes-consumed" signal is
needed — that signal is `streamInflate`'s job on the `fetch-pack` path, where entries are
concatenated and lengths are unknown a priori.

## Options considered

1. **(chosen) Use `createInflateStream` as-is** for loose + non-delta packed blobs —
   pros: zero new port/adapter surface; it is implemented and contract-tested already;
   exact-slice removes any need for a consumed-bytes signal; `DecompressionStream` is
   native and streaming on all adapters (the 64 KiB O(n²) cap lives on `streamInflate`,
   not here) / cons: none material for this scope.
2. **Reshape the port** (add a consumed-bytes signal) before using it — Rejected:
   changes all three adapters + the contract test for a need exact-slice already
   eliminates; only the out-of-scope `fetch-pack` streaming would want it.
3. **Add a new `inflateStreamFromSlice` port method** — Rejected: `chunk.subarray(offset)`
   into the existing method does the same with no new surface.

## Decision

`streamBlob` feeds the exact-slice (packed base) or whole compressed file (loose) bytes
into the existing `Compressor.createInflateStream()`, then bridges its readable side to an
`AsyncIterable` via the existing `readableStreamToAsyncIterable`. No port or adapter
interface changes.

## Consequences

### Positive

- The feature is the intended first consumer of dead-but-tested infrastructure; zero
  port churn.

### Negative

- None for this scope; `fetch-pack`'s separate `streamInflate` cap is untouched (and
  unreachable from this read path).

### Neutral

- `streamInflate` and its `bytesConsumed` contract remain solely for `fetch-pack`.
