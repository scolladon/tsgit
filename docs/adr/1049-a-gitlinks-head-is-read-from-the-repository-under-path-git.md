---
subjects:
  - src/application/commands/add.ts
---
# 1049 — A gitlink's HEAD is read from the repository `<path>/.git` leads to

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** none

## Context

git's `add` stages a stage-0 gitlink whose submodule checkout HEAD differs from the index id
(design rows GL1–GL10); tsgit never reaches a gitlink. git resolves that HEAD through
`<path>/.git`, a directory or a gitfile, not through the `.gitmodules` name: an embedded clone
with no `.gitmodules` entry (GL17), a submodule added with `--name other` (GL18) and a replaced
repository (GL19) all stage.

## Options considered

1. **Read `<path>/.git`** — a directory is the gitdir; a gitfile goes through
   `parseGitfilePointer`, resolved relative to `<path>`; derive a child `Context` on that gitdir
   (as `buildChildContext` does) and call `resolveRef(child, HEAD)`, which covers packed refs, a
   symbolic HEAD and reftable. Pros: reuses bundled code, matches GL17–GL19. Cons: the gitfile
   may point outside the work tree, as it may for git — the read stays read-only. Designer's
   recommendation.
2. **Reuse `deriveSubmoduleContext`** (`.gitmodules` name → `.git/modules/<name>`) — misses GL17,
   GL18 and GL19.
3. **A minimal reader** (HEAD file, loose ref, `packed-refs`) — reimplements ref resolution and
   misses a reftable submodule.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- The security review checks the gitfile path handling: a pointer outside the work tree is
  followed read-only, never written.
- Nothing is staged when HEAD equals the index id, the directory is empty, or the repository has
  no commit (GL11–GL13, GL16); a skip-worktree gitlink is left (GL23).
