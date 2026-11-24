---
subjects:
  - test/perf/**
phases: [implementation, review]
kind: technique
trigger: writing a perf row for a new bound and reaching for an elapsed-time budget in milliseconds
evidence:
  - test/perf/domain/pathspec/compile-glob.perf.test.ts:214
  - test/perf/domain/pathspec/compile-glob.perf.test.ts:141-212
source: { run: wildmatch-bracket-class, phase: review, date: 2026-11-24 }
status: active
supersedes: []
last-verified: 2026-11-24
---
# 056 — A new perf row gates a ratio measured in the same process

## Context

Review added a row: a megabyte of bracket sets compiles within 1000 ms. Alone it took 154 to
298 ms. Inside `npm run validate` the gate's own load reached 38 and the row took 1280 ms: the
phase gate went red on correct code. Two earlier rows of the same file, "folding costs under
three times case-exact matching", had failed the same way with a denominator near 1 ms. The row
was rewritten as a ratio: compile time over the time to fill one 256-slot table per set, both
timed inside the row. It reads 1.28 on the fixed code and about 17 with the slow pool key, and
it held three runs out of three at load 9 to 14 with the gate at 4.

## Lesson

A budget in milliseconds measures the machine. A ratio against work done in the same process
measures the code.

## How to apply

Gate new work against a reference that does the part of it no implementation can avoid, timed in the same row.
Pick a reference well above timer noise: a denominator near 1 ms flips under load.
Set the gate between the ratio measured on the fix and the ratio of the defect it guards; record both.
Run the row three times under load before trusting it.

## Evidence

`test/perf/domain/pathspec/compile-glob.perf.test.ts:214` — the megabyte-line row, compile time against table fill.
`test/perf/domain/pathspec/compile-glob.perf.test.ts:141-212` — the fold and encode rows, written as a share of the per-rule work they replace.
