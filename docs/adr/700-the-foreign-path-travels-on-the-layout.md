# 700 — The foreign path travels on the layout

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate DN-4) · **Refines:** ADR-678, ADR-684

## Context

The trust verdict is computed **once**, in `finishLayout`. `DUBIOUS_OWNERSHIP` is built later,
per command, off the frozen layout — and the requirement that the predicate not re-run per
command forbids recomputing it there. But ADR-678 ratified `untrusted?: true` as a *flag*, so
nothing currently carries the failing path that ADR-684 asks the error to report.

## Options considered

1. **One further present-only-when-present `RepositoryLayout` field**, beside `untrusted` and
   `implicitBare` — pros: follows the established idiom one line above; resolved once, read
   synchronously / cons: a third layout field.
2. **Widen `untrusted` from `true` to the foreign path** — pros: no new field / cons: breaks the
   neighbouring present-only-when-**true** idiom and changes a public field's type for existing
   consumers.
3. **Recompute at throw time** — cons: per-command `stat` calls, which the cost budget forbids,
   and it contradicts the one-verdict-per-open TOCTOU posture the threat model records.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`RepositoryLayout` gains a present-only-when-present field carrying the first foreign path, set
by the same single evaluation in `finishLayout` that sets `untrusted`.

## Consequences

- The verdict stays a single evaluation per `openRepository`, so the TOCTOU posture and the
  `stat` budget are both unchanged.
- Three layout fields now express open-time verdicts (`untrusted`, `implicitBare`, and this one),
  all following the same present-only idiom; `reports/api.json` is regenerated.
- Option 3 is not merely more expensive but semantically different: recomputing could return a
  *different* answer than the one the repository was opened under, which is exactly the
  inconsistency the single-evaluation rule exists to prevent.
