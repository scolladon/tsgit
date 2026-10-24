---
subjects:
  - src/application/primitives/compare-working-tree-entry.ts
  - src/application/primitives/internal/scan-tracked-entries.ts
---
# 1067 — The symlinked-leading-path check is one memoized scanner per scan

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** none

## Context

A tracked path below a directory that became a symlink is deleted for git (`check_removed` →
`has_symlink_leading_path`; design rows ST20, ST21) and `?? d` is untracked. tsgit reads the
gitlink as `modified` and the plain file as clean: the comparison follows the symlink. The fix
lives in `compareAndRefresh`, on `status`'s hot path, and
`createLeadingPathScanner(ctx).hasSymlinkedLeadingPath(path)` already implements the check for
apply-changeset, memoizing one verdict per directory.

## Options considered

1. **One scanner per scan, passed through `ComparisonScope`** — the designer's recommendation.
   Pros: sibling entries share the directory verdicts; the shape apply-changeset uses. Cons: a
   new optional scope member.
2. **A fresh scanner per `compareAndRefresh` call** — repeats the `lstat`s per sibling.
3. **Check only when the parent chain holds a symlink the untracked walk found** — couples the
   tracked scan to the walk's order.

## Decision

**Adopted as recommended (no user judgment) — option 1.** `ComparisonScope` gains an optional
scanner; `scanTrackedEntries` creates one per scan and passes it; a consumer that passes none gets
a scanner created for the call, so correctness never depends on the scope.

## Consequences

- The check runs before the `lstat` verdict for every mode, so a plain file under a symlinked
  parent reads `absent` too.
- The cost is measured with `npm run bench:ab` against the previous commit once the part lands.
