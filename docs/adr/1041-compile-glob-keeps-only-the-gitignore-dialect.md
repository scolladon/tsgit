---
subjects:
  - src/domain/pathspec/compile-glob.ts
  - src/domain/ignore/parse-gitignore.ts
  - src/domain/attributes/parse-gitattributes.ts
  - src/domain/sparse/non-cone.ts
---
# 1041 — `compileGlob` keeps only the gitignore dialect

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-040 and ADR-077; none superseded

## Context

After ADR-1033 and ADR-1039 the only callers of `compileGlob` are `parseGitignore`,
`parseGitattributes` and the non-cone sparse rules, and every one passes `pathname: true`.
`scanStar`, the `pathname` option, the `options.pathname === true` branch in `scanToken`,
`containsGlob`, `compileLiteral` and `compileDirectory` have no caller left. The repo refuses
dead code, and the removed bytes are the offset the browser-bundle cap needs (ADR-1043).

## Options considered

1. **Remove the non-gitignore mode** (designer's recommendation) — one dialect, one option set.
2. **Keep it** — dead code behind an option nothing sets, and no size offset.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `compileGlob` compiles the
`WM_PATHNAME` family only: a star run crosses `/` as a whole path component, `?` is one non-`/`
unit, `[…]` and `\` stay verbatim. The `pathname` option disappears from `CompileGlobOptions`;
the three callers drop it. The matcher stays the linear dynamic program of ADR-077; the existing
equivalence marks on its loops are kept.

## Consequences

- The `compile-glob` unit rows for the removed mode go with it; every `pathname` row stays,
  retitled as the gitignore dialect.
- `compile-glob` gains its property sibling (totality over patterns; a special-free pattern
  matches exactly itself).
