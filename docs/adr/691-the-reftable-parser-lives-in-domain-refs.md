# 691 — The reftable parser lives in `domain/refs/reftable/`

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DC-8)

## Context

The reftable parser and serializer are pure binary codecs with no platform dependency, so they
belong in `src/domain/`. Which subtree is the question: `domain/refs/` already holds
`packed-refs.ts`, while `domain/storage/` holds the other binary codecs (`pack-index.ts`,
`rev-index.ts`, `pack-entry.ts`).

## Options considered

1. **`domain/refs/reftable/`** (design recommendation) — pros: grouped by what it models (refs),
   beside `packed-refs.ts`, the other ref-storage codec / cons: splits binary codecs across two
   subtrees.
2. **`domain/storage/`** — pros: all binary codecs together / cons: `domain/storage/` is object
   storage; a ref codec there is grouped by encoding rather than by domain.
3. **Its own top-level domain subtree** — cons: a third home for one format.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`src/domain/refs/reftable/`, beside `packed-refs.ts`.

## Consequences

- Cohesion follows the domain concept, not the file encoding — the house rule for `src/domain/`.
- 100% line/branch/function coverage and a zero-survivor mutation result apply, since
  `src/domain` is inside the coverage scope.
- The directory holds several modules (header, block codecs, stack, writer, compaction) rather
  than one file, keeping each within the file-size guidance.
