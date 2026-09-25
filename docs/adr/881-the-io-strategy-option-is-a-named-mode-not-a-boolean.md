---
subjects:
  - src/index.node.ts
  - src/adapters/node/node-adapter.ts
---
# 881 — The I/O strategy option is a named mode, not a boolean

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D3, DC-1b) · **Supersedes/Refines:** refines ADR-879

## Context

ADR-879's sync fast path is default-on and needs a per-repository opt-out on `openRepository`
and `createNodeContext`. The house shape for adapter switches is a boolean (`hooks?: boolean`,
`command?: boolean` on `NodeAdapterOptions`). The design recommended following it. The tuning
numbers (ADR-880) stay internal whichever shape is chosen.

## Options considered

1. **`syncIo?: boolean`, default `true`** — pros: the house shape / cons: names the mechanism,
   not the strategy; a third mode later needs a second flag. *Recommended by the design.*
2. **`io?: 'sync-fast-path' | 'threadpool'`** — pros: names the strategy, a future mode extends
   the union, self-documenting at the call site / cons: slightly heavier than a boolean.
3. **`syncIo?: false | { budgetMs?: number; maxReadBytes?: number }`** — pros: exposes tuning
   now / cons: no requester; YAGNI.

## Decision

**Option 2 — the user's judgment (deviates from the design's recommendation).**
`OpenNodeRepositoryOptions` and `NodeAdapterOptions` gain `readonly io?: 'sync-fast-path' |
'threadpool'`, default `'sync-fast-path'`. `'threadpool'` creates no sync policy and every
adapter the repository builds runs today's async path. The design's `syncIo` field name is
replaced everywhere by `io`. A future strategy (a tuned sync mode, a worker-thread mode) is a new
union member, never a second flag, and the budget and gate values stay internal until a mode
that carries them exists.

## Consequences

- The public surface documents one strategy enum instead of a mechanism flag; docs and the
  `openRepository` reference pages describe the two modes and when to pick `'threadpool'`.
- The design is revised to carry the `io` name into every part (option plumbing, contract suite
  rows, docs).
- A boolean toggle named after an implementation mechanism is not the shape for future adapter
  strategies in this codebase.
