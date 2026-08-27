---
subjects:
  - src/application/commands/maintenance.ts
---
# 733 — gc repacks promisor objects separately

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-18) · **Supersedes/Refines:** refines ADR-732 (promisor packs join the consolidation, in their own class)

## Context

ADR-732 named `*.keep` exclusion but was silent on `.promisor` packs. Pinned (git
2.55.0): default gc repacks promisor objects into a **separate** promisor pack and never
merges them into the normal pack — merging would signal that lazily-fetchable objects
are fully present locally, breaking partial clones, so merging is excluded outright.
The open choice was excluding promisor packs like `*.keep` versus consolidating them
separately as git does.

## Options considered

1. **Exclude promisor packs like `*.keep`** (designer's written default) — pros: smaller; promisor objects still live in a promisor pack / cons: promisor packs never consolidate; a placement divergence from default gc.
2. **Full parity: consolidate promisor objects into a fresh promisor pack** (chosen) — one extra pack build + `.promisor` sidecar write; placement parity total.

## Decision

**User-ratified.** The gc task consolidates promisor packs in their own class: promisor
objects repack into a fresh promisor pack with its `.promisor` sidecar, never merged
with the normal pack; superseded promisor packs retire under the same sibling-deletion
and ordering rules as normal packs. `*.keep` exclusion is unchanged.

## Consequences

Object placement under gc reaches total parity with default git across all four file
classes (normal, cruft, promisor, kept). The interop table's promisor rows assert
parity instead of a recorded divergence. Parity includes duplication: a **reachable**
promisor-pack object is repacked into both the promisor pack and the normal pack,
pinned against git 2.55.0 — promisor membership is not a `.keep`-style exclusion from
the normal pack. An **unreachable** promisor-pack object stays exclusive to the
promisor pack (never crufted, never destroyed), per the retain-direction pin this ADR
already recorded.
