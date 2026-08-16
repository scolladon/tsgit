# 645 — The commit-graph header cache is entry-capped at 65 536

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D7)

## Context

`read-commit-graph.ts` memoises `CommitHeader` per `Context` in an inner `Map` that
never evicts — the one unbounded cache among its siblings (`deltaCache`, bitmap
reconstruction, parent-realpath — all `createLruCache`-bounded). A long-lived host
holding one repository open converges toward caching every commit header in the graph.
`CommitHeader` is small and fixed-shape: `{ rootTree, parents, committerDate,
generation }`, dominated by hex oid strings.

## Options considered

1. **Entry-count bound: `createLruCache(Infinity, CAP)` with `byteSize = 1` (design
   recommendation)** — pros: entry count is an honest proxy for bytes on a fixed-shape
   value; no estimator to maintain / cons: `currentSize` degenerates into an insert
   counter (unread here).
2. **Byte-estimated bound** — pros: matches sibling sizing style / cons: buys accuracy
   the shape does not need.
3. **Both bounds, like `deltaCache`** — pros: symmetry / cons: a knob with no reader.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** The inner `Map` becomes
`createLruCache<CommitHeader>(Number.POSITIVE_INFINITY, 65_536)` with `set(id, header,
1)`. The cap mirrors `DEFAULT_DELTA_CACHE_ENTRIES` (`src/index.node.ts`), so the repo
gains no second magic number. Eviction re-derives from the already-parsed graph layers
and performs no I/O, so no observable result changes.
