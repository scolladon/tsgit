---
subjects:
  - src/domain/objects/tree.ts
---
# 764 — Parsed entries view one private per-tree copy

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1) · **Supersedes/Refines:** refines ADR-758

## Context

ADR-758 made the entry factory copy the bytes it is given, so a published entry can never
alias a caller-supplied or cached buffer. That invariant is right and is not in question.
The chosen mechanism — one copy per entry — was measured expensive in retained heap:
396 bytes per entry against 164 on the previous shape, a 142% increase, because every
entry carries its own buffer and typed-array header for a name averaging around 22 bytes.

Review measured a middle ground on the same fixture: the parser copies the object content
**once** and hands each entry a view onto that private copy. That is 376 bytes per entry
against 504 for per-entry copies, recovering roughly 55% of the added memory, and about
12% faster to build.

## Options considered

1. **One private per-tree copy, entries view into it** — pros: recovers most of the memory and is faster; the invariant holds verbatim because the parser owns the buffer / cons: entries within one tree share a lifetime, so retaining one entry retains the tree's names.
2. **Keep the per-entry copy** — pros: simplest possible rule, no shared-lifetime reasoning / cons: 504 bytes per entry retained, measurably slower to build.

## Decision

**Ratified by the user: option 1.** `parseTreeContent` copies the tree's content once into
a buffer it owns and mints entries as views onto that copy. The defensive copy stays on
the factory's other entry points — a string, or a `Uint8Array` supplied by a caller —
because those sources are not the parser's to trust.

ADR-758's invariant is unchanged and restated: **a published entry never aliases a
caller-supplied or cached buffer.** Only the mechanism changes.

## Consequences

### Positive

- Roughly 55% of the added retained heap recovered, and entry construction about 12% faster.

### Negative

- Entries parsed from one tree share their backing buffer, so retaining a single entry retains that tree's name bytes. Exposure is bounded — parsed trees are not cached, and a single tree's names are small — but it is a real lifetime coupling where per-entry copies had none.
