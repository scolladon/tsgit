# ADR-746: Reflog results carry no skipped-line count

## Status

Accepted (at `fc54f8cd`) — adopted-as-recommended (no user judgment)

## Context

With lenient reads, the library could report how many malformed lines a read
skipped. git is silent about skipped lines in every command surface (the only
signal is rev-parse's stderr gap warning, which is rendering). A count is
structured data, so the structured-output charter permits it — but nothing
consumes it, and with expire rewriting unconditionally (ADR-743) no internal
consumer needs it either. Alternatives: a public `skippedLines` on the show
result; or an internal-only count on the seam verb's return.

## Decision

No skipped-line count anywhere: `ReflogResult` keeps its shape (modulo ADR-744's
`removed` change) and the seam verb returns entries only.

## Consequences

### Positive

- No speculative surface; the seam verb stays a plain entries read.

### Negative

- A caller wanting corruption diagnostics must diff a strict parse against a
  lenient one itself.

### Neutral

- Revisit only if a consumer materialises.
