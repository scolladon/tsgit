# ADR-386: Deltified blobs are reconstructed in full, then streamed, with `materialised: true`

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-384](384-blob-stream-asynciterable-return.md)

## Context

A blob stored as a pack delta (OFS_DELTA / REF_DELTA) cannot be streamed before
reconstruction: delta application needs the **full base object** plus the delta
instructions resident in memory to run copy/insert ops (`applyDelta`,
`resolvePackChain`). The reconstructed result exists only as a complete buffer. Loose
blobs and non-delta ("base") pack entries are the cleanly-streamable cases; deltified
blobs are not. The contract must state honestly what `streamBlob` does for a deltified
blob — it must not claim bounded memory it does not deliver.

## Options considered

1. **(chosen) Reconstruct fully, then stream from the buffer; expose `materialised: true`**
   on the `BlobStream` — pros: honest (the caller can observe memory was not bounded);
   one uniform iterable interface for all storage forms; correct bytes always / cons:
   no memory saving on the deltified path (the heavy step is the reconstruction).
2. **Reconstruct fully, return a buffered result with no flag** — Rejected: silently
   lies about bounded memory; a caller cannot tell streamed-from-disk from
   streamed-from-reconstruction.
3. **Refuse — throw "delta blob not streamable"** and tell the caller to use `readBlob`
   — Rejected: pushes storage-form branching onto every caller and breaks the uniform
   contract for an implementation detail (whether `git gc` happened to deltify the blob).

## Decision

For a deltified blob, `streamBlob` reconstructs the full content via the existing
buffered pack-chain path, then yields from that buffer, setting `materialised: true` on
the `BlobStream`. Loose and base-pack blobs yield `materialised: false` (genuinely
streamed). The yielded bytes are byte-identical to `readBlob(id).content` in all cases.

## Consequences

### Positive

- Uniform interface; honest memory contract; always-correct bytes.

### Negative

- The deltified path gives no peak-memory benefit (documented via the flag).

### Neutral

- Peak memory for a deltified blob ≈ base + result, as for `readBlob` today.
