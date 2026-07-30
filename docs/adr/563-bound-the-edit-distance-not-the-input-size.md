# 563 — Bound the edit distance, not the input size

- **Status:** accepted
- **Date:** 2026-07-31
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

`MAX_DIFF_LINES` had to be settled once, for two independent reasons: ADR-560 retires it
as the cause of the two arms disagreeing, and ADR-561 needs it faithful for counts.
Measurement moved the question. The current `M + N > MAX_DIFF_LINES` input-size pre-check
protects nothing for the common shape — a 50 000-line pair with a one-line edit costs
3.6 ms and 7.8 MB, and two lines larger it refuses outright. The real worst case is
edit-distance-driven and is **reachable today under the cap**: a fully-different pair
costs 958 ms and 769 MB, because `iterationBudget = (M + N) × MAX_DIFF_ITERATION_FACTOR`
makes worst-case trace memory linear in input size. A 70 000-byte line through `diffLines`
costs 0.2 ms, so `MAX_LINE_BYTES` buys nothing on the diff path at all.

## Options considered

1. **Keep the input-size pre-check at 50 000** — cons: leaves the count divergence
   half-fixed. Every over-`MAX_LINES` file is over `MAX_DIFF_LINES` too, so removing the
   `isBinary` caps alone converts "wrongly binary" into "wrongly degraded" on five of six
   surfaces — and on three-way merge that means a whole-file conflict region where git
   auto-merges **clean**, arguably worse than today.
2. **Delete the input-size pre-check; activate the already-exported, currently-inert
   `MAX_DIFF_EDIT_DISTANCE = 10 000` as a live edit-distance bail in `computeMyersTrace`,
   re-basing `iterationBudget` on an absolute constant** (designer's recommendation);
   `MAX_DIFF_LINES` stays exported at 50 000, export-only.
3. **Raise `MAX_DIFF_LINES`** to a large constant, keeping the pre-check's shape — cons:
   re-values a public constant whose *literal value is its type* (`reports/api.json` churn
   plus a public type change), moves the cliff instead of removing it, and multiplies
   worst-case trace memory roughly twentyfold because the budget is proportional to
   `M + N`.

## Decision

**Option 2**, ratified by the user, at the constant's **existing** value of 10 000 rather
than a tightened one.

## Consequences

Today's bail at the cap already sits at `d ≈ 10 000`, so activating the constant at its
existing value reproduces the current ceiling **exactly** while removing its dependence on
input size — the change is faithful where it matters and worst-case-neutral where it does
not. The 958 ms / 769 MB worst case is therefore **inherited, not introduced**, but it is
inherited deliberately and with the number known; tightening the constant was offered and
declined, and would have been a behaviour change (more pairs degrading than today) rather
than a bound correction. `internLines` and the `2(M + N) + 1` `v` array are now paid on
arbitrarily large inputs — both O(M + N), the same order `splitLines` already pays,
measured at 0.3 ms and roughly 3 MB for a 200 002-line pair. No public constant is
re-valued, so `reports/api.json` should not move on this account; if it does, something
else leaked.
