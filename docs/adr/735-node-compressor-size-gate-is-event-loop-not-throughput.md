---
subjects:
  - src/adapters/node/node-compressor.ts
---
# 735 — The Node compressor's size gate trades event-loop stall, not throughput

- **Status:** accepted
- **Date:** 2026-08-27
- **Design:** docs/design/perf-remediation-2026-08.md · **Supersedes/Refines:** none

## Context

`NodeCompressor` dispatches `deflate`/`deflateRaw`/`inflate` to either Node's synchronous zlib
API or its callback (libuv threadpool) API, gated on `CALLBACK_DISPATCH_THRESHOLD_BYTES`
(16 KiB). The gate previously applied to `inflate` as well as `deflate`/`deflateRaw`, and its
docstring justified the callback arm as letting "concurrent calls genuinely overlap" — a claim
that assumed a `cpuBound`-pooled caller dispatching many compressor calls at once.

Two problems surfaced under review:

1. **`inflate` measurably regresses, always.** A/B at concurrency 4: inflate sync runs
   0.20–0.66 ms per call across 4–64 KiB; inflate callback runs 1.41–2.33 ms — 1.9–5.3× slower,
   with no size in the measured range where the callback arm wins. Decompression is too cheap
   per byte for the threadpool round trip to ever pay for itself.
2. **No genuine concurrent `deflate`/`deflateRaw` producer exists among the primitives this ADR's
   author owns.** `build-pack.ts`'s entry-encoding loop is a plain sequential `for…of`; nothing
   pools deflate calls at `cpuBound` today. The "genuine overlap" justification was therefore
   unearned for the one caller inspected.

## Options considered

1. **Drop the gate entirely; both `deflate` and `inflate` always sync.** Simplest, and honest
   given no verified concurrent producer. Cons: forecloses a real future win — a single large
   deflate still blocks the event loop for everything else the host process is doing, which a
   library used inside a long-running server cannot get back by adding concurrency later, because
   the gate would need to be reintroduced anyway.
2. **`inflate` always sync; `deflate`/`deflateRaw` keep the size gate, re-justified as an
   event-loop-stall trade rather than a throughput trade** (recommended, chosen).
3. **Repoint a real pool at `cpuBound` in `build-pack.ts` to make the original throughput
   justification true.** Rejected for this ADR: no measurement showed `build-pack.ts`'s
   sequential loop is an actual bottleneck, and adding concurrency to manufacture a
   justification for an unrelated threshold is backwards. If a future profile shows pack writing
   pool-worthy, that pool can be added on its own merits.

## Decision

**Option 2.** `inflate` is unconditionally `inflateSync` — the threshold no longer applies to it
at all. `deflate`/`deflateRaw` keep `CALLBACK_DISPATCH_THRESHOLD_BYTES` (16 KiB), re-justified as
follows, verified by a concurrency-1 probe (Node 22.22.3, single measuring machine):

Per-call latency (median of 21 runs) shows the callback arm is strictly slower, at every size, for
both directions — this alone would argue against gating either:

| size   | deflate sync | deflate callback | inflate sync | inflate callback |
|--------|--------------|-------------------|---------------|--------------------|
| 4 KiB  | 0.039 ms     | 0.079 ms           | 0.005 ms      | 0.044 ms            |
| 16 KiB | 0.090 ms     | 0.131 ms           | 0.005 ms      | 0.041 ms            |
| 64 KiB | 0.516 ms     | 0.643 ms           | 0.011 ms      | 0.076 ms            |

The real effect is how long the callback arm keeps the event loop free for *other, unrelated*
scheduled work while a large `deflateSync` would otherwise block it — measured as the delay to an
unrelated `setTimeout` scheduled at the same instant (median of 15 runs, nominal delay 5 ms):

| size    | sync-path delay | callback-path delay |
|---------|------------------|------------------------|
| 16 KiB  | 6.454 ms (+1.454 ms stall) | 6.582 ms (noise) |
| 256 KiB | 5.130 ms (noise)           | 5.364 ms (noise) |
| 1 MiB   | 12.596 ms (+7.596 ms stall) | 4.572 ms (no stall) |

At the current 16 KiB threshold this benefit is indistinguishable from noise; it only becomes
real by roughly 1 MiB. The threshold is kept at 16 KiB anyway rather than raised to where the
benefit first appears, because the per-call cost of gating early is small in absolute terms (tens
of microseconds) and large objects are rare enough that tuning the exact crossover against one
measuring machine is not worth doing.

`inflate` is excluded from the gate entirely because it has no analogous large-stall case in the
measured range: even at 64 KiB, `inflateSync` costs ~0.01 ms — orders of magnitude below where an
event-loop stall would be worth trading callback overhead for.

## Consequences

The size gate no longer claims a throughput benefit it cannot demonstrate; if a concurrent
`deflate`/`deflateRaw` producer is added later (e.g. a pooled pack-writer), its own profile should
be checked against this threshold rather than assumed to validate it. `inflate` regressed on every
read path above 16 KiB before this ADR — every packfile/loose-object read over that size now stays
on the fast, always-synchronous path. A `test/bench/node-compressor.bench.ts` bench prices both
arms directly so a future change to the threshold, or an attempt to reintroduce inflate gating,
shows up as a measured regression rather than a silent one.
