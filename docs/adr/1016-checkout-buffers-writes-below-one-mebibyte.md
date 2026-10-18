---
subjects:
  - src/application/primitives/internal/write-working-tree-file.ts
---
# 1016 — Checkout buffers blob writes below 1 MiB

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** none

## Context

Checkout streams every blob through a `pipeline` and a `WriteStream`, even small ones. git's syscalls are the same whether a blob is buffered or streamed, so the threshold is a tsgit memory policy, not observable behaviour.

## Options considered

1. A fixed 1 MiB constant (recommended).
2. `core.bigFileThreshold` (default 512 MiB, times the pool width).
3. Always buffer unless a transform is active.

## Decision

**Adopted-as-recommended (no user judgment)**: option 1.

## Consequences

- Memory per pooled write stays bounded at 1 MiB.
