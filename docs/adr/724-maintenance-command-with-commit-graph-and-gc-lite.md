---
subjects:
  - src/application/commands/maintenance.ts
  - src/repository.ts
  - src/index.ts
---
# 724 — `maintenance` command with commit-graph write and gc-lite

> Superseded by [ADR-731](731-gc-uses-cruft-packs.md) for the gc task's prune-loose
> semantics (replaced by git's cruft-pack lifecycle). The command, explicit-only
> invocation, the commit-graph task, the structured result shape, the midx/`.rev`
> constraints and the Tier-1 surface gates are carried forward unchanged.

- **Status:** superseded by ADR-731 (prune semantics; the command and commit-graph task stand)
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-2) · **Supersedes/Refines:** un-parks the gc/repack/prune backlog entry (docs/BACKLOG.md)

## Context

tsgit reads commit-graph, midx, `.rev` and bitmaps but writes only `.rev`; there is no
gc. The parked-entry rationale ("redundant next to canonical git") fails for the headline
target: browser/OPFS repositories have no host git, accumulate loose objects and
unconsolidated packs forever, and the commit-graph fast path in the date walk is dead
code for tsgit-created repos. Pinned: `git commit-graph write --reachable` is
byte-deterministic, `gc` writes the identical file, and tsgit's reader already parses
exactly the chunk set git emits (`OIDF OIDL CDAT GDA2`, `EDGE` for octopus).

## Options considered

1. **commit-graph write only** (recommended) — pros: byte-pinnable assembly of existing subsystems / cons: leaves pack accumulation unsolved.
2. **commit-graph + gc-lite** (chosen) — pros: the honest full answer to the parked entry / cons: the largest lift of the run — pack lifecycle, midx expiry, `.rev` sibling deletion.
3. **Stay parked** — cons: indefensible for the browser case.

## Decision

**User-ratified, above the recommendation.** A Tier-1 `maintenance` command ships with
both tasks, explicit-only (never auto-triggered), returning structured data per the
structured-output rule (counts, booleans — no rendered text):

- **commit-graph** — write `objects/info/commit-graph` byte-identical to
  `git commit-graph write --reachable` for the same commit set, pinned by interop.
- **gc-lite** — when loose-object count exceeds `gc.auto` (default 6700; 0 disables),
  pack loose objects through the existing `packObjects` + `.idx`/`.rev` writers, prune
  the packed loose objects, honouring the two carried constraints: an existing midx is
  expired or rewritten, and a removed pack's sibling `.rev` is deleted with it.

The full Tier-1 surface gate set applies (barrel, facade, key list, docs page + index
row, parity scenario, README command count, regenerated `reports/api.json`).

## Consequences

tsgit-managed repositories stop structurally decaying; the commit-graph fast path
becomes reachable for repos tsgit itself creates. The backlog entry is un-parked and
ticked with this design. Interop pins: commit-graph byte identity and gc outcomes
against git 2.55.0. Changed-path Bloom filters remain out of scope (a read+write pair
for a future change).
