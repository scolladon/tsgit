---
subjects:
  - src/ports/compressor.ts
---
# 908 — The Compressor port gains a capped inflate and a head inflate

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 1, H2) · **Supersedes/Refines:** none

## Context

ADR-907 needs a loose read to learn the size claim and stop inflating at header + claim.

## Options considered

1. **Optional output cap on `inflate` plus `inflateHead(data, max)` on the port, in every
   adapter** — ~+1.3 µs per loose read. *Recommended by the design.*
2. No port change: stream the header, then a capped `streamInflate` — ~55 µs vs 2 µs per
   object on the hot path.

## Decision

**Option 1 — ratified by the user.**

## Consequences

- Node, browser and memory adapters implement both; the port contract suite pins them.
