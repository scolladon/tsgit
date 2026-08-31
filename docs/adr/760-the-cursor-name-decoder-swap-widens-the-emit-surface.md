---
subjects:
  - src/domain/objects/tree-cursor.ts
  - src/domain/diff/raw-tree-diff.ts
  - src/application/primitives/internal/walk-raw-subtree.ts
  - src/application/primitives/internal/flatten-raw.ts
---
# 760 — The cursor-name decoder swap widens the emit surface

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/plan/tree-entry-byte-sensitivity.md (DC-P1) · **Supersedes/Refines:** refines ADR-723's unchanged-surface claim

## Context

Making flatten emit byte-faithful paths means the cursor's name decoder must stop
stripping a leading byte-order mark. The design assumed that decoder had one consumer.
Measured, it has four: the flatten walk, the raw subtree walk, the raw merge-join diff
(three call sites), and the path descent. The merge-join and the subtree walk use it only
to *emit* a path, never to decide anything — so no verdict, refusal or ordering changes —
but the strings they emit for a name carrying a byte-order mark do change. ADR-723's
consequences describe both of those surfaces as unchanged by this line of work.

## Options considered

1. **Swap the decoder once, accept the wider emit surface, and pin the new path on all three consumers** — pros: one decoder, one behaviour, consistent with the byte-fidelity rule / cons: changes emitted paths on two surfaces a prior decision called unchanged.
2. **Leave the shared decoder alone and give flatten its own preserving helper** — cons: buys a second helper in order to keep two consumers wrong; a BOM-stripped path out of the recursive diff is the same defect one surface over.
3. **Leave the decoder alone entirely** — cons: flatten keeps dropping the mark from a path git materialises with it, contradicting the whole change.

## Decision

**Adopted as recommended (no user judgment) — aligns with ADR-748's rule that every
tree read path is byte-faithful.** The cursor's name decoder preserves a leading
byte-order mark, once, for all consumers. The paths emitted by the recursive tree diff
and the raw subtree walk change accordingly, and are pinned.

This does **not** touch what ADR-723 actually protects: no check is added to the cursor's
own scan, no refusal moves into it, and the merge-join still validates nothing. Only the
rendering of an emitted name changes.

## Consequences

### Positive

- One decoder, so a name renders the same way on every surface that emits it.

### Negative

- Two surfaces ADR-723 recorded as unchanged now emit a different string for a byte-order-mark-bearing name. Each gains a pinning test rather than inheriting the claim.

### Neutral

- The design's stated justification for this option was factually wrong about the consumer count; the option it recommended was nevertheless correct. This record carries the corrected measurement so the next reader does not inherit the error.
