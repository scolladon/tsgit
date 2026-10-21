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
source: { run: lift-delta-chain-read-cap, phase: review, date: 2026-10-20 }
status: active
supersedes: []
last-verified: 2026-10-21
---
# 003 — Wall-clock budget tests fail under foreign load

## Context

Three consecutive `npm run validate` runs went red on `test:perf` alone, each on a
different budget assertion (1016 ms and 1077 ms against 1000 ms, 1078 ms against 800 ms),
while another session was fuzzing git on the host and the machine was swapping. The same
source had passed `test:perf` twice earlier that day. Retrying blindly would have looped.

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
