# 587 — This change claims accessibility only, not pack-body verification

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-7) · **Refines:** ADR-226

## Context

git folds a full `verify_pack` — pack trailer checksum, per-object index CRC, an
inflate of every object — into the same exit bit 4 (Pin N). Accessibility is a subset
of git's bit-4 surface. The no-follow-ups directive for this change means the boundary
must be drawn deliberately, not deferred.

## Options considered

1. **Accessibility only** (designer's recommendation) — the header gate and whether
   the index opens, exactly what the registry already computes; zero new parsing.
2. **Plus the pack trailer checksum** — turns the O(packs) probe into O(pack-bytes) on
   every fsck, the trade 28.1 declined for the read path.
3. **Full `verify_pack`** — complete bit-4 parity; a different feature by size,
   overlapping the content-validation pass that already inflates every object.

## Decision

User-ratified option 1: accessibility only. Pack-body integrity verification is a
distinct capability tsgit has never had (a `git verify-pack` analogue), not a deferred
slice of this feature — the residual is recorded in the design's Out-of-scope section
as a capability boundary, not as follow-up work from this change.

## Consequences

A pack that is accessible but internally corrupt (flipped body byte) still reads as
healthy to `fsck` where git reports bit 4 — a named capability boundary, discoverable
by anyone reading the design doc, with no pending work item attached.
