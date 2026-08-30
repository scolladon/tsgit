---
subjects:
  - src/domain/objects/tree.ts
---
# 758 — The tree-entry factory copies its name bytes

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (DC-D) · **Supersedes/Refines:** refines ADR-749

## Context

ADR-749 publishes a tree entry's raw name bytes. On the parse path those bytes are a
sub-range of the object's content buffer, and that buffer is frequently a cached object
body rather than a fresh allocation. Handing a consumer a view onto it would let any
write through that view corrupt the cache for every later reader, and would let the
buffer's lifetime be extended by a single retained entry.

## Options considered

1. **Always copy in the factory** — pros: a published entry can never alias internal state; one rule, no caller has to know / cons: one small allocation per entry on the parse path.
2. **Return the sub-range view; document that it must not be mutated** — pros: zero-copy, matching the cursor's philosophy / cons: a documented rule the type system does not enforce, on a published surface, where the failure is silent cache corruption.
3. **Copy only when the source is a cached buffer** — cons: the factory would need to know its caller's provenance, which is exactly the coupling the factory exists to remove.

## Decision

**Adopted as recommended (no user judgment) — consistent with the domain's immutability
rule.** The factory copies the bytes it is given, whether they arrive as a string or as
a `Uint8Array`. A `TreeEntry` never aliases a buffer it does not own.

## Consequences

The zero-copy path stays where it already is and where it is measured: `TreeCursor` and
its consumers read names in place without ever building a `TreeEntry`. This decision
governs only the materialised entry, which is the surface that escapes. A future
performance pass that wants to remove the copy has to solve the aliasing problem first,
and this record is why.
