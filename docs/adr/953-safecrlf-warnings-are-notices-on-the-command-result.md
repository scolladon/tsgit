---
subjects:
  - src/application/commands/add.ts
  - src/application/commands/stash.ts
---
# 953 — safecrlf warnings are notices on the command result

- **Status:** accepted
- **Date:** 2026-10-12
- **Design:** docs/design/eol-conversion.md · **Supersedes/Refines:** refines ADR-249

## Context

`core.safecrlf` defaults to `warn`: on every object-writing to-git route (add, stash push) git
prints `warning: in the working copy of '<path>', LF will be replaced by CRLF the next time Git
touches it` (or the CRLF/LF-swapped line) and proceeds; `false` is silent; comparison, blame,
renormalization and every to-worktree route never warn (§D1.6 of the design). Because `warn` is the
default, the notice fires on ordinary adds of CRLF files under `core.autocrlf`. tsgit has two
channels for such text: structured data on the command result (ADR-249) and the optional
`ctx.logger?.warn?.(message, context)` used for the rename-limit warning.

## Options considered

1. **Structured notices on the command result** — `AddResult.eolNotices` and the stash-push result
   carry one entry per path (recommended). Pros: ADR-249's shape, ordered, testable without a
   logger. Cons: a new result field on two commands.
2. **`ctx.logger.warn` with a context object** — the house precedent for informational text. Pros:
   no result change. Cons: optional, unordered, invisible to a caller without a logger.
3. **Both** — duplicates the same fact on two channels.

## Decision

**User-ratified — option 1.** `AddResult` gains `eolNotices: ReadonlyArray<EolNotice>` and the
stash push result the same field, each entry `{ path, loss, crlf, loneLf }` (the shape of
ADR-952), in git's processing order (index order). `core.safecrlf=false` yields an empty array;
`true` refuses instead (ADR-952); no route writes the notice to the logger. Comparison, blame,
renormalization, checkout and archive routes never produce a notice.

## Consequences

- Callers reconstruct git's warning line from the fields; the `add` and `stash` use pages document
  the field and the reconstruction.
- The logger channel remains for texts that have no command result to attach to; this ADR does not
  move the rename-limit warning.
- `add --renormalize` returns an empty `eolNotices` by construction — renormalization never checks.
