---
subjects:
  - src/application/commands/internal/resolve-pathspec.ts
  - src/domain/working-tree-path.ts
---
# 1196 — The long-pathspec change ships as a fix

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/long-pathspec-refusals.md (D6) · **Supersedes/Refines:** none

## Context

The change removes two `INVALID_OPTION` refusals and moves long names from
`PATHSPEC_OUTSIDE_REPO` to success or `PATHSPEC_NO_MATCH`. No union member, type or `api.json`
entry changes. ADR-1048 shipped a removed refusal as `fix`; ADR-1190 counted a new refusal as
breaking.

## Options considered

1. **`fix:`** (recommended) — refusals git does not make are removed; codes move between existing
   members.
2. **`fix!:`** — counts a changed refusal code for an input class as a contract break.

## Decision

**ratified by the user** — option 1. Every commit of the change is `fix(…)`, none breaking.
