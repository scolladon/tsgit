# ADR-383: Blob streaming is a new `streamBlob` primitive beside `readBlob`

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)

## Context

`readBlob(ctx, id, options?): Promise<Blob>` materialises the whole inflated
`Uint8Array` as `Blob.content`. Multi-MB blobs (e.g. StaticResources) hold their
full content resident. We want a bounded-memory way to consume a blob's content
without ever holding the whole inflated buffer. 24.10 already fixed large-blob
*correctness* (exact-slice pack reads + size-unbounded inflate); this is purely a
peak-memory capability. The question is how to expose it on the API surface.

## Options considered

1. **(chosen) A new `streamBlob` primitive** beside `readBlob`, returning a distinct
   stream type; `readBlob` stays fully-buffered and unchanged — pros: each function
   has a single return shape (CQS, Object Calisthenics); additive, zero regression to
   the many callers that need the whole buffer; the streaming and buffered contracts
   stay independently documentable / cons: one more public symbol to gate.
2. **An option on `readBlob`** (`{ stream: true }`) that switches the return type —
   Rejected: a boolean parameter that flips the return type to a union is a
   boolean-param + union-return smell; every caller must narrow.
3. **Size-tiered auto-escalation inside `readBlob`** (buffer small, stream large, same
   return type) — Rejected: cannot return a unified type without erasing the
   distinction, and hides a peak-memory cliff behind an unchanged signature.

## Decision

Add `streamBlob(ctx, id, options?)` as a sibling primitive, reachable on the facade as
`repo.primitives.streamBlob`. `readBlob` and `Blob.content` are untouched.

## Consequences

### Positive

- Single-shape functions; the buffered API is unchanged and non-regressing.
- The streaming contract (delta handling, verification) lives on its own symbol.

### Negative

- A new public export to carry through the surface gates (barrel, facade,
  repository snapshot, api.json, docs).

### Neutral

- Escalation policy, if ever wanted, belongs *inside* `streamBlob` (see ADR-385), not
  in `readBlob`.
