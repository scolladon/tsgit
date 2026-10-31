---
subjects:
  - src/repository/resolve-layout.ts
  - src/application/primitives/ref-store.ts
---
# 1139 — the gitdir spelling follows git run without a logical PWD

- **Status:** accepted
- **Date:** 2026-10-31
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-1126 and ADR-1129

## Context

fsck strips git's own spelling of the gitdir from a symlinked ref's realpath referent. Probed on
git 2.56.0, that spelling depends on `$PWD`: in a repository reached through a symlinked path
(`/var` → `/private/var` on macOS), `git fsck` run at the top with `PWD` set to the logical path, or
with `GIT_DIR=.git`, spells the gitdir logically, so a ref `refs/heads/link → main` gets
`badReferentName` and exit 8; with no `PWD`, or from a subdirectory, git spells it physically and
prints only `symlinkRef`, exit 0. tsgit canonicalises the caller's cwd before resolving, so it
always matches git run without a logical `PWD`. An absolute logical explicit `gitDir` already
matches git, because git keeps that spelling.

## Options considered

1. **Follow git run without a logical PWD** (reviewer's alternative) — pros: no process
   environment read in the library; one deterministic result per call / cons: a caller passing a
   logical cwd sees git's no-`PWD` result.
2. **Treat a caller cwd that names the same directory as its realpath like git's `PWD`** (git's
   `get_pwd_cwd` rule) — pros: matches git with `PWD` set / cons: the result then depends on how
   the caller spelled the cwd, a second source of truth the layout does not carry today.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The gitdir spelling fsck strips is
derived from the physical cwd, exactly as git derives it when `PWD` is absent or does not name the
cwd. An explicit absolute `gitDir` keeps its spelling, as git does.

## Consequences

- A symlinked ref in a repository opened through a logical cwd reports what `env -u PWD git fsck`
  reports.
- Matching git's `PWD` rule later means carrying the caller's cwd spelling on the layout.
