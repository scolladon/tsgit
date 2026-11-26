---
subjects:
  - src/application/primitives/internal/ignore-evaluator.ts
---
# 1275 — The ignore session keeps one append-only stack

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (DC-3, §2) · **Supersedes/Refines:** serves ADR-1272

## Context

Today's loaders append each directory's rules to one stack shared by every query of a call,
and the match skips a level whose directory is not above the path. The session of ADR-1272 can
keep that stack, or build a chain of levels for each query.

With the shared stack, a verdict must not depend on which query loaded a level first. It does
not: a level is pushed only after every directory above it was tested and found not excluded,
and a level of the directory itself, of a directory beneath it or of an unrelated directory is
skipped by the match.

## Options considered

1. **Keep the shared append-only stack; a per-directory verdict decides whether a level is
   pushed** (recommended).
2. Build, for each query, the chain of the base levels and the levels of its leading
   directories that are not excluded.

## Decision

**Adopted-as-recommended (no user judgment)** — no trade-off for this fix: both options give
the same verdicts, and option 1 is the smaller change. Option 1.

Order independence is pinned by unit rows that ask the same paths in both orders and by a
property over permuted query lists.

Refused: option 2 changes the cost of every match, and nothing measured asks for it. It is
looked at again only if the bench of ADR-1273 shows the scan of the shared stack dominating.

## Consequences

### Positive

- The match and its precedence stay as they are.

### Negative

- A match still scans every level the session has loaded.
