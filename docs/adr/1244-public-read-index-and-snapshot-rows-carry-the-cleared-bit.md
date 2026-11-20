---
subjects:
  - src/application/primitives/read-index.ts
---
# 1244 — Public readIndex and snapshot rows carry the cleared bit

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-I, R11) · **Supersedes/Refines:** refines ADR-1236

## Context

`primitives.readIndex` and the snapshot resolvers expose index entries with their flags. git's
`ls-files -t` shows the cleared bit (S1b).

## Options considered

1. **The cleared view everywhere** (recommended), one meaning for the bit across the API.
2. Raw bits for snapshot resolvers, cleared elsewhere.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — no trade-off: git exposes one view.
Planning checks that the caching snapshot resolver does not serve a bit cleared before a file
appeared or vanished.

## Consequences

### Negative

- A consumer reading flags sees `skipWorktree: false` for a present file it set skip-worktree on.
