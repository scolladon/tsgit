---
subjects:
  - src/application/primitives/compare-working-tree-entry.ts
  - src/application/primitives/internal/is-entry-stat-clean.ts
---
# 1230 — The executable-bit policy rides the comparison scope

- **Status:** accepted
- **Date:** 2026-11-19
- **Design:** docs/design/core-filemode-false.md (D-E, R4, R5, R11) · **Supersedes/Refines:** refines ADR-1229

## Context

`compareFile` is where the working-tree mode is derived for `status`, `rm`, `stash`, refresh and
the merge-family overwrite check. Under `core.fileMode = false` it must follow git's
`ce_mode_from_stat`, with the index entry as donor. The policy has to reach it without changing the
public `compareWorkingTreeEntry(ctx, entry, provider?, indexMtime?)` signature.

## Options considered

1. **An optional `ComparisonScope.executableBit`, resolved once by `compareAndRefresh` when the
   caller did not set it** (recommended).
2. A mandatory parameter threaded through every caller.
3. A per-entry read inside `compareFile`.

## Decision

Option 1, **adopted-as-recommended (no user judgment)** — no trade-off: the three differ in
mechanics; option 1 keeps the public signature, resolves once per scan and keeps standalone callers
correct. `matchesCachedStat` carries the same policy in its `CachedStat` argument, and the racy
smudge check follows it.

## Consequences

Scan loops set the policy once per operation. Standalone callers of the public primitive pay one
session-cached config read.
