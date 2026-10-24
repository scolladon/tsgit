---
subjects:
  - test/unit/application/commands/stash.test.ts
phases: [implementation, review, validation]
kind: gotcha
trigger: a row counts filesystem calls across passes and one pass runs only for racily clean entries
evidence:
  - test/unit/application/commands/stash.test.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
source: { run: status-gitlink-parity, phase: review, date: 2026-10-24 }
status: active
supersedes: []
last-verified: 2026-10-24
---
# 012 — A row counting passes over racily clean entries needs a still clock

## Context

A stash row pinned "the shared directory is lstat-ed once per pass: the classification, the
restore, the index refresh" at three. It passed alone, four times in a row, and failed once in
the full validate run with two. The third pass is the racy-clean comparison, which runs only
for entries whose mtime shares the index file's second; under the load of a full run the index
write and the file writes crossed a second boundary, nothing was racy, and the pass did not run.

## Lesson

A count that depends on which entries are racily clean is a count that depends on the clock.
The row was right about the code and wrong about its fixture.

## How to apply

Freeze `Date` for the row (`vi.useFakeTimers({ toFake: ['Date'] })`) so the index and every file share one second and the refresh pass always runs.
Release the clock in a `finally` around the Act.
Prefer this to loosening the assertion: the exact count is the point of the row.

## Evidence

`test/unit/application/commands/stash.test.ts` — the row titled `… lstat-ed once per pass …`.
`src/application/primitives/internal/smudge-racily-clean.ts` — the pass that runs only for racily clean entries.
