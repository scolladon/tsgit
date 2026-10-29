---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/midx-binding.ts
  - src/application/primitives/internal/pack-miss-rescan.ts
supersedes:
  - adr: "592"
    scope: "a midx hit on an owner pack that cannot be opened is a miss for the whole registry"
---
# 1113 — a midx owner pack that cannot be opened is recovered on the second read

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F6, D-F6) · **Supersedes/Refines:** supersedes ADR-592 (the owner-unavailable branch only); refines ADR-226

## Context

git 2.56's 8f909ff ("packfile: recover when a multi-pack-index names a removed pack") makes
`midx_fill_entry` return a tri-state. When the midx names an owner pack that cannot be prepared
or is not valid, the regular fallback over midx-free packs runs as before, and then, only on the
second read (`OBJECT_INFO_SECOND_READ`), git scans every pack the midx binds across its layers and
serves the first copy it finds. A QUICK caller skips the second read and keeps the miss. Pinned on
2.56.0 against 2.55.0 with a blob in two midx-covered packs assigned to the newer one: deleting
that pack, deleting only its `.pack`, or making it unreadable now yields `<oid> blob 4` from
`cat-file --batch-check` and exit 0 from `cat-file -p` and `-e`, where 2.55.0 reported `missing`
and exited 128 and 1. ADR-592 made such a hit a miss for the whole registry.

## Options considered

1. **A registry operation reached only on the second-read path, after the reprepare retry
   missed; quick `hasObject` never reaches it** — pros: mirrors git's gate without widening the
   hot `lookup` signature / cons: the recovery lives beside the rescan rather than in `lookup`.
2. **A `secondRead` flag on `PackRegistry.lookup`** — pros: one entry point / cons: a boolean
   parameter on the hottest lookup.
3. **Scan on every owner-unavailable lookup** — pros: simplest / cons: diverges for QUICK
   callers and adds a per-lookup cost.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `findMidxHit` reports hit, miss or
owner-unavailable. On an owner-unavailable miss the first read still falls through to the
midx-free packs; the second read, after `reprepare()` has missed, scans the midx's bound packs in
`PNAM` order across layers, base layers first, through their already-loaded `.idx` lookups, and
serves the first hit. No registry teardown, no pack re-listing beyond the reprepare, no name-keyed
cache. Quick `hasObject` keeps the false negative, as git's QUICK does.

Superseded from ADR-592: a midx hit on an owner pack that cannot be opened is a miss for the whole
registry.

Carried forward from ADR-592: the midx is consulted first; a pack it names is served through it;
the `.idx` loop is filtered to packs the midx does not name; a `PNAM` entry that resolves to no
pack drops out of the midx's universe.

## Consequences

- The midx interop rows that pinned `missing` on a removed owner now pin the read, and the
  "documented divergence" row is re-judged as agreement.
- The recovery costs one `.idx` lookup per bound pack, only on an owner-unavailable second read.
