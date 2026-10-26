---
subjects:
  - src/application/commands/checkout.ts
---
# 1090 — An unforced switch refreshes a touched entry's stat

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC4, F9) · **Supersedes/Refines:** refines ADR-226

## Context

After an unforced `checkout HEAD`, `checkout main`, `checkout t` or `checkout --detach main`, git 2.55 has refreshed
the index stat of an entry that was touched but whose content is unchanged. tsgit leaves the stat stale. Only the
index's stat cache differs; `ls-files -s` is equal. The fix is in the same function, `switchBranch`.

## Options considered

1. **Fold it.** After the two-way apply, refresh the stat of every stage-0 entry the switch kept whose stat drifted
   and whose content matches. Cost: one `lstat` per kept entry plus one hash per stat-dirty entry, the same as
   `git status`.
2. **Keep it out and file it.**

## Decision

**Adopted (no user judgment): option 1. This deviates from the design's draft recommendation.** It follows the
standing rule: a proven, in-perimeter faithfulness gap is folded, not filed.

## Consequences

- Every unforced switch pays the refresh. It is benchmarked in `test/bench/checkout.bench.ts`.
