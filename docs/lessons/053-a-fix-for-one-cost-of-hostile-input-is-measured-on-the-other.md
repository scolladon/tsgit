---
subjects:
  - src/domain/glob/wildmatch.ts
  - test/perf/domain/pathspec/compile-glob.perf.test.ts
phases: [review]
kind: trap
trigger: a review fix removes a memory amplification on hostile input by adding work per item at compile time
evidence:
  - src/domain/glob/wildmatch.ts:160-178
  - test/perf/domain/pathspec/compile-glob.perf.test.ts:214
  - test/unit/domain/glob/wildmatch.test.ts
source: { run: wildmatch-bracket-class, phase: review, date: 2026-11-24 }
status: active
supersedes: []
last-verified: 2026-11-24
---
# 053 — A fix for one cost of hostile input is measured on the other

## Context

Security review found that a megabyte line repeating one bracket set kept a 256-byte table per
set: 164 MB retained for `[a]` against 83 MB on main. The fix pooled set tables by content, and
the pool key was the table spread into `String.fromCharCode`, 256 arguments per set. Retained
heap fell to 17 MB and the cycle closed on that number. Nobody timed the same input. Cycle 2
measured it: compiling 262 144 repetitions of `[ab]` took 2021 ms, against 105 to 115 ms before
the pool. A key packed sixteen slots to a UTF-16 unit brought it to 298 ms, and building that key
from locals to 154 ms. The finding took three cycles, two of them on a cost the first fix created.

## Lesson

Hostile input has two costs, memory and time. A fix that buys one with the other moves the
finding to the next cycle instead of closing it.

## How to apply

After a fix for retained heap on hostile input, time the same input; after a fix for time, weigh it.
Measure both on main, on the head before the fix and on the fix, with one script, before the cycle closes.
Pin the second cost with a row beside the first, as a ratio against work measured in the same process.

## Evidence

`src/domain/glob/wildmatch.ts:160-178` — `keyUnitOf` and `keyOf`: the pool key packed sixteen slots per unit, built from locals.
`test/perf/domain/pathspec/compile-glob.perf.test.ts:214` — the megabyte-line row that gates compile time against filling one table per set.
`test/unit/domain/glob/wildmatch.test.ts` — "Given a pattern repeating bracket sets": one table across repeated sets, distinct tables kept apart.
