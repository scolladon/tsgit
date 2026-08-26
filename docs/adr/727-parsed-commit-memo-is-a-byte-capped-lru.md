---
subjects:
  - src/application/primitives/object-resolver.ts
  - src/domain/objects/commit.ts
---
# 727 — Parsed-commit memo is a byte-capped LRU

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-13) · **Supersedes/Refines:** none

## Context

No parsed-object memo exists at any level; every read re-parses. The existing
commit-graph header cache chose FIFO because its misses re-derive with zero I/O — a
rationale that does not transfer to parsed commits, whose miss costs a full object read
plus parse, and whose sizes vary by orders of magnitude with message length.

## Options considered

1. **Byte-capped LRU, sized from a fraction of the delta-cache budget** (recommended, chosen).
2. **Entry-capped FIFO mirroring the header cache** — cons: a repo of large messages blows the budget; FIFO rationale does not transfer.
3. **No memo; byte parser only** — the honest fallback if sizing proves hard.

## Decision

**Adopted-as-recommended (no user judgment).** A per-session byte-capped
`LruCache<CommitData>` consulted by the object resolver for commits (and tags), populated
on parse, sharing the delta-cache byte budget by fraction. `CommitData` is deep-readonly,
so sharing parsed objects is safe.

## Consequences

Repeat walks parse each commit once per session. The memo interacts with the loose-read
byte cache (demand shifts); its size fraction is A/B-measured, and option 3 remains the
recorded fallback if the interaction cannot be sized cleanly.
