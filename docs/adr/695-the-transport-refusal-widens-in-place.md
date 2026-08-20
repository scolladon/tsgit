# 695 — The transport refusal widens `UNSUPPORTED_OBJECT_FORMAT` in place

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D4) · **Refines:** ADR-681

## Context

`UNSUPPORTED_OBJECT_FORMAT { format }` already exists, and its documentation row —
*"tsgit only supports sha1 repositories"* — is falsified by ADR-681. A fetch or clone between a
SHA-1 and a SHA-256 peer must still refuse, because git itself has no conversion.

## Options considered

1. **Widen the existing code in place, plus one new code for the push direction** (design
   recommendation) — pros: no breaking removal; the code's meaning becomes "this peer's format is
   not one we can work with here" / cons: an existing docs row must be rewritten.
2. **One code for both directions** — cons: erases which side refused, which is the actionable
   part for a caller.
3. **Two fresh codes and remove the old one** — cons: a breaking removal for no behavioural gain.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`UNSUPPORTED_OBJECT_FORMAT` is widened and re-documented; one new code covers the push direction.

## Consequences

- The falsified docs row in `docs/use/errors.md` is corrected in this change — it is a
  documentation defect the moment ADR-681 lands, not a follow-up.
- No public code is removed, so no consumer breaks.
- The mismatch refusal is a transport concern and sits outside ADR-682's acceptance tier: both
  repositories are individually acceptable; only the pairing is not.
