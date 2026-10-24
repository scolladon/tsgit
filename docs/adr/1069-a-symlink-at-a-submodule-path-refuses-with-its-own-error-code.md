---
subjects:
  - src/domain/error.ts
  - src/application/commands/internal/submodule-state.ts
---
# 1069 — A symlink at a submodule path refuses with its own error code

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** none

## Context

When a tracked gitlink's path is a symlink, git 2.55's dirty check dies:
`error: expected submodule path 'sub' not to be a symbolic link`, exit 128 (design row SF9).
Under `--ignore-submodules=dirty` the same tree reports ` T sub` with worktree mode `120000`
(q4), so the refusal belongs to the dirty check, not to the comparison. tsgit has no error for
this condition.

## Options considered

1. **A new `SUBMODULE_PATH_IS_SYMLINK { path }`** — the designer's recommendation. Pros: names
   git's condition. Cons: one union member, about 30 B gzip, plus the exhaustiveness switches and
   the barrel-surface test.
2. **Reuse `NOT_A_REPOSITORY { path }`** — names a different condition.
3. **No refusal, report `T`** — diverges from git's exit 128.

## Decision

**Adopted as recommended (no user judgment) — option 1.** The member lands under `fix:` with the
rest of the change, by the user's ruling in ADR-1064.

## Consequences

- The error union, its exhaustiveness switches, the barrel-surface test and the documented error
  table change in the same part.
- With the ignore mode `dirty` or `all` the symlink is not refused and the row reads
  `type-changed` with the stat-derived mode.
