# 591 — Unreachable findings type from the recovered header

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (§D11 residual, Pin R) · **Refines:** ADR-588

## Context

git types an unreachable object from its recovered `<type> <size>\0` header; tsgit's
object cache types from a successful full parse. For an object whose header is
recoverable but whose body is wrong (size disagreement, truncated tree), git prints
`dangling tree/blob …` while the ADR-588 closure alone would report
`objectType: 'unknown'` (Pin R rows R7, R9, R10d). Both tools agree on id, verdict and
exit code; only the type label inside the finding differs.

## Options considered

1. **Close it — type from the header.** When the header is recoverable but the body
   parse fails, carry the header's type into the finding. Full finding parity on the
   three rows; the DC-10 discriminator already recovers the header, so the plumbing
   exists.
2. **Carry it — named residual.** Ship `'unknown'` on those rows, named in
   Out-of-scope; a known divergent cell of the same shape DC-8 and DC-10 were ruled
   against.

## Decision

User-ratified option 1: type from the recovered header, matching git's semantics.

## Consequences

The object cache retains the header-recovered type when the body parse fails; the
`'unknown'` classification is reserved for objects whose header itself is
unrecoverable, exactly as git reserves it. Three test rows flip expectation from
`'unknown'` to the real type; the header-type retention path gains its own rows.
