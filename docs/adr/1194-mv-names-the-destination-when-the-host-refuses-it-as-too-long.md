---
subjects:
  - src/application/commands/mv.ts
  - src/application/commands/internal/working-tree.ts
---
# 1194 — mv names the destination when the host refuses it as too long

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/long-pathspec-refusals.md (D4) · **Supersedes/Refines:** none

## Context

`mv base S300`: git 2.56 exits 128 with `renaming 'base' to 'S300' failed: File name too long`,
state unchanged. With the caps gone the node rename raises `PATH_TOO_LONG { path }` naming the
absolute SOURCE, which is not the operand that is too long. `mv base P5000` refuses
`MV_DESTINATION_DIRECTORY_MISSING` (`lstatOrUndefined` reads the too-long parent as missing);
narrowing that helper would turn the missing-long-source row into `PATH_TOO_LONG` where git says
bad source.

## Options considered

1. **Leave the scratch behaviour** — a `path` naming the wrong operand.
2. **Re-raise `pathTooLong(<destination, repo-relative>)`** (recommended) — one catch, no union
   change; the P5000 row unchanged.
3. **A new `MV_RENAME_FAILED { source, destination }`** — a union member for one errno.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-249 (fields carry the right data) and no
trade-off beyond mechanics. Both rows refuse with index and disk unchanged; `mv -n` returns the
plan as git's dry run does. The catch wraps only the leaf rename inside `moveNode`, so a too-long
source descendant of a directory move keeps naming itself.

## Consequences

### Neutral

- The P5000 row keeps `MV_DESTINATION_DIRECTORY_MISSING`: same refusal and state as git, a
  different code.
