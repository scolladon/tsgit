# 550 — The drop predicate keeps a gated streaming arm

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

Once ADR-548's seam and ADR-549's gate exist, the predicate could stop streaming
altogether. Doing so would delete the scanner's `needs-input` state and roughly half its
chunk-boundary tests — a real simplification. The counter-weight is that the streaming
predicate exists precisely so a very large file diffed with `-w` is never materialised.

## Options considered

1. **Yes, gated** (designer's recommendation) — blobs above the threshold still stream;
   sub-threshold pairs take the buffered arm. Pros: preserves the memory posture
   ADR-513 / ADR-383 built the streaming predicate for; costs one branch / cons: keeps
   `needs-input` and its tests.
2. **No — the predicate always buffers**; `streamBlob` keeps its other callers. Pros:
   deletes half the scanner and its tests / cons: materialises **both** sides of a
   674 MB `-w` diff in full — exactly the case the streaming predicate was built for.
3. **Yes, but pack-base only** — loose always buffered (ADR-388 reads the whole
   compressed file anyway), streaming kept for pack-base entries. Cons: makes a large
   **loose** blob unbounded on the inflated side, which is the one thing ADR-388
   deliberately still bounds. Worst of the three.

## Decision

**Option 1**, ratified by the user. The predicate has two arms: `compareBuffered` when
both sides resolve to `bytes`, `compareStreamed` otherwise.

## Consequences

`compareStreamed` keeps today's structure and its concurrency — both sides still advance
under one `Promise.all` per step, so a two-large-blob diff keeps overlapping its I/O.
The mixed case (one buffered side, one streamed side) stops allocating and awaiting a
resolved promise for the buffered side on every line, because advancing a side now
consults the synchronous scanner first and only awaits on `needs-input`. Because the
streaming arm survives, the "one state machine, not two" requirement is what guarantees
the two arms cannot drift; ADR-551 is what delivers it. The buffered arm returns
`compareBuffered(…)` as a plain boolean and the streamed arm uses `return await` — never
a bare `return <promise>`, which is this repository's recurring workerd
unhandled-rejection class.
