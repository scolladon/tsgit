# 572 — Local pack-open gate sits in lookup, at the idx hit

- **Status:** accepted
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** refines ADR-226 (applies the prime directive to local pack open)

## Context

tsgit's local read path never inspects a pack's 12-byte header, so packs of any version
are parsed as v2 where git refuses them at first open. Git's `is_pack_valid` runs inside
the pack-lookup loop — after the `.idx` claims the object, before the claim is honoured —
so a bad pack whose index never claims a requested object is never opened at all (Pin C1),
and the refusal is re-evaluated per request with no negative cache (Pin C5).

## Options considered

1. **In `lookup()`, between the idx hit and the returned hit** (designer's recommendation) —
   pros: reproduces every Pin C row exactly, including C1 laziness / cons: `registry.all()`
   consumers (`enumerateObjects` → `fsck --full`) stay ungated, so tsgit's fsck lists a
   refused pack's objects then misses on read where git reports the pack inaccessible.
2. **Eagerly in `loadPack()` during the idx scan** — pros: `all()` and `lookup()` consistent,
   closes the fsck gap with one mechanism / cons: diverges from Pin C1 by probing packs git
   never touches; one extra read per pack per scan.
3. **At the pack-file touch points (`offsetTable()` / handle memo)** — pros: fires on the
   first byte actually read / cons: refusal arrives after `lookup` answered, so mapping it
   to git's "missing" spreads one policy across two files.

## Decision

The gate is one awaited `header()` validation inside `PackRegistry.lookup`, between the
index hit and the returned hit — git's `is_pack_valid` position. `registry.all()` stays
ungated. The header memo clears on rejection so a refused pack is re-probed per lookup hit
(no negative cache), matching Pin C5.

## Consequences

Every Pin C row is reproduced structurally. The `fsck --full` enumeration gap is a known,
documented divergence: closing it requires gating `all()` and is deferred to a follow-up
backlog entry rather than a second mechanism in this change.
