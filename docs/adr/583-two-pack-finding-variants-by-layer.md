# 583 — Two pack-finding variants, one per layer

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-3) · **Refines:** ADR-249

## Context

The two fault layers differ in git's message (`cannot be accessed` vs `index not
opened`) **and** in exit composition (bit 4 vs bit 4 | 64, Pin K). Message wording is
tsgit's under ADR-249; the exit integer is bound by the prime directive.

## Options considered

1. **Two variants** (designer's recommendation) — `pack-inaccessible` and
   `pack-index-unusable`.
2. **One variant with a `layer` field** — smaller surface, but the exit-bit rule becomes
   a conditional on a field: one more mutation-surviving branch, one more thing a caller
   can ignore.
3. **Reuse `bad-object` with a synthetic id** — refused on principle: a pack is not an
   object and the `id` field would be a lie, precisely the confusion Pin O3 shows tsgit
   already causing.

## Decision

Adopted as recommended: two variants. The exit-bit rule is a property of the variant, so
the pass needs no per-row branching, and the caller reconstructs the right git line from
the type alone.

## Consequences

Two entries in `docs/use/commands/fsck.md` and `reports/api.json` (three with ADR-586's
rev-index variant).
