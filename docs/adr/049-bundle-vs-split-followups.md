# ADR-049: Phase 14.5 — bundle 14 follow-up items into one PR

## Status

Accepted (at `50e6eed`)

## Context

The 14 items recorded under `docs/BACKLOG.md §14.5` came out of the
three review passes performed on §14.4. Each is a small, stand-alone
change:

- 4 perf items (string-alloc caching, parallel removeTree, resolve
  gating, parent-dir LRU).
- 4 TS refactors (rmRecursive double-containment, lstat pre-check,
  makePolicy typing, findLayout boundary).
- 5 security / errno items (symlink targets, EISDIR, isSymlinkLeaf
  parameter, ENOTEMPTY, `\\?\` prefix).
- 1 test coverage gap (openWithNoFollow(write) DI).

Three plausible delivery strategies:

1. **14 separate PRs.** Each item gets its own branch, design,
   reviews, mutation kill, and PR. Maximum reviewability per change
   but minimum throughput. Item dependencies (e.g., 14.5.10 changes
   error codes that 14.5.11 tests need to update) would force
   sequencing across PRs.
2. **Bundled by axis.** Three or four PRs grouped by theme (perf,
   refactor, security). Easier reviews per PR but still requires
   coordinating dependencies that cross axes (the rmRecursive
   refactor in 14.5.5 affects the parallel-walk perf in 14.5.2).
3. **One bundled PR.** Single branch, single PR, atomic conventional
   commits per slice. All 14 items reviewed and shipped together.

The §14.5 items all touch the same three files
(`src/adapters/node/node-file-system.ts`, `path-policy.ts`,
`fs-operations.ts`, plus the related tests). Splitting them into
multiple PRs would mean repeated rebases on every interim merge,
because every PR would touch overlapping lines. The atomic-commits-
in-one-branch pattern bundles the dependency graph into a single
linear history.

The author's standing preference (documented in `MEMORY.md`,
"single bundled PR" was confirmed the right call for the §14.4
follow-up branch) leans bundle-first when the changes share a single
area of the codebase.

## Decision

Bundle all 14 §14.5 items into one branch (`feat/phase-14-5`) and one
PR. Atomic conventional commits per slice — each commit message
references the §14.5.N item it implements. Slice ordering per design
§6 (refactors → errno → perf → security → coverage).

The bundled PR will be reviewed via the standard three-pass parallel-
agent pattern (typescript-reviewer + code-reviewer + security-
reviewer + perf review) and mutation-tested at the end.

## Consequences

### Positive

- One review cycle, not 14. The three-pass × four-reviewer pattern is
  expensive (12 sub-agent invocations); running it once instead of
  14 times conserves agent budget and keeps the merge tail short.
- Atomic commits inside the branch preserve per-slice reviewability.
  The reviewer can `git log --oneline` and see one concept per
  commit.
- No interim-merge rebases. Each slice rebases only on the previous
  slice in the same branch.
- Cross-slice dependencies (14.5.10 + 14.5.11 + locked-directory test
  update; 14.5.5 + 14.5.2 in the same hot path) land together
  without coordination overhead.

### Negative

- One large PR means one large diff at merge time. Mitigated by the
  atomic-commit history — squash-merge collapses to a single commit
  on `main`, but reviewers can read the unsquashed history during PR
  review.
- A reviewer who blocks on one slice blocks the whole bundle. Trade-
  off: if a single slice needs a rewrite, the others continue to
  ship together once that slice converges.

### Neutral

- The `[ ]` → `[x]` flip in `BACKLOG.md §14.5` happens in the bundled
  PR's own commits, per the project's "tick travels with
  implementation" rule.
- §14.5's parent (the `[ ] **14.5**` line itself) flips to `[x]`
  only when all 14 sub-items are `[x]` and the design + plan + ADR
  artefacts are in place. The bundled PR satisfies that condition.
