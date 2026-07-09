# 467 — heap migration ships on the asymptotic argument; no wide-frontier benchmark

- **Status:** accepted
- **Date:** 2026-07-09
- **Design:** docs/design/commit-priority-queue-heap.md · **Relates:** ADR-465

## Context

The brief gates the churn on profiling: "profile to confirm the win on deep
histories before committing the churn." The design established a load-bearing
empirical finding — the existing scaled bench fixtures
(`test/bench/support/fixture-generator.ts`) build **strictly linear** histories
(one parent per commit), so the queue frontier is width ≈ 1 and both the sorted
array and the heap are effectively O(1) per step. Those benches therefore
**cannot demonstrate the win**, which only appears on a wide frontier (many
concurrent equal-date branches / octopus merges). The design recommended adding
a net-new wide-frontier micro-benchmark as the gate. The question is whether that
fixture is built now or the migration ships on the complexity argument.

## Options considered

1. **Wide-frontier micro-bench + narrow-frontier regression check** — new
   bushy-DAG fixture, justify iff ≥2× at B=512 and no material narrow-frontier
   regression. Pros: measures the win. Cons: net-new bench fixture + glue this
   PR. *(design recommendation)*
2. **Real-command bench only** — bushy fixture through `mergeBase` / a date-walk
   end-to-end. Cons: I/O-dominated, can mask the queue win.
3. **Ship on the asymptotic argument** — trust O(N²)→O(N log N) (git's own
   `prio_queue` complexity) and rely on the existing linear benches for
   no-regression only. Cons: the wide-frontier win is argued, not measured.

## Decision

Ship on the asymptotic argument (user-ratified — **deviates from the design's
recommendation**). No net-new wide-frontier benchmark fixture is added in this
change. The profiling gate is satisfied by (a) the complexity argument — the
migration reproduces git's `prio_queue` O(N log N) behaviour, an established
result — and (b) no regression on the existing linear-history bench suite
(`log-scale` / `describe` / `name-rev`), which is the overwhelmingly common case
and the one a heap could plausibly slow via sift bookkeeping. The design's
empirical frontier-width finding is retained as the *rationale* for why the
existing benches show a wash; the wide-frontier fixture it proposed is
deliberately not built.

## Consequences

- Minimal diff: no bench fixture or scenario-glue churn rides along with the
  structural change.
- The wide-frontier win is asserted from complexity, not demonstrated by a
  measurement in-repo. Should a future change need the empirical curve, a
  bushy-DAG bench can be added then without disturbing this decision.
- **No-regression is still enforced:** the heap must not regress the linear
  bench suite beyond noise — a material narrow-frontier regression would be a
  blocker, since linear histories dominate real usage.
- The design doc's §"Profiling gate" is superseded by this decision and is
  reconciled in the against-ADRs design revision.
