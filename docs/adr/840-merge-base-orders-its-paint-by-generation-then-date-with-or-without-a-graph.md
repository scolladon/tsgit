---
subjects:
  - src/application/primitives/merge-base.ts
---
# 840 — merge-base orders its paint by generation then date, with or without a graph

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-5) · **Supersedes/Refines:** refines ADR-190

## Context

git's `paint_down_to_common` pops its queue in generation-then-date order and breaks as soon as a
popped commit's generation falls below `min_generation`; the break is only sound on a
generation-ordered queue. git switches the queue to date-only when `min_generation` is `0` and
corrected commit dates are not enabled. The main paint passes `0`; the redundancy reduction passes
the minimum generation over the candidates.

## Options considered

1. **Generation-then-date always** (recommended, chosen) — pros: required whenever `min_generation > 0`; without a graph every generation is infinite and the order is today's date order / cons: on a topo-level (v1) graph the main paint's traversal order differs from git's date-only order.
2. **Replicate git's comparator switch exactly** — pros: identical traversal order in every configuration / cons: needs a graph-metadata probe on `readCommitMeta` for no change in any result.

## Decision

**Adopted-as-recommended (no user judgment).** The heap compares higher generation first, then
newer committer date, then **insertion order** — the tie-break git's `prio_queue` applies through
its insertion counter. The shared date-then-oid comparator the paint used before is not git's rule
for this walk: measured on a criss-cross whose two bases share a committer second (git 2.55.0,
with and without a graph), git returns the base its queue saw first, and only the insertion-order
tie reproduces that deterministically. The shared comparator itself is untouched; other walks keep
it. The main paint passes `min_generation = 0`; the reduction paints each candidate with the
minimum generation over the whole candidate set and breaks when a popped generation falls below it.

## Consequences

Without a graph the result set is unchanged; the single-result tie order is now git's (see
ADR-845), which the lexicographic rule never was. With a graph, merge-base reads no commit objects and
stops early in the reduction as git does. The `RESULT` set and the reduced set are independent of
traversal order, so results match git in every configuration; the only residual is the tie order of
same-second bases in the single-result rule, recorded in ADR-845. The reduction's minimum is taken
over the whole candidate set where git takes it over the not-yet-redundant entries — never higher
than git's, so it never prunes more than git does.
