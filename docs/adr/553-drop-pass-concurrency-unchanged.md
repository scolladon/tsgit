# 553 — Drop-pass concurrency stays at the existing bounded map

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

The brief proposed running the drop pass over N modified pairs through the existing
`BoundedReader` "instead of sequential awaiting". Checked against the code, the premise
is false: `applyDropPredicate` already runs `boundedMap(diff.changes,
MAX_CONCURRENT_OBJECT_LOADS = 32, …)`, and within a pair both blob resolutions and both
per-line digest advances are already under `Promise.all`. `createBoundedReader` is a
*per-id-deduped* semaphore built for commit walks; dedup is worthless here because every
blob id appears once.

## Options considered

1. **Unchanged** (designer's recommendation) — keep `boundedMap(changes, 32)`.
2. **Raise the bound** now that each unit is a cheap buffered read.
3. **Split bounds** — a higher bound for the buffered arm, 32 for the streaming arm.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. No change to the drop pass's
concurrency in this work.

## Consequences

32 is also what bounds peak buffered memory under ADR-549 (32 × 2 × 64 KiB compressed),
so raising it is not a free knob — it multiplies the accepted residual. Whether a higher
bound helps is a *measurement* to take after the per-unit cost changes, not a design
decision to take before: the buffered arm's cost is syscalls plus `inflateSync`, neither
of which scales past core count. Re-measure once the fast path lands; only then consider
option 2.
