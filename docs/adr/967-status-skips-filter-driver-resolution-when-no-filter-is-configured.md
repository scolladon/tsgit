---
subjects:
  - src/application/commands/status.ts
  - src/application/primitives/compare-working-tree-entry.ts
---
# 967 — `status` skips filter-driver resolution when no filter is configured

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-958

## Context

The 2026-09-10 ruling asked to memoise a "no `.gitattributes` anywhere" verdict once per `status`. An
untracked nested `.gitattributes` still engages check-in conversion (ADR-951), so that verdict cannot be
taken up front without walking the worktree before the tracked scan, which costs more than the lookups
it saves. The measured per-file cost on the miss path is
`resolveFilterDriver(…, { eagerSectionValidation: true })`.

## Options considered

1. **Skip filter-driver work without a `[filter]` section** — thread `status`'s once-per-call
   `configuresFilterDriver` verdict into the comparator; `text`/`eol`/`ident` lookups stay on the
   provider's per-directory cache (recommended).
2. **A literal "no `.gitattributes`" verdict** from the index, `info/attributes` and a worktree pre-walk.
3. **No memo in this run.**

## Decision

**User-ratified — option 1.** When no `[filter "<driver>"]` section is configured, the comparator's
conversion step skips filter-driver resolution and eager section validation; attribute lookups for
`text`, `eol` and `ident` are unchanged. The verdict is computed once per `status` call. No verdict can
change: with no filter section there is no driver to resolve or validate.

## Consequences

- The per-file filter-driver cost disappears on repositories without filter drivers.
