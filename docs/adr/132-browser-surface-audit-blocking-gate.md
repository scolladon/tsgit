# ADR-132: Browser-surface audit is a blocking gate, not warn-only

## Status

Accepted (at `75a0cde6`)

## Context

Three preceding audits chose warn-only postures:

- ADR-099 (path-based docs PR gate): warn-only until "one cycle of
  observation."
- ADR-125 (integration usefulness): warn-only because the heuristic
  is fuzzy and noise would block real work.
- 19.5 (parity-fixtures determinism): blocking, but only against a
  narrow nondeterministic-source detector.

The 19.5a audit must pick a side: warn-only (consistent with the
recent posture) or blocking (consistent with binary truths).

The signal it measures is binary. A surface name either appears in a
call site (or an allowlist entry) or it does not. There is no fuzzy
heuristic, no flaky external dependency, no cross-OS variance, no
runtime noise to absorb. The audit reads the source tree and the
allowlist, parses, sets-diffs, exits.

The cost of a missed regression is significant: a refactor that
silently drops a `repo.checkout` call from every browser spec would
go unnoticed until a user reports the bug, despite the parity
harness existing precisely to catch this.

## Decision

The `check:browser-surface` audit is **blocking**. The wireit script
runs in the `check` and `validate` aggregates; CI fails when the
audit exits non-zero. No warn-only grace period.

The ADR-099 / ADR-125 warn-then-promote pattern doesn't transfer
because:

1. The signal is crisp, not fuzzy.
2. The transition cost is paid upfront in this same PR: 31 gaps
   are either closed (parity scenarios) or allowlisted (transport,
   hooks). After the merge, the audit reports 0 gaps from the start.

## Consequences

### Positive

- New commands cannot land without a matching browser-reachable
  spec or an explicit allowlist entry — the contract enforces
  itself.
- Refactors that move call sites between files keep coverage
  visible: the report's `sources[]` list changes, but coverage
  doesn't drop.

### Negative

- A scenario that breaks at parse time (e.g., a syntax error in a
  new file under `test/parity/scenarios/`) could be misread as a
  coverage drop. Mitigated by `check:types` running before the
  surface audit in the wireit graph — TypeScript errors halt the
  validate chain first.

### Neutral

- The audit's runtime is sub-second on the current tree (filesystem
  read + two regex scans). Adding it to `validate` does not change
  local iteration latency in a measurable way.
