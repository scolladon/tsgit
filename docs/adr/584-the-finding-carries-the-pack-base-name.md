# 584 — The finding carries the pack base name

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-4) · **Refines:** ADR-249

## Context

The pack identifier crosses the library boundary as data no sanitiser touches (threat
model T-3). `isSafePackName` already constrains the base name at the scan boundary;
a composed path is unconstrained, adapter-dependent, and discloses the gitdir layout.

## Options considered

1. **`pack: string` — the base name** (designer's recommendation), the value
   `isSafePackName` already vetted.
2. **`path: string` — the derived `.pack` path** — reconstructs git's line without the
   caller knowing the layout, but git itself prints a relative path locally and an
   absolute one for alternates, so "verbatim" is not even well-defined; and an
   index-layer fault never constructed a `RegisteredPack`, so the path would be
   re-derived exactly where the derivation is least trustworthy.
3. **Both fields** — maximal convenience, largest disclosure, two fields to keep
   consistent.

## Decision

Adopted as recommended: the base name only. It is the smallest faithful datum, the only
field both layers carry uniformly, and the identifier a future repair surface would take
as input.

## Consequences

Callers compose git's display line from their own knowledge of the object directory
(interop tests demonstrate the reconstruction).
