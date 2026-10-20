---
subjects:
  - src/domain/range-diff/**
phases: [validation]
kind: technique
trigger: a Stryker survivor sits on a guard that mirrors a git BUG() and cannot fire in any reachable state
evidence:
  - src/domain/range-diff/linear-assignment.ts
  - test/unit/domain/range-diff/linear-assignment.test.ts
source: { run: lift-delta-chain-read-cap, phase: validation, date: 2026-10-20 }
status: active
supersedes: []
last-verified: 2026-10-20
---
# 004 — Suppress only the all-equivalent mutator, and test unreachable guards directly

## Context

The ported solver kept git's `BUG("negative j")` guard. Its `if (false)` mutant was
equivalent, but the same `(ConditionalExpression, line)` pair also held the killable
`if (true)` mutant, so a mark on the pair would have hidden a real mutant and the alternative
left a permanent survivor. The first mark also named `BlockStatement` on a bare `throw`,
a mutant that did not exist.

## Lesson

A `Stryker disable next-line` mark binds to a mutator on a line, never to one variant. When
one variant is killable and another equivalent, neither marking nor leaving it is right. The
way out is structural: move the guard into an exported `@internal` helper with direct
Given/When/Then tests, so every mutant inside it is killed, and mark only the call site's
`CallExpression` with the unreachability proof. Every mark is hand-verified first by applying
the exact replacement and running the full covering set.

## How to apply

Mark only a mutator whose every variant on that line is equivalent; check the report lists the mutant you name.
If a pair holds a killable and an equivalent variant, extract the guard into an `@internal` helper with direct tests.
Hand-verify each exact replacement against the full covering set before writing a mark.
Re-run the bucket without the incremental file after marking: stale verdicts replay from the cache.

## Evidence

`src/domain/range-diff/linear-assignment.ts` — `assertColumnIndex` and the single
`CallExpression` mark at its call. `test/unit/domain/range-diff/linear-assignment.test.ts`
— the two direct tests that kill the helper's mutants.
