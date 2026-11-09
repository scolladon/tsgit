---
subjects:
  - src/application/primitives/update-ref.ts
  - src/domain/error.ts
---
# 1169 — the lock refusal carries REF_LOCKED with the name given

- **Status:** accepted
- **Date:** 2026-11-08
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1164

## Context

git's shared-lock refusal prints `cannot lock ref '<n>': Unable to create '<path>.lock': File
exists.` where `<n>` is the name the caller gave (`ref_update_original_update_refname`,
refs.c:3150) and `<path>` the colliding loose file. tsgit already has a `REF_LOCKED` error
shape carrying a `name`.

## Options considered

1. **Reuse `REF_LOCKED { name: <the name given> }`** — pros: an existing shape; the path is
   derivable from `refLocation(name)` by any caller that wants to print git's line. The
   designer's recommendation.
2. **A new error shape carrying the colliding path too** — cons: a second shape for one
   refusal; the path duplicates what the locator computes.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-249 (structured data; the caller
renders) and no trade-off beyond mechanics: option 1.** The collision refuses with
`REF_LOCKED` whose `name` is the name the caller gave, prefixed or bare, before any file is
written; the compare-and-swap refusal keeps precedence over it.

## Consequences

- No new error code; the interop rows rebuild git's line from `name` and `refLocation`.
