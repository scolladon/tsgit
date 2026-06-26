# 415 — archive returns metadata + a lazy tree→entry stream

- **Status:** accepted
- **Date:** 2026-06-26
- **Design:** docs/design/archive.md · **Refines:** ADR-249 (structured data only) · **Relates:** ADRs 383–394 (blob streaming)
- **Decision class:** D-SURFACE user-ratified

## Context

`archive` exports a tree-ish as the sequence of entries `git archive` would frame. Two
forces shape its return type. First, the command must surface the **resolved metadata**
up front — the exported tree oid, and (for a commit-ish) the peeled commit oid and
committer time that `git archive` stamps into the tar pax global header / zip comment —
because that metadata, and the refusal conditions, must be observable *before* any entry
is read. Second, an entry carries blob bytes that can be arbitrarily large; eagerly
materialising every blob into one array contradicts the blob-streaming direction
(ADRs 383–394) and the performance priority "streaming, no full-buffer". **What shape
does the command return?**

## Options considered

1. **Bare `AsyncIterable<ArchiveEntry>`** — pros: maximally lazy; cons: no channel for the
   commit oid / committer time, and refusals can only surface mid-iteration, not up front.
2. **Aggregated `Promise<{ commit?, commitTime?, entries: ArchiveEntry[] }>`** — pros:
   simplest to consume, mirrors the `fsck` precedent; cons: buffers every blob's bytes in
   memory at once — violates the blob-streaming direction on large trees.
3. **`Promise<ArchiveResult>` = metadata + a lazy `entries: AsyncIterable`** *(designer
   recommendation)* — pros: metadata + refusals resolve on `await`; entries hydrate blob
   bytes lazily per iteration; cons: the result type is a small two-part shape callers
   must understand.

## Decision

**Option 3 — user-ratified.** `repo.archive(opts)` returns
`Promise<ArchiveResult>` where:

```ts
interface ArchiveResult {
  readonly tree: ObjectId;          // resolved tree exported
  readonly commit?: ObjectId;       // peeled commit oid (pax/zip comment); absent for a bare tree
  readonly commitTime?: number;     // committer epoch seconds (default mtime); absent for a bare tree
  readonly entries: AsyncIterable<ArchiveEntry>;
}
```

Awaiting resolves the metadata and raises any refusal (R1–R4). The `entries` iterable is
**lazy**: each entry's blob bytes are read as it is yielded — no whole-tree buffering.

## Consequences

- Public types: `ArchiveResult`, `ArchiveEntry`, `ArchiveOptions`.
- Metadata is known after `await`, before iteration — a caller can build the tar pax
  global header / zip end-of-central-directory comment without draining the stream.
- The interop test reconstructs git's archive bytes from `entries` + metadata and asserts
  byte-equality — the faithfulness proof under ADR-249.
- The aggregated array (option 2) is foreclosed: it cannot stream large blobs.
