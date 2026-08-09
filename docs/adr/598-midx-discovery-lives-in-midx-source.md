# 598 — Midx discovery lives in an internal midx-source primitive

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-7)

## Context

The chunked-format parser is domain code (`src/domain/storage/midx.ts`, sibling to
`pack-index.ts`). Discovery, flat-vs-chain precedence (Pin J) and chain assembly
(Pin I) are application-layer I/O with ~20 testable rows of their own.
`pack-registry.ts` is already 548 lines carrying two skip layers, a handle lifecycle
and a health memo.

## Options considered

1. **Fold precedence/chain into `pack-registry.ts`** — one more concern in a file
   already at the size limit's edge.
2. **New `src/application/primitives/internal/midx-source.ts`** owning discovery,
   precedence and chain assembly; the registry consumes a `MidxLoadResult`.
3. **Everything in `pack-registry.ts`** including the parser — puts domain parsing in
   the application layer; the dependency rule forbids it.

## Decision

Adopted as recommended: **option 2**. `internal/` already holds exactly this class of
building block (`promise-memo`, `bounded-map`, `bounded-reader`).

## Consequences

`midx-source.ts` is separately unit-tested over the memory adapter (Pin I/J as a
table, with fs-call ledger assertions for the never-read-the-chain rows). The
registry's integration surface is one field on `PackGeneration` produced inside the
same scan memo.
