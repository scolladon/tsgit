---
subjects:
  - src/application/primitives/merge-base.ts
  - src/application/primitives/internal/read-commit-meta.ts
supersedes:
  - adr: "840"
    scope: "the date-only comparator when min_generation is 0 without corrected commit dates"
---
# 1114 — merge-base follows git 2.56's paint queue

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F7) · **Supersedes/Refines:** supersedes ADR-840 (the comparator switch); refines ADR-226

## Context

git 2.56 rewrote `paint_down_to_common` (a3e5bad, 02d7ba0, 56c9056, ae68032). The queue is always
ordered by generation, then committer date, then insertion; the date-only fallback is gone. A
`paint_state` counts the queued non-stale commits per bucket (PARENT1 only, PARENT2 only, both).
`paint_queue_get` stops when no candidate is queued and either both sides are exhausted, or one
side is exhausted and the popped generation is below the topological ceiling
(`GENERATION_NUMBER_V1_MAX` without corrected commit dates, infinity with them). The single-result
break fires only below that ceiling. Pinned on 2.56.0 against 2.55.0 on the interop fixture with
two shared bases: with a `commitGraph.generationVersion=1` graph, `merge-base` now answers the
deeper base where 2.55.0 answered the shallow one; `--all` and the no-graph and v2 cases are
unchanged. ADR-840 replicated 2.55's comparator switch.

## Options considered

1. **Port the 2.56 algorithm: comparator, counters, side-exhaustion exit and ceiling** — pros:
   identical pop order and flag map, so `removeRedundant` sees what git sees / cons: a termination
   change on every merge-base caller.
2. **Change only the comparator** — pros: smaller / cons: the fixture's answer depends on the
   side-exhaustion exit, so the row stays red.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The paint queue always orders by
generation, then date, then insertion; it keeps per-side and candidate counters that move a
re-marked entry between buckets; it stops on both sides exhausted, or on one side exhausted below
the topological ceiling; and the single-result break applies below that ceiling only. The ceiling
derives from the chain's corrected-commit-dates verdict (ADR-848).

Superseded from ADR-840: the date-only comparator when `min_generation` is 0 and corrected commit
dates are not enabled.

Carried forward from ADR-840: the `ENQUEUED` dedup, the insertion tie-break, and the reduction's
minimum-generation paint.

## Consequences

- `GENERATION_NUMBER_V1_MAX` moves beside `GENERATION_INFINITY` in `read-commit-meta` and is
  shared with the commit-graph verifier.
- Every merge-base row, and every command built on `mergeBase`, runs at the gate to prove result
  parity after the termination change.
