# 599 — INVALID_MULTI_PACK_INDEX carries a closed check discriminant

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-8) · **Refines:** ADR-575's
  allow-list discipline (no message re-parsing, no `catch {}`)

## Context

The tier mapping of ADR-593 needs to know *which* parser gate fired, and only the
parser knows. Reusing `INVALID_PACK_INDEX` is an active hazard: `isSkippableIdxFault`
allow-lists that code at the scan layer, so a midx parse failure would be silently
classified as a per-pack `.idx` fault and could exclude an innocent pack from the
generation.

## Options considered

1. **New `INVALID_MULTI_PACK_INDEX { reason, check }`** with `check` a closed union
   naming the gate (`size` | `signature` | `version` | `base-files` | `hash-version`
   | `chunk-table` | `required-chunk` | `fanout` | `chunk-length` | `pack-names` |
   `pack-int-id` | `large-offset`).
2. **Reuse `INVALID_PACK_INDEX { reason }`** — the mis-classification hazard above.
3. **New code with `reason` only** — the tier table would key on message text or a
   duplicated check-order; a parser change could silently re-tier a fault.

## Decision

Adopted as recommended: **option 1**. The `check` union makes ADR-593's tier mapping
exhaustive at the type level. Its price is stated: `check` is public surface in
`api.json`, so its members are a compatibility commitment.

## Consequences

`src/domain/storage/error.ts` gains the code and the `MidxCheck` union;
`midx-source.ts` owns the total `MidxCheck → tier` function; tests assert
`.data.check` and `.data.reason` via try/catch, never bare `toThrow`.
