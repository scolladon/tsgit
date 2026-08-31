---
subjects:
  - test/integration/tree-entry-bytes-interop.test.ts
---
# 756 — Tree byte-parity pins live in one interop suite

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (D9) · **Supersedes/Refines:** none

## Context

The parity matrix behind this work is one contract — what git accepts and refuses for a
tree entry's name bytes and mode bytes — observed through four consumers. The repo
already has three candidate homes: a tree suite, an fsck suite, and a corrupt-tree diff
suite that owns the literal tree-building helpers.

## Options considered

1. **One new suite claiming the tree write-surface, carrying every row across all four sites** — pros: the matrix cannot drift row by row / cons: duplicates a few helper lines.
2. **Split by surface — parse rows in the tree suite, fsck rows in the fsck suite** — cons: the byte-order-mark row gets written three times and drifts independently.
3. **Extend the corrupt-tree diff suite, reusing its helpers** — cons: that suite declares the *diff* surface and exists to document the merge-join's deliberately narrower refusals; parse-tier rows there would blur the distinction ADR-723 defends.

## Decision

**Adopted as recommended (no user judgment).** One new interop suite carries the whole
matrix and claims the tree write-surface. The write-surface audit treats coverage as a
list, so claiming a surface a second suite also claims aggregates rather than conflicts.
The literal tree-building helpers are copied rather than shared, so the diff suite's
declared surface stays what it says it is.

## Consequences

Every row in the matrix has exactly one assertion and one place to update. A future
tree-parity question extends this suite rather than choosing a home.
