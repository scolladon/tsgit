---
subjects:
  - src/application/commands/add.ts
phases: [implementation, review]
kind: gotcha
trigger: a test is meant to prove that a narrowed fold or catch did not spread to a sibling caller
evidence:
  - src/application/commands/add.ts
  - test/unit/application/commands/add.test.ts
source: { run: long-pathspec-refusals, phase: review, date: 2026-11-16 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 040 — A guard that a fold did not widen is run against the widened fold

## Context

`add` reads a pathspec probe the file system refuses as too long as "nothing on disk". The fold
had to stay off the stats of tracked entries, which share the same `lstat` helpers. The first
guard stubbed every `lstat` of `x.log` to fail. It passed with the fold correctly narrowed, and it
also passed with the fold moved into the shared `lstatOrBeneathFile`: the refusal it asserted came
from a later `lstatOrMissing` call, not from the caller it was meant to watch. A review mutation
probe found it; the tracked-gitlink caller had no guard at all.

## Lesson

A "did not widen" guard proves nothing until it has been seen to fail with the fold widened. A
stub that refuses every call to a path lets whichever call comes first or last carry the
assertion, so the test can pass for a reason unrelated to the caller it names.

## How to apply

Write one guard per caller the fold must not reach, named for that caller.
Make the stub refuse only the call that caller makes (by order, or by path), so no sibling call can satisfy the assertion.
Before committing, apply the widened fold on a copy and confirm each guard goes red; keep the one that does.

## Evidence

`test/unit/application/commands/add.test.ts`: `refusingFirstStatTooLong` and the rows "Given a
modified tracked file an ignore rule hides and a stat refused as too long" (`hiddenWalkEntryOf`)
and "Given a tracked gitlink whose stat is refused as too long" (`movedGitlinkOf`). Each turns
red when `PATH_TOO_LONG` is folded inside `lstatOrBeneathFile` in `src/application/commands/add.ts`.
