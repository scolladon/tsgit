# 707 — tsgit gains a `packRefs` surface, and orphan cleanup lives there

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidate DN-4) · **Refines:** ADR-690

## Context

git removes unreferenced `*.ref` tables only during `pack-refs --all` / `gc`. tsgit has neither,
and ADR-690 had just ratified keeping it that way. The consequence measured by the design: a
crash between writing a table and swapping `tables.list` leaks that file **forever** in tsgit,
where git would eventually reclaim it. A long-lived repository would only ever grow.

## Options considered

1. **Clean opportunistically inside the transaction**, while the `tables.list` lock is already
   held (design recommendation) — pros: no new surface; faithful in effect, since git only avoids
   the permanent leak by having `gc` / cons: a deliberate divergence — tsgit removing files git
   would not, at a moment git never would.
2. **Never clean; document the leak** — pros: strictly faithful to git's write path / cons: an
   unbounded leak that nothing can reclaim, with no command in tsgit able to fix it.
3. **Add a `packRefs` surface** and let cleanup live there, as git does.

## Decision

**Option 3 — ratified by the user, against the design's recommendation.**

tsgit gains a `packRefs` command. Orphaned-table cleanup lives there, in the same place and at
the same moment git performs it — faithful in both **mechanism and location**, rather than
faithful only in effect.

## Consequences

- **ADR-690 is refined, not reversed.** No migration surface is added: tsgit still does not
  convert between backends. What changes is that ADR-690's broader consequence — "tsgit offers no
  destructive whole-repository rewrite, consistent with having no `gc`, `prune` or `repack`" — is
  now narrower: tsgit has one *ref-maintenance* command, and still no object-maintenance command.
- **`preciousObjects` is unaffected and still honoured by construction** (ADR-667, ADR-685).
  `packRefs` packs refs; it deletes no objects. The premise that nothing in tsgit removes objects
  survives intact, and this ADR records that explicitly so a future reader does not assume the
  premise broke.
- `packRefs` is a **Tier-1 command**, so the full new-command surface gate applies: barrel export,
  repository facade, facade test, a docs page, a browser parity scenario, README, and a
  regenerated `reports/api.json`. The plan must treat it as a command, not a helper.
- It must be faithful in its own right — `pack-refs` has measurable behaviour on the **files**
  backend too (packing loose refs into `packed-refs`), so the command cannot be reftable-only.
  Its files-backend behaviour needs its own pinned matrix.
