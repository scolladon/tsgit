---
subjects:
  - src/application/primitives/apply-changeset.ts
  - src/application/primitives/find-would-overwrite.ts
  - src/application/primitives/internal/occupant-clash.ts
---
# 1076 — The changeset and merge pre-flights share one occupant classifier

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC2, P3, P4) · **Supersedes/Refines:** refines ADR-226

## Context

The unforced changeset pre-flight (`checkDirty`) and the merge-family pre-flight
(`findWouldOverwrite`) both decide whether an occupant blocks a write. Neither knows a leading
regular file. The merge pre-flight also follows a dangling leading symlink, so cherry-pick and
`stash apply` overwrite an untracked link that git 2.55 refuses to touch (design RC4, RC5). Once
ADR-1075 makes forced writes displace occupants, any occupant a pre-flight misses is deleted
instead of crashing the write.

## Options considered

1. **One internal module, `occupant-clash.ts`, used by both pre-flights.** Pros: one set of shape
   rules (leading obstruction, directory survivors, ignore rules); the two refusals cannot drift
   apart. Cons: `findWouldOverwrite` gains the merge's own deletions as input.
2. **Duplicate the rules in `find-would-overwrite.ts`.** Pros: no new module. Cons: two copies of
   git's `verify_absent` rules, which drift.
3. **Drop the merge's untracked branch and apply clean merges unforced.** Pros: one pre-flight.
   Cons: the merge family would return a different refusal type from its `would-overwrite` result.

## Decision

**Adopted as recommended (no user judgment): option 1.** `classifyOccupant` decides the class
first from the occupant's shape, then from its content, in git's order: `verify_absent` then
`check_leading_path`, and `verify_uptodate` then `ie_match_stat`. Both pre-flights call it. Each
refusal keeps one path per entry, sorted by `comparePaths`.

## Consequences

- `applyMergeToWorktree` and the merge conflict path pass the merge's resolved deletions as the
  removed set.
- `isDirtyUnder` and `isWorkingTreeDirty` keep their contract for sparse narrowing.
