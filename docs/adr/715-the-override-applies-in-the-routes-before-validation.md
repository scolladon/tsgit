---
subjects:
  - src/repository/resolve-layout.ts
  - src/repository/find-layout.ts
---
# 715 — the override applies in the routes, before candidate validation

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D7)

## Context

The caller's `commonDir` could be substituted in three places: inside each route function,
in `finishLayout` (via `LayoutOverrides`), or between the two by rewriting the
`WalkOutcome`. The discovery walk validates each candidate's shared dirs **at the common
dir** — so the substitution point decides whether the walk validates the value it actually
uses.

## Options considered

1. **In each route** (`resolveExplicitOutcome` + `layoutFor`/`findLayout`), before
   candidate validation (design recommendation) — pros: the only placement that puts the
   value in front of `sharedDirsValid`, which ADR-714 requires / cons: one extra parameter
   on `findLayout` and `layoutFor`.
2. **In `finishLayout`** as a `LayoutOverrides` field — pros: one site / cons: the walk
   accepts a candidate on evidence that no longer applies.
3. **In `resolveLayout`**, rewriting the outcome — same flaw as 2.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

Each route substitutes the caller's value for the file-derived one before any candidate
validation; `finishLayout` and every consumer downstream receive an outcome that already
carries the right value, unchanged.

## Consequences

- `findLayout`/`layoutFor` gain an optional `commonDir` parameter beside the existing
  optional `ceilingDirs`.
- No consumer below `finishLayout` line 258 changes at all — trust gate, format read,
  layout emission and containment roots are reached for free.
