---
subjects:
  - src/application/primitives/internal/sparse-entry-kinds.ts
  - src/application/primitives/materialize-tree.ts
phases: [implementation, review]
kind: gotcha
trigger: a fold encodes a rule chosen because it makes every probed row pass, with no git source line behind it
evidence:
  - src/application/primitives/internal/sparse-entry-kinds.ts
  - test/integration/sparse-gitlink-writers-interop.test.ts
source: { run: skip-worktree-present-files, phase: review, date: 2026-11-22 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 051 — A rule fitted to probe outcomes is derived from git's source before it folds

## Context

Review cycle 2 folded a rule for when a skip-worktree gitlink counts as a directory, fitted to
the checkout probes. Cycle 3 raised it HIGH: the same rule gave the wrong kind for merge, reset
and reapply. git's source explains why: the entry-type helper in `dir.c` reads an unknown type
on little-endian, so the index fallback answers "directory" only for an up-to-date gitlink, and only commands that
refresh before unpack (checkout, merge, stash) set it. The fitted rule had no refresh dimension,
because no probe varied it.

## Lesson

Probes confirm a rule; they cannot reveal a dimension none of them varies.

## How to apply

Before folding a rule inferred from probes, find the git source lines that decide it.
List every input those lines read, and make sure some probe varies each one.
Name the rule's inputs in the code (here `refreshedIndex`), not the probes it was fitted to.

## Evidence

`src/application/primitives/internal/sparse-entry-kinds.ts` — `withEntryKinds` and its
`refreshedIndex` option; `test/integration/sparse-gitlink-writers-interop.test.ts` — one row
per writer, refreshing and not.
