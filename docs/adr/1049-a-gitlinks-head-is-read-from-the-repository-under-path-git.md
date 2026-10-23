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
  followed read-only, never written. The review round pinned how: the child's filesystem is the
  facade's confined view over the resolved gitdir plus its common dir (the same capability linked
  worktrees use); on adapters without that capability (memory, browser) the parent filesystem is
  used, where such a pointer cannot exist. A `<path>/.git` symlink is classified by a following
  stat as git's `read_gitfile` does; a dangling or looping link, like a missing `.git`, means
  nothing is checked out. A `commondir` file is honoured (HEAD's branch and the config live in the
  common dir), and the child's `extensions.refStorage` is read from that config so a reftable
  checkout resolves through its own backend. The repository-format rules of the main repository
  apply to the child and refuse as git does (a bad or missing value, a version above 1, an unknown
  extension at version 1, a v1-only extension at version 0, a gitdir or common dir lacking
  `objects/` or `refs/`): the refusal is `NOT_A_REPOSITORY` or the config error, before any write.
- Once the child is a usable repository, a HEAD that cannot be resolved (a corrupt reftable stack,
  an unreadable `refs/heads`, a loose ref that is a symlink to non-ref content) leaves the recorded
  commit in place, as git's `resolve_gitlink_ref` returning a failure does; a symlinked leading
  component makes the entry a removal, as git's `has_symlink_leading_path` does.
- Nothing is staged when HEAD equals the index id, the directory is empty, or the repository has
  no commit (GL11–GL13, GL16); a skip-worktree gitlink is left (GL23).
