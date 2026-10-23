---
subjects:
  - src/application/commands/status.ts
---
# 1061 — `status` lists an untracked repository as its directory

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1054 and ADR-1059

## Context

`git status --porcelain` lists an untracked embedded repository as `?? sub/` (design rows
EM78–EM82); tsgit lists the files inside it.

## Options considered

1. **Pass the walk hook from `status` and list the directory with git's spelling** — the designer's
   recommendation, the same hook `add` uses.
2. **Change the walk only** — leaves `status` inconsistent with `add`.
3. **A separate item** — the user's standing rule is to include what sits on the perimeter.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- `stash` and the snapshot enumerator are unchanged; their twins are not pinned here.
