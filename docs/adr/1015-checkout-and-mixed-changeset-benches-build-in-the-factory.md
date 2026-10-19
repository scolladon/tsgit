---
subjects:
  - test/bench/checkout.bench.ts
  - test/bench/support/write-scratch.ts
---
# 1015 — Checkout benches isolate a direction with pre-built copies and a write-scratch mixed fixture

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** none

## Context

vitest bench per-iteration hooks do not run, so a checkout bench cannot reset between iterations. The current alternation charges each row for both directions. No fixture produces a mixed changeset (modify, delete and add together).

## Options considered

Reset: (a) a pool of pre-built scratch copies consumed one per iteration, if `bench-dsl` can cap iterations (recommended); (b) checkout+reset pairs minus a reset-only row; (c) keep the alternation. Mixed fixture: (a) a write-scratch builder with thirds modified, deleted and new (recommended); (b) a new fixture-generator strategy; (c) git-built in the factory.

## Decision

**Adopted-as-recommended (no user judgment)**: reset (a), falling back to (b) if iterations cannot be capped; mixed fixture (a).

## Consequences

- Each checkout direction gets its own row.
- A cached, tiered mixed fixture remains a follow-up.
