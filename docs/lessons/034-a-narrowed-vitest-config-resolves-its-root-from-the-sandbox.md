---
subjects:
  - .claude/workflow/mutation.md
  - vitest.stryker.config.ts
phases: [validation]
kind: gotcha
trigger: writing a narrowed vitest config for a Stryker bucket outside the tree root
evidence:
  - vitest.stryker.config.ts
  - stryker.config.mjs
  - src/application/primitives/internal/closure-engine.ts
source: { run: rev-list-objects-zero-count-boundary, phase: validation, date: 2026-11-11 }
status: active
supersedes: []
last-verified: 2026-11-11
---
# 034 — A narrowed vitest config resolves its root from the sandbox

## Context

A narrowed bucket's vitest config was generated under `reports/` with `root` set to the
worktree's absolute path, so its relative `include` would resolve. Stryker copies the project
into `.stryker-tmp/sandbox-*` and runs vitest from the copy. The absolute `root` pointed vitest
back at the worktree, so every test imported the unmutated sources. The run on
`closure-engine.ts:572-573` reported 0 killed and 11 survived, while a reviewer had killed all
twelve mutants by hand. With `root` derived from the config file's own location, the same run
killed 11 of 11.

## Lesson

A config Stryker loads runs inside the sandbox copy, so every path in it must be relative to the
copy. An absolute path to the worktree runs the tests against unmutated code, and every mutant
survives.

## How to apply

Derive `root` from the config file itself: `root: new URL('../..', import.meta.url).pathname`.
Keep the config inside the tree: a config in a temp dir cannot resolve `vitest/config`.
Put it under a gitignored path such as `reports/`, and move it out before the phase gate.
Baseline the narrowed config unmutated before launching the run.
Read 0 kills with every mutant surviving as a broken run, not a test gap: re-run before triage.

## Evidence

`vitest.stryker.config.ts` — the base config: relative `include`, no `root`, so it resolves inside
the sandbox. `stryker.config.mjs` — `vitest.configFile` names the config Stryker loads in the copy.
`src/application/primitives/internal/closure-engine.ts` — `listCommitSeeds`, the guard both runs
mutated: 0/11 killed with the absolute root, 11/11 with the relative one.
