---
subjects:
  - src/application/primitives/types.ts
  - src/application/primitives/walk-commits.ts
  - src/application/primitives/walk-commits-by-date.ts
  - src/application/primitives/internal/commit-date-walk.ts
---
# 838 — `until` accepts a set as well as an array on both public commit walks

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-3) · **Supersedes/Refines:** none

## Context

Every caller that already holds a set of boundary commits spreads it into an array
(`until: [...marks.commits]`) only for the walk to rebuild a `Set` from it. The closure engine, the
not-side marker, cherry-pick, revert and rebase all do this. `WalkCommitsOptions.until` and
`WalkCommitsByDateOptions.until` are public.

## Options considered

1. **Widen to `ReadonlyArray<ObjectId> | ReadonlySet<ObjectId>` on both public walks** (recommended, chosen) — pros: non-breaking; removes every spread round trip; symmetric across the two walks / cons: a union type on a public option.
2. **Replace with a set-only type** — cons: breaking; every array caller changes for no gain.
3. **Widen `walkCommits` only** — cons: leaves the date walk rebuilding its set from an array while its sibling takes one by reference.

## Decision

**Adopted-as-recommended (no user judgment).** Both option types accept either shape. One shared
internal narrowing helper returns a set by reference and builds one from an array; the walk state
holds a `ReadonlySet` and only ever reads membership.

## Consequences

`reports/api.json` is regenerated in the slice that widens the type. Callers holding sets pass
them by reference — including a set that is still being filled, which is safe in the one place
that does it because a commit is added to it only after it has been yielded and yielded commits
are already visited. Array callers are untouched. Because the type widens, a green type check is
not a consumer sweep: the design lists every call site by value shape.
