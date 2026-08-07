# 574 — The local refusal reuses INVALID_PACK_HEADER verbatim

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** refines ADR-249

## Context

The local-open gate needs an error shape for a refused pack. Under ADR-573 the error
never reaches a caller — it is caught in `lookup` and forwarded to the logger — so the
question is what the gate throws internally and what the ingest path keeps throwing.

## Options considered

1. **Reuse `INVALID_PACK_HEADER { reason }` verbatim** (designer's recommendation) —
   identical to the ingest path; one condition, one representation. Pros: keeps the twin
   interop assertions symmetrical / cons: version not machine-readable.
2. **Extend to `{ reason, version? }`** — cheap, but adds an optional field nothing reads.
3. **New `UNSUPPORTED_PACK_VERSION { version, packName }` variant** — most expressive;
   touches the public `StorageError` union, the exhaustiveness test, and `reports/api.json`;
   worth it only if ADR-573 had chosen propagation.

## Decision

Adopted as recommended: reuse `INVALID_PACK_HEADER { reason }` with the observed version
named in `reason` (`unsupported version: expected 2 or 3, got N`). Per ADR-249 the
condition matches git; the wording is ours.

## Consequences

Zero public-surface delta. If a future change propagates pack faults to callers
(revisiting ADR-573), the discriminated-variant option should be re-evaluated then.
