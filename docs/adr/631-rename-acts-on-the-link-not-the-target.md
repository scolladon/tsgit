# 631 — `rename` acts on the link, never the target

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-9) · **Supersedes/Refines:** —

## Context

`rename`'s src arm is guarded today by the read-shaped mode, which realpaths the leaf —
so the adapter renames the **resolved target**, not the link. Verified against Node
directly: `renameSync('link', 'moved')` moves the symlink (POSIX semantics), while
renaming the realpath moves the target and leaves the link dangling. `mv <symlink>`
therefore relocates the target file today — divergent from git and from POSIX. A live
bug, found by the design's write-surface audit.

## Options considered

1. **No-follow write guard — rename the link itself** (design recommendation).
2. Keep the realpath-follow — preserves a bug.
3. Fix in a follow-up — ships a rewrite of this exact line while knowingly leaving it
   wrong.

## Decision

**adopted-as-recommended (no user judgment).** Option 1. Both `rename` arms take the
write guard's leading-path containment (W1); neither arm realpaths its leaf. Renaming a
symlink moves the link and leaves the target in place — POSIX and git semantics.

## Consequences

- `mv <symlink> <dst>` becomes correct; pinned by a dedicated adapter test.
- The dst arm's semantics are unchanged (rename replaces the destination *name*).
