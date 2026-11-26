---
subjects:
  - test/perf/**
phases: [review, validation]
kind: gotcha
trigger: test:perf is red on a budget assertion while the machine carries load from another session
evidence:
  - test/perf/application/commands/archive.perf.test.ts
  - test/perf/domain/refs/reftable-seek.perf.test.ts
  - test/perf/domain/regex/extended-regex.perf.test.ts
  - test/unit/application/commands/add.test.ts
  - test/unit/application/primitives/walk-working-tree.test.ts
  - test/integration/gitmodules-symlink-alias-interop.test.ts
  - test/integration/merge-abort-interop.test.ts
  - test/integration/skip-worktree-present-files-status-interop.test.ts:246
source: { run: lift-delta-chain-read-cap, phase: review, date: 2026-10-20 }
status: active
supersedes: []
last-verified: 2026-11-26
---
# 003 — Wall-clock budget tests fail under foreign load

## Context

Three consecutive `npm run validate` runs went red on `test:perf` alone, each on a
different budget assertion (1016 ms and 1077 ms against 1000 ms, 1078 ms against 800 ms),
while another session was fuzzing git on the host and the machine was swapping. The same
source had passed `test:perf` twice earlier that day. Retrying blindly would have looped. A clean rebuild is itself foreign load: after
`rm -rf dist .wireit` in the worktree-ref-store run (2026-11-08), Spotlight's file-event daemon and
`mds` re-indexed the tree at full CPU for about twenty minutes, a gate started at load 4 ended
at load 25, `add.test.ts` timed out once under coverage and one interop row in
`ref-transaction-interop.test.ts` failed an assertion it passed alone; the next run on a quiet
host was green with only the two scripts re-executing.

## Lesson

A budget assertion measures the machine as much as the code. The failure is load, not a
defect, when all three signatures hold: the failure is budget-shaped with no assertion of
correctness failing, the failing set changes between runs, and the file is absent from the
diff. An interleaved A/B of the file on `main` and on the branch settles the rest: here the
same test varied tenfold on `main` itself. Once the foreign load ended the gate passed on
the first retry, with only `test:perf` re-executing from the wireit cache.

## How to apply

Classify first: budget-shaped, failing set changes, file not in the diff — all three, or treat it as a defect.
A/B the failing file on `main` and on the branch, interleaved, three runs each, before any retry.
Wait for the host to be quiet (load under 15, no foreign test process) rather than retrying under load.
Retry with the wireit cache kept so only the red script re-runs; read "Ran N and skipped M" honestly.
Judge "quiet" by load and CPU %, never by a process name: an idle helper that matched the name stalled a wait for an hour.

## Evidence

`test/perf/application/commands/archive.perf.test.ts` and
`test/perf/domain/refs/reftable-seek.perf.test.ts` — the two budget suites that alternated.
`test/perf/domain/regex/extended-regex.perf.test.ts` — the `runs within 8 times RegExp` row at 8.29 under five foreign mutation jobs (load 20); 231 s later, at load 2.6, the cached retry passed.
`test/unit/application/commands/add.test.ts` — the `exactly at the size cap` row timed out at 120 s under
coverage (150 s) while two review agents ran interop suites beside `npm run validate` (load 24 / 54 / 43,
Spotlight indexing and an orphaned vitest worker at 100 %); the same gate re-run alone passed 29 652 tests,
and `test:perf` failed its archive (1037 vs 1000 ms) and reftable-seek (801 vs 800 ms) budgets in that run
and passed 15/15 twice alone. A unit timeout under coverage is the same symptom as a budget miss.

Refreshed 2026-11-25: no foreign job is needed. `npm run validate` alone drove the load to 30 to 38
and went red on the reftable-seek budget (816 vs 800 ms) and on three 120 s timeouts under coverage:
two 2048-level rows of `test/unit/application/primitives/walk-working-tree.test.ts` and the size-cap
row of `add.test.ts`. All four passed alone (the perf row in 174 ms), and the re-run at load 6 to 12
was green with only `test:perf` and `test:coverage` re-executing.

Refreshed 2026-11-26: three of four full-gate runs went red on one integration row each, a
different file every time, at load 21 to 30 with Spotlight at 145 to 268 % CPU. Two were
`spawnSync git ETIMEDOUT` (`test/integration/gitmodules-symlink-alias-interop.test.ts`,
`test/integration/merge-abort-interop.test.ts`); each file passed twice alone in under 30 s. The
third was an assertion at `test/integration/skip-worktree-present-files-status-interop.test.ts:246`,
a row whose fixture settles index raciness with wall-clock sleeps: 2 of 3 alone at load 19 to 27,
8 of 8 on main and on the branch, alternated, at load 4 to 9. Before the first of those runs, five
orphaned vitest workers from hand-applied hanging mutants held a core each until they were ended.
