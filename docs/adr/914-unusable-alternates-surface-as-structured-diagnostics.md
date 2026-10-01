---
subjects:
  - src/application/primitives/internal/alternate-chain.ts
  - src/application/primitives/object-store.ts
---
# 914 — Unusable alternates surface as structured diagnostics, never as errors

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-1) · **Supersedes/Refines:** refines ADR-249 (structured output)

## Context

git reports an unusable alternate — missing directory, nesting too deep, a path that is not a
directory — on stderr and keeps reading (Pin U, Pin N). tsgit has no stderr, and a read must not
fail because one alternate is unusable.

## Options considered

1. **`ctx.logger.warn` only** — pros: smallest / cons: invisible without a wired logger, untestable as data.
2. **`logger.warn` and a structured `objectSources(ctx)` view `{ sources: [{ objectsDir, local }], unusable: AlternateDiagnostic[] }`** (recommended) — pros: data not text (ADR-249), follows the pack-registry warn precedent, doubles as the interop oracle for `count-objects -v` / cons: one more public primitive.
3. **Throw** — cons: not git; reads continue in git.

## Decision

**Adopted-as-recommended (no user judgment) — option 2.** Each unusable alternate is skipped,
warned once per resolution through `ctx.logger?.warn`, and listed in `objectSources(ctx).unusable`
with a reason classified like git's three diagnostics (plus `unreachable`, ADR-916). A read never
throws because an alternate is unusable.

## Consequences

- `objectSources` is exported from the primitives barrel and `repo.primitives`.
- Interop tests reconstruct git's `count-objects -v` `alternate:` lines and git's warning set from the view.
