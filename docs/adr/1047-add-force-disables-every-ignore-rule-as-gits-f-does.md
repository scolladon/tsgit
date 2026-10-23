---
subjects:
  - src/application/commands/add.ts
---
# 1047 — `add`'s `force` disables every ignore rule, as git's `-f` does

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1046

## Context

`AddOptions.force` is declared and read nowhere (design rows I13–I16). With ADR-1046 the literal
fast path stops staging an ignored file, so without a working `force` no route could stage one at
all, where git has `-f`.

## Options considered

1. **Wire it as git's `-f` on every route** — the literal split, the walk and `addAll` apply no
   ignore rule, so nothing is reported and every reached path is staged (I12–I16). Pros: git's
   flag as pinned; cons: none beyond the plumbing. Designer's recommendation.
2. **Wire it for the literal report only** — keeps I13–I16 divergent on the walk route.
3. **Leave it unread** — an ignored untracked file could no longer be staged through `add`.

## Decision

**Adopted as recommended (no user judgment) — option 1.** `force: true` makes `add` behave as if
no ignore rule existed on every route; `ignored` is then always `[]`.

## Consequences

- The option's documentation changes from a declared no-op to git's `-f`.
- A test per route pins the flag against git 2.55 (I12–I16).
