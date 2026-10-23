---
subjects:
  - src/application/primitives/walk-working-tree.ts
  - src/application/commands/add.ts
---
# 1055 — A `.git` symlink in an untracked directory is classified by one stat, never walked through

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-031 and ADR-1054

## Context

git classifies a directory's `.git` with a following `stat`: a symlink to a repository makes the
directory an embedded repository (design rows EM24–EM26) and a symlink to a repository with no
commit refuses (EM27). tsgit's walk never follows symlinks (ADR-031, carried forward by ADR-1054);
today it walks into such a directory and stages its files. The tracked-gitlink probe already
follows a `.git` symlink with one read-only stat through the confined derived filesystem
(ADR-1049), a model the security review verified.

## Options considered

1. **One read-only `stat` of the `.git` entry through the link, as git does and as the tracked
   probe already does; the directory itself is never walked through** — the designer's
   recommendation.
2. **Keep walking into such a directory** — stages files git treats as a submodule's.
3. **Treat any `.git` symlink as a marker without classifying it** — hides files git stages when the
   link is dangling.

## Decision

**Adopted as recommended (no user judgment) — option 1.** The classification follows the link
once, read-only, through the facade's path probe; the walk still never descends through a symlink.

## Consequences

- A dangling or looping `.git` symlink makes the directory plain, as for git.
- The containment reasoning of ADR-031 holds: one bounded stat, no read of the target's content
  outside the confined derived filesystem.
