---
subjects:
  - src/application/primitives/internal/ignore-evaluator.ts
  - test/bench/**
phases: [design, implementation, review]
kind: gotcha
trigger: a change adds work per entry to code the tree walk calls, and the command benches stay inside their threshold
evidence:
  - docs/design/is-ignored-leading-directory.md:628-634
  - test/bench/ignore-leading-directory.bench.ts:17-19
  - docs/adr/1278-the-ignore-session-keeps-one-outcome-per-directory-chain.md
source: { run: is-ignored-leading-directory, phase: implementation, date: 2026-11-26 }
status: active
supersedes: []
last-verified: 2026-11-26
---
# 064 — A per-entry cost on the walk is timed against main at more than one depth

## Context

The ignore session first kept one verdict per directory and walked the leading directories of
every entry. Its bench read 2.0 to 2.2 times a floor twin, and the A/B run of the command
benches stayed inside its 10 % threshold: `status` on the 20 000-file tree read +4.2 %. Timed
alone, in one process, against main's predicate, the session cost 1.37 to 1.41 times main with
entries two levels deep and 1.57 to 1.63 times with entries five levels deep. The bench trees are
shallow. The session was rebuilt to keep one outcome per directory chain before review, and
then read 0.92 and 0.73 times main.

## Lesson

A floor twin says how far code is from the work no implementation can avoid. A command bench
says whether one shallow tree got slower. Neither says what a deeper tree pays, and a cost per
leading directory grows with depth.

## How to apply

When a change touches code the walk calls once per entry, time that code alone against main's version, in one process.
Run the bench fixture at its own depth and again several levels deeper: a cost per level shows in the second.
Check that the variants return the same count before comparing their times.
Record both ratios in the design before the floor-twin gate is set.
Treat a ratio above 1 at either depth as a regression to fix in the change, whatever the command benches read.

## Evidence

`docs/design/is-ignored-leading-directory.md:628-634` — the three variants at two depths, with the
same count of ignored entries from each.
`test/bench/ignore-leading-directory.bench.ts:17-19` — the fixture: 20 packages of 10 libraries of
100 files, every entry two levels deep.
`docs/adr/1278-the-ignore-session-keeps-one-outcome-per-directory-chain.md` — the decision the
measurement led to.
