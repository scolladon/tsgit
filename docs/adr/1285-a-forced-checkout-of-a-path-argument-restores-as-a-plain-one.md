---
subjects:
  - src/application/commands/checkout.ts
---
# 1285 — a forced checkout of a path argument restores as a plain one

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-5, G-d, G-e) · **Supersedes/Refines:** applies DOCTRINE(D-5), ADR-1037

## Context

When `checkout <arg>` finds no revision and no guess, git treats `<arg>` as a pathspec and
restores the matched paths from the index (rows P1–P3, P5, P7), or reports `pathspec did not
match`. tsgit throws `PATHSPEC_NO_MATCH` without evaluating the pathspec. That line is the
guess's miss path, so D-5 folds it. With `-f`, git skips an unmerged path with a warning
(row U2); tsgit has no forced path restore, not even for `{ paths }`.

## Options considered

1. Build git's forced restore: skip unmerged entries with a warning (U2).
2. **Route `force` to the plain restore:** identical except on an unmerged path, which refuses
   as U1 does (`path is unmerged`); U2 goes to the divergence ledger (recommended).
3. Fold none of the fall-through.

## Decision

**Ratified by the user** — option 2. The plain fall-through is a fold under D-5 and reuses
`pathRestore`. Option 1 grows the change into a forced path-restore mode no caller can reach
today. Option 3 contradicts D-5. P1 overwrites a local change to the restored path, as git
does (DOCTRINE(D-4)).

## Consequences

### Positive

- `checkout({ rev: <tracked path> })` restores it as git does; `PATHSPEC_NO_MATCH` comes from a
  real pathspec evaluation.

### Negative

- U2 stays a divergence, recorded in `docs/known-divergences.md`.
