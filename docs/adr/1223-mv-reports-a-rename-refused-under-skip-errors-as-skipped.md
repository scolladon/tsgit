---
subjects:
  - src/application/commands/mv.ts
---
# 1223 — mv reports a rename refused under skipErrors as skipped

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (N1) · **Supersedes/Refines:** refines ADR-1220, applies ADR-249

## Context

Under ADR-1220 a rename refused with `skipErrors` is swallowed: a refused file stays where it is,
and a refused directory's members are repathed in the index while the source directory is
deleted. git `-k` prints nothing for the refusal. Without a signal, a caller cannot tell from
`MvResult` that a directory was deleted.

## Options considered

1. **A `skipped` entry `{ source, reason: 'rename-failed' }` for a refused file or directory** — a
   new `MvSkipReason` member; a refused file is absent from `moved`, a refused directory's members
   stay in `moved` (the index truth).
2. Absence only — no API change, no signal for the deletion.
3. Keep the refused file in `moved`, mirroring git's `-v` line — the result claims a move that did
   not happen.

## Decision

Option 1, ratified by the user.

## Consequences

`MvSkipReason` gains `'rename-failed'`, typed so the planning-time `refusal()` mapping cannot
produce it. The release is already breaking (ADR-1222); the new union member rides under it.
