---
subjects:
  - test/integration/fsck-worktree-private-refs-interop.test.ts
  - test/integration/fsck-broken-ref-chain-interop.test.ts
---
# 1162 — the worktree interop rows live in their own suite

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1152

## Context

The pinned rows need several linked worktrees created in a set order, hand-made admin
directories, and `files`/`links`/`restricted` keyed by gitdir-relative path, from the main or
a named linked working directory. The existing suite
`test/integration/fsck-broken-ref-chain-interop.test.ts` (about 1460 lines) seeds one linked
worktree and rebuilds the `worktrees/wt/` prefix itself (`shownRef`), which ADR-1152 retires.
Its `printedPath` prints every linked-admin path absolute, which is wrong from the main
working directory for walk paths (A11, A13, B5, B6, P10).

## Options considered

1. **A new suite with a multi-worktree seeder, plus the minimal harness edits to the old one**
   — pros: the old suite stays readable; the seeder fits the rows / cons: two fsck ref suites.
   The designer's recommendation.
2. **Extend the old suite** — cons: a second seeder inside an already long file; every linked
   row there changes names anyway.

## Decision

**Adopted-as-recommended (no user judgment) — no trade-off beyond mechanics: option 1.**
`test/integration/fsck-worktree-private-refs-interop.test.ts` holds the rows of this design,
with every `openRepository`/`createNodeContext` tracked through
`test/integration/repository-lifecycle.ts`. The old suite drops `shownRef`, and its
`printedPath` follows git's spelling: absolute from a linked working directory; from the main
one, relative except a linked store's root-ref paths.

## Consequences

- Content and walk lines are compared as a sorted multiset, pointer lines in sequence; the
  die rows compare the whole multiset so a lost store shows.
- Order-dependent rows derive the expectation from git on the same throwaway (ADR-1157).
