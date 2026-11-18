---
subjects:
  - src/application/primitives/materialize-tree.ts
---
# 1213 — A dirty out-of-pattern file is left with a warning

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/sequencer-sparse-cone-writes.md · **Supersedes/Refines:** applies DOCTRINE(D-2), ADR-1199

## Context

When the patterns exclude a present, non-skip-worktree file that is not up to date, git keeps the
file and its `H` entry, warns `The following paths are not up to date and were left despite sparse
patterns:` and continues: `checkout` (dpsco) and a clean cherry-pick exit 0, a conflicted pick
stops on its conflict. tsgit's `checkout` refuses with `CHECKOUT_OVERWRITE_DIRTY`. The sequencer's
clean path calls `materializeTree` forced, which skips the dirty guard, so passing the sparse
matcher alone would silently delete the file (dpscp).

## Options considered

1. **Carry a dirty mover as a kept `H` entry in `materializeTree`'s mover partition and warn once,
   forced or not.** Fixes `checkout` too.
2. Pass `force: false` on the sequencer clean path; dpscp/dpscf refuse where git succeeds
   (breaking under D-3) and dpsco stays red.
3. Ship the sparse-only fix and ledger dpsco; loses user bytes.

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE(D-2) and ADR-226; option 3 loses data,
option 2 diverges.

## Consequences

`checkout`'s refusal on this shape disappears; a removed refusal is `fix` (ADR-1199). The warning
goes through `ctx.logger?.warn` as data (paths), per ADR-249.
