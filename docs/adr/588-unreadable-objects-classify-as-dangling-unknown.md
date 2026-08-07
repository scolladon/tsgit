# 588 — Unreadable objects classify as dangling unknown in connectivity-only mode

- **Status:** accepted (user-ratified, deviates from the design's recommendation)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-8) · **Refines:** ADR-226

## Context

git's `--connectivity-only` mode enumerates a refused pack's ids and reports each as
`dangling unknown <oid>` (Pin M7); tsgit reports nothing, because `collectTypeFindings`
skips null-cache entries and `FsckFinding['dangling'].objectType` has no `'unknown'`
member. The exit codes already agree; only the findings differ. The divergence became
reachable because of 28.1 (a v99 pack used to be read as v2), but it predates this
change for unreadable loose objects.

## Options considered

1. **Close it fully** — widen `dangling`/`unreachable` `objectType` to include
   `'unknown'` and stop skipping null-cache entries; exact parity in all three modes;
   also makes any unreadable loose object produce `dangling unknown`, which needs its
   own git pins.
2. **Leave it, name it** (designer's recommendation) — an unreadable-object
   classification question, not a pack-accessibility one; ships one known divergent
   cell.
3. **Close it only for inaccessible packs** — a special case keyed on pack health
   inside the classifier.

## Decision

User-ratified option 1, overriding the recommendation: close it fully. Shipping a known
divergent cell in a mode this feature otherwise makes faithful contradicts both the
prime directive and the no-follow-ups directive. The loose-object rows this widening
newly affects must be pinned against real git in this change (the design revision adds
those pins).

## Consequences

`FsckObjectType` gains `'unknown'` for the dangling/unreachable classification —
a public type widening with its own `api.json` and doc deltas. The design doc is
revised to pin git's `dangling unknown` behaviour for unreadable loose objects, and the
test matrix gains those rows.
