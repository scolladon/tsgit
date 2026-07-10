# 473 — memory measurement: vitest-bench timing plus a separate RSS/heap probe

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/memory-pressure-bench-scenarios.md · **Relates:** ADR-471, ADR-472

## Context

The brief is *memory-pressure* scenarios, but `vitest bench` measures wall-clock time
only — it has no built-in heap or peak-RSS capture. The design argued that
per-iteration `process.memoryUsage()` sampling *inside* the measured closure is noisy
(GC timing, shared-heap effects) and pollutes the timing signal, and so recommended
timing-only, deferring real memory numbers to the 26.3 profile path.

## Options considered

1. **Timing only** — cold-vs-warm delta-chain gap + large-pack spread timing; declare
   heap/RSS out of scope for a `vitest bench` scenario, leave memory numbers to the
   26.3 profile harness. *(design recommendation)*
2. **Add RSS/heap sampling** — capture `process.memoryUsage()` around the memory-pressure
   workloads so the suite reports actual memory numbers now, accepting the noise
   trade-off.
3. **Pull the 26.3 profile path forward** — route memory capture through
   `tooling/profile.ts` ahead of that dedicated item. Larger scope for this ticket.

## Decision

Adopt option 2 — **capture real RSS/heap numbers for the memory-pressure workloads in
this change** (user-ratified; **deviates from the design's recommendation** of
timing-only). The user's call: a memory-pressure item should report memory, not only a
timing proxy.

To honour the design's valid noise concern, the capture is kept **out of the
`vitest bench` timed path**: the `.bench.ts` scenarios stay wall-clock-only (with their
isomorphic-git baselines per ADR-471/472), and a **separate memory probe** measures
RSS + `heapUsed` around the deep-chain read and the large-pack spread — sampled around
the workload, not inside a timed `sut` iteration — with forced GC (`--expose-gc`) before
each baseline reading for stability. Its output is reported as its own artifact, never
merged into the timing summary, so neither signal contaminates the other.

## Consequences

- 26.6 delivers actual memory numbers for the two workloads, not just a timing proxy.
- A small memory-probe harness is added (runnable script + its wiring); the `vitest bench`
  timing scenarios are unchanged by it.
- The probe needs a GC hook, so it runs under `node --expose-gc`; that invocation detail
  is captured in the tooling/docs wiring.
- The design doc is revised (scope-fold) to add the probe as its own part; the 26.3
  profile path may later subsume or extend it.
