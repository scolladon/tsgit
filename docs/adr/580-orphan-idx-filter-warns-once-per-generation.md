# 580 — The orphan-idx filter warns once per generation

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/plan/pack-v3-read-compliance.md (DC-9) · **Supersedes/Refines:** refines ADR-579

## Context

ADR-579's scan-time sibling-pack filter drops an orphaned `.idx` from the registry
generation, but is silent on whether that drop is logged. The arm has no error object —
it is a filter, not a fault — yet an orphaned `.idx` is a genuine repository anomaly
(git's `count-objects -v` calls it `garbage: 1` and prints
`warning: no corresponding .pack`).

## Options considered

1. **Silent filter** — fold the sibling test into the candidate predicate; mirrors git's
   silence on the read path; defensible on "a filter is not a fault".
2. **One warn per generation** (planner's recommendation) —
   `packRegistry: skipping pack index with no pack file` with the idx name; mirrors git's
   `count-objects` warning; gives the one shape where tsgit deliberately hides objects a
   diagnosable channel.
3. **Warn per lookup that would have hit it** — no mechanism at the scan layer; would
   re-introduce the lookup arm ADR-579 narrowed.

## Decision

Adopted as recommended: one structured `ctx.logger?.warn?.` per generation per orphaned
`.idx`. Per ADR-249 the logger channel sits outside the faithfulness boundary, so this
costs no faithfulness while honouring the no-swallowed-reason requirement.

## Consequences

The scan filter's `continue` gains a second independent test oracle beyond
`all().length`. Reverting to a silent filter is a one-line deletion plus one assertion.
