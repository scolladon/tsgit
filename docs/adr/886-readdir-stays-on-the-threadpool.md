---
subjects:
  - src/adapters/node/node-file-system.ts
---
# 886 — `readdir` stays on the threadpool

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D3, DC-6) · **Supersedes/Refines:** refines ADR-879

## Context

The user's decision (ADR-879) names the sync-eligible primitives and `readdir` is not among
them. Its cost is proportional to an unbounded entry count: a 256-way loose fanout, an
`objects/pack` directory with thousands of packs, a working tree directory of any size. After
the shared pack-directory listing lands, the cold read path issues one or two `readdir` calls.

## Options considered

1. **Out — `readdir` stays pooled** — pros: no unbounded sync work; matches the decided set /
   cons: one threadpool hop per listing remains. *Recommended by the design.*
2. **In, gated by an entry-count probe** — cons: the count is only known after the call.
3. **In, unconditionally** — cons: a large directory holds the loop for the whole listing.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `readdir` runs on the threadpool.
So do every write, `rmRecursive`, `rename`, and any read above the ADR-880 gate. The decision is
revisited only when a trace shows serial `readdir` calls dominating a hot path.

## Consequences

- The sync arm's worst case stays bounded by the budget and the read gate, not by directory size.
- The cold-read work reduces the listing count instead of the listing cost.
