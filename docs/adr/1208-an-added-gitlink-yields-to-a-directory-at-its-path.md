---
subjects:
  - src/application/primitives/internal/occupant-clash.ts
  - src/application/primitives/apply-merge-to-worktree.ts
  - src/application/commands/merge.ts
---
# 1208 — An added gitlink yields to a directory at its path

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/gitlink-rmdir-keeps-occupant.md · **Supersedes/Refines:** none

## Context

git's `verify_clean_subdirectory` returns early for a gitlink: a directory with content at an
added gitlink's path is the submodule's, not an untracked obstruction. tsgit's occupant judge
(`classifyAddedPath`) refuses it, so `checkout`, `merge --ff-only`, a three-way `merge`,
`cherry-pick` and `stash apply` refuse where git 2.56.0 succeeds (pinned under both
`core.ignorecase` values). This change's own stash-apply follow-up row exposed it.

## Options considered

1. **Fold**: `OccupantShape` `add` carries the result `mode`; a gitlink over a directory is clear.
2. **Defer** to the backlog (it clears the ADR-1170 bar: a wrong refusal on a well-formed repository).

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): the divergence sits in the shared
judge every consumer uses and this change's own pinned row is red without it; fold it whole with
unit rows and an interop pin per consumer. Removes refusals only, so it is not breaking (ADR-1199).

## Consequences

The `add` shape gains a required `mode`; `findWouldOverwrite` receives the result-side mode per
added path. A file in a gitlink's leading path still refuses.
