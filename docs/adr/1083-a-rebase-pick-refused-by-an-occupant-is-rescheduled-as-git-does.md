---
subjects:
  - src/application/commands/rebase.ts
---
# 1083 — A rebase pick refused by an occupant is rescheduled, as git does

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC9, OS3) · **Supersedes/Refines:** refines ADR-1079

## Context

The design probe (A.5 U1b) found that git 2.55 handles a pick refused by an untracked occupant
during an interactive `rebase --continue` by rescheduling it: both the todo list and `done` carry
`pick X`. tsgit refuses up front with the same class, paths and work tree, but leaves `done` ending
in the previous `edit` line. A later `rebase --skip` then takes a different route from git.

## Options considered

1. **Fold:** the interactive continue writes git's reschedule when its pick is refused.
2. **Keep it out of the perimeter** and file it only with the user's consent.
3. **Fold it together with the todo-grammar issues** (`break`, the merges-aware continue).

## Decision

**Option 1, by the user's fold rule, which deviates from the design's recommendation.** This
change's own probes exposed the defect, and it sits on the occupant refusal path the change
rewrites. The todo-grammar issues are a separate subsystem. They stay out of the perimeter and go
to the user as a warn-and-ask.

## Consequences

- Interop rows cover the rescheduled state end to end: refuse, then `--skip` or `--continue`.
