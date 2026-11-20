---
subjects:
  - src/application/primitives/compare-working-tree-entry.ts
  - src/application/primitives/find-would-overwrite.ts
  - src/application/commands/status.ts
---
# 1234 — A directory at a tracked file path reads removed, except to the overwrite check

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/core-filemode-false.md (review fold) · **Supersedes/Refines:** applies DOCTRINE D-2

## Context

Review of the `core.fileMode` change probed a directory standing where the index holds a regular
file, symlink or unmerged path (git 2.56.0, both `core.fileMode` values):

- `status` / `diff-files` / `rm` / `stash` go through git's `check_removed`: a directory at a
  non-gitlink path is **removed** (`.D`, unmerged `mW` `000000`).
- The checkout/merge overwrite check (`verify_uptodate` → `ie_match_stat`) counts it as a
  **change** and refuses.

tsgit's shared comparison seam reports `modified` with a file mode for every consumer. The
divergence predates this change, but the change edits both loci (`compareFile`'s mode
derivation and `status`'s unmerged work-tree mode).

## Options considered

1. Defer to impact triage (design recommendation: outside the fileMode perimeter).
2. Fold `status` and the unmerged work-tree mode only.
3. **Fold the whole per-consumer split**: the seam reports a directory at a non-gitlink path as
   absent; the merge-family overwrite check keeps it as a local change; pin each consumer.

## Decision

Option 3, ratified by the user against the recommendation. `compareAndRefresh` returns `absent`
for a directory at a non-gitlink entry; `find-would-overwrite` treats that occupant as a local
change, as `verify_uptodate` does; the unmerged `worktree.mode` is omitted for a directory.
Each consumer (`status`, `diff`, `rm`, `stash`, the merge family) gets an interop row.

## Consequences

`status` reports `deleted` where it reported `modified`, matching git. The merge family's refusal
is unchanged. The fold is a scope expansion and gets its own review before validation.
