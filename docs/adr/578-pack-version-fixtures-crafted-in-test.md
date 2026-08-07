# 578 — v3/v99 pack fixtures are crafted in-test, per tier

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** none

## Context

The tests need packs stamped with versions git never generates. Three provenance options
exist for those bytes.

## Options considered

1. **Crafted in-test, per tier** (designer's recommendation) — each tier mutates the pack
   its own baseline tool produced (unit: tsgit's `writeSyntheticPack`; interop: real
   `git repack`) by flipping the u32 BE at offset 4 and re-hashing the trailer with the
   context's hash. Pros: no opaque committed bytes; the manipulation is visible in the
   test that depends on it.
2. **Committed binary fixtures** — freezes a SHA-1 pack into the repo and hides the one
   manipulation the reader needs to understand.
3. **Always crafted from real git, all tiers** — makes the unit tier depend on a git
   binary, which `GIT_AVAILABLE` then gates out of the default run — the wrong tier for a
   domain guard.

## Decision

Adopted as recommended: crafted in-test, per tier. Trailer re-hashing takes its digest
length from the context's hash configuration, never a literal 20 (hash-width genericity,
Pin E).

## Consequences

The unit tier proves tsgit's own writer round-trips through the widened guard; the interop
tier proves the bytes git actually produces do. The v99 idx re-stamp recipe lives in the
interop test where it is used.
