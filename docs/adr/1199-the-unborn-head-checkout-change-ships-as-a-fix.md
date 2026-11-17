---
subjects:
  - src/application/commands/checkout.ts
  - src/application/primitives/materialize-tree.ts
---
# 1199 — The unborn-HEAD checkout change ships as a fix

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D3) · **Supersedes/Refines:** none

## Context

The change removes refusals git does not make (a switch from an unborn HEAD, `-b` with no start
point, a staged file the target replaces with a directory), moves codes between existing members
(`REF_NOT_FOUND` → `CHECKOUT_START_POINT_NOT_COMMIT` / `PATHSPEC_NO_MATCH`, `INVALID_OPTION` →
`NO_INITIAL_COMMIT`), and widens `CheckoutSwitchOptions.rev` from required to optional. That widening
is source-compatible for callers, but `reports/api.json` changes and the documented
`REF_NOT_FOUND` for an unborn HEAD goes away. No union member is removed. ADR-1048 and ADR-1196
shipped removed refusals as `fix`; ADR-1190 and doctrine D-3 count a new refusal where tsgit
returned as breaking, which this change does not add.

## Options considered

1. **`fix:`** (recommended) — refusals removed, codes moved between existing members.
2. **`fix!:`** — counts the documented code change and the widened input as a break.
3. **`feat:`** — counts the newly expressible no-start-point form as a feature.

## Decision

**ratified by the user** — option 1. Every commit of the change is `fix(…)`, none breaking.

Refined by ADR-1204: the branch-name refusal it folds during review is the one breaking commit.
