# 630 — `chmod` keeps a write guard and refuses a symlink leaf

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-8) · **Supersedes/Refines:** —

## Context

`chmod` is guarded today by the read-shaped mode (full leaf realpath) — but it is a
write that also **follows** the leaf: POSIX `chmod(link)` re-modes the target. Under the
read relaxation a lexical-only guard would let a symlink leaf re-mode a file outside the
tree, and no portable no-follow chmod exists (the no-follow variant is macOS-only).
This is exactly the write-path-symmetry trap the design checklist exists for.

## Options considered

1. **Leading-path containment (W1) + an explicit leaf `lstat` that refuses a symlink**
   (design recommendation).
2. W1 only, accepting that POSIX `chmod` follows the leaf — leaves the outside-re-mode
   hole open.
3. Leave it lexical like the reads — the silent outcome if nobody noticed.

## Decision

**adopted-as-recommended (no user judgment).** Option 1. `chmod` takes the write guard's
leading-path containment plus an explicit leaf `lstat`; a symlink leaf throws
`PERMISSION_DENIED`. Faithfulness cost is nil: git only ever chmods regular files — a
`120000` entry carries no exec bit.

## Consequences

- The one leaf-dereferencing write surface that cannot use `O_NOFOLLOW` still cannot
  reach outside the tree.
- One extra `lstat` per `chmod` — a cold write-path surface, not a hot read.
