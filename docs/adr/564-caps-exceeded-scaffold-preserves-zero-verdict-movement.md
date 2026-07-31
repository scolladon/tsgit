# 564 — A temporary `capsExceeded` scaffold preserves the perf commit's zero verdict movement

- **Status:** accepted
- **Date:** 2026-07-31
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

ADR-554 makes "the perf commit moves no verdict" a load-bearing property — it is what
keeps the differential oracle clean and the perf diff cheap to review, and a blind-spot
check turns it into a mechanical test ("the perf commit's diff touches no divergence-ledger
entry"). ADR-558 then removed the caps from the scanner entirely. Those two pull in
opposite directions for exactly one commit: the perf commit's scanner no longer *has* the
cap rule whose verdicts it must reproduce.

## Options considered

1. **An observation scaffold** (designer's recommendation): the scanner carries two
   counters and one derived boolean through the perf commit; the **predicate** applies
   today's cap rule from them; the cap-fix commit deletes all of it.
2. **Relax ADR-554 for the cap family** — let the perf commit land the performance change
   and the cap verdict change together, and drop the mechanical check for those rows.
3. **Fix the caps first**, on today's asynchronous predicate, before building the scanner
   — then the perf commit is verdict-neutral against an already-fixed baseline.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. Roughly six lines of scaffold
that exist for exactly one commit.

## Consequences

Option 1 is the only mechanism found that honours ADR-554 and ADR-558 together without
reintroducing buffering, and the scaffold's deletion is itself the clearest possible
statement of the change — the cap-fix commit's diff reads as *"the caps stopped
deciding"*. The scaffold observes at line-emit rather than at the old pending-bytes
short-circuit, so its verdict-identity is not self-evident and is proved in the design
against all six pinned cap-family shapes rather than asserted. Option 2 was rejected as
forfeiting the property that made the perf slice safe to review at all, on precisely the
family where the oracle is most contested. Option 3 was rejected as the worst of the
three: fixing the caps on today's buffering predicate means deleting the pending-bytes
bail while the line buffer still exists — committing a known unbounded-buffering window,
even if only for the span of one in-branch commit.
