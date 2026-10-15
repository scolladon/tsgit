---
subjects:
  - src/domain/diff/flat-tree.ts
---
# 983 — The merge engine switches to escaped paths one consumer group at a time

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** —

## Context

Carrying bytes through the merge engine (ADR-977) touches every flattened-tree consumer.

## Options considered

1. **Outbound paths first, one consumer group per change, then a type brand on the engine input**
   (recommended).
2. One atomic switch.
3. Option 1 without the brand.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Every commit compiles and keeps the
suite green; the brand lets the compiler find any consumer left on the decoded view.

## Consequences

- Functions that are identity on well-formed strings land before the switch.
- A forgotten consumer fails type-checking instead of silently renaming.
