# 600 — Dedicated midx size and chain-length bounds

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-9, T-3)

## Context

A midx is attacker-controllable bytes and must be read bounded (stat → read →
recheck, the `readBoundedIdx` shape). The existing `.idx` bound is 64 MiB
(`exceedsMaxPackIdxBytes`), but a midx over N objects is
`1024 + N·(digestLength + 8) + names` bytes — 64 MiB caps out around 2.3 M objects,
refusing exactly the many-pack repositories the feature exists for. The chain file
also needs a layer cap, or a million-line chain is a file-descriptor amplifier.

## Options considered

1. **Reuse the `.idx` 64 MiB bound; named chain cap** — refuses the target repo class.
2. **Size cap only, chain unbounded** — git has no cap, but T-3 does.
3. **New `MAX_MIDX_BYTES` + `MAX_MIDX_CHAIN_LAYERS`** in `primitives/validators.ts`
   beside the policy limits already there, with `REASON_*` strings following the
   house pattern.

## Decision

Adopted as recommended: **option 3**. Placed in `validators.ts`, not
`domain/engine-limits.ts`, whose doc-comment scopes it to limits the JavaScript
engine imposes rather than limits this library chooses.

## Consequences

Both bounds are named constants with reason strings; the midx read runs
stat-then-read-then-recheck against `MAX_MIDX_BYTES`; the chain loader caps the
leading hex-line run at `MAX_MIDX_CHAIN_LAYERS`. Exceeding either is a Tier-B
discard (bounds are tsgit policy, not git structure — git has no such refusal to
replicate).
