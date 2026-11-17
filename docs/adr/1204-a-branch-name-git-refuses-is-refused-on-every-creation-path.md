---
subjects:
  - src/application/commands/branch.ts
  - src/application/commands/checkout.ts
---
# 1204 — A branch name git refuses is refused on every creation path

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md · **Supersedes/Refines:** refines ADR-1199

## Context

git's `strbuf_check_branch_ref` refuses a branch named `HEAD` or one starting with `-`
(`fatal: '<name>' is not a valid branch name`), for `branch <name>` and `checkout -b <name>`
alike. tsgit validates only the full `refs/heads/<name>`, so both names pass: `branch.create`
and a born `checkout -b` write `refs/heads/HEAD` or `refs/heads/-x`, and the new unborn
`checkout -b` writes HEAD as a symbolic ref to them. Pinned with git 2.56.0 during review.

## Options considered

1. **Fold on every path and mark it breaking** — one branch-name rule shared by
   `branchCreate` and the unborn switch; a refusal where tsgit returned is breaking (ADR-1190,
   doctrine D-3).
2. **Unborn path only** — keeps the PR non-breaking and defers the born paths.
3. **Fold and mark it `fix`** — departs from D-3.

## Decision

**ratified by the user** — option 1, `branch.create` included. The commit carrying the rule is
`fix(checkout)!:`; every other commit of the change stays `fix(…)`, so ADR-1199's "none
breaking" holds for all of them but this one.
