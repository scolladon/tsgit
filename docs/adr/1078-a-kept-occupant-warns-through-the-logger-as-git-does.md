---
subjects:
  - src/application/primitives/apply-changeset.ts
  - src/application/commands/internal/apply-sparse-checkout.ts
---
# 1078 — A kept occupant warns through the logger, as git does

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC4, P2, P6) · **Supersedes/Refines:** refines ADR-249

## Context

git 2.55 warns `unable to unlink '<path>'` when a forced delete meets a directory and keeps it. It
warns that a path is `already present` when sparse re-inclusion finds an occupant and keeps it. In
both cases the command still succeeds. The observable result is the kept occupant and the index
entry dropped or re-included.

## Options considered

1. **No warning.** The work tree and index are the data.
2. **`ctx.logger?.warn?.(…)` with git's text.** This follows 57 existing call sites, such as the
   rename-limit warning in `detect-merge-renames.ts`.
3. **A structured `retained` list on the results.** This changes the public result shapes.

## Decision

**Adopted as recommended (no user judgment): option 2.** ADR-249 binds the data a command
returns. A diagnostic sent to an optional logger is not returned data, and the repo already
follows this precedent.

## Consequences

- Neither the result shapes nor `api.json` change.
- Unit rows assert the logger call. Interop rows compare only the work tree and index state.
