---
subjects:
  - src/application/primitives/internal/index-pack.ts
  - src/application/commands/bundle-verify.ts
---
# 783 — The in-memory walk shares the streaming indexer

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-5) · **Supersedes/Refines:** none

## Context

Two entry points reach the same entry pipeline: `walkQuarantinedEntries`, over a disk byte
source, from fetch and clone; and the module-exported `walkPackEntries`, over an in-memory byte
source, whose only production caller is `bundle verify`. The `PackByteSource` seam exists
precisely so the walk is written once against two sources.

## Options considered

1. **Share** — one indexer over the existing seam, two sources (recommended).
2. **Keep the old pipeline** for the in-memory source.
3. Replace `walkPackEntries` with a validate-only entry point returning nothing, since its one
   caller discards the array.

## Decision

**Option 1.** Both sources drive the same two-pass indexer.

`bundle verify` has the same residency problem the fetch path does — on a bundle of this
repository's own history it would hold 571 MiB of inflated content — so sharing fixes it for
free and leaves one code path to mutation-test. Option 2 preserves two implementations of one
piece of logic, which `check:duplicates` exists to catch. Option 3 is a genuine simplification
and remains available at any time *after* option 1, but it changes a module export's contract
for a caller count of one and is not a prerequisite.

## Consequences

`walkPackEntries` keeps its signature and its `WalkedEntry` return, so `bundle-verify.ts`
changes only its import path. `walkPackEntries` is not in `reports/api.json`, so no published
surface moves on this decision's account. Anything the indexer gains — the record store, the
refusal shapes, the base cache — `bundle verify` gains at the same moment.
