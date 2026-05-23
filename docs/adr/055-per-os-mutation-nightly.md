# ADR-055: Per-OS mutation testing runs nightly, not per-PR

## Status

Superseded by [ADR-102](102-remove-per-os-mutation-nightly.md) — the per-OS nightly is being removed. The original context (per-PR matrix mutation would be ~3× the slowest gate) still stands; what changed is that the nightly's signal has been empty since landing, and 19.1's diff-scoped PR gate makes the "full nightly" role obsolete.

Originally accepted at `5da3b52`.

## Context

[ADR-044](044-ci-matrix-windows-inclusion.md) re-included `windows-latest` in
the `unit-tests` matrix but kept mutation testing on `ubuntu-latest` only,
explicitly deferring per-OS mutation to "Phase 15.4". Backlog item 11.2
(cross-platform E2E) stays `[~]` precisely because that per-OS mutation gap is
open.

Mutation testing is the most expensive job in the pipeline — ADR-044 cites
"~45 min per OS". The `mutation` job in `ci.yml` runs incrementally on every
PR. The question 15.4 must answer: **where does macOS + Windows mutation run?**

A per-PR matrix `os: [ubuntu, macos, windows]` on the mutation job would make
the slowest, merge-gating stage roughly 3× its current runner cost (~135 min
of runner time per PR) and lengthen the merge queue for a signal — a
platform-specific surviving mutant — that changes rarely.

## Decision

Per-OS mutation runs on a **nightly cron**, not per-PR.

- New workflow `.github/workflows/mutation-os.yml`: `schedule` cron +
  `workflow_dispatch`, `strategy.matrix.os: [macos-latest, windows-latest]`,
  runs the full `npm run test:mutation` (non-incremental — a nightly has the
  time budget), `timeout-minutes: 90`, uploads `reports/mutation/` per OS.
- The cron fires offset from `bench.yml` so the two heavy nightly jobs do not
  contend for the runner pool.
- The per-PR `mutation` job in `ci.yml` is unchanged — Linux-only,
  incremental.

This satisfies 11.2's intent: per-OS mutation **exists and runs on a
schedule**, so 11.2 may flip to `[x]`.

## Consequences

### Positive

- Platform-specific surviving mutants are caught within a day, on a cadence
  matched to how often platform-branching code actually changes.
- The per-PR merge gate keeps its current cost — no slowdown for contributors.
- Full (non-incremental) nightly runs avoid incremental-state drift across
  OSes.

### Negative

- A platform-specific mutation regression can land on `main` and sit up to ~24
  h before the nightly flags it. Accepted: mutation score is a quality ratchet,
  not a correctness gate, and the per-PR Linux run still covers the bulk.
- Two more scheduled jobs consume nightly runner minutes (macOS minutes bill
  at a premium). Bounded by `timeout-minutes` and the nightly cadence.

### Neutral

- `stryker.config.json` needs no change — the vitest runner and relative
  `tempDirName` are already OS-portable.
- The workflow is `workflow_dispatch`-enabled, so a maintainer can run per-OS
  mutation on demand before a risky platform change.

## Alternatives considered

- **Per-PR `os` matrix on the `mutation` job** — rejected: ~3× the slowest
  gating stage for a slow-moving signal.
- **Manual / label-triggered only** — rejected: relies on a human remembering;
  coverage drift would go unnoticed between triggers.
- **Keep mutation Linux-only indefinitely** — rejected: leaves 11.2 open and
  the adapter's platform branches (the actual home of OS-specific bugs)
  unmutated on the OSes that matter.
