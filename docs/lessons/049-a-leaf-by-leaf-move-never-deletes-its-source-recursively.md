---
subjects:
  - src/application/commands/internal/working-tree.ts
phases: [design, implementation, review]
kind: gotcha
trigger: a directory is moved entry by entry and its source is then removed
evidence:
  - src/application/commands/internal/working-tree.ts
  - test/integration/mv-interop.test.ts
source: { run: mv-directory-one-rename, phase: design, date: 2026-11-19 }
status: active
supersedes: []
last-verified: 2026-11-19
---
# 049 — A leaf-by-leaf move never deletes its source recursively

## Context

`mv d D` on a case-insensitive host resolved `D` to the existing `d`, so the destination became
`D/d`, which is inside the source. The old walk moved every leaf to `d/d/…` and then ran
`rmRecursive(d)`: the whole directory, untracked files included, was gone while `mv` returned
success. git's single `rename(d, D/d)` fails with `EINVAL` and changes nothing.

## Lesson

After entry-by-entry moves, whatever remains under the source is exactly what the moves left
there, and an aliased destination can make that everything.

## How to apply

Rename a directory in one platform step wherever the adapter can.
On an entry-by-entry fallback, read the whole subtree before the first move.
Clean the source only with empty-directory removal, never with a recursive delete.

## Evidence

`src/application/commands/internal/working-tree.ts`: `renameInWorkingTree` and
`moveTreeEntryByEntry` (ending in `removeEmptyDirectoryTree`);
`test/integration/mv-interop.test.ts`: the case-folded row 5, which keeps untracked `d/u`.
