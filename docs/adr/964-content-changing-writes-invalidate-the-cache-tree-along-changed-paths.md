---
subjects:
  - src/domain/git-index/cache-tree.ts
  - src/domain/git-index/carry-extensions.ts
  - src/application/primitives/internal/index-lock.ts
---
# 964 — Content-changing writes invalidate the cache-tree along changed paths

> Superseded in part by ADR-1009: unpack_trees-class writers leave changed chains invalid where git recomputes the cache-tree. Chain invalidation for in-place writers still stands.

- **Status:** superseded by ADR-1009
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** diverges from ADR-226 for `unpack_trees`-class writers

## Context

Every tsgit index write dropped the `TREE` (cache-tree) extension, so one `tsgit add` destroyed git's
cache-tree. git changes `TREE` in two ways (§D1.5): in-place writers (`add`, `rm`, `mv`, `reset <paths>`,
`checkout -- <paths>`) invalidate the ancestor chain of every entry they replace
(`cache_tree_invalidate_path`); `unpack_trees`-class writers (`checkout <branch>`, `reset --hard`, merge,
cherry-pick, rebase, stash) and `commit` recompute it fully (`cache_tree_update`).

## Options considered

1. **Drop `TREE`** — today. No regression, keeps the defect.
2. **Generic ancestor-chain invalidation in the commit path** — the same rule for every writer, derived
   from the before/after entry diff (recommended).
3. **Per-writer transcription** — chain invalidation plus full recomputation for the `unpack_trees`
   class. Needs tree reads per writer: the O(change) `TREE` work kept for a later run.

## Decision

**User-ratified — option 2.** The commit path diffs the entries it writes against the index it
replaces and invalidates, in the carried `TREE`, every node on the directory chain of each changed
`(path, stage)`; a subtree whose name is replaced by a file or deleted is removed. Untouched subtrees
keep their bytes. Invariant: no node with a valid entry count covers a changed path. A carried `TREE`
that fails to parse is dropped, never refused. Both serialisation and invalidation take the
repository's digest width.

**Divergence (named, bounded):** for `unpack_trees`-class writers git recomputes the cache-tree; tsgit
leaves the changed chains invalid. The two are equal under readback (every valid node tsgit keeps
carries git's oid for that directory) but not byte-identical. The byte-exact form lands with the
O(change) `TREE` maintenance work.

## Consequences

- In-place writers produce git's `TREE` bytes; interop rows pin them.
- `replace` writers pin "every valid node carries git's oid" and `git fsck` exit 0, not byte equality.
