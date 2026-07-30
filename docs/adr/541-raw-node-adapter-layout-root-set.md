# 541 — Raw node adapter confined to the layout root set

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-535/ADR-537; revises the design's original §3 rooting; refines ADR-495 (commonAncestor's discovery role retired)

## Context

The design originally rooted the raw `NodeFileSystem` at the common ancestor of
the layout roots, treating the facade's multi-root `wrapFsValidator` as "the
real gate". Review verified an exploit: the validator is purely lexical, while
the adapter's realpath check is the only symlink-aware containment layer —
rooting it at the ancestor let a symlink inside a linked worktree read and
write anywhere under that ancestor (degrading to `/` for cross-top-level
layouts), where real git refuses (`pathspec … is beyond a symbolic link`).

## Options considered

1. **Generalise `NodeFileSystem` to a containment root set and pass `layoutRootsOf(layout)` verbatim** (chosen) — pros: realpath containment bounded to exactly the layout roots (R8); normal repos collapse to `[workDir]`, byte-identical / cons: N-way loop on the containment hot path (roots are minimised, so N=1 for normal repos).
2. **Keep the ancestor rooting; make the facade validator symlink-aware** — pros: adapter untouched / cons: duplicates realpath logic at the wrong layer and leaves `unsafeRawAdapters` consumers wide open.
3. **One adapter per root** — pros: no adapter change / cons: every call site must pick the right instance; cross-root operations break.

## Decision

The raw node adapter (and `makeWorktreeFs`) takes a **root set**: first root is
primary (relative-path base); containment passes when the path is under any
root, raw or canonical. A root that does not yet exist derives its canonical
prefix from the realpath of its nearest EXISTING ancestor plus the missing
tail (needed by `worktree add`, whose target may sit beneath a symlinked
ancestor such as macOS `/tmp`); non-ENOENT realpath errors still surface. An
empty root set fails closed.

## Consequences

`commonAncestor` lost its last production consumer and has since been deleted
(the refactoring pass); ADR-495 is marked deprecated with a forward pointer
here — its drive-letter / mixed-separator / case-fold comparison algebra now
lives entirely in `PathPolicy` + the adapter's containment, and
`docs/design/common-ancestor-windows-paths.md` stays as historical record.
ADR-495's cross-volume
limitation no longer applies to the adapter root: each volume's root stands on
its own. Through-adapter symlink escapes from linked worktrees are refused
exactly as in a normal repo, pinned by unit and integration regressions; the
guarantee is through-adapter — the pre-existing per-parent realpath-cache
TOCTOU under a concurrent external writer is recorded in the design's
Out-of-scope and is not widened by this decision.
