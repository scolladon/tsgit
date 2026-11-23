---
subjects:
  - src/application/commands/stash.ts
---
# 1240 — stash retires a clean out-of-pattern file as git does

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-E, R7, R8) · **Supersedes/Refines:** applies DOCTRINE D-2

## Context

With the bit cleared (ADR-1236), `stash push` on a present out-of-pattern file saves it, then
git's reset removes the file and marks it `S` (P1, P2); tsgit's reset passes no sparse matcher and
rewrites the file with `H`. `stash apply` of a change to a cleared clean out-of-pattern file
leaves git's file absent with `H` at the pre-apply blob (T2); tsgit leaves the stashed content.
The git step that removes the file in T2 is not yet traced.

## Options considered

1. **Fold both: the push reset applies the sparse patterns; apply reproduces T2's outcome**
   (recommended).
2. Fold the push reset, ledger T2 until traced.
3. Ledger both.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-2. Planning traces T2's
mechanism before the part is written; the interop row pins the outcome either way.

## Consequences

### Negative

- T2 removes a file the user can see, as git does (DOCTRINE D-4).
