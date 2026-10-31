---
subjects:
  - src/application/commands/gc.ts
  - src/application/primitives/ref-store.ts
---
# 1134 — gc prunes what only a ref under an unreadable directory reaches, as git does

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (DC-2) · **Plan:** docs/plan/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-226

## Context

Probed on git 2.56.0: with `refs/heads/d/` at mode 000, `git gc` exits 0 and prunes a commit reachable only
from `refs/heads/d/x`; at 0400 it exits 128 and keeps it.

## Options considered

1. **Follow git** (planner's recommendation) — cons: a ref's history can be pruned silently, as in git.
2. **Refuse at 000** — cons: a divergence.

## Decision

**Ratified by the user: option 1.** gc lists refs through the shared walk, which skips the 000 directory, and
prunes accordingly; the 0400 shape keeps git's death.
