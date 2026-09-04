---
subjects:
  - src/application/primitives/internal/index-pack.ts
  - src/application/primitives/internal/pack-records.ts
  - src/application/primitives/fetch-pack.ts
---
# 787 — The indexer splits an I/O module from a pure record store

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-9) · **Supersedes/Refines:** none

## Context

`fetch-pack.ts` is 1 036 lines against this repository's 800-line ceiling, and this change adds
more than it removes. The new work also contains a genuinely pure component — a typed-array
record store with two sorted child indexes — sitting inside an otherwise I/O-bound module.

## Options considered

1. One new module, `internal/index-pack.ts`.
2. **Two** (recommended): `internal/index-pack.ts` for the passes and I/O, plus
   `internal/pack-records.ts` for the record store and child indexes, pure and I/O-free.
3. Keep everything in `fetch-pack.ts`.

## Decision

**Option 2.** The record store and its two child indexes live behind a pure boundary; the passes,
the byte sources and the refusals live in the indexer module; `fetch-pack.ts` keeps negotiation,
the quarantine lifecycle, `fetchPack`/`materializePack` and `verifyPackTrailer`.

The byte-source seam moves **with the indexer**, not with the receiver: it exists to feed the
walk, and moving only the pipeline would leave `fetch-pack.ts` on the ceiling rather than under
it. Option 3 is not available for that reason. Option 1 is smaller but folds a pure data
structure into an I/O module and loses the property-test lens the store naturally takes — a
store/lookup round-trip and two compositional matchers.

## Consequences

`walkQuarantinedEntries` becomes a call into the indexer module; `bundle-verify.ts` and the
`fetch-pack` unit tests re-point their imports, including roughly ten references to
`DISK_WALK_WINDOW_BYTES`, which moves with the disk source. Neither new module is coverage-gated
— the 100 % gate covers `domain/` and `adapters/` — so mutation is the gate that will notice if
their tests are weak, and they are written to that standard deliberately.
