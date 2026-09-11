---
subjects:
  - src/application/commands/push.ts
---
# 842 — push drops negatives it does not hold before computing the closure

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-7) · **Supersedes/Refines:** none

## Context

`push` moves from its own enumerator to `computeClosure({ wants, not: haves, objects: true })`.
The remote's advertised tips include commits the local repository may not have, and ref-creation
sentinels are zero oids. The closure's not-side marker reads every `not` and refuses an absent one
— the correct behaviour for `rev-list ^x` and `pack-objects`, where an absent negative is a user
error git refuses. git's `send-pack` `feed_object` drops a negative the local object store does
not hold before it ever reaches `pack-objects`.

## Options considered

1. **A `hasObject` pre-filter in `push`** (recommended, chosen) — pros: the rule sits where git puts it; `computeClosure` stays strict for every other caller / cons: one bounded membership pass per push over the distinct haves.
2. **An engine-level tolerance in the not-side marker** — cons: weakens the closure for callers whose absent negative is a genuine error.

## Decision

**Adopted-as-recommended (no user judgment).** `push` filters the distinct haves through
`hasObject` under the I/O-bound pool and passes only the present ones as `not`. `hasObject` never
triggers a promisor fetch, as git's local-only probe does not.

## Consequences

Zero-oid sentinels and tips absent locally fall out without a membership set; locally present
ancestors become real negatives. The pushed object set shrinks from "everything reachable from the
wants" to git's `wants AND NOT haves`, and the not-side commit walk is total (a pre-existing engine
trait, documented at the marker) rather than git's slop-limited walk.
