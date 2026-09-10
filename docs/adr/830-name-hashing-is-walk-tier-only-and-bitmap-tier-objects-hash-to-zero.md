---
subjects:
  - src/application/commands/pack-objects.ts
---
# 830 — Name hashing is walk-tier only; bitmap-tier objects hash to zero

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-5)

## Context

`packObjects` has two closure tiers. The walk tier enumerates through `walkTree` and knows every
object's path; the bitmap tier reads a reachability bitmap and knows only object ids. Name
hashing needs a path, so the bitmap tier cannot produce one from what it reads today.

Git has the same split and the same answer: without a name-hash cache it has no hash for a
object read from a bitmap either. Its bitmap format carries an optional hash cache — `BITMAP_OPT_HASH_CACHE`,
flag `0x4` — that stores one hash per object, and git fills `oe->hash` from it when present.
tsgit's bitmap reader checks only the `FULL_DAG` flag and does not parse that extension, and
tsgit writes no bitmaps at all.

The path this entry measures — gc — is walk-tier by pin, so the bitmap tier does not affect the
numbers either way.

## Options considered

1. **Walk tier only; bitmap-tier objects hash to `0`** (chosen) — pros: exactly what git does for a bitmap without a hash cache; no format work, no new pin; the measured path is unaffected / cons: a bitmap-tier pack keeps today's size ordering and misses the clustering gain.
2. **Parse the `.bitmap` name-hash cache** — pros: faithful to git-with-a-cache, and a contained parser extension / cons: a bitmap-format feature with its own pin, helping only git-written bitmaps read by tsgit, exercised by no corpus in this entry.
3. **Force the walk tier whenever delta emission is on** — pros: every delta-emitting pack gets hashes / cons: changes `packObjects`' pinned default tier and the fewer-objects semantics of a bitmap closure with haves, trading a documented default for a size gain on one command.

## Decision

**User-ratified.** Objects enumerated through the bitmap tier carry no name hash, which the
comparator reads as `0`. The tier default is unchanged and no bitmap-format work is undertaken.

A zero hash is a real value in the ordering, not a sentinel for "unknown": a whole-bitmap-tier
pack has every object at hash `0` and therefore falls through to the size term, which is exactly
today's ordering.

## Consequences

The gc path takes the full gain and `packObjects`' bitmap default is untouched, so no pinned
behaviour changes for the command whose tier this is.

A bitmap-tier pack is ordered as it is today and is larger than a walk-tier pack of the same
objects. That asymmetry is git's too, and it strengthens rather than weakens the existing rule
that a `packId` must never be compared across tiers.

Parsing the hash cache stays available as a contained follow-on: it needs the bitmap reader to
learn one more flag and would slot in behind the same comparator with no ordering change.
