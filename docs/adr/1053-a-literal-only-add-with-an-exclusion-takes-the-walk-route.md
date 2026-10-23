---
subjects:
  - src/application/commands/add.ts
  - src/application/commands/internal/resolve-pathspec.ts
---
# 1053 — A literal-only `add` holding an exclusion takes the walk route

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1035 and ADR-1045

## Context

`add`'s literal fast path never applies `!` exclusions: `resolvePathspec` derives the route from
the positive entries only, and `stageLiterals` stages every literal. `add(['x', '!x'])` therefore
stages `x` and writes its blob where `git add x ':!x'` stages nothing (design rows X1–X3, X5, X7,
untracked; X8–X10, X12, X14, tracked and modified). The walk route already matches git: the
tracker's verdict applies exclusions before a positive counts as seen, and the on-disk escape
runs after that (X1 exits 0, X15 refuses) — an order the pins fixed, not a choice.

## Options considered

1. **Send every call holding a negated entry to the walk route (`addByPathspec`)** — reuses the
   one implementation that already matches git, so the two routes cannot drift; costs a walk on the
   rare literal-plus-exclusion call and a few bytes. Designer's recommendation.
2. **Filter the literal list through the full matcher inside the fast path** — duplicates the
   refusal and escape logic in a second place.
3. **Pre-filter in `resolvePathspec`** — pushes on-disk knowledge into the intake.

## Decision

**Adopted as recommended (no user judgment) — option 1.** The literal fast path handles only calls
with no negated entry; any exclusion routes the call through the walk.

## Consequences

- `rm --cached` and `checkout --` literal routes do not share the gap (X20–X26) and are unchanged.
- The fast path's remaining inputs are pinned by the existing literal rows; the exclusion rows
  become interop tests on the walk route.
