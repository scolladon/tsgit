---
subjects:
  - src/application/commands/add.ts
---
# 996 — add keeps every stage of other unmerged paths

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

During a conflict, `add <any path>` drops stages 1 and 2 of every other unmerged path: the existing
entries map is keyed by path alone (`readExistingEntries`), so the last stage wins and the rewrite loses
the others. git 2.55 keeps stages 1–3 of `f` after `add top`. Pre-existing, data loss, found while
pinning this change.

## Options considered

1. Separate backlog entry and design (designer's recommendation).
2. Fold it into this change.

## Decision

**User-ratified — option 2 (deviates from the design's recommendation).** `add` keeps every stage of
an unmerged path it does not stage; staging a path still collapses its stages to stage 0, as git does.
The fold is designed with its own pinned matrix in the revised design doc.

## Consequences

- Rows R10, R12 and R16 are re-derived with all stages present.
- Every add route and the conflict-resolution flow come under test for multi-stage preservation.
