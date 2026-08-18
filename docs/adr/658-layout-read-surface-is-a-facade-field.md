# 658 — The layout read surface is a facade field, not a `revParse` extension

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D6)

## Context

Callers need a convenient way to read the resolved git dir path and the rest of the
layout — the structured analogue of `git rev-parse --git-dir` / `--absolute-git-dir` /
`--git-common-dir` / `--is-bare-repository` and friends. `ctx.layout` already carries
the data; `revParse` is a hot single-purpose revision resolver
(`(ctx, expression) => Promise<ObjectId>`) with no options type.

## Options considered

1. **`readonly layout: RepositoryLayout` on the `Repository` facade — the same
   deep-frozen object as `ctx.layout` (design recommendation)** — pros: synchronous,
   one source of truth, every rev-parse display form reconstructible from
   `layout` + `cwd` per the structured-data doctrine / cons: none material.
2. **Extend `revParse` with structural queries returning a union** — forces a union
   return on every existing caller and re-imports the display-form question
   (`.` vs `.git` vs absolute) that ADR-249 assigns to the caller.
3. **Both** — option 2's cost with option 1's benefit already paid.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Aligns with ADR-249: the
library ships resolved absolute paths and booleans; relative/display forms are the
caller's. Exposing the field is also the moment the layout object becomes deep-frozen.
