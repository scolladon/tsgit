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
  histogram, warm, 5 runs): sync mode max ≈ 8 ms / p99 ≈ 3 ms against ≈ 4.5 ms / ≈ 2.4 ms on
  the threadpool. Patching the budget to 0.25 ms leaves the tail at ≈ 7.5 ms and 4 ms raises it
  to ≈ 13 ms, so the residual sits outside every `admit` checkpoint; locating it is a recorded
  follow-up, not a reason to move the constants.
- The gate keeps blobs, packs and large `.idx` files on the threadpool where the pool measured
  faster.
- Making the numbers tunable is additive (ADR-881 reserves the room); it waits for a filesystem
  where the constants are wrong.
