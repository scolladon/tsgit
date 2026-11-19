---
subjects:
  - src/application/commands/mv.ts
---
# 1221 — mv accepts a case-only rename under core.ignorecase

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (D5) · **Supersedes/Refines:** applies ADR-226

## Context

With `core.ignorecase=true`, `git mv f F` and `git mv d/g d/G` succeed: `builtin/mv.c` reads the
destination as existing only when `lstat(dst) == 0 && (!ignore_case || strcasecmp(src, dst))`.
tsgit refuses `MV_DESTINATION_EXISTS { source: 'f', destination: 'F' }`. With `false`, both refuse
unless forced, as tsgit does today.

## Options considered

1. **Fold git's `ignore_case` escape into `destinationFree`**, reading `core.ignorecase` once per
   call and grouping `force` with it in one policy record.
2. Report it as out of perimeter.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 and the run's brief, which put the
case-only rename family in scope; a pinned refusal mismatch on a well-formed repository.

## Consequences

A refusal git does not make is removed (ADR-1048: `fix`). The index-side check stays case-exact,
as git's is.
