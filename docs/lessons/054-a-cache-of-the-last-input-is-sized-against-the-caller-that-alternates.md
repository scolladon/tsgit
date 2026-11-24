---
subjects:
  - src/domain/pathspec/compile-glob.ts
  - test/perf/domain/pathspec/compile-glob.perf.test.ts
phases: [implementation, review]
kind: trap
trigger: putting a single-entry memo in front of a pure function that more than one caller reaches
evidence:
  - src/domain/pathspec/compile-glob.ts:99-118
  - test/perf/domain/pathspec/compile-glob.perf.test.ts:160
  - test/perf/domain/pathspec/compile-glob.perf.test.ts:199
  - docs/adr/1260-a-fixed-tail-refuses-a-path-and-two-paths-are-remembered.md
source: { run: wildmatch-bracket-class, phase: review, date: 2026-11-24 }
status: active
supersedes: []
last-verified: 2026-11-24
---
# 054 — A cache of the last input is sized against the caller that alternates

## Context

Folding a path's case once per rule cost more than matching it, so the compiler kept the last
path it folded and the result. An ignore rule set tests one path against every rule in turn, and
that loop hit the entry on every rule but the first. The measurement that ratified the entry was
taken on that loop only. Attribute rules reach the same compiler in another order: a rule tests
the path, the next one its basename, and so on. One entry missed on every call there, and review
measured 59.6 and 99.0 ms on the attribute loop. Two entries brought it to 22.3 and 26.0 ms.

## Lesson

A cache of the last input encodes one caller's order of calls. A caller that alternates between
two inputs turns every lookup into a miss, and the cache into overhead.

## How to apply

List every caller of the memoised function and write the order of keys each one sends.
Size the cache to the longest period among them, or hoist the value into the caller.
Add one perf row per order of calls: the alternating row is the one a single entry fails.

## Evidence

`src/domain/pathspec/compile-glob.ts:99-118` — `remembering`, two slots, used for the fold and for the byte encoding.
`test/perf/domain/pathspec/compile-glob.perf.test.ts:160` and `:199` — the rows where rules alternate between the path and its basename.
`docs/adr/1260-a-fixed-tail-refuses-a-path-and-two-paths-are-remembered.md` — the decision that superseded the single entry, with the measurements.
