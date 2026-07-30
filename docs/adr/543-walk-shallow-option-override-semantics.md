# 543 — Walk `shallow` option: auto-load with caller-override semantics

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/shallow-boundary-commit-walk.md · **Supersedes/Refines:** none

## Context

`WalkCommitsOptions.shallow` / `WalkCommitsByDateOptions.shallow` are public exports that
no caller in `src/` ever passes — dead wiring. Once the walks auto-load the repository's
shallow set, the option needs defined semantics: it can override, be removed, or be
unioned with repo state.

## Options considered

1. **Auto-load; explicit option overrides** (designer's recommendation) — omitted ⇒ load
   from `.git/shallow`; explicitly passed (including `new Set()`) ⇒ the caller's set wins.
   Pros: source-compatible (doc-only `reports/api.json` diff), keeps a raw-ancestry escape
   hatch for audit tooling / cons: two sources of truth to document.
2. **Auto-load; remove the option** — pros: cleaner surface / cons: breaking public-API
   removal inside a bug fix; deletes the escape hatch.
3. **Auto-load; always union** — pros: never misses the repo boundary / cons: an explicit
   `new Set()` silently still masks — surprising override semantics.

## Decision

User-ratified: **option 1**. The walks resolve their effective set once at session
construction — `options.shallow ?? await loadShallowSet(ctx)` — and thread that same set
through every grafted read in the walk. An explicit empty set disables masking.

## Consequences

The shallow set is a parameter of the grafted read, never an ambient lookup, so the
override reaches every masked site consistently. Non-walk grafted sites (show, rev-parse,
blame, merge-base, …) have no override concept and always load repo state. The option's
JSDoc must state the auto-load contract; regenerated `reports/api.json` ships with the
change.
