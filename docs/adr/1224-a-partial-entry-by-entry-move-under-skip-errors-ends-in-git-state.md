---
subjects:
  - src/application/commands/mv.ts
  - src/application/commands/internal/working-tree.ts
---
# 1224 — A partial entry-by-entry move under skipErrors ends in git's state

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (N2) · **Supersedes/Refines:** refines ADR-1218 and ADR-1220

## Context

On an adapter without `renameDirectory` (ADR-1218), a write fault after the first leaf has moved
leaves part of the subtree at the destination. git's outcome for a directory whose rename fails
under `-k` is: index repathed, source deleted, nothing at the destination.

## Options considered

1. **Treat it as a refused directory rename and also remove what the partial move put at the
   destination**, so the disk matches git's.
2. Treat it as a refused directory rename and leave the moved entries at the destination.
3. Throw; skip only a refusal raised before the first move.

## Decision

Option 1, ratified by the user against the design's recommendation (option 2) — DOCTRINE D-4:
copy git's observable outcome, data loss included. The destination did not exist before the move
(mv refuses an existing one), so the removal deletes only what the move created.

## Consequences

Under `skipErrors` every adapter ends a failed directory move in git's state. Without
`skipErrors`, ADR-1218's documented partial move stands.
