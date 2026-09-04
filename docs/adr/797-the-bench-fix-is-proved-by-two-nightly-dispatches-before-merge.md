---
subjects:
  - .github/workflows/bench.yml
---
# 797 — The bench fix is proved by two nightly dispatches before merge

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D7) · **Supersedes/Refines:** none

## Context

`benchmark-snapshot` runs only on `push` to `main`, so nothing on a pull request exercises the
job that has been red. `bench.yml` accepts `workflow_dispatch` on any ref and runs the same
`test:bench` under the same fixture cache key. The failing case is specifically a *restored*
fixture that a later bench tags, so a single cold run does not reproduce it.

## Options considered

1. **Two `gh workflow run bench.yml --ref <branch>` dispatches, cold then restored**
   (designer's recommendation) — pros: the second run is the exact path that has been failing /
   cons: two runner slots.
2. **One dispatch** — cons: proves the cold path only.
3. **Label the pull request `bench` so `benchmark-compare` runs** — cons: base and head share
   one fixture cache and the base tree still mutates it, so the head side's guard fires every
   round; the job is `continue-on-error` and measures nothing here.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** Before merge the branch is dispatched
twice; the first run must miss the cache and cold-build, the second must hit the branch's own
entry. Both must be green, must not print `Failed to resolve 'HEAD~10'`, and must not print the
not-pristine warning.

## Consequences

- The pull request carries both run links as its evidence for the bench half.
- After merge, `main`'s first push pays one cold build (branch caches are not visible to
  `main`), then `benchmark-snapshot` resumes publishing to the benchmark-data branch.
