# 646 — fsck's object cache stores a structural projection

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D8)

## Context

`buildObjectCache` decodes every object in the fsck universe and retains the full
`GitObject` — including each blob's entire `content` bytes — in one `Map` held for the
whole command: peak memory is O(total repository content), where real git streams. The
design traced every consumer (`buildBlobFilenameMap`, `buildInEdgeMap`,
`buildReachableSet`, `collectTypeFindings`): none reads blob bytes from the cache;
content validation reads raw bytes through its own path.

## Options considered

1. **Structural projection: store `{ type }` plus per-type out-edge data, `null` for
   unreadable; drop blob bytes (design recommendation)** — pros: peak drops to O(graph
   metadata) with zero re-reads, zero added I/O, no async signature changes / cons: a
   projection type to maintain beside `GitObject`.
2. **Projection plus folding `buildBlobFilenameMap` into the build pass** — pros: tree
   entry names not retained either / cons: moves fsck's special-filename knowledge into
   the cache builder; only worth it if measurement shows tree names are material.
3. **Byte-capped LRU with re-read on eviction** — pros: generic / cons: all four
   consumers become async, and evicted packed objects re-pay full delta-chain
   resolution because `auditCtx` deliberately carries `NO_DELTA_CACHE`.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** The cache value type becomes a
projection carrying the object type and exactly the fields the passes consume; blob
content is never retained. `applyGraft` is applied before projecting a commit so shallow
reachability verdicts are unchanged. Findings, their order, and exit codes are
byte-identical for every repository shape.
