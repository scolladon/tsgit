# ADR-222: `resolveOidPrefix` — abbreviated-oid resolution primitive

## Status

Accepted (at `b4faeceb`)

## Context

The bidirectional sequencer (ADR-218) requires tsgit to resume a *git-started*
range, whose `.git/sequencer/todo` carries **7-char abbreviated** oids. tsgit
currently has no abbreviated-oid resolution: `rev-parse` accepts only an exact
40-hex oid or a ref name. `git cherry-pick <short-sha>` arguments are abbreviated
too. Without prefix resolution, the git→tsgit direction is impossible.

## Decision

Add a primitive `resolveOidPrefix(ctx, prefix): ObjectId`:

- Scan **loose** objects (`<2-char dir>/<38-char file>`) and **pack** indexes
  (fanout-bounded) for object ids whose hex starts with `prefix`.
- **Exactly one** match → the full `ObjectId`.
- **More than one** → `ambiguousOidPrefix(prefix, candidates)` (new
  `AMBIGUOUS_OID_PREFIX` domain error; candidate list capped).
- **Zero** → `objectNotFound`.
- Accept prefix length 4–40 (git's `core.abbrev` minimum is 4); a full 40-hex is
  returned without scanning.

Consumed by `sequencer-state` (todo parsing), the `resolveCommitIsh` ladder
(abbreviated `cherry-pick` args), and — as a natural, near-free extension —
`rev-parse`'s `resolveBase` (so `rev-parse <short-oid>` now resolves).

## Consequences

### Positive

- Unlocks the git→tsgit resume direction and abbreviated-oid args; improves
  overall rev-parse faithfulness as a side effect.

### Negative

- Object enumeration on each call (no abbreviation cache in v1); acceptable —
  cherry-pick resume is not hot, and the loose/pack scans are bounded.

### Neutral

- `AMBIGUOUS_OID_PREFIX` carries a capped candidate list so a hostile near-
  collision cannot inflate the thrown error (mirrors other capped error payloads).
