# 627 — Delete through a symlinked leading directory skips silently

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** docs/design/git-parity-containment.md (DC-5) · **Supersedes/Refines:** —

## Context

Pinned (git 2.55.0): `git checkout -f` to a branch that deletes `dir/file`, where `dir`
has been replaced by a symlink, exits 0, **skips the removal**, leaves the symlink in
place, and never touches the link target. tsgit today refuses the same operation via the
lstat-mode parent realpath (`PERMISSION_DENIED`).

## Options considered

1. **Skip the removal silently, like git** (design recommendation).
2. Refuse with `PERMISSION_DENIED` — safe but noisier than git; breaks a forced checkout
   git completes.
3. Leave `rm`/`rmRecursive` on today's lstat mode — unsafe after the read relaxation:
   without its realpath the mode would delete outside the tree.

## Decision

**adopted-as-recommended (no user judgment).** Option 1. The checkout/apply delete path
detects the symlinked leading component (same scan as ADR-626's, shared and memoised)
and skips the removal, exit-successful, exactly as git does. The adapter's write guard
(parent realpath) remains the backstop refusing an actual outside deletion.

## Consequences

- Forced checkouts that git completes now complete identically in tsgit.
- The outside target is provably untouched in both tools — pinned by the interop test's
  byte-identity assertion.
- A genuinely escaping delete still refuses at the adapter (defence in depth).
