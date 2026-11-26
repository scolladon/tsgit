---
subjects:
  - stryker.config.mjs
  - .claude/workflow/mutation.md
phases: [validation]
kind: gotcha
trigger: a Stryker report lists Timeout verdicts on mutants that hundreds of tests cover
evidence:
  - src/application/primitives/compare-working-tree-entry.ts:354
  - src/application/primitives/internal/is-entry-stat-clean.ts:74
  - stryker.config.mjs:65
  - test/unit/application/primitives/is-ignored.test.ts:722-744
  - src/application/primitives/internal/ignore-evaluator.ts:72
source: { run: whole-second-stat-match, phase: validation, date: 2026-11-25 }
status: active
supersedes: []
last-verified: 2026-11-26
---
# 062 — A Stryker timeout on a widely covered mutant is verified one by one

## Context

One narrowed bucket, concurrency 1, no foreign load (5 to 11): 215 mutants, 64 killed, 3
survived and 67 timed out. Every timeout sat on a mutant that 600 to 1200 tests cover, in the
stat compare and its two callers, and they took most of the run's 58 minutes. Applied by
hand in a throwaway copy, each exact replacement ran the same 38 suites in 6 to 21 seconds;
three re-run without file isolation took 6 seconds each. 66 failed between 1 and 319 tests. One
passed all 2089: the
scope resolver's "already resolved" shortcut turned off, a copy that recomputes the same
values. The report counted it as detected, and its three sibling mutants on the same line are
real kills, so a sample of one per file would most likely have missed it.

## Lesson

A Timeout verdict says the harness ran out of time, not that a test failed. On a mutant
hundreds of tests cover it hides a survivor as easily as a kill, and it raises the score either
way.

## How to apply

Treat every Timeout as unverified, not as one sample per file.
Apply each exact replacement in a throwaway copy and run the narrowed include under an external watchdog; a script does 70 in twelve minutes.
Triage a passing one as a survivor: kill it, remove its guard, or record the proof of equivalence.
Report the score with the timeouts split out: killed by the run, killed by hand, survived, equivalent.
Scope the post-triage run to the files the triage changed, so it does not pay for the timeouts again.
End the watchdog's whole process group: a vitest killed alone leaves its workers running at full load.

## Evidence

`src/application/primitives/compare-working-tree-entry.ts:354` — `isResolved`: the mutant that
makes it always false was reported Timeout and passes every unit test.
`src/application/primitives/internal/is-entry-stat-clean.ts:74` — `matchesStatData`: 22 of its
mutants timed out; each fails tests within seconds by hand.
`stryker.config.mjs:65` — `timeoutMS: 60000` and `timeoutFactor: 2`, the budget those runs
exceeded.

Refreshed 2026-11-26: `test/unit/application/primitives/is-ignored.test.ts:722-744` — a row over a
path 20 000 directories deep. With it in the covering set, nine mutants that never exclude or
always load (for one, `src/application/primitives/internal/ignore-evaluator.ts:72` forced true)
read 20 000 rule files and were reported Timeout. Applied by hand with that row set aside, seven
fail 4 to 95 tests in two seconds and two loop forever.
