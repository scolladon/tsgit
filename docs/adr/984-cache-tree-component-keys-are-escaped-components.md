---
subjects:
  - src/domain/git-index/cache-tree.ts
---
<!-- cspell:ignore latin -->
# 984 — Cache-tree component keys are escaped components

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-981

## Context

After ADR-981 the cache-tree is the only user of `latin1` component keys; every other path key is the
escaped path.

## Options considered

1. Keep `latin1` component keys.
2. **Escaped components**, deleting `latin1` (recommended).
3. Option 2 later.

## Decision

**Adopted-as-recommended (no user judgment) — option 2.** One key scheme across the index, the
cache-tree and the merge engine (ADR-981).

## Consequences

- `latin1` is removed; a cache-tree child keys the same way as its path component everywhere else.
