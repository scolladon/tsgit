# ADR-384: `streamBlob` returns a `BlobStream` — `AsyncIterable<Uint8Array>` plus metadata

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-383](383-stream-blob-primitive.md)

## Context

`streamBlob` (ADR-383) needs a return type for the content-byte stream. The codebase
composes `AsyncIterable` in `src/operators/` (`pipe`/`map`/`take`/`filter`), and
`src/operators/readable-stream.ts` already bridges a Web `ReadableStream<Uint8Array>`
to an `AsyncIterable`. The deltified-blob decision (ADR-386) needs the result to carry
a `materialised` flag, so the return type must be able to surface metadata alongside
the byte stream.

## Options considered

1. **(chosen) `BlobStream` = `AsyncIterable<Uint8Array>` with metadata attached**
   (e.g. a `materialised` flag) — pros: `src/operators/` already composes
   `AsyncIterable`; the bridge already exists; it is the lowest-common-denominator
   across Node and browser; metadata rides on the same object, so ADR-386's flag has a
   home without a separate type / cons: an iterable-with-extra-properties is a slightly
   unusual shape (documented).
2. **Raw Web `ReadableStream<Uint8Array>`** — Rejected: forces every `operators`
   consumer through an adapter; the reverse (iterable → stream) is the rarer need and
   trivial to adapt when wanted.
3. **A handle object** `{ stream(): AsyncIterable; size; materialised }` — Rejected as
   the default: heavier surface than an iterable-with-props; folded into option 1 (the
   metadata lives on the iterable object itself).

## Decision

`streamBlob` resolves to a `BlobStream`: an `AsyncIterable<Uint8Array>` of raw content
bytes that also exposes the metadata ADR-386 requires (`materialised`). Chunk sizes
and boundaries are **not** part of the contract — a consumer must not assume them.

## Consequences

### Positive

- Directly composable with existing operators; metadata has a home.

### Negative

- Consumers wanting a Web stream adapt via the existing bridge (one call).

### Neutral

- The byte sequence is identical to `readBlob(id).content`; only residency differs.
