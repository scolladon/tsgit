---
subjects:
  - src/application/primitives/internal/update-cache-tree.ts
---
# 1010 — A valid cache-tree node is reused on an existence check, without freshening

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** applies ADR-226

## Context

git's `update_one` reuses a valid node iff `odb_has_object` finds it, and does not freshen it. Only rebuilt nodes go through `odb_write_object`, which freshens on a hit. tsgit's commit freshened (`utime`) every tree on every commit: 17.3% of the 500-directory commit profile.

## Options considered

1. Existence check only, no `utime` (recommended).
2. Freshen reused subtrees too, keeping today's mtimes.
3. Freshen the root only.

## Decision

**Adopted-as-recommended (no user judgment)**, under ADR-226: option 1.

## Consequences

- The mtimes of reused tree objects stop moving on commit, as with git.
- The design's main commit saving comes from this decision together with ADR-1007.
