---
subjects:
  - src/domain/describe/match.ts
---
<!-- cspell:ignore wildmatch -->
# 1039 — `describe --match` and `--exclude` use the flags-0 wildmatch on the short tag name

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1033; none superseded

## Context

git's `describe` tests each exclude, then each include, with `wildmatch(pattern, refname + 10, 0)`
on the name after `refs/tags/`: `*` crosses `/`, `[…]`, `\x` and the abort cases apply (DS2–DS7,
DS10–DS13). `src/domain/describe/match.ts` compiles patterns with `compileGlob(…, { anchored: true })`,
so `--match 'v*'` picks `v1.0` over the nearer `v1/rc1` (DS2) and `v[0-9].*` finds no name (DS3).

## Options considered

1. **`compileRefGlob` on the short name** (designer's recommendation) — the flags-0 engine as
   `name-rev` uses; ref names cannot hold `* ? [ \`, so the verbatim-first rule adds nothing.
2. **The new pathspec matcher** — carries the verbatim and fast-path machinery `describe` never
   needs, and encodes per candidate for no gain.

## Decision

**User-ratified — option 1** (decided with ADR-1033 as one dialect question). `buildNameFilter`
compiles every include and exclude once with `compileRefGlob`; the include/exclude logic is
unchanged (both must hold, so order is immaterial). `describe --contains` keeps mapping its
patterns to `refs/tags/<pattern>` through `name-rev` (ADR-1040).

## Consequences

- DS2–DS7 and DS14 flip to git's answers; DS1, DS8–DS13 stay.
- `describe/match.ts` drops its `compileGlob` import (ADR-1041).
