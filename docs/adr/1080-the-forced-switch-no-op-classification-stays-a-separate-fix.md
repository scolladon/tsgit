---
subjects:
  - src/application/commands/checkout.ts
  - src/application/primitives/materialize-tree.ts
---
# 1080 — The forced switch's no-op classification stays a separate fix

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC6, O4) · **Supersedes/Refines:** refines ADR-226

## Context

`checkout -f HEAD` leaves every occupant shape in place, while git 2.55 replaces it with HEAD
content. The design-time probe proved this happens before the apply is reached. The forced switch
passes `force` without `forceRewriteAll`, so `computeChangeset` classifies every path `noop` and
`splitWaves` drops it. On the same shapes, `reset --hard HEAD` and `checkout -- <path>` do reach
the apply.

## Options considered

1. **Keep it separate, as the next fix.** The defect is in classification (git's one-way reset
   rewrites an entry whose stat is stale), not in displacement. It builds on ADR-1075.
2. **Widen this change to the forced-switch classification.**

## Decision

**Adopted as recommended (no user judgment): option 1.** The brief allows widening only if the
probe proves the same defect on the same path. The probe proved the opposite.

## Consequences

- The forced-switch rows stay out of this change's interop pins.
- The next fix relies on ADR-1075's displacement for its S1, S3c and S3d shapes.
