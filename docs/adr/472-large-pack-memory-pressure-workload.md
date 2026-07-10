# 472 — large-pack memory-pressure workload: reuse LARGE_FIXTURE, spread read, gated

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/memory-pressure-bench-scenarios.md · **Relates:** ADR-471, ADR-473

## Context

The "large packs" half of the memory-pressure brief needs a pack big enough to stress
the reader without the scenario itself materialising the whole pack. `LARGE_FIXTURE`
already builds a single ~500 MB pack of 200 000 objects, and a single cold `readBlob`
against it is already covered by `pack-read-scale.bench.ts` (under `TSGIT_BENCH_LARGE`).
The net-new signal is touching *many* pack regions / fanout buckets in one measured
read.

## Options considered

1. **Reuse `LARGE_FIXTURE`, spread read** — read a deterministic spread of object ids
   spanning the pack index in one measured call, gated behind `TSGIT_BENCH_LARGE` (so it
   never runs in nightly CI, which sets no such env). *(design recommendation)*
2. **Reuse `LARGE_FIXTURE`, single cold read** — one `readBlob`. Already covered; little
   net-new signal.
3. **Purpose-built larger fixture** — a new pack beyond 200 000 objects. Marginal extra
   pressure for a real CI/disk-budget cost.

## Decision

Adopt option 1 — **reuse `LARGE_FIXTURE` and read a deterministic spread of objects
across the pack in one measured call, gated behind `TSGIT_BENCH_LARGE`** (adopted as
recommended — no user judgment). The spread ids are resolved once at setup (in `build`,
outside the measured `sut`) from fixed `blobPath(k)` indices spanning the index. The
scenario runs **tsgit-only** (no isomorphic-git baseline): repeated `readBlob` over a
200 000-object pack is impractically slow for iso-git, matching the tsgit-only precedent
of `log-scale`/`status-scale`; `BenchComparison.baseline` is optional by design.

## Consequences

- No new fixture and no CI-budget growth — the scenario is skipped entirely in nightly
  CI (no `TSGIT_BENCH_LARGE`) and is a local/manual escape hatch, exactly like the other
  large-scale scenarios.
- The spread workload touches many pack regions in one read, the net-new "large pack"
  memory-pressure signal beyond the existing single-object cold read.
- Object-id resolution stays in `build`, never in the timed `sut`, so the measurement is
  the reads, not the id lookup.
