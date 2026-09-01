---
subjects:
  - src/application/primitives/internal/index-pack.ts
  - src/ports/hash-service.ts
---
# 781 — Base-entry oids are computed through the incremental hasher

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-3) · **Supersedes/Refines:** none

## Context

`computeLooseObjectId` builds `headerBytes ++ content` into a fresh buffer purely to hand
`ctx.hash.hashHex` one argument — a full second copy of every object in the pack. On the
delta-free fixture, where a base entry's content is not otherwise copied, measured residency
still reached 2.36× the total inflated size, and this copy is the largest identified
contributor. The `HashService` port already exposes `createHasher()`.

## Options considered

1. **Incremental** (recommended) — `h = ctx.hash.createHasher(); h.update(headerBytes);
   h.update(content); await h.digestHex()`.
2. **Keep the concatenated buffer.**
3. Incremental on Node, concatenated elsewhere, behind a capability probe.

## Decision

**Option 1.** Base oids and reconstructed-delta oids are computed by feeding the header bytes
and the content into `createHasher()` separately.

The adapter asymmetry is recorded rather than hidden: Node's hasher wraps `crypto.createHash`
and is genuinely incremental; the memory and browser adapters implement `createHasher` by
collecting chunks and concatenating at `digest()` time, because SubtleCrypto has no streaming
digest. Option 1 is therefore a clear win on Node and exactly neutral elsewhere — it never
regresses, and it removes the copy on the runtime that clones large repositories. Option 3 adds
a branch that buys nothing over that.

## Consequences

One full copy per object leaves the pipeline. This does **not** remove the
`largestEntryInflatedBytes` term from the memory bound: `createInflateStream()` could let bytes
flow into a hasher without ever existing whole, but it does not report `bytesConsumed`, and a
pack stores no entry lengths — so pass 1 must keep `streamInflate` to find where the next entry
begins. If the memory/browser hash adapters ever gain a true streaming digest, they inherit the
benefit with no call-site change.
