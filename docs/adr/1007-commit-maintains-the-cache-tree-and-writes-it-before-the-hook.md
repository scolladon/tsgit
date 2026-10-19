---
subjects:
  - src/application/commands/commit.ts
  - src/domain/git-index/cache-tree-update.ts
  - src/application/primitives/internal/update-cache-tree.ts
  - src/application/primitives/internal/index-lock.ts
---
# 1007 — commit maintains the cache-tree and writes it into the index before the pre-commit hook

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** applies ADR-226; refines ADR-964 for `commit`

## Context

tsgit `commit` rebuilt every tree from the index on each call and never wrote the index back, so it never wrote a `TREE` extension (design §Evidence: 3/3 probe runs). git's `prepare_index` runs `cache_tree_update(WRITE_TREE_SILENT)` and writes the index before the pre-commit hook and the emptiness and message refusals (design §D1.1–§D1.2). On a 500-directory repository at least 35% of a one-file commit is work over every tree that a valid cache-tree skips.

## Options considered

1. Keep rebuilding every tree and write no `TREE`: the current defect.
2. Port git's `update_one`: reuse a valid node whose object exists, rebuild invalid ones, write the index before the hook (recommended).

## Decision

**Adopted-as-recommended (no user judgment)**, under ADR-226. `commit` takes the index lock, updates the cache-tree in write mode, and writes the index before the pre-commit hook and the nothing-to-commit and empty-message refusals, so a refused commit still leaves the updated `TREE`. An unmerged index refuses before any write. Subtrees are ordered by name length, then bytes (`subtree_name_cmp`). `entry_count` counts the index entries a directory covers, recursively. **User-ratified fold:** intent-to-add entries are left out of their tree, and their directory chain is marked invalid while its trees are still written, as git does (pins C7, I1; tsgit committed them, pin T2). After the hook, the index is re-read and the cache-tree updated in memory only.

## Consequences

- `TREE` bytes after `commit` equal git 2.55's. A cross-tool interop test pins the bytes and the rewrite decision row by row.
- Commit tree oids change only for indexes holding intent-to-add entries.
- `commit` can now refuse with `RESOURCE_LOCKED` when another writer holds `index.lock`, as `git commit` does.
- The pre-commit hook sees git's order: the index is written first and the lock released.
