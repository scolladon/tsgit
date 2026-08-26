---
subjects:
  - src/application/primitives/read-head-tree.ts
  - src/application/primitives/internal/flatten-raw.ts
---
# 726 — FlatTree cache keys on `(rootTreeOid, maxDepth)`

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-12) · **Supersedes/Refines:** none

## Context

The HEAD `FlatTree` is rebuilt on every `status`/`rm` call although trees are immutable.
A `FlatTree` is only valid under the `core.maxTreeDepth` it was built with, and the LRU
silently drops entries larger than its cap.

## Options considered

1. **Key `(rootTreeOid, maxDepth)`, byte-capped LRU, floor-at-1 sizer** (recommended, chosen).
2. **Key oid only, invalidate on config write** — cons: a second config coupling to get wrong.
3. **FIFO entry-capped Map** — cons: the FIFO precedent's rationale (zero-I/O re-derivation) does not transfer; a FlatTree miss re-walks the whole tree.

## Decision

**Adopted-as-recommended (no user judgment).** A Context-scoped (session-scoped once the
session token lands) byte-capped `LruCache` keyed `(rootTreeOid, maxDepth)`, sized from
the existing delta-cache budget, with a floor-at-1 byte sizer. Gitlink entries (mode
`160000`) are preserved in cached trees. An over-cap tree simply never caches; that drop
is documented, not worked around.

## Consequences

Repeat `status` on an unchanged HEAD becomes a map hit; other flatten consumers may opt
in later. Cache correctness across a `core.maxTreeDepth` change is structural (the key),
not an invalidation protocol.
