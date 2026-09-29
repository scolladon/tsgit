---
subjects:
  - src/application/commands/blame.ts
---
# 895 — Blame detects renames with the blamed path as the sole destination

- **Status:** accepted
- **Date:** 2026-09-25
- **Design:** docs/design/rename-exact-one-shot-delete.md (§4.3, D3) · **Supersedes/Refines:** none

## Context

Blame's `renamedSource` runs full-tree rename detection and looks for a rename landing on the
blamed path. It follows fan-out copies today only because of the #300 bug; after ADR-893 only
the first copy would follow (row B1). git blame uses `single_follow`: the blamed path is the
only destination, so every copy traces back to its source.

## Options considered

1. **Public `followPath` rename option** — right once a second follower exists.
2. **Blame-local restriction** — raw diff, keep every delete plus the add at the blamed path,
   hand that to `detectSimilarityRenames`. *Recommended by the design.*
3. **Accept the regression.**

## Decision

**Option 2 — adopted-as-recommended (no user judgment).** No public surface is added; blame is
the only follower today (YAGNI).

## Consequences

- Blame matches git for exact and inexact follows of fan-out copies.
- Unrelated adds in a commit no longer count toward the rename limit of a blame lookup,
  matching git's `num_create = 1`.
