---
subjects:
  - src/application/commands/checkout.ts
  - src/application/commands/stash.ts
---
# 1091 — Path restore and `stash push` refuse and log as git does

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC5, F10–F12) · **Supersedes/Refines:** refines ADR-226

## Context

The matrix proved three more gaps on call sites this change edits:

- F10: `checkout -- f` on an unmerged `f`. git exits 1 with `error: path 'f' is unmerged` and keeps the index.
  tsgit succeeds and drops the stages.
- F11: `stash push` writes no HEAD `reset: moving to HEAD` reflog entry.
- F12: `stash push` on an unmerged index. git exits 1 with `error: could not write index` and stashes nothing.
  tsgit stashes and resets.

## Options considered

1. **Keep them out and warn-and-ask.**
2. **Fold them.**

## Decision

**Adopted (no user judgment): option 2. This deviates from the design's draft recommendation.** It follows the
standing rule: a proven gap on a touched surface is folded.

## Consequences

- Each refusal gets its own interop pin: the message class, and the index and work tree left unchanged. The design
  revision probes the exact refusal text.
