---
subjects:
  - src/repository/wrap-fs-validator.ts
---
# 1205 — The repository wrapper forwards the port's rmdir

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/gitlink-rmdir-keeps-occupant.md · **Supersedes/Refines:** none

## Context

A gitlink leaving the index is removed with git's `rmdir_or_warn`: a file or symlink standing at
its path stays, and git warns `unable to rmdir '<p>': Not a directory`. tsgit's removal path
already follows that rule (`removeGitlinkDirectory` → `removeEmptyDirectory`, which prefers the
port's `rmdir`), but `wrapFsValidator` forwards every `FileSystem` member except the optional
`rmdir`, so in production `removeEmptyDirectory` falls back to `rm` and deletes the occupant.
Pinned against git 2.56.0 under both `core.ignorecase` values on `reset --hard`, `checkout`
(forced and not), `stash push` (plain and `-u`), `merge` (ff and three-way), `cherry-pick`,
`revert` and a linked worktree.

## Options considered

1. **Forward `rmdir` through the wrapper behind the write guard**, as `utimeNow` is.
2. **Leave the wrapper; `lstat`-guard `removeGitlinkDirectory` only** — `rmdir` stays dead in
   production and every other `removeEmptyDirectory` caller keeps diverging.
3. **Fix inside `materialize-tree.ts`**, the locus the backlog entry named — that code already
   follows git's rule.

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off: option 1 fixes the defect where it
is (the member is unreachable) for every first-party adapter at once; 2 and 3 patch a symptom.
ADR-226 (git-faithfulness) applies.

## Consequences

- Every `removeEmptyDirectory` caller now refuses a non-directory in production, as the unit
  suites (bare memory adapter) already assumed.
- One more consumer changes behaviour (a symlinked reflog directory, ADR-1210).
