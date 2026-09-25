---
subjects:
  - src/adapters/node/node-file-system.ts
---
# 880 — The sync budget is one millisecond of clock time and reads are gated at 64 KiB

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D1, DC-1) · **Supersedes/Refines:** refines ADR-879; same event-loop framing as ADR-735

## Context

ADR-879 bounds synchronous work per event-loop turn but leaves the budget's unit, value and the
small-read gate open. A count-based budget is cheaper to charge than a clock but mis-sizes on the
slow disks where the bound matters most. Measured on this machine: one clock read before and one
after a 1.1–1.4 µs op costs 0.13 µs (about 10 %), a `setImmediate` yield costs 13 µs, and the
files the serial path reads (HEAD, refs, config, packed-refs, `.rev` files and small `.idx`
files) fit under 64 KiB.

## Options considered

1. **1 ms clock-based budget, 64 KiB read gate** — pros: the shape the perf review measured; a
   yield costs about 1.3 % of a long sweep; slow disks self-limit / cons: two clock reads per op.
   *Recommended by the design.*
2. **2 ms / 128 KiB** — pros: fewer yields / cons: doubles the worst-case stall for no measured
   gain.
3. **Op-count budget (≈ 700 ops per turn), 64 KiB** — pros: no clock reads / cons: 700 ops on a
   cold network mount can be tens of milliseconds; the bound fails exactly where it is needed.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** The budget is 1 ms of clock time per
event-loop turn, **measured as the wall-clock time elapsed since the turn's first admitted sync
operation started** — not as the sum of the operations' own durations, so the CPU work between
two cheap calls counts against the same turn. The small-read gate is 64 KiB. Both are internal
constants, not options. The first charge in a turn pins the turn's start and arms one
`setImmediate` marker that ends the turn and resolves one shared next-turn promise; `admit()`
returns `undefined` while the turn is under budget (no microtask hop on the hot path) and the
shared promise otherwise, so concurrent callers share one yield. A read's size is checked at read time, not stat time: the arm reads the stated size plus
one extra `readSync` to confirm EOF, and delegates to the async arm if the file grew past the gate
between `fstat` and the read, so a growing file is never truncated.

## Consequences

- The worst-case loop stall attributable to the sync arms is about 1 ms plus the CPU work queued
  behind the last admitted operation. Measured on a 20k-file `status` (event-loop delay
  histogram, warm, 5 runs, 3 repeats): sync mode max 8.41–8.68 ms / p99 2.87–4.00 ms against
  4.79–5.10 ms / 2.57–2.66 ms on the threadpool. Patching the budget to 0.25 ms leaves the tail
  at ≈ 7.5 ms and 4 ms raises it to ≈ 13 ms, so the residual sits outside every `admit`
  checkpoint.
- **Located (`node --cpu-prof`, sync mode, 40 warm `status()` iterations on `medium-v3`):** the
  residual is `status.ts`'s in-memory index-vs-tree diff pass —
  `collectStagedKinds`→`diffIndexAgainstTree` (`stage0IndexMap` + `unionPaths` + a `sortByPath`
  call), immediately chained into `buildChanges`'s own union-and-sort — plus V8 GC pauses
  measured alongside it (≈2.2 ms self time/iteration on average, worse at the tail). Self-time
  sum across the diff/union/sort functions alone averages ≈3.7 ms/iteration (`unionPaths` 1.3,
  `stage0IndexMap` 1.0, `diffIndexAgainstTree` 1.0, `collectStagedKinds` 0.2,
  `buildChanges` 0.1). Both classes touch zero filesystem calls, so `sync-io-budget.ts`'s
  `admit()` — wired only at fs syscall boundaries — never runs during them; a GC pause cannot be
  paused or checked from JS at all, and the diff pass sits in
  `application/commands`/`domain` code that runs unmodified on the browser adapter (no event
  loop, no Node `setImmediate`) — threading a Node-only yield primitive into it to shave one
  adapter's tail would cost every platform a two-sort, whole-index CPU phase that canonical
  git's own `status`/`diff-index` also runs as one uninterruptible pass. No change made; the
  residual is accepted as CPU work outside the sync-arm's remit, per the option above.
- The gate keeps blobs, packs and large `.idx` files on the threadpool where the pool measured
  faster.
- Making the numbers tunable is additive (ADR-881 reserves the room); it waits for a filesystem
  where the constants are wrong.
