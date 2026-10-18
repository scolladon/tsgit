---
subjects:
  - src/application/primitives/internal/index-lock.ts
  - src/domain/git-index/carry-extensions.ts
  - src/application/primitives/internal/update-cache-tree.ts
  - src/application/commands/stash.ts
supersedes:
  - { adr: "964", scope: "unpack_trees-class writers leave changed chains invalid where git recomputes the cache-tree" }
---
# 1009 — Replace writers repair the cache-tree as unpack_trees does

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** supersedes ADR-964 (divergence clause only)

## Context

ADR-964 left changed chains invalid after `unpack_trees`-class writers, which are equal to git's output under readback but not byte-identical, and deferred the byte-exact form to this work. Pins U1–U21, R1, S1–S4 and Q3 (design §D1.3–§D1.4) show one rule covers every replace writer: `TREE_after = invalidate(repair(invalidate(TREE_before, changedPaths), entries), restagedPaths)`. REPAIR hashes each invalid node without writing it, and the node is valid iff that object exists. Priming from the target tree would be wrong (R1).

## Options considered

1. Keep ADR-964's divergence.
2. Prime from the target tree (`prime_cache_tree`): wrong on R1.
3. git's REPAIR rule for every `'replace'` write (recommended).

## Decision

**Adopted-as-recommended (no user judgment)**, under ADR-226. Every `'replace'` index write produces git's `TREE` bytes by the rule above. `repair` treats a directory holding an unmerged or intent-to-add entry as invalid, along with its ancestors. Without a previous `TREE` (clone, worktree add), `repair` covers every directory. In-place (`'update'`) writers keep ADR-964's chain invalidation, including mixed `reset` (U5, U6).

Superseded from ADR-964: the named divergence that `unpack_trees`-class writers leave changed chains invalid where git recomputes.

Carried forward from ADR-964: chain invalidation for in-place writers, dropping an unparseable carried `TREE`, and digest-width serialisation.

## Consequences

- The interop rows for replace writers move from "every valid node carries git's oid" to byte equality.
- A checkout now hashes every changed directory, which is a small cost measured separately from the checkout write-path change.
