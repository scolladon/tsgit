# 502 — Hot-path granularity: per-command operation

- **Status:** accepted (adopted-as-recommended — no user judgment; the alternatives carry
  no real trade-off)
- **Date:** 2026-07-24
- **Design:** docs/design/bench-hot-path-rework.md · **Relates:**
  [ADR-501](501-hot-path-picking-methodology.md) (the list this granularity keys),
  [ADR-475](475-committed-profile-baseline-hot-shares.md) (`baseline.json` command keying)

## Context

The hot-path registry (ADR-501, ADR-505) must key its entries at some granularity. The
Phase-26 profiler keys by **command/operation** (`log`, `status`, …); the self-shares within
each command are keyed by **frame** (`checkContainment`, `isContainedInEitherRoot`, …); the
bench suite registers by **scenario** (cold/warm/clean/dirty within an operation).

## Options considered

1. **Per-command operation** (design recommendation) — the registry is a set of operation
   names. / pros: matches `baseline.json` keying and how a caller invokes the library; one
   hotness verdict per operation. / cons: none material.
2. **Per-primitive / per-frame** — list hot *functions*. / cons: the hot frames
   (`checkContainment`, `isContainedInEitherRoot`) are cross-cutting across
   `log`/`status`/`describe`/`name-rev`/`blame` and map to no single bench — unusable as a
   bench-selection key.
3. **Per-bench-scenario** — list hot scenarios. / cons: duplicative — an operation's
   cold/warm/clean/dirty scenarios share one hotness verdict.

## Decision

The hot-path registry is keyed by **per-command operation** (`log`, `status`, `pack-read`,
`blame`, `describe`, `name-rev`). Fixture tiering and gate scoping both resolve an entry to
its operation by bench-file basename (`log.bench.ts` → `log`).

## Consequences

- The registry stays a small, closed set of operation names aligned with `baseline.json`.
- The operation↔bench-file mapping is a pure basename derivation — no second mapping table.
- Cross-cutting hot frames remain the concern of within-command optimisation work (ADR-475),
  not the bench-selection registry.
