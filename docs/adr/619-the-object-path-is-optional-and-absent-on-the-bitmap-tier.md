# 619 — The object path is optional, and absent on the bitmap tier

- **Status:** accepted (ratified — resolves a design escalation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (E-2) · **Refines:** ADR-613, ADR-616, ADR-618

## Context

`rev-list --objects` associates a path with each tree and blob. A bitmap **cannot supply
one**: it encodes reachability over pack positions and carries no names. Measured on a
367-object fixture, git's bitmap tier emits **0** name-carrying lines against the walk's
**127** — git simply prints bare object ids when the bitmap answers. The name-hash cache
extension is delta-selection data, not a path source.

This is the point at which the acceleration story could have collapsed: if every `--objects`
result must carry a path, no bitmap can ever serve `--objects`.

## Options considered

1. **`path` optional, absent on the bitmap tier** — exactly git's behaviour / the result type
   is no longer total, so consumers must handle its absence.
2. **`path` always present** — uniform, total result / the bitmap can then never serve
   `--objects`, only `--count` and `pack-objects`.
3. **Bitmap, then tree-walk for names** — uniform *and* accelerated / walking trees for names
   costs more than the walk the bitmap replaced; strictly slower than either alternative.

## Decision

Option 1. The structured entry carries an object id and a type always, and a **path
optionally**. The walk tier populates it; the bitmap tier does not. This reproduces git
exactly on both tiers.

Under ADR-618 this is invisible by default — `rev-list` walks unless the caller opts into the
bitmap — so the optional field is only ever empty for a caller who explicitly chose the tier
that cannot fill it. `pack-objects` never needs a path at all, since ADR-614 excludes delta
compression permanently.

ADR-616's equality obligation is restated in terms of this decision: the two tiers are
compared on **object id and type**, never on path.

## Consequences

The result type is not total in its path field, and the documentation page must say plainly
which tier populates it and why. A consumer that requires paths must not opt into the bitmap
tier; that requirement is expressed in the option's own doc-comment rather than enforced by
a refusal, matching git, which likewise leaves the choice to the caller.
