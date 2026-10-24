---
subjects:
  - src/application/primitives/apply-merge-to-worktree.ts
  - src/application/primitives/internal/symlinked-leading-path.ts
phases: [validation]
kind: technique
trigger: Stryker survivors sit inside a gate whose only purpose is to skip a slower path that yields the same result
evidence:
  - src/application/primitives/apply-merge-to-worktree.ts
  - src/application/primitives/internal/symlinked-leading-path.ts
  - test/unit/application/primitives/internal/symlinked-leading-path.test.ts
source: { run: status-gitlink-parity, phase: validation, date: 2026-10-24 }
status: active
supersedes: []
last-verified: 2026-10-24
---
# 011 — An optimisation gate breeds equivalent survivors

## Context

Two gates landed in one change: "does the index after a clean merge differ from the merged
tree, so that a tree must be synthesized from it" and "is this directory's leading-path verdict
still fresh, or must the memo be walked again". The primitives mutation bucket reported thirteen
survivors, all inside those two gates, and every one survived its full covering set when the
exact replacement was applied by hand. None was a defect: each mutant only turns the gate's
"skip" into "do the slower thing", and the slower thing yields the identical tree id or the
identical verdict.

## Lesson

When a gate's wrong answer can only be "take the branch that recomputes the same result", no
test can observe the mutant: the outputs are equal by construction. Such survivors are
equivalent and the triage must say so with the proof, not chase them with spies.

## How to apply

Hand-verify each survivor against its full covering set first; a pass proves the shape.
Then remove the arithmetic the mutants bite where a value-free form exists (a fresh `Symbol`
per change instead of a counter).
Mark the remaining lines inline with the mutator names and the one-line proof.
Never add a call-count spy to kill a perf-only mutant.
Expect the review's PROBE records to predict these; verify them, do not trust them.

## Evidence

`src/application/primitives/apply-merge-to-worktree.ts` — `keepsStagedChanges` and `unchangedCount`, marked per line.
`src/application/primitives/internal/symlinked-leading-path.ts` — the `generation` token and the marked cache-key lines.
`test/unit/application/primitives/internal/symlinked-leading-path.test.ts` — the invalidation rows that kill the real mutants beside them.
