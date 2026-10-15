---
subjects:
  - src/application/primitives/materialize-tree.ts
  - src/application/primitives/read-head-tree.ts
---
# 987 — Public signatures stay on the decoded view

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-982

## Context

Carrying escaped paths through the merge engine reaches public functions: `materializeTree`'s
`paths`, `readHeadTree`, `mergeTrees`, `diffIndexAgainstTree`, `groupUnmergedEntries`.

## Options considered

1. **Keep every public signature on the decoded view; add internal escaped variants** (recommended).
2. Retype the public signatures to escaped keys (breaking).

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Same rule as ADR-982: escaped keys are
internal.

## Consequences

- No breaking change to the public API; internal variants carry the escaped keys.
