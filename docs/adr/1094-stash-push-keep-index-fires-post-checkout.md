---
subjects:
  - src/application/commands/stash.ts
---
# 1094 — `stash push --keep-index` fires `post-checkout`

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC7, F14) · **Supersedes/Refines:** refines ADR-226

## Context

git's `stash push --keep-index` fires `post-checkout <head> <head> 0`. tsgit fires no hook. Both sides are pinned.

## Options considered

1. **Fold it into the push tail.**
2. **Keep it out and warn-and-ask.**

## Decision

**Adopted as recommended (no user judgment): option 1.** It is a proven gap in the same function.

## Consequences

- `stash.push({ keepIndex: true })` runs the hook, a new side effect for its callers.
