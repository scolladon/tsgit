---
subjects:
  - src/application/commands/internal/submodule-absorb.ts
  - src/application/commands/rm.ts
---
# 1074 — `rm` absorbs a symlinked `.git` by moving its target and writes the gitfile in place of the link

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-1066 and ADR-1073

## Context

ADR-1066 made `rm` migrate an embedded submodule repository into `.git/modules/<name>` before
removing the submodule, as git's `absorb_git_dir_into_superproject` does. The review round found
that a `sub/.git` which is a symbolic link to a repository directory was treated as that directory
and the link itself renamed into `modules/<name>`, leaving the checkout half-migrated (design row
RV27). git 2.55 resolves the link with `real_pathdup`, renames the directory it leads to, and then
calls `connect_work_tree_and_git_dir`, whose `write_file` opens `sub/.git` with `O_CREAT` and so
follows the now-dangling link: the `gitdir:` pointer lands as a new file at the link's old target —
outside the work tree when the link pointed there — while `sub/.git` stays a symbolic link to it.
tsgit's adapters open with `O_NOFOLLOW` and refuse to write through a symbolic link leaf, by the
containment rules ADR-298 and the write-side symlink policy fixed; writing the pointer at the
resolved target would create a file at a path the repository does not own.

## Options considered

1. **Move the target, replace the link with the gitfile** — the orchestrator's recommendation.
   Pros: the repository ends where git puts it, with the same `core.worktree`; the checkout stays
   reachable through a plain gitfile; nothing is written past the checkout. Cons: when the safety
   valve then refuses the removal, `sub/.git` is a regular gitfile where git leaves a link to a
   stray gitfile — both resolve to the same `modules/<name>`.
2. **Write the pointer at the link's old target, as git does** — byte-faithful on disk, but it
   writes a file outside the superproject at a location the link author chose, which the adapters'
   containment refuses and which no reader of the checkout needs.
3. **Refuse a symlinked `.git`** — safe, but it diverges on a path git accepts and leaves the user
   to repair the link by hand.

## Decision

**Adopted as recommended (no user judgment) — option 1.** When `rm` absorbs a submodule whose
`.git` is a symbolic link, it relocates the repository the link leads to (git's `real_pathdup`
target) into `modules/<name>`, removes the link and writes the gitfile at `sub/.git` as a regular
file. A link whose target already lies inside the superproject's git directory is left alone, as
git leaves it, and the checkout counts as not using a gitfile. This is the one place the change
diverges from git's on-disk state: no `gitdir:` file is created at the link's old target.

## Consequences

- Design row RV27 records the divergence; the interop twin compares the superproject's state
  (module directory, config, index, status) and not the stray file outside it.
- `rm` under `cached` never reaches the absorption, so a symlinked `.git` is untouched there.
- Any future writer that connects a work tree to a git directory (`submodule absorbgitdirs`,
  `submodule update`) inherits the same rule: replace a link, never write through one.
