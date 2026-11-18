---
subjects:
  - test/integration/gitlink-removal-occupant-interop.test.ts
  - tooling/test-pyramid/detect-bad-title.ts
phases: [planning, implementation]
kind: gotcha
trigger: an interop suite wraps its rows in a `describe.each` over core.ignorecase or another twin setting
evidence:
  - test/integration/gitlink-removal-occupant-interop.test.ts
  - tooling/test-pyramid/detect-bad-title.ts
source: { run: gitlink-rmdir-keeps-occupant, phase: implementation, date: 2026-11-18 }
status: active
supersedes: []
last-verified: 2026-11-18
---
# 045 — An ignorecase twin wrapper takes the Given slot

## Context

Two new interop suites wrapped every row in `describe.each(['false', 'true'])('Given
core.ignorecase=%s in both twins', …)` and then opened each row with its own `Given …`
describe. The test-pyramid audit accepts one combined `Given …, When …` describe or a
`Given` > `When` pair, so eight rows failed `gwtTitle` at the phase gate. The audit also reads
no title from a three-stage `describe.skipIf(…).each(…)(…)` call, so that row lost its Given.

## Lesson

The twin wrapper is the row's Given. Everything inside it is a When, and its skip condition
goes on the `it`.

## How to apply

Under a `Given <setting>=%s` twin wrapper, title the inner describes `When …`, never `Given …`.
Use `describe.each(…)(title, …)` for the wrapper and `it.skipIf(cond)(…)` for a platform skip;
never chain `describe.skipIf(…).each(…)`.
Run `npm run check:test-pyramid` on the part, not only at the phase gate.

## Evidence

`test/integration/gitlink-removal-occupant-interop.test.ts` titles its inner describes
`When stash push -u runs over …` under `Given core.ignorecase=%s in both twins`.
`tooling/test-pyramid/detect-bad-title.ts` `classifyAncestors` returns `nested-gwt` for two
Given ancestors.
