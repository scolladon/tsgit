---
subjects:
  - src/application/primitives/internal/ignore-evaluator.ts
  - test/bench/ignore-leading-directory.bench.ts
---
# 1273 — The walk callers share the session predicate under a floor-twin gate

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (DC-2, §6) · **Supersedes/Refines:** serves ADR-1272; applies DOCTRINE(D-7)

## Context

`status`, `add` and `stash push -u` walk the working tree from the root and ask about every
directory, as a directory, before entering it. Each path they ask about has therefore had
every leading directory asked and answered "no", so the rule of ADR-1271 cannot change their
verdicts. The proof is in the design's Context section.

Sharing the session of ADR-1272 with them still costs something on a hot path: one more rule
match per distinct directory, and a verdict lookup per leading directory of every entry. git
pays the same double test, once when its walk meets the directory and once in `prep_exclude`.

## Options considered

1. **Share the session predicate; gate the added work with a bench row and a same-process
   floor twin, and compare `status`, `add` and `stash` before and after** (recommended).
2. Keep today's full-path predicate as a separate predicate for the walk callers.
3. Share the predicate, and seed the per-directory verdict from the walk's own directory
   question so no directory is matched twice.

## Decision

**User-ratified — option 1.** The floor twin is one full-path match per entry over the loaded
levels plus one directory match per distinct directory. Both rows are measured on the fixture
before the ratio is set, and the gate sits between the measured ratio and the ratio of a
session that tests the leading directories of every entry again. A regression the comparison
shows on `status`, `add` or `stash` is fixed in this change.

Refused: option 2 leaves two predicates that agree only while every walk caller prunes from
the root, and nothing enforces that; a second copy that drifted is the defect this change
fixes. Option 3 saves the match through a branch no test can tell apart, keyed on what the
caller says the path is.

## Consequences

### Positive

- One predicate answers the walk and the per-path probe.

### Negative

- One more rule match per directory on `status`, `add` and `stash push -u`.
- One more bench to run on a quiet machine.
