# ADR-388: Loose-blob streaming reads the whole compressed file on every adapter

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-387](387-reuse-create-inflate-stream.md)

## Context

For the loose-object path, `streamBlob` must get the compressed bytes off disk before
feeding `createInflateStream` (ADR-387). The granularity of that read — whole-file vs.
chunked — controls whether the *compressed* read is bounded (the *inflated* output is
bounded by `createInflateStream` regardless, and that is the multi-MB quantity that
motivated the feature).

A wrinkle: per-adapter or chunked reads cannot use the existing `FileSystem` surface
uniformly — `openWithNoFollow` throws `UNSUPPORTED_OPERATION` on browser OPFS and is
pointless on the in-memory adapter — so bounding the compressed read would require a
**new `FileSystem` port method** (a `createReadStream`-style streaming read), implemented
×3 adapters + contract test. Crucially, the **packed** path (where most large blobs live
after `git gc`) reads its exact compressed slice whole via `readSlice` (24.10) and is
likewise *not* compressed-bounded — so chunking only the loose path buys an inconsistency
for the minority case (loose, incompressible, multi-MB).

This decision deviates from the design's recommendation (which leaned to a per-adapter
split, Node chunked); the user chose whole-file-everywhere after the blast-radius and
packed-path-asymmetry were surfaced.

## Options considered

1. **(chosen) Whole-file everywhere** — `ctx.fs.read(path)` → single enqueue →
   `createInflateStream` — pros: zero new port surface; KISS/YAGNI; bounds the inflated
   output (the real win); consistent with how the packed path already behaves / cons:
   the compressed file is held whole before inflate (acceptable: the inflated output is
   the large quantity, and the packed path has the same property).
2. **Per-adapter** (Node chunked via `FileHandle`, browser/memory whole) — Rejected:
   needs the new `createReadStream` port method ×3 adapters + contract test; only helps
   loose incompressible multi-MB blobs; creates loose/packed asymmetry.
3. **Chunked everywhere** — Rejected: same new-port-method cost, and chunked reads are
   pointless on OPFS/memory.

## Decision

`streamBlob`'s loose path reads the whole compressed object with the existing
`ctx.fs.read`, enqueues it once into `createInflateStream`, and streams the inflated
output. No new `FileSystem` port method. Peak memory is bounded on the inflated side
only — the same posture as the packed path.

## Consequences

### Positive

- Zero new port surface; consistent loose/packed behaviour; simplest implementation.

### Negative

- The compressed loose file is briefly held whole (bounded by compressed size).

### Neutral

- True end-to-end compressed-read bounding remains a future option (a `createReadStream`
  port method) if a concrete need appears.
