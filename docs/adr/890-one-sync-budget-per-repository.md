---
subjects:
  - src/index.node.ts
  - src/adapters/node/node-adapter.ts
---
# 890 — One sync budget per repository

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D1, DC-10) · **Supersedes/Refines:** refines ADR-879 and ADR-880; same per-session framing as ADR-722

## Context

The turn budget (ADR-880) must belong to something. A repository builds several Node
filesystem adapters: the layout probe, the main adapter and one per worktree through
`makeWorktreeFs`. A process may open several unrelated repositories, and test files open many.

## Options considered

1. **One budget per repository, shared by its layout probe and every adapter it builds** —
   pros: the stall bound is the budget times concurrently active repositories, documented; no
   cross-repository coupling / cons: none found. *Recommended by the design.*
2. **One process-wide module singleton** — cons: mutable module state shared across unrelated
   repositories and test files.
3. **One per `NodeFileSystem` instance** — cons: a repository's worktree adapter and main
   adapter each take a full budget in the same turn.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `openRepository` creates one
`SyncIoPolicy` (operations, budget, read gate) and passes it to the layout probe, the main
adapter and every worktree adapter it builds; `createNodeContext` creates one per context. No
module-level budget exists.

## Consequences

- The documented worst case is one budget per concurrently active repository.
- Tests that construct adapters directly get no budget unless they pass one; those exercising
  the sync arm pass an injected clock and scheduler.
