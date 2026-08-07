# 585 — fsck narrows its universe via an enumerate-objects knob

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-5) · **Refines:** ADR-575

## Context

`fsck`'s object walk must exclude objects contributed only by an unusable pack
(Pin M1/M2), but git's other enumeration surfaces (`cat-file --batch-all-objects`) do
list a refused pack's ids — so the narrowing is fsck-only, and `registry.all()` plus
default `enumerateObjects` must not change.

## Options considered

1. **`EnumerateObjectsOptions` gains an accessibility knob** (designer's
   recommendation) — default preserves today's behaviour; `fsck` opts in. One optional
   public field; the primitive stays the single enumeration route. Costs a second
   `health()` call per run (cheap: only failed packs re-probe).
2. **`fsck` composes the universe itself** — zero public delta, one `health()` call,
   but duplicates `collectPackedObjectIds` inside a command, the layering
   `enumerate-objects.ts` exists to prevent.
3. **`enumerateObjects` always filters** — refuted by Pin M1 and would silently change
   `resolveOidPrefix`.

## Decision

User-ratified option 1: the knob. The layering argument won over the surface delta —
one enumeration route, one place the universe is defined.

## Consequences

One `api.json` delta and one doc-page row. `health()` runs twice per fsck in full mode;
the second call re-probes only failed packs (12 bytes each) and doubles their
per-generation logger warn — matching git's own repeated `error:` lines for the same
no-negative-cache reason.
