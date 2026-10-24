---
subjects:
  - src/domain/submodule/error.ts
  - src/application/commands/rm.ts
---
# 1073 — `rm` refuses to migrate an embedded repository whose path has no `.gitmodules` name

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-1066

## Context

ADR-1066 made `rm` migrate an embedded `.git` directory into `.git/modules/<name>` before
removing the submodule. git 2.55 takes `<name>` from the `.gitmodules` section whose `path` is
the entry's path and dies when there is none: `fatal: could not lookup name for submodule 'sub'`,
exit 128, nothing written (design row CO42, pinned in the main worktree and in a linked one). The
Part 14 implementation fell back to the path as the name and migrated where git refuses. tsgit has
no error for a missing `.gitmodules` mapping.

## Options considered

1. **A new member `SUBMODULE_NAME_NOT_FOUND { path }`** — the orchestrator's recommendation.
   Pros: names git's condition; the refusal happens before any write. Cons: one union member, the
   exhaustiveness switches, the barrel-surface test, the documented error table.
2. **Reuse `NOT_A_REPOSITORY { path }`** — the embedded repository is a valid one; the name is
   what is missing.
3. **Keep the path as the name** — migrates where git dies; a divergence on the on-disk layout.

## Decision

**Adopted as recommended (no user judgment) — option 1.** When a gitlink entry being removed has
an embedded `.git` directory and no `.gitmodules` row whose `path` equals the entry's path, `rm`
refuses with `SUBMODULE_NAME_NOT_FOUND { path }` before migrating, removing or editing anything.
A gitfile-based or empty submodule without a section is still removed, with `.gitmodules` left
alone (the Part 14 pin). The member lands under `fix:` with the rest of the change, by the user's
ruling in ADR-1064.

## Consequences

- The member joins the submodule error union, its message switch, the exhaustiveness switch and
  the error table.
- The migration's `core.worktree` is computed from the real module directory to the real
  working-tree path (design row CO43): in a linked worktree git migrates into that worktree's own
  admin directory (`.git/worktrees/<wt>/modules/<name>`, which is what `layout.gitDir` already
  names) and writes `../../../../../../<wt>/<path>`, a value the name-and-path helper cannot
  produce.
