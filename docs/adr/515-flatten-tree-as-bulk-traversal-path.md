# 515 — flattenTree is the bulk traversal path; walkTree keeps per-entry streaming

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** consistent with ADR-239 (walkTree public surface additive)

## Context

`walkTree`'s async generator yields one entry per promise; on a 16.5k-entry recursive walk nearly a third of wall time is microtask overhead. `flattenTree` — the eager one-shot `Map` builder — already exists, is exported, but was never bound on `repo.primitives` (the wiring gap fixed in this change).

## Options considered

1. **Add batched yields to `walkTree`** — pros: streaming consumers win / cons: new option shape on a public surface for a need no consumer has voiced.
2. **Bind + document `flattenTree` as the bulk path (recommended)** — pros: zero new surface beyond the binding the wiring fix lands anyway; the spike's own suggested alternative / cons: `walkTree` per-entry cost remains for streaming drains.
3. **Both** — pros: complete / cons: speculative surface.

## Decision

**Adopted-as-recommended (no user judgment) — Option 2.** `flattenTree` is bound on `repo.primitives` and documented as the bulk traversal route; `walkTree` keeps its per-entry streaming shape unchanged. A batched-yield option remains open for a future consumer-driven ADR.

## Consequences

Bulk consumers (full-tree drains: indexing, archive-shaped work) get the zero-per-entry-promise path immediately. No public-surface reshape; ADR-239 and ADR-249 untouched.
