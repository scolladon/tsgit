# ADR-125: Integration audit ships warn-only, promote after one cycle

## Status

Accepted (at `9b109c1fecccf317fc4b017127fe6bedf849b26c`)

## Context

19.4 introduces an audit heuristic that touches every integration test file. Two posture options at land time:

1. **Land warn-only** (`gating.integrationProof: false`). Sweep cleans every existing file; CI prints findings but doesn't fail. After one merge cycle confirms no contributor lands a new violator, a follow-up PR flips the gate to `true`.
2. **Land blocking** (`gating.integrationProof: true`). The sweep PR enforces the gate from the first merge.

The project has rehearsed this decision four times already:

- ADR-099 (docs PR gate) — landed warn, promoted later.
- ADR-104 (pyramid audit report-only) — landed report-only by policy.
- ADR-114 (AAA semantic audit hybrid) — landed warn for known offenders, blocked for new ones during the sweep.
- ADR-118 / 119 (cancel-on-merge workflow) — landed live without an observation cycle because the failure mode is "wasted CI", not "broken test gate".

The audit's failure modes (missing header, duplicate, misplaced) are surfaced by a brand-new parser. Bugs in the parser would manifest as false-positive findings — a stuck PR with no obvious recourse short of editing the manifest. An observation cycle lets the team see the audit's output on real branches before the gate becomes load-bearing.

## Decision

Option 1: land warn-only. The sweep PR ships:

- The audit heuristic and the schema fields.
- The `@proves` header on all 21 existing integration files.
- `gating.integrationProof: false` in `test-pyramid-budgets.json`.

A follow-up PR, no earlier than the next phase boundary (19.5 or 19.5a), flips the gate after the audit has stayed clean across ≥ 1 merge cycle.

## Consequences

### Positive

- **Parser bugs are non-blocking.** If the audit reports a false positive on a clean file, no contributor is stuck.
- **Pattern consistency.** Same posture the project used three times before; no new operational vocabulary.
- **The follow-up PR is mechanical.** One-line manifest change with a green CI run already on `main`.

### Negative

- **A new violator can land between sweep and promotion.** Mitigation: the audit prints findings in the markdown report; reviewers see them on every PR. The cost of a missed finding is one round of clean-up before the promotion PR, not a buggy gate.

### Neutral

- **No explicit observation budget.** "One merge cycle" is the floor; the actual delay depends on what else is moving through `main`. The promotion PR is small enough to slot into any branch.
