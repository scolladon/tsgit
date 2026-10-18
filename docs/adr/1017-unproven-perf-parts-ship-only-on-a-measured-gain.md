---
subjects:
  - src/application/primitives/compute-changeset.ts
  - src/domain/diff/index-diff.ts
  - src/application/commands/status.ts
  - src/domain/ignore/matcher-stack.ts
---
# 1017 — Performance parts whose targets are under 1% of the profile ship only on a measured gain

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** none

## Context

The merge-joins and the ignore-matcher changes target frames each under 1% of the pre-change profile (design §D8–§D9). The rule for this work: no edit without profile evidence.

## Options considered

1. Implement, then keep only what the bench shows above noise, or what fixes byte-order sorting (recommended).
2. Implement unconditionally.
3. Defer both.

## Decision

**Adopted-as-recommended (no user judgment)**: option 1. `bench:ab`, 5 rounds, decides each part. A change that only reorders output into git's byte-order sorting stays, because it is a faithfulness fix.

## Consequences

- The PR reports each of these parts as kept or dropped, with its numbers.
