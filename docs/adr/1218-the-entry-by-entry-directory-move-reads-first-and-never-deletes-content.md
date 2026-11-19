---
subjects:
  - src/application/commands/internal/working-tree.ts
---
# 1218 — The entry-by-entry directory move reads first and never deletes content

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (D2) · **Supersedes/Refines:** refines ADR-1217

## Context

An adapter without `renameDirectory` (OPFS, third-party) still moves a directory entry by entry.
Today that walk interleaves reads with moves, drops empty subdirectories (row E), and removes the
source with `rmRecursive`, which deletes whatever an aliased move left under it.

## Options considered

1. **Collect every `lstat`/`readdir` first, recreate every directory, rename every leaf, then clean
   the source with `removeEmptyDirectoryTree`.** A write fault midway leaves a documented partial
   move; the index is not written.
2. Option 1 plus a best-effort rollback of moved leaves — itself a non-atomic sequence that can
   fail, with no pinned fault to justify it.
3. Keep the interleaved walk and `rmRecursive`.

## Decision

Option 1, ratified by the user.

## Consequences

No read fault can strand a partial move, empty subdirectories survive on every adapter, and the
cleanup never deletes a non-directory. A write fault after the first rename leaves the work tree
partially moved, the same degradation the browser adapter's own `rename` documents.
