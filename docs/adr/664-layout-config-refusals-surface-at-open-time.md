# 664 — Layout-config refusals surface at `openRepository`

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D12)

## Context

A malformed `core.bare` (`bad boolean config value`) and a valueless `core.worktree`
(`missing value`) refuse in git on every command, because git's setup and command are
one invocation. tsgit splits setup (`openRepository`) from command; today the
malformed-boolean refusal fires at the first command via
`assertDiscoveryBooleansValid`, pinned by `config-boolean-interop` X11/X12/X14. The new
Stage-2 layout read needs these keys at open time.

## Options considered

1. **Refuse at `openRepository` (design recommendation)** — pros: Stage 2 *is* git's
   setup, and every observable git behaviour puts the refusal ahead of the command's
   work; never resolves a layout from a value about to be called invalid / cons: the
   three pinned tests move their assertion from the command call to the open call
   (codes and payloads unchanged; X12's key-ordering guarantee survives, since open
   precedes first command).
2. **At first command (today's timing)** — the layout is silently resolved from a value
   the library then rejects: `core.bare = banana` would briefly reproduce the
   fabricated-work-tree defect this feature removes.
3. **Split by key** — one git rule spread across two tiers by value type.

## Decision

**Option 1 — ratified by the user.**
