---
subjects:
  - src/application/primitives/internal/blob-source.ts
---
# 929 — Ref-update object verification reads the type before choosing an order

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-17) · **Supersedes/Refines:** refines ADR-928

## Context

git's `parse_object` reads the object's type first, then streams a blob (stream order, ADR-928)
and reads anything else in-core. tsgit's `verifyStoredObject` must pick the same order for the
same faults to refuse the same ref updates (Pin M5).

## Options considered

1. **git's exact sequence: header-only type read, then stream order for a blob, in-core otherwise** (recommended).
2. **Decide inside `locateStream` at the first copy found** — saves the separate read, but the order is no longer git's.

## Decision

**Adopted-as-recommended (no user judgment) — option 1**, by ADR-226 and ADR-928.

## Consequences

- One extra header-only read per ref update.
