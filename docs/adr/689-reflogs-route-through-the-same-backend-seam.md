# 689 — Reflogs route through the same backend seam

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-6) · **Refines:** ADR-686

## Context

Reftable stores reflogs **inside the stack**, not under `logs/`. `reflog-store.ts` and
`reflog-identity.ts` assume the files layout. Measured: a reftable repository has 3 reflogs that
tsgit reports as 0, and `updateRef` writes `.git/logs/...` entries git never reads.

## Options considered

1. **The same backend seam** as refs (design recommendation) — pros: one selection point, one
   place where "which storage" is answered; matches git, where the backend owns both / cons: the
   narrowed interface carries reflog verbs too.
2. **A separate reflog seam** — pros: smaller ref interface / cons: two backends to select and
   keep consistent, for one storage decision.
3. **Files-only reflogs, refused on reftable** — cons: leaves a measured read defect open under
   ADR-680, which implements the backend completely.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

Reflog read and write verbs live on the same backend-neutral `RefStore` of ADR-686.

## Consequences

- `reflog-store.ts` and `reflog-identity.ts` are re-expressed against the seam, not special-cased.
- The write-then-throw defect covered stray `logs/` writes as well as stray refs; routing both
  through one seam is what removes the whole class rather than half of it.
- Reflog encoding is one of the two places git's shipped spec contradicts its own bytes
  (`tz_offset` is raw `±HHMM`, not minutes) — the seam's reftable implementation follows the
  measured bytes.
