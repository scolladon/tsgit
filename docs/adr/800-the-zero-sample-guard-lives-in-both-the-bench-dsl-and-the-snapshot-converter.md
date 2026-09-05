---
subjects:
  - test/bench/support/bench-dsl.ts
  - tooling/bench-to-snapshot.ts
---
# 800 — The zero-sample guard lives in both the bench DSL and the snapshot converter

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D1) · **Supersedes/Refines:** none

## Context

A benchmark whose measured function throws during warmup is reported by `vitest bench` as a
pass with an empty sample list and exit code 0: tinybench stores the warmup error on the task
and throws it only when its `throws` option is set, which vitest never sets, and the run phase
returns early on a stored error before any event fires. The fetch-pack scenario shipped in that
state and the only component that noticed was the publish action on `main`, rejecting a snapshot
entry that had no value. Two holes, two layers: the bench step passed while measuring nothing,
and the publish step trusted its input.

## Options considered

1. **DSL `throws: true` only** — pros: the bench step goes red at the source with the stack that
   names the scenario / cons: the publish step keeps trusting whatever reaches it.
2. **Converter refusal only** — pros: the published artefact can never carry a value-less entry /
   cons: a bench file keeps passing green while measuring nothing.
3. **Both** (designer's recommendation) — pros: each layer closes the hole the other cannot /
   cons: one more line in the DSL and one guard in the converter.

## Decision

**Ratified by the user: option 3.** The bench DSL passes `throws: true` in the options it
attaches to every bench it registers, so a warmup failure fails the file with its error visible.
The snapshot converter refuses, by scenario name, any raw entry that carries no sample and
therefore no value, so nothing without a value reaches the publish action.

## Consequences

A scenario that throws in warmup is now a red bench step, not a silent pass; its teardown does
not run (the already-accepted cost under ADR-791 and ADR-799, reclaimed by the explicit prune).
The run-phase hang that `throws` introduces is bounded by ADR-801. The converter's guard shape
is ADR-802.
