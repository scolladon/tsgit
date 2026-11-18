---
subjects:
  - src/application/commands/stash.ts
  - src/application/commands/internal/unstage-changes-unless-new.ts
---
<!-- cspell:ignore stps unstaging -->
# 1216 — stash apply checks out skipped changes before unstaging

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/sequencer-sparse-cone-writes.md · **Supersedes/Refines:** applies ADR-226

## Context

A clean `stash apply` without `--index` writes an out-of-pattern path the stash changes and clears
its bit (rows st, sta): git's `unstage_changes_unless_new` step 2 checks out every changed merged
entry the merge left skip-worktree. Once the merge is sparse-aware, tsgit must replay that step;
an untouched present-despite-skipped file stays removed and `S` (stps).

## Options considered

1. **Sparse merge, then git's step 2 in `settleCleanIndex`.**
2. Run the no-`--index` clean merge without the matcher; stps stays red and the primitive needs a
   mode option.

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off: only option 1 matches git's sequence
on every pinned row.

## Consequences

Autostash (`applyAutostash`, `applyMergeAutostash`) inherits step 2, as git's `apply_autostash` runs
`stash apply`. A conflicted stash apply skips step 2, as git does.
