# ADR-739: Lenient reflog reads extend to every pinned reader

## Status

Accepted (at `fc54f8cd`) — ratified by the user

## Context

The backlog brief scopes the change to the `reflog` command. The pinned matrix
(design doc §1b, git 2.55.0) shows git reads reflogs leniently in every consumer:
`rev-parse ref@{n}`/`@{date}` resolves across a malformed line (with a stderr gap
warning tsgit does not reproduce — warnings are rendering, ADR-249), `stash
list`/`apply`/`drop` skip it, and stash-oriented snapshot reads index over the
surviving entries. Leaving those strict ships a repo where `reflog show` works and
`stash list` throws on the same corrupt file. Alternatives: the command only (the
literal brief); or additionally flipping fsck's non-strict arm, which changes which
roots fsck reports — an independent question with its own oracle.

## Decision

The lenient read (ADR-737) replaces the strict read in: `commands/reflog.ts`
(show/delete/expire), `commands/rev-parse.ts` (`@{n}`/`@{date}` resolution),
`primitives/stash-ref.ts` (all three read sites), and
`primitives/snapshot/snapshot-factory.ts`. `branch.ts` is governed by ADR-740.
fsck's arms are untouched. No other reader moves.

## Consequences

### Positive

- One behaviour across every user-facing surface git is lenient on; `@{n}`
  numbering counts survivors everywhere, matching git.

### Negative

- Wider diff than the literal brief; each moved reader needs its own parity
  assertion.

### Neutral

- fsck's strict arm keeps throwing internally (caught upstream) — its root set is
  unchanged.
