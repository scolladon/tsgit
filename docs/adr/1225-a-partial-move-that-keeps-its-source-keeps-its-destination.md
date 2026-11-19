---
subjects:
  - src/application/commands/mv.ts
---
# 1225 — A partial move that keeps its source keeps its destination

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (N3) · **Supersedes/Refines:** refines ADR-1224

## Context

Under `skipErrors`, an entry-by-entry directory move can fail after its first leaf while a lossy
member keeps the source directory in the index. git never reaches this state: it moves every
member's index entry and deletes the source. The leaves already moved exist only at the destination.

## Options considered

1. Remove the destination anyway — deletes data that neither git nor the fault-free path loses.
2. **Keep the destination when the source is kept**; ADR-1218's documented partial move applies to
   this arm.
3. Move the leaves back, then decide — a rollback ADR-1218 rejected, with a second fault surface.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-1218: the entry-by-entry path never deletes
content; ADR-1224's removal exists to reach a state git reaches, and git has none here.

## Consequences

ADR-1224's destination removal runs only when the source is abandoned.
