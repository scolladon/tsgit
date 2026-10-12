---
subjects:
  - src/application/commands/internal/fsck/types.ts
---
# 920 — Pack-class fsck findings carry their objects dir

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-8) · **Supersedes/Refines:** refines ADR-584 (finding carries the pack base name)

## Context

ADR-584 identifies a pack finding by base name. With alternates two sources can hold packs with
the same base name, and git prints the absolute alternate path (Pins F4b/F4c).

## Options considered

1. **Optional `objectsDir` on pack-class findings, absent for the primary** (recommended).
2. **Base name only** — cons: ambiguous across sources.
3. **Absolute path in `pack`** — cons: changes the field's meaning for every consumer.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Additive, non-breaking; primary findings are unchanged.

## Consequences

- Consumers reconstructing git's message prefix the base name with `objectsDir/pack/` when present.
