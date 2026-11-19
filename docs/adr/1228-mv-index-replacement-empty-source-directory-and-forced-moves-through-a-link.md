---
subjects:
  - src/application/commands/mv.ts
---
# 1228 — mv index replacement, an empty source directory, and forced moves through a link

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/mv-directory-one-rename.md (N7, N8, N9) · **Supersedes/Refines:** refines ADR-1227, applies DOCTRINE D-3 and D-4

## Context

Re-pinning ADR-1227's rows against git 2.56.0 (2/2) showed three more choices:

- Writing an index entry `P` removes every entry at a leading directory of `P` and every entry
  beneath `P/` (with or without `force`, with or without a link). tsgit leaves both, writing an
  index that holds `t` and `t/keep` together.
- A present source directory with no tracked member: git refuses `source directory is empty`;
  tsgit refuses `MV_SOURCE_NOT_TRACKED`.
- With `force`, `mv f lnk/description` where `lnk -> .git` overwrites `.git/description` through
  the link and records `lnk/description`.

## Options considered

- **N7** — report the replaced entries: (1) **no, `moved` unchanged**; (2) a new `replaced`
  field; (3) list them in `skipped`.
- **N8** — the empty source directory: (1) **fold with a new `MV_SOURCE_DIRECTORY_EMPTY` code and
  a `'source-directory-empty'` skip reason**; (2) ledger; (3) reuse `MV_BAD_SOURCE`.
- **N9** — the forced move through a link into the git directory: (1) **copy git**; (2) refuse
  inside the git directory; (3) refuse every forced move through a link.

## Decision

- N7: option 1, **adopted-as-recommended (no user judgment)** — ADR-249 and git, which reports
  nothing for the replaced entries.
- N8: option 1, **adopted-as-recommended (no user judgment)** — DOCTRINE D-3 and ADR-202's
  granular `MV_*` family.
- N9: option 1, ratified by the user after security sign-off, consistent with ADR-1226 and
  DOCTRINE D-4.

## Consequences

The index replacement closes a data-integrity defect (an index holding a path and a path beneath
it). The new code and skip reason widen public unions under the run's breaking marking
(ADR-1222). A forced move can write into the git directory through a tracked link, as git's does.
