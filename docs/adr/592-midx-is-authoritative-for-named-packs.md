# 592 — The midx is authoritative for the packs it names

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-1, Pin H)

## Context

The 28.2 brief described the midx as "an additive acceleration layer" with per-pack
`.idx` fallback. The design's Pin H matrix (the `DUP` fixture — one blob in two packs,
the midx assigning it to pack A) refuted that premise: when a midx-named pack is
deleted, unreadable, or gutted, git reports the object **missing** even though a
sibling pack in the same midx holds it (H2–H4). Removing the midx or setting
`core.multiPackIndex=false` restores the object (H5/H6). A `PNAM` entry that resolves
to no pack at all drops out of the midx's universe and that pack is scanned normally
(H7); a pack written after the midx is served normally (H8).

## Options considered

1. **Accelerator with `.idx` fallback** — the brief's wording. Keeps every object
   readable, but installs a new permanent divergence from git on the hot path — the
   exact divergence the brief asked to close.
2. **Authoritative** (designer's recommendation) — packs the midx names are served
   only through it; a midx hit on an unusable pack returns not-found; only unnamed
   packs are scanned as fallback.
3. **Authoritative plus a `Context` opt-out** mirroring `core.multiPackIndex` — adds a
   config surface tsgit has no precedent for.

## Decision

User-ratified as recommended: **authoritative** (option 2). ADR-226's prime directive
binds hardest exactly where the brief got it wrong: with a stale midx the observable
answer is `missing`, and matching it is the point. The price is stated plainly: tsgit
begins returning `OBJECT_NOT_FOUND` for objects it finds today in repos where a midx
outlived its packs.

## Consequences

`lookup` consults the midx first; a hit on an unusable or vanished bound pack is a
miss for the whole registry, and the `.idx` loop is filtered to packs the midx does
not claim. `all()` keeps the on-disk `.idx` universe (git's enumeration universe,
Pin K). The `DUP` interop row asserts the stale-midx answer, so the behaviour is
pinned, not incidental.
