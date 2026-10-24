---
subjects:
  - src/application/commands/internal/submodule-state.ts
---
# 1070 — A failing child status propagates the child's error unchanged

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** none

## Context

When the submodule's own status fails — its index truncated to junk — git 2.55 prints the
child's fatal first (`index file smaller than expected`), then
`fatal: 'git status --porcelain=2' failed in submodule sub`, exit 128 (design row SF10). tsgit's
dirty check runs the child status on a derived context, so the child's `TsgitError` is what
surfaces.

## Options considered

1. **Propagate the child's error unchanged** — the designer's recommendation. Pros: the child's
   refusal is the one git prints first; the caller already knows the path. Cons: the second line
   has no structured analogue.
2. **Wrap it in a new `SUBMODULE_STATUS_FAILED { path, cause }`** — one more union member to say
   what the caller knows.
3. **Treat the submodule as dirty** — hides a corrupt repository.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- A refusal inside a nested submodule surfaces the same way through each level.
- Anything that is not a `TsgitError` is a bug and is rethrown as is, the rule the gitlink reader
  already applies to HEAD resolution.
