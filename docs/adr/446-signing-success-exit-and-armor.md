# 446 — Signing success is exit-0 plus a well-formed armor block

- **Status:** accepted
- **Date:** 2026-07-03
- **Design:** docs/design/gpg-signing.md · **Relates:** ADR-407 (CommandRunner), ADR-442 (signer reuse)
- **Decision class:** D-mechanism (adopted-as-recommended, no user judgment)

## Context

git detects signing success by parsing the signer's status output (`SIG_CREATED` on
`--status-fd`). `CommandRunner` (ADR-407) captures stdout and the exit code but not stderr,
and git writes its status lines to the status-fd (stderr in our argv). Adding captured
stderr to the port purely to parse `SIG_CREATED` would widen the port for one consumer.

## Options considered

1. **Exit-0 + well-formed armor on stdout** *(design recommendation)* — treat signing as
   successful iff the process exits 0 **and** stdout contains a valid armor block
   (`-----BEGIN … SIGNATURE-----` … `-----END … SIGNATURE-----`). No port change.
2. **Extend `CommandRunner` with captured stderr** and parse `SIG_CREATED`.
3. **Exit-0 only** — trust the exit code alone; risks accepting empty output.

## Decision

**Option 1, adopted as recommended (no user judgment).** A signature is accepted only when
the process exits 0 and stdout carries a well-formed armor block; otherwise the operation
refuses atomically (nothing is written) per ADR-447's failure semantics. `CommandRunner` is
unchanged.

## Consequences

### Positive
- No port widening; the detector is a pure function of the two signals the port already
  exposes.
- Empty/garbage output on a zero exit is still rejected (armor well-formedness check).

### Negative
- We do not surface gpg's granular status codes; a failure yields a faithful generic
  "gpg failed to sign the data"-class error rather than the specific status line.

### Neutral
- If a future need for `SIG_CREATED` parsing arises (e.g. verification), extending the port
  remains open.
