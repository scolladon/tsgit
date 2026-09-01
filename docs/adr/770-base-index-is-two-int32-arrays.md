---
subjects:
  - src/domain/storage/delta-encode.ts
---
# 770 — The base index is two Int32Arrays over fixed blocks

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-4)

## Context

Finding copy sources means indexing the base by fixed-size block hash. That index sits on the
path this design must prove deterministic, so its iteration order is not a free choice.

## Options considered

1. **Two `Int32Array`s** — a `heads` table plus a `next` chain over fixed 16-byte blocks (chosen) — pros: iteration is an array walk, trivially deterministic; about `base.length / 2` bytes; no per-block allocation; git's own shape / cons: two parallel arrays are less readable than a map.
2. **`Map<number, number[]>` keyed by block hash** — pros: readable / cons: four to six times the memory, and puts a `Map` on the exact path that must be proven order-stable.
3. **Index one window member at a time** — pros: constant index memory / cons: rebuilds the index once per candidate instead of once per window admission, discarding the point of a sliding window.

## Decision

**User-ratified.** The index is a `heads` `Int32Array` sized to the hash table plus a `next`
`Int32Array` sized to the block count, both filled with an explicit end-of-chain sentinel.
Lookup walks the chain in index order. No hash-keyed container appears anywhere in the
selection path.

## Consequences

Determinism is structural rather than argued: there is no container whose iteration order a
reviewer must reason about. Memory is a fixed fraction of the base size, so the residency
formula stays closed-form. Switching to a map later would reopen this record.
