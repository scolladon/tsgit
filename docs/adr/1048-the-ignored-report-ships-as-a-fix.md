---
subjects: []
---
# 1048 — The ignored report ships as a `fix`, not a breaking change

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1046

## Context

Today `add(['ignored.txt'])` stages an ignored untracked file by its literal spelling, a pinned
behaviour (`add.test.ts`, row I1). Under ADR-1046 the same call reports the path and stages
nothing unless `force` is set, as git does. The change is observable by a consumer that relied on
the literal bypass, and the brief excluded breaking changes, so the release class was the user's
call.

## Options considered

1. **Ship as a `fix`** — the bypass of ignore rules is a git-faithfulness defect like the other
   refusal and staging corrections this change ships (B1, R2, C6); `force` (ADR-1047) keeps a
   route to stage an ignored file. Designer's recommendation.
2. **Report on the walk route only until a major** — `add x.log` would stage while
   `add x.log '*.txt'` reports: behaviour split by route; I1–I4 and I9 stay divergent.
3. **Hold the whole report for the breaking batch** — I1–I16 stay open.

## Decision

**Ratified by the user — option 1.** The ignored report, the end of the literal bypass and the
`force` wiring ship together as `fix` commits; no `!` marker, no major.

## Consequences

- The changelog entry names the literal case so a consumer relying on it reads the new `force`.
- The same reasoning applies to the sparse report of skip-worktree entries (R13).
