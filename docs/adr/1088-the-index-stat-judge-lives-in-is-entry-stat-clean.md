---
subjects:
  - src/application/primitives/internal/is-entry-stat-clean.ts
  - src/application/primitives/internal/occupant-clash.ts
---
# 1088 — The shared index-stat judge lives in `is-entry-stat-clean.ts`

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC2) · **Supersedes/Refines:** refines ADR-1075

## Context

The new stale-entry pass needs git's `ie_match_stat`, with assume-unchanged ignored. The tree already has that judge
as `matchesCachedStat` and `lstatBeyondLink`, both private to `internal/occupant-clash.ts`.

## Options considered

1. **Move both into `internal/is-entry-stat-clean.ts` and export them.** `occupant-clash.ts` imports them back.
2. **Move them into a new `internal/index-stat-match.ts`.**
3. **Reuse status's `compareAndRefresh`.** It hashes a stat-dirty file and reports a touched file clean, but git
   rewrites that file (T rows). Not faithful.

## Decision

**Adopted as recommended (no user judgment): option 1.** One module holds every stat rule, and two consumers use it.

## Consequences

- `occupant-clash.ts` behaviour is unchanged. Its tests still cover the moved functions through it.
- The racy-entry attribute provider is built lazily, once per pass.
