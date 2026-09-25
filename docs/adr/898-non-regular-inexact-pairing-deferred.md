---
subjects:
  - src/application/primitives/detect-similarity-renames.ts
---
# 898 — Symlink-to-regular inexact pairing is deferred to its own change

- **Status:** accepted
- **Date:** 2026-09-25
- **Design:** docs/design/rename-exact-one-shot-delete.md (§10, D6) · **Supersedes/Refines:** none

## Context

Row #11: a deleted symlink and an added regular file with identical blobs pair through the
similarity pass. git's `estimate_similarity` scores any non-regular side 0. The fix touches
three pool builders shared with `-C` and `-B` and needs its own matrix.

## Options considered

1. **Follow-up** — extend ADR-405's gitlink exclusion to all non-regular modes. *Recommended by
   the design.*
2. Include it in this change.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Row #11 is a documented, unchanged
divergence in this change.

## Consequences

- The known divergence stays until the follow-up lands.
