---
subjects:
  - src/application/primitives/detect-similarity-renames.ts
supersedes:
  - adr: "898"
    scope: "deferral of symlink-to-regular inexact pairing"
---
# 899 — Non-regular files leave the inexact scoring pools

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§2.2, §3.3, §4.4, D1) · **Supersedes:** ADR-898 · **Refines:** ADR-405

## Context

git's `estimate_similarity` scores 0 whenever either side is not a regular file, so a
symlink and a regular file holding the same blob never pair by similarity. tsgit excluded
only gitlinks (ADR-405) and paired the rest (row N-series of the design). ADR-898 deferred
the fix; the user folded it into this change.

## Options considered

1. **New ADR superseding ADR-898 and refining ADR-405** — *recommended by the design.*
2. Amend ADR-405 in place.
3. Amend ADR-898 into a decision.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Every non-regular mode (symlink,
gitlink, tree) is excluded from similarity scoring and blob hydration, in the rename, copy
and break pools alike. They keep participating in exact pairing (identical mode), in
basename-uniqueness counts and in the rename-limit counts, exactly as git does.

Superseded from ADR-898: the deferral — the exclusion ships in this change.
Carried forward from ADR-898: nothing — it only recorded the deferral.

## Consequences

- Row #11 of the exact-pass design (symlink ↔ regular, identical blob) now matches git.
- ADR-405's gitlink rationale stays true and becomes a special case of this rule.
