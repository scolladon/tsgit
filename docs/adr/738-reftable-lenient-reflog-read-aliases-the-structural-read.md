# ADR-738: Reftable lenient reflog read aliases the structural read

## Status

Accepted (at `fc54f8cd`) — adopted-as-recommended (no user judgment)

## Context

"Malformed line" has no reftable analogue: log records are length-prefixed binary
inside a block, so a damaged record damages the block, not one entry. The reftable
backend's `readReflog` already skips non-entry records. Alternatives: (b) invent a
per-record tolerance (skip a log record that fails to decode) with no git
counterpart to pin against; (c) throw `unsupported` for the lenient verb on
reftable, which would re-break gc under reftable — the defect ADR-737 closes.

## Decision

The reftable backend implements `readReflogLenient` as an alias of its structural
`readReflog`, with the reasoning recorded in the method's doc comment.

## Consequences

### Positive

- gc's retention walk works identically on both backends.
- No invented tolerance without an oracle.

### Negative

- None identified.

### Neutral

- If a future git defines per-record reftable log tolerance, this alias is the one
  place to revisit.
