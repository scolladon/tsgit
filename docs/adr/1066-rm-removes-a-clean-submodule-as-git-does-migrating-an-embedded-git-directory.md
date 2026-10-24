---
subjects:
  - src/application/commands/rm.ts
---
# 1066 — `rm` removes a clean submodule as git does, migrating an embedded `.git` directory

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** none

## Context

`git rm sub` on a clean submodule removes the directory, removes the `.gitmodules` section whose
`path` is `sub` and stages the file, and keeps `.git/modules/<name>` (design rows CO21, CO22,
CO30). When the submodule holds a `.git` directory, git first migrates it into
`.git/modules/<name>` (CO23). A moved, dirty or untracked-holding submodule refuses with local
modifications (CO24–CO26), an oversized gitfile dies (CO28), `--cached` touches the index only
(CO29). tsgit refuses every clean submodule today (`RM_LOCAL_MODIFICATIONS`); once the safety
valve is fixed, the removal step would refuse the directory instead (`CHECKOUT_OVERWRITE_DIRTY`).

## Options considered

1. **Full git behaviour** — valve parity, directory removal, `.gitmodules` section removal and
   staging, the `.git`-directory migration — the designer's recommendation. Pros: the pinned
   behaviour. Cons: the migration writes the module's `core.worktree` and a gitfile, the largest
   piece of the change.
2. **Full, minus the migration** — a `.git`-directory submodule refuses; an ADR would record the
   divergence on CO23.
3. **Valve parity only** — a clean gitlink still fails at the removal step: one wrong refusal
   traded for another.

## Decision

**The user chose option 1.** `rm` treats a gitlink's local modification as the HEAD comparison
being `modified` or `type-changed`, or any flag of the dirty check (ADR-1063) with the ignore mode
forced to `none`, as git's `bad_to_remove_submodule` counts untracked files; the dying gitfile
reader runs here too. A clean submodule is removed recursively, an embedded `.git` directory is
migrated into `.git/modules/<name>` first, the matching `.gitmodules` section is removed with the
existing section-removal text transform and the file is staged, and `.git/modules/<name>` is kept.
`--cached` changes the index only; `-f` removes a modified submodule the same way.

## Consequences

- The migrated module's on-disk state (its `config` with `core.worktree`, the gitfile git writes
  before removing the directory) is pinned by the CO23 twin, bytes included, during
  implementation.
- `.gitmodules` ends empty when the removed section was its only one (CO21); the staged blob is
  pinned against git's.
