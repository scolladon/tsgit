# ADR-745: Reflog rewrite serializer always emits the message TAB

## Status

Accepted (at `fc54f8cd`) — adopted-as-recommended (no user judgment)

## Context

git has two reflog writers with two rules (measured, design doc §1d): the append
writer omits the TAB for an empty message (`update-ref` with no `-m` writes a
tab-less line), while the expire/delete rewrite writer always emits it — the same
entry gains a trailing TAB after `reflog expire --expire=never`.
`serializeReflogLine` implements the append rule and is pinned by
`reflog-writers.test.ts`. Alternatives: change `serializeReflogLine` to always
emit the TAB (breaks the pinned append bytes); or record the divergence
(unavailable — the tab-less line is reachable through tsgit's own writers, so the
rewrite path would provably diverge).

## Decision

`applyReflogReplace` uses a rewrite-specific serialization that always emits the
TAB, leaving `serializeReflogLine`'s append behaviour untouched.

## Consequences

### Positive

- Both git writer rules encoded honestly; byte parity on both surfaces.

### Negative

- Two serialization paths to keep in sync for every other field.

### Neutral

- ~3 lines of mechanism.
