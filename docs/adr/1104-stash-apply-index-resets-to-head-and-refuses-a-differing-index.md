---
subjects:
  - src/application/commands/stash.ts
---
# 1104 — `stash apply --index` resets the index to HEAD and refuses when the index differs from HEAD

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC7, F15, Appendix A.7) · **Supersedes/Refines:** refines ADR-1101, ADR-212, ADR-226

## Context

When `--index` reinstates a staged state and the current index differs from HEAD's tree, git's `do_apply_stash`
runs `reset_head` (a mixed reset of the index to HEAD, stats refreshed) before the work-tree merge, then its
`unclean()` check refuses with "Your local changes to the following files would be overwritten by merge" for every
path where HEAD and the pre-reset index differed, prints "Index was not unstashed.", restores the untracked tree as
after any refusal and keeps the stash. The user's staging is left unstaged; the work tree is untouched. The check
precedes git's "Already up to date." early return. Three pinned rows (a second staged hunk, a staged new file, a
staged new file with W equal to its base) show tsgit applying where git refuses. When the index side is not
reinstated (I equal to B), git skips both the reset and the check, and tsgit matches.

## Options considered

1. **Replicate: mixed reset to HEAD, then refuse** — pros: git's refusal condition and on-disk index state (ADR-226);
   every file's content survives in the work tree, only the staging is lost, as in git / cons: tsgit reproduces a
   behaviour that discards a user's staging.
2. **Refuse as git does but keep the current index** — pros: protects the staging / cons: a recorded divergence on
   the index state.
3. **Leave it out of this change** — pros: smaller change / cons: a proven data-shape gap on the same `--index`
   step this change rewrites, filed instead of fixed.

## Decision

**User-ratified: option 1.** When the index-side judge returns a tree and the current index differs from HEAD's
tree, `stash apply` / `pop` with `restoreIndex` write a mixed reset of the index to HEAD (entries whose id and mode
agree keep their stat; the work tree is not written), then refuse `STASH_APPLY_WOULD_OVERWRITE` with
`localChanges` = every path where HEAD and the pre-reset index differ, in index order, and `untracked: []`; the
stash's untracked tree is restored as after any refusal and the stash is kept. The check runs before the W = base
early return.

## Consequences

- One more index write on the refusal path, matching git's `reset --quiet --refresh`.
- The refusal reuses the existing code and classes (ADR-1098); no new public surface.
- Interop rows pin the three shapes for `apply --index` and `pop --index`, with and without `-u`, and the I = B
  bound where neither tool resets or refuses.
