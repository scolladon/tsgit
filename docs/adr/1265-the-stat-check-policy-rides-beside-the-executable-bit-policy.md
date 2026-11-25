---
subjects:
  - src/application/primitives/compare-working-tree-entry.ts
  - src/application/primitives/internal/is-entry-stat-clean.ts
  - src/application/primitives/internal/scan-tracked-entries.ts
  - src/application/primitives/internal/smudge-racily-clean.ts
  - src/application/primitives/internal/stale-entries.ts
  - src/application/primitives/internal/sparse-left-dirty.ts
  - src/application/primitives/internal/occupant-clash.ts
  - src/application/primitives/materialize-tree.ts
  - src/application/commands/add.ts
---
# 1265 — The stat-check policy rides beside the executable-bit policy

- **Status:** accepted
- **Date:** 2026-11-25
- **Design:** docs/design/whole-second-stat-match.md (DC-A, G-f, R5) · **Supersedes/Refines:** applies ADR-1230

## Context

The compare of ADR-1261 needs the repository's `StatCheck`, which `readStatCheck` resolves from
`core.trustCtime` and `core.checkStat` with an asynchronous config read. The hot path
(`statOnlyVerdict`, once per entry per `status`) is synchronous. `isStaleAssumedEntry` reads the
config once per assume-valid entry today.

## Options considered

1. **A `statCheck` field beside every `executableBit` (the comparison scope, `CachedStat`, the
   stale and sparse judges, `add`'s conversion scope), read once per scan, and lazily where the
   branch may not run** (recommended).
2. One `StatPolicy { executableBit, statCheck }` replacing `executableBit` everywhere.
3. A per-session memo inside `readStatCheck`, called from the predicates.

## Decision

**Adopted-as-recommended (no user judgment)** — ADR-1230 already rules this shape for a stat
policy: it rides the comparison scope, is resolved once per scan, and `CachedStat` carries it.
Option 1.

Refused: option 2 renames about thirty sites the fix does not need. Option 3 is the per-entry
read ADR-1230 refused, and it needs an invalidation rule for a config write during a command.

## Consequences

### Positive

- Public signatures are unchanged and the hot path stays synchronous.
- No per-entry config read remains, `isStaleAssumedEntry` included.

### Negative

- Two policies travel as two fields. A third would justify option 2.
