# 692 — The reftable stack loads eagerly

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-9) · **Refines:** ADR-680

## Context

A reftable stack is a list of tables, each block-structured with restart points. Measured stack
depth on real repositories was **1–2 tables**. CLAUDE.md lists zero-copy `DataView` parsing and
streaming reads among the performance priorities, so eager whole-table loading needs a reason
rather than a default.

## Options considered

1. **Eager whole-table load** (design recommendation) — pros: at depth 1–2 the whole stack is
   small; one read per table, then pure in-memory resolution / cons: a pathological stack
   allocates proportionally.
2. **Lazy per-block reads** — pros: bounded memory / cons: an I/O round trip per block on a
   structure that is usually smaller than a single pack index.
3. **Hybrid** — index eagerly, blocks lazily — cons: the complexity of both for a measured depth
   of 2.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

The stack is read eagerly, parsed zero-copy over `DataView` in the house style.

## Consequences

- Compaction (ADR-680) needs the whole stack in memory regardless, so eager loading is not an
  extra cost on the write path — it is the shape that path already requires.
- Reads stay allocation-light through zero-copy views; "eager" concerns the file read, not object
  materialisation.
- If a pathological stack depth is ever observed, this is a localised change behind the
  ADR-686 seam and supersedes only this ADR.
