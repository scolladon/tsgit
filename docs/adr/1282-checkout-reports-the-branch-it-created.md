---
subjects:
  - src/application/commands/checkout.ts
---
# 1282 — checkout reports the branch it created

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-2) · **Supersedes/Refines:** applies ADR-249

## Context

A guessed checkout creates a branch and sets its upstream; git prints `Switched to a new branch
'feat'` and `branch 'feat' set up to track 'origin/feat'.`. `CheckoutResult` carries
`{ branch, id, detached, changedPaths }`, so a guessed switch and a plain switch to an existing
branch return the same data. `checkout -b` has the same gap.

## Options considered

1. **`createdBranch?: BranchCreateResult`** (`{ name, id, upstream? }`), set by `createBranch`
   and by the guess (recommended).
2. No field: the caller compares `branch` with what it asked for.
3. `guessedFrom?: RefName`, for the guess only.

## Decision

**Ratified by the user** — option 1. ADR-249 asks for the fields a display is rebuilt from; both
of git's lines come from `createdBranch` and its `upstream`. The type already exists, and `-b`
gains the same fact. Option 3 adds a second shape and leaves `-b` without it.

## Consequences

### Positive

- The caller can tell a branch was created and what it tracks.

### Negative

- Unit rows that compare a whole `-b` result gain the field.
