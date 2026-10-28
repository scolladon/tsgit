---
subjects:
  - src/application/commands/stash.ts
  - src/application/primitives/walk-working-tree.ts
---
# 1102 — `stash push --include-untracked` removes untracked directories holding no file

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (review finding H1) · **Supersedes/Refines:** refines ADR-1099, ADR-226

## Context

git's `stash push -u` runs `clean --force --quiet -d :/` before its reset. Besides the untracked files it just
stashed, `clean -d` removes every untracked directory that holds no file: one that was already empty, one holding
only empty subdirectories, and the parent of a stashed file once nothing but empty subdirectories remains under it.
A directory holding a tracked file stays, and so does one holding only ignored files (no `-x`). tsgit removes the
stashed files and prunes the directories that removal emptied (ADR-1099 and the fold beside it), so a directory that
never held a file survives the push. Probes against git 2.55 pinned both sides: `emptydir/`, `nest/inner/` and `d/`
(holding `d/u` and an empty `d/e/`) are gone after git's push and present after tsgit's. tsgit's untracked walk
reports files only, so the push never learns of those directories. The design listed untracked empty directories at
push time as out of scope; the reviewer's probe made the gap concrete and the user chose to fold it.

## Options considered

1. **Report empty, non-ignored untracked directories from the walk and remove them, deepest first** — pros: git's
   end state on every probed shape; the removal reuses the pruning routine / cons: the untracked walker, a shared
   subsystem, gains a new kind of report; the change widens the PR beyond the stash command.
2. **Defer** (the designer's and orchestrator's recommendation) — pros: the PR stays within the stash command /
   cons: a proven gap on the function this change edits is filed instead of fixed.

## Decision

**User-ratified: option 1.** `stash push --include-untracked` removes every untracked directory git's `clean -d`
removes: a directory with no file under it (empty, or holding only empty directories), removed deepest first after
the stashed files, and the parents a removal leaves without any file. A directory holding a tracked file, or any
ignored file, is kept, and so is an ignored directory. The untracked walk reports the empty, non-ignored
directories the push needs; `status` keeps its own listing unchanged.

## Consequences

- The untracked walker exposes empty, non-ignored untracked directories to callers that ask for them; the stash
  push is the first caller. `status` output is unchanged.
- Interop rows pin the push on: a pre-existing empty directory, a nested empty chain, a stashed file beside an
  empty subdirectory, a directory holding a tracked file, a directory holding an ignored file, an ignored empty
  directory.
- One extra directory classification per empty untracked directory during a `-u` push; git's `clean -d` pays the
  same walk.
