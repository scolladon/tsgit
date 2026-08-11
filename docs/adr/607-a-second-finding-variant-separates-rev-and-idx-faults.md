# 607 — A second finding variant separates a `.rev` fault from an `.idx` fault

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-5) · **Refines:** ADR-583, ADR-586

## Context

`fsck` today emits one variant, `pack-rev-index-unusable { pack, reason }`, and sets exit
bit 64 — but only when the `.idx` itself could not be parsed. Its own doc-comment concedes
the gap: *"tsgit has no reverse-index reader … the name is a promise the code does not yet
keep."* ADR-586 closed with the claim that the real reader would land *"with nothing to
correct"*; that is falsified — tsgit exits 0 where git exits 64 on a corrupt `.rev`.

The two causes never co-occur: an unusable `.idx` **suppresses** the `.rev` check entirely
(design Pin H, C1 ≡ C2 byte-identical), because git never loads a `.rev` for a pack whose
index it could not load.

## Options considered

1. **Widen the existing variant** — no new surface / makes two genuinely different layers
   indistinguishable and re-uses a doc-comment promising a different cause.
2. **Add a second variant** (designer's recommendation) — matches ADR-583's
   one-variant-per-layer rule and git's own two message families.
3. **Widen plus an optional `position` field** — right about the data, wrong about the
   shape: an optional field mostly absent is the primitive obsession ADR-584 avoided.

## Decision

Option 2. A second variant reports a fault in the `.rev` **file**, distinct from the
existing variant reporting a `.rev` made unavailable by its `.idx`. Both set exit bit 64;
a consumer seeing which variant fired learns which layer failed, which a widened variant
could not express.

`EXIT_PACK_REV_INDEX`'s doc-comment is rewritten in the same change: the promise the code
did not keep is now kept, and the comment must stop saying otherwise.

## Consequences

Both variants are public surface in `reports/api.json`. ADR-586's closing sentence is
superseded and its ADR gains a correction note. Pairs with ADR-608, which settles the
cardinality of the body-mismatch case.
