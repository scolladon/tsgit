---
subjects:
  - src/application/primitives/materialize-tree.ts
---
# 1203 — A switch replaces a staged directory the target makes a file

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D7, R7(b)) · **Supersedes/Refines:** none

## Context

This is the mirror of ADR-1201: staged entries under `dir/`, and a target that holds a file `dir`.
git switches under either `core.ignorecase` setting (`verify_clean_subdirectory`): an up-to-date
entry is removed and the file written, a modified one refuses as a local change, and an untracked
file under `dir` refuses as untracked. tsgit refuses `untracked: ['dir']` in every case, and so
gives the modified case the wrong refusal class. The rows become reachable from an unborn HEAD
through this change.

## Options considered

1. **Fold it** (recommended): judge each staged entry below `dir` as a deletion. The routing change
   that ADR-1202 needs covers this case with no extra code path.
2. **Leave it out**: defer it as an impact.

## Decision

**ratified by the user**: option 1, applying doctrine D-2.
