---
subjects:
  - src/domain/diff/line-diff.ts
supersedes:
  - adr: "563"
    scope: "edit-distance bail to a whole-file change"
---
# 909 — The line diff transcribes git's xdiff for every consumer

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 2, H3) · **Supersedes:** ADR-563

## Context

`computeMyersTrace` stops past an edit distance of 10 000 and reports every line changed
(4 × 32 MiB modifies: 4 194 304 lines vs git's 3 871 665). git's xdiff never bails: it caps
the search cost and splits heuristically. Below the cap, tsgit also lacks xdiff's multi-match
record cleanup (numstat differs) and change compaction (patch shape differs).

## Options considered

1. **Transcribe xdiff (classification, prefix/suffix trim, record cleanup, cost-capped split,
   change compaction) as the single engine behind numstat, patch, blame, merge, range-diff and
   patch-id** — *recommended by the design.*
2. Same engine for diff stat and patch only.
3. Lift the cap only.

## Decision

**Option 1 — ratified by the user.** Blame and merge rows are pinned against git before the
switch; any row that moves is escalated.

Superseded from ADR-563: the edit-distance bail to a whole-file change.
Carried forward from ADR-563: bounding cost by work done rather than input size — now git's
cost cap.

## Consequences

- Memory is linear in input; every line-diff consumer matches git byte-for-byte.
