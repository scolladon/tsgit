---
subjects:
  - src/application/commands/stash.ts
---
# 1209 — stash push -u stops its untracked walk at a gitlink

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/gitlink-rmdir-keeps-occupant.md · **Supersedes/Refines:** none

## Context

With an index-only gitlink `new` whose directory holds `new/x`, git 2.56.0's `stash push -u`
records no untracked commit and leaves `new/x` in place: the directory is the submodule's.
tsgit's `listUntracked` descends into it, stores `new/x` in the untracked tree and cleans it, so
the stash commit differs. `status` already agrees with git.

## Options considered

1. **Fold**: `listUntracked` prunes stage-0 gitlink paths through the walker's `ignore` option.
2. **Defer** to the backlog.

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE(D-1)/(D-2): the row is pinned by this
change on a command it already exercises (`push -u` is named by the entry), and the fix is local to
one function. Fold.

## Consequences

The `-u` stash commit's SHA matches git's when a gitlink directory holds content.
