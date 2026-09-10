---
subjects:
  - src/application/commands/push.ts
---
# 843 — push computes its closure at the bitmap tier

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-8) · **Supersedes/Refines:** refines ADR-618

## Context

ADR-618 selects the closure tier per command: `rev-list` walks, `pack-objects` prefers a usable
bitmap. `push` now calls `computeClosure` directly and must name its tier. git's `send-pack`
drives `pack-objects --revs`, whose default is the bitmap when one is usable, with a silent walk
fallback otherwise.

## Options considered

1. **`tier: 'bitmap'`** (recommended, chosen) — pros: git's default for the push closure; the exact difference when a bitmap is usable; the pruned walk otherwise / cons: none.
2. **`tier: 'walk'`** — cons: ignores a usable bitmap that git would use.

## Decision

**Adopted-as-recommended (no user judgment).** `push` requests the bitmap tier.

## Consequences

Push inherits the bitmap path and, on the fallback, the seen-tree prune. The tier rule of ADR-618
gains a row: `push` behaves as `pack-objects` does.
