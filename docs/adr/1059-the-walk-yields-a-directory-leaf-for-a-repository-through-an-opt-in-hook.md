---
subjects:
  - src/application/primitives/walk-working-tree.ts
---
# 1059 — The walk yields a directory leaf for a repository through an opt-in hook

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-030 and ADR-1054

## Context

A directory holding a `.git` of any kind must become a candidate for `add` without the walk
following symlinks or learning about the index, and a `.git` that leads to no repository must make
the directory ordinary (design rows EM31–EM36). The walk primitive is public.

## Options considered

1. **An optional hook on the walk's options, called for any directory holding a `.git` entry:
   `true` yields a directory leaf, `false` walks in, unset keeps today's gate** — additive public
   surface; the designer's recommendation.
2. **A callback after the walk** — cannot express EM31–EM36 (the walk has already skipped).
3. **A per-directory `lstat` in the ignore wrapper** — mixes a repository test into ignore rules.

## Decision

**Adopted as recommended (no user judgment) — option 1.** `status`, `stash`, the snapshot
enumerator and the public primitive keep today's gate unless they pass the hook (ADR-1061 for
`status`).

## Consequences

- `reports/api.json` gains the option; the walk's cost is unchanged for directories without a
  `.git` entry.
