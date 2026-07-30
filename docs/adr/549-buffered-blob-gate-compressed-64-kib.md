# 549 — The buffered-blob gate is 64 KiB of compressed bytes, uniformly

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

ADR-548's seam needs a threshold, and a threshold needs a unit. The constraint is that
learning the gated quantity must cost no I/O — a gate that costs a full read to decide
not to read is not a gate. Each storage form already knows a different number for free:
loose knows `compressed.length` from the read ADR-388 mandates anyway, a pack base entry
knows both its exact compressed slice (`nextOffset - offset`) and its declared inflated
size (`header.size`) from the entry header `streamBlob` already parses, a pack delta
knows nothing pre-inflate but is materialised in full by ADR-386 regardless, and a
delta-cache hit *is* the buffer.

## Options considered

1. **Compressed/on-disk bytes, uniform, 64 KiB** (designer's recommendation) — pros: one
   constant with one meaning, free on every arm, bounds the quantity actually read /
   cons: compressed size is not a bound on inflated size.
2. **Inflated bytes where free (pack base `header.size`) + compressed for loose** —
   pros: tighter bound on the pack arm / cons: the gate's unit depends on the storage
   form; two meanings for one constant is a review hazard. Note this is not a real loss
   for option 1: `header.size` is free on the pack-base arm there too, so option 1's
   implementation may cheaply assert it as a *second* condition.
3. **No numeric threshold — buffer only what is already a buffer** (delta-cache hit,
   pack delta) — pros: no new risk surface / cons: does not solve the problem. The
   megarepo case is small loose and pack-base blobs, exactly what this leaves streaming.

## Decision

**Option 1**, ratified by the user, including explicit acceptance of the amplification
argument. The gated quantity is compressed/on-disk bytes; the threshold is 64 KiB;
delta-cache hits and pack deltas are always buffered (already resident / already
materialised), a cache hit above the threshold included.

## Consequences

A sub-threshold object that inflates large is newly materialised where it would have
streamed, bounded only by the adapter's 2 GiB `MAX_INFLATED_OBJECT_BYTES`. This is
accepted because it is precisely the posture `readBlob`, `readObject` and `readRawObject`
already hold for every loose object in the library: the fast path stops the predicate
being uniquely stricter and opens no new class of exposure. Peak buffered memory under
load is bounded by ADR-553's concurrency: 32 concurrent pairs × 2 sides × 64 KiB
compressed, with the *inflated* side of that product being the review hook the design's
blind-spot checklist directs a reviewer to attack. Blobs above the gate keep streaming
per ADR-550.
