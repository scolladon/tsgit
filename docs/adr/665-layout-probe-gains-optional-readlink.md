# 665 — `LayoutProbe` gains an optional `readLink`

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (revisits ADR-659's residual at the user's direction)
- **Refines:** docs/adr/535 (probe minimalism), docs/adr/659 (HEAD content parsed)

## Context

ADR-659 chose to parse `HEAD` content and documented one residual divergence: git
judges a `HEAD` **symlink** by its link text (`refs/…` qualifies even when the target
is dangling; anything else disqualifies even when the target exists), which a probe
limited to a following `stat` plus `readUtf8` cannot see. The user directed closing
the residual in the same change rather than deferring it.

## Options considered

1. **Optional `readLink?` member on `LayoutProbe`; node implements it, sandboxed
   adapters omit it and keep the following-`stat` behaviour** — pros: closes the
   divergence exactly where it is observable (a physical filesystem); sandboxed
   adapters cannot express symlinked `HEAD`s anyway, so their omission is a
   documented no-op, and ADR-535's minimalism survives for them / cons: the walk pays
   one `readlink` per level on node (the probe checks link text first, like git's
   `lstat`-driven `validate_headref`).
2. **Mandatory `readLink`** — forces memory/browser adapters to stub a capability
   their filesystems cannot express.
3. **Keep the residual (ADR-659 as-was)** — the shape is real (`ln -s refs/heads/x
   .git/HEAD` pre-checkout is a git-recognised repository) and the user asked for it.

## Decision

**Option 1 — ratified by the user (the in-PR residuals directive).** The walk-cost
note changes from "one extra stat per miss level" to "one extra stat plus, on
adapters exposing `readLink`, one readlink"; pinned by the dangling-symlink and
outside-`refs/` interop rows.
