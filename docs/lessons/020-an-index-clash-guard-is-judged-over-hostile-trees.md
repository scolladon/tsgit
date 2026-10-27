---
subjects:
  - src/application/commands/internal/staged-patch.ts
  - test/unit/application/commands/internal/staged-patch.test.ts
  - test/integration/stash-apply-index-judge-interop.test.ts
phases: [review, validation]
kind: gotcha
trigger: a clash or ordering guard over index entries is called redundant or a mutant on it equivalent
evidence:
  - src/application/commands/internal/staged-patch.ts
  - test/unit/application/commands/internal/staged-patch.test.ts
  - test/integration/stash-apply-index-judge-interop.test.ts
source: { run: stash-apply-dir-file-replacement, phase: validation, date: 2026-10-27 }
status: active
supersedes: []
last-verified: 2026-10-27
---
# 020 — an index clash guard is judged over hostile trees

## Context

The stashed-index judge ports git's `apply --cached`. Its file/directory clash check reasoned
over canonical trees twice and was wrong twice. In review, an "equivalent" simplification
dropped the re-add of each placement to the occupied set; a stashed tree holding `n` as both a
blob and a tree, which `mktree --missing` builds, then applied where git refuses. In mutation
triage, a survivor on the guard that kept modified paths occupied turned out to be closer to git
than the code: git's write phase removes every patched path first, then adds in patch order, so
with `n/x` already in the index git reports the clash at `n/x` and tsgit reported `n`. Both
shapes were proven against git 2.55 before a line changed.

## Lesson

A tree in a stash, a pack or a peer's ref is input, not an invariant. A guard that only matters
for a tree git itself would never write still binds the refusal data, and a proof that it is
redundant, or that a mutant on it is equivalent, holds only if it covers such trees.

## How to apply

Before calling a clash, ordering or occupancy guard redundant, or a mutant on it equivalent,
build the hostile tree with plumbing and run git on it.
Keep one unit row per hostile shape beside the canonical ones, and a cross-tool twin for each.
When a survivor contradicts the code on such a guard, treat the mutant as a candidate model and
probe git before writing a kill test.

## Evidence

- `src/application/commands/internal/staged-patch.ts`, `survivingEntriesOf` and `firstClash`:
  every judged path leaves the occupied set, placements are added in index order.
- `test/unit/application/commands/internal/staged-patch.test.ts`, the `duplicateNameTree` rows:
  C holds neither, C holds `n/x` as the base does, C holds `n/x` with a line the stash never saw.
- `test/integration/stash-apply-index-judge-interop.test.ts`, the `duplicate-name`,
  `duplicate-over-file` and `duplicate-over-moved-file` shapes, each refused at the path git names.
