---
subjects:
  - src/application/primitives/internal/gitlink-head.ts
  - src/application/commands/internal/submodule-absorb.ts
  - src/application/commands/internal/submodule-state.ts
  - src/domain/error.ts
  - docs/use/commands/add.md
  - docs/use/commands/status.md
---
# 1110 — a gitfile that names an invalid repository refuses with its own code

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F4, D-F4) · **Supersedes/Refines:** refines ADR-249

## Context

git 2.56's 54a441b ("read_gitfile(): simplify NOT_A_REPO error message") dies with
`fatal: gitfile does not point to a valid repository: <gitfile>` for every gitfile whose target is
not a repository, naming the gitfile (`sub/.git`) and never the target. 2.55.0 printed
`fatal: not a git repository: <target>`, and `(null)` on the discovery route. Pinned on 2.56.0: a
missing relative target, a missing absolute target, a module directory with a garbage HEAD and one
whose `commondir` names nothing all give the new line; a `.git` directory or symlink with a garbage
HEAD keeps `fatal: '<path>' not recognized as a git repository`. tsgit throws `NOT_A_REPOSITORY`
carrying the target, so the interop row cannot rebuild the line from the data.

## Options considered

1. **A new code `GITFILE_NOT_A_REPOSITORY { path }`, `path` the gitfile as git names it;
   `NOT_A_REPOSITORY` stays for discovery** — pros: one code per distinct git refusal, the data
   is self-describing / cons: one more code on the error surface.
2. **Keep `NOT_A_REPOSITORY`, set `path` to the gitfile, add `via: 'gitfile' | 'directory'`** —
   pros: no new code / cons: one code for three refusals told apart by a qualifier.
3. **Keep `NOT_A_REPOSITORY` and change only `path`** — pros: smallest change / cons: the test
   must infer the wording from the fixture; the data alone cannot.

## Decision

**User-ratified: option 1.** A gitlink whose `.git` file points at anything that is not a valid
repository refuses with `GITFILE_NOT_A_REPOSITORY { path }`, where `path` is the gitfile itself
as git names it (the gitlink path joined with `.git`). The directory and symlink routes keep their
"not recognized" refusal, and repository discovery keeps `NOT_A_REPOSITORY`.

## Consequences

- `gitlink-head`, `submodule-absorb` and `submodule-state` throw the new code on the gitfile
  route; `add` and `status` document it.
- The add-gitlink and status-gitlink interop rows rebuild git's line from `path` alone.
- Discovery inside a broken-gitfile worktree (`openRepository` on the submodule path) is not
  covered by any row and keeps its current data.
