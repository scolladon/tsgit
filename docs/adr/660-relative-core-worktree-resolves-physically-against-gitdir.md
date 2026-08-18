# 660 — Relative `core.worktree` resolves physically against the gitDir

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D8)

## Context

git resolves a relative `core.worktree` by `chdir`ing to the gitDir, `chdir`ing to the
value, and taking `getcwd()` — physical resolution. Pinned consequences: the failure
message names the relative value (`cannot chdir to '../wt'`), and a symlinked work tree
resolves to its real path (`core.worktree = ../../wt-link` yields the target's
realpath).

## Options considered

1. **Resolve against the gitDir, then canonicalise — realpath on node, lexical on
   sandboxed adapters (design recommendation)** — pros: matches every pinned row;
   applies ADR-537's established node/sandboxed split to one more path / cons: none.
2. **Lexical resolution everywhere** — diverges on symlinked work trees and
   reintroduces the realpath-comparison mismatch ADR-537 fixed.
3. **Resolve against cwd** — measurably wrong: git fails on `../wt` precisely because
   the cwd-relative answer is not what it computes.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Pinned by measurement;
aligned with ADR-537.
