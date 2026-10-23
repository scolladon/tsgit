---
subjects:
  - src/application/commands/rm.ts
---
# 1042 — `rm` without `recursive` refuses by match level

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1012 and ADR-226; none superseded

## Context

git's `rm` computes each pathspec's best match level over the index. A level of
`MATCHED_RECURSIVELY` without `-r` dies `not removing '<spelling>' recursively without -r`
(exit 128), and that fires for a glob reaching a directory through the verbatim rule: `rm 'a?'`
with `a?/f` and no `ab` refuses (R4b), while `rm 'd*'` with `dir/f` removes it because the match
is `MATCHED_FNMATCH` (R6). tsgit applies the `-r` check to literals only; under the ADR-1033
verbatim rule a glob would silently remove `a?/f` without `-r`.

## Options considered

1. **Per-entry max match level, checked with the no-match check in argument order** (designer's
   recommendation) — `NONE` refuses `PATHSPEC_NO_MATCH`, `RECURSIVE` without `recursive` refuses
   `RM_RECURSIVE_WITHOUT_R`, `FNMATCH` and `EXACT` remove. Pros: R4, R4b, R6 as pinned; no data loss.
2. **Literals only** — `a?/f` is removed without `-r`.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `pathspecMatchLevel(entry, path)`
returns `EXACT`, `RECURSIVE`, `FNMATCH` or `NONE`; `rm` takes the maximum over the index per
positive entry and the first failing entry in argument order wins.

## Consequences

- R1–R8 become interop rows asserting the index and the working tree.
- The level helper is shared with the `add` seen pre-check (ADR-1035).
