# 614 — `pack-objects` ships closure-to-pack only

- **Status:** accepted (ratified — new scope, no design recommendation existed)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (revision) · **Refines:** ADR-249, ADR-603, ADR-613

## Context

`pack-objects` is the second capability a bitmap enables, and the building blocks already
exist: `buildPack` streams objects into a pack and the pack writer serialises the `.pack`
and `.idx`. What needed deciding is how far past that core the command reaches — git's own
`pack-objects` also writes the auxiliary artefacts and performs delta compression.

## Options considered

1. **Closure to pack core** — take wants/haves, compute the closure (bitmap-accelerated),
   write `.pack` + `.idx`, return structured results / no auxiliary-artefact writing.
2. **Core plus `.rev`/`.bitmap` writing** — closes the cross-tool asymmetry / needs an EWAH
   *encoder* on top of the decoder and a new annotated write surface.
3. **Core plus delta compression** — smaller packs / a large independent workstream; the
   pack writer currently emits non-delta entries.

## Decision

Option 1. `pack-objects` computes the object closure for given wants and haves and writes a
pack and its index, returning structured fields (pack object id, object count, byte
counts) per ADR-249 — never a rendered progress or summary line.

**Writing `.rev` and `.bitmap` is excluded permanently**, not deferred. The consequence is
recorded rather than fixed: a tsgit-written pack has no `.rev` where a git-written one does,
so a tsgit repository is *distinguishable* from a git one. This is harmless in both
tools — a missing `.rev` and a missing `.bitmap` are non-events, pinned — and it stays a
read-side entry by construction. Delta compression is likewise excluded permanently here;
it is a pack-*writer* concern, not a bitmap one, and belongs to whatever entry takes the
writer on.

Because tsgit writes no auxiliary artefacts, no `@writes` annotation and no write-surface
allowlist entry is added, and that gate stays green untouched.

## Consequences

Pays the same Tier-1 surface tax as ADR-613. Any future maintenance surface that *deletes*
packs must delete their `.rev`/`.bitmap` alongside — orphans are ignored by both tools, so
this is hygiene rather than correctness, and it is weaker than the equivalent midx
constraint, which is a correctness one.
