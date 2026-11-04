---
subjects:
  - src/application/commands/rev-parse.ts
  - src/application/commands/internal/refname-ambiguity.ts
  - src/application/commands/internal/revision-name.ts
---
# 1147 — the misspelt reread is quiet through a read mode threaded to the ladder

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-226

## Context

After a miss, `rev-parse` re-reads the argument to decide whether it names a path
(`maybe_die_on_misspelt_object_name`), and git reads it quietly: `get_oid_basic` skips the rest of
the ladder count, the refname warning and the abbreviation scan, while a `^` or `~` suffix drops the
quiet flag and the `ignoring dangling symref` line stays printed twice (all pinned twice on 2.56.0).
tsgit's `rereadMisspelt` re-emits the warning, so `rev-parse x^{commit}` on a tag whose target is
missing, and `x^{blob}` on a valid ambiguous `x`, warn twice where git warns once.

## Options considered

1. **Thread a closed union `RevisionReadMode = 'reporting' | 'quiet'` as an options object from
   `rereadMisspelt` down to `resolveAmbiguousLadder`** — pros: the quiet read skips the scan git
   skips, so the fanout-log count is right too; no boolean parameter / cons: every caller of
   `resolveRevisionName` moves to an options object. The designer's recommendation.
2. **Wrap `ctx.logger` with a filter during the reread** — cons: cannot skip the abbreviation scan,
   and filters by message text.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `rereadMisspelt` reads in `'quiet'` mode
unless the argument carries a `^` or `~` operator; in quiet mode `resolveAmbiguousLadder` returns the
first candidate that counts without counting the rest, without the warning and without the
abbreviation scan. `warnSkipped`, `warnIfRefNamesObjectId` and `reportPeelMismatch` are not gated.

## Consequences

- Warning counts match git on every pinned `rev-parse` row, including the `x~5` control (twice) and
  the dangling-symref controls (the skip line twice).
- `resolveRevisionName` takes `{ accepts?, mode? }`; its callers are updated in the same part.
