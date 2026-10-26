---
subjects:
  - src/application/commands/rebase.ts
---
# 1086 — An emptied interactive pick stays outside this change

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC13, OS5) · **Supersedes/Refines:** refines ADR-1083

## Context

The `drop_redundant_commits` probe (A.5 E) exposed OS5: when a replay empties a pick, tsgit's
`rebase -i` commits it. `produceOnto` never compares the merged tree to HEAD's tree. git 2.55
stops on that pick instead.

## Options considered

1. **Keep OS5 out of this change** and raise it with the user, with the A.5 E proof.
2. **Fold it.** This adds git's empty-stop state machine and its `--continue` / `--skip`
   handling, none of which is pinned yet.

## Decision

**Adopted as recommended (no user judgment): option 1.** OS5 concerns empty-commit policy, not an
occupant in the way. The user's perimeter rule forbids pulling in behaviour outside the change's
perimeter, even in a file the change edits. As with OS1 and OS2, it reaches the user as a
warn-and-ask with its proof. It is not filed silently.

## Consequences

- P11 and P12 leave how `produceOnto` handles an emptied pick unchanged.
