# 501 — Hot-path picking methodology: absolute nightly ranker, revealed-effort cross-check, per-major refresh

- **Status:** accepted (user judgment — ratified the design's recommendation over the
  revealed-set-only and self-share alternatives)
- **Date:** 2026-07-24
- **Design:** docs/design/bench-hot-path-rework.md · **Refines:**
  [ADR-475](475-committed-profile-baseline-hot-shares.md) (the committed baseline is
  intra-command self-shares, not cross-comparable), [ADR-483](483-committed-hand-transcribed-benchmark-snapshot.md)
  (the nightly bench run is the clean absolute reference)

## Context

Backlog 27.4 rebuilds the bench suite around "hot paths" and requires the hot-path list to
land as an ADR, derived from the Phase-26 perf output. The committed Phase-26 artifact
(`docs/perf/baseline.json`) holds per-command **self-shares** normalised *within* each
command (they sum to ≈1 per command, ADR-475). Those shares answer "which frame dominates
*within* `status`?" but provably **cannot** answer "is `status` slower than `log`?" — two
commands with wildly different absolute cost can carry identical share tables. The brief
asks for a *cross-command* "hottest operations" list, which self-shares cannot produce.
The only cross-comparable absolute timing lives in the non-committed nightly bench artifact
(`bench.yml`, ADR-483), which times only operations that already have a bench.

## Options considered

1. **Absolute nightly wall-clock ranker + revealed-effort cross-check, frozen in the ADR,
   re-derived per major version** (design recommendation) — rank benched operations by
   absolute median-ms from the nightly artifact; take those above a documented floor;
   cross-check against the operations Phase 26 actually spent optimisation effort on
   (26.4/26.4a/26.4b/26.4c + the profiler's original `HOT_PATHS` triple). / pros: uses the
   only sound cross-command source, corroborated by revealed effort; explicit refresh
   cadence. / cons: wants a fresh nightly snapshot recorded at freeze time.
2. **Revealed-effort set only** — freeze exactly the 26.4* operations, no fresh
   measurement. / pros: lightest. / cons: no fresh absolute ranking recorded; drifts silently
   if a future operation becomes hot without an optimisation ADR.
3. **Self-share ranking from `baseline.json`** — rank by committed shares. / cons: **unsound**
   — intra-command shares cannot cross-rank (the crux).

## Decision

The hot-path list is derived by ranking the **benched** operations by **absolute median-ms
from the nightly `bench.yml` artifact** and taking those above the documented floor, then
**cross-checking against Phase-26's revealed optimisation effort**. The self-shares are
**never** the ranker — they remain the within-command drill-down. The list is **frozen into
a committed registry** (`docs/perf/hot-paths.json`, see ADR-505) recording the snapshot it
was derived from, and is **re-derived each major version** from that version's nightly
artifact. Both sources converge on the initial list:

```
hot = [ "log", "status", "pack-read", "blame", "describe", "name-rev" ]
```

Only benched operations can be ranked, so the hot set is a subset of the benched set; an
un-benched profiled command is "non-hot by absence of evidence" and gets medium-only
coverage (ADR-504), never a hot tiering.

## Consequences

- The hot list has a defensible, repeatable derivation and an explicit refresh cadence,
  not a hand-frozen guess.
- The initial list is corroborated by two independent signals (nightly ranking + revealed
  effort), so it is robust to a single ephemeral measurement.
- A future operation only enters the hot set once it (a) has a bench and (b) ranks above
  the floor at a major-version refresh — preventing silent scope creep.
- Self-shares keep their ADR-475 role (within-command optimisation drill-down) and are
  explicitly disqualified as a cross-command ranker.
