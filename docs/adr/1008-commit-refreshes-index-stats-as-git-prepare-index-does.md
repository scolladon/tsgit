---
subjects:
  - src/application/commands/commit.ts
  - src/application/primitives/internal/index-lock.ts
---
# 1008 — commit refreshes index stats and rewrites the index when they moved, as git does

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** refines ADR-1007

## Context

git's `prepare_index` calls `refresh_cache` before the cache-tree update and writes the index when either changed (`cache_changed || !cache_tree_fully_valid`). With `SKIP_IF_UNCHANGED` it writes nothing when neither changed. Pin CW2: with a fully valid `TREE`, a `touch b/f` makes `commit --allow-empty` rewrite the index with `b/f`'s stat refreshed. tsgit had no commit-time refresh.

## Options considered

1. Write only when `TREE` is not fully valid, and file the refresh as a follow-up (designer's recommendation).
2. Port the refresh as well, reusing the status refresh's stat comparison (`compareAndRefresh`), and write when stats or `TREE` changed.
3. Always rewrite the index.

## Decision

**User-ratified — option 2** (the designer recommended option 1). `commit` refreshes entry stats the way `refresh_cache` does, then writes the index iff a stat was refreshed or the cache-tree was not fully valid. It writes nothing when neither changed (CW1, CW3).

## Consequences

- One `lstat` per index entry per commit, which git also pays.
- The rewrite-or-not interop rows cover CW1–CW4, C4 and C5.
