---
subjects:
  - .claude/workflow/mutation.md
  - test/unit/application/commands/merge-worktree-gate.test.ts
phases: [validation]
kind: gotcha
trigger: re-running narrowed Stryker buckets after triage added new test files
evidence:
  - .claude/workflow/mutation.md
  - test/unit/application/commands/merge-worktree-gate.test.ts
  - test/unit/application/commands/merge-submodule-type-change.test.ts
source: { run: forced-checkout-displace-occupant, phase: validation, date: 2026-10-26 }
status: active
supersedes: []
last-verified: 2026-10-27
---
# 016 — A verification pass regenerates the narrowed test include too

## Context

The narrowed buckets' vitest include lists the unit suites that import each mutated module,
and it was generated once, before triage. Triage then killed eleven merge mutants with tests
in two new files that import the command through the facade. The verification pass reused the
old include, so Stryker never ran those files. The eleven mutants came back as survivors. With
the full unit include, every one of them was killed.

## Lesson

A narrowed include is a snapshot of the suites that existed when it was generated. Re-scoring
kill claims with it re-scores them against a corpus that omits the tests making those claims.

## How to apply

Before the verification pass, regenerate the include as well as the mutate ranges, and add
every test file the triage commits created or touched (`git diff --name-only <pre-triage>..HEAD -- test`).
When hand-verifying a survivor in a copy, run it with a config that includes the files you
pass: a narrowed include silently filters them out, and vitest's "no test files" exit reads as a kill.
List test suites only in the include: a helper file in it stops the dry run (`No test suite found`).
Delete the generated configs from the tree root before the phase gate, or the whole-tree format check flags them.

## Evidence

`.claude/workflow/mutation.md` — the run and triage procedure.
`test/unit/application/commands/merge-worktree-gate.test.ts`, `test/unit/application/commands/merge-submodule-type-change.test.ts` —
the triage suites the stale include missed.
`.claude/workflow/mutation.md` — the bucket procedure the stash-apply run followed when a helper
file in the generated include stopped the dry run and the leftover configs turned the gate red.
