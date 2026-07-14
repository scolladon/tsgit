# 491 — The comparison logic is an extracted, unit-tested pure function

- **Status:** accepted (adopted-as-recommended — no user judgment)
- **Date:** 2026-07-13
- **Design:** docs/design/bench-regression-gate.md · **Supersedes/Refines:** none

## Context

Today's `benchmark-compare` buries its comparison in an inline `node <<'SCRIPT'` heredoc in
the CI YAML — untestable, and the source of a past quote-collapse bug. 26.5 adds real
policy (median-ms, asymmetric, `tsgit`-scoped, new/missing handling) worth testing in
isolation rather than hiding in YAML. `tooling/bench-to-snapshot.ts` already exports a pure
`toSnapshotEntries(raw)` flattener.

## Options considered

1. **New `tooling/bench-check.ts` exporting a pure `compareToBaseline`** (design
   recommendation, chosen) — reuses `toSnapshotEntries`; the pure core is independently
   unit-tested; the CI YAML shrinks to an invocation. / cons: one new small file.
2. **Extend `bench-to-snapshot.ts` with a compare mode** — / cons: overloads one module
   with two responsibilities (convert *and* judge).
3. **Keep the logic inline in the CI YAML** — / cons: untestable; the existing pain.

## Decision

A new `tooling/bench-check.ts` exports a **pure** `compareToBaseline(base, current, policy)
→ { rows, failed }` (no I/O; the unit SUT). A thin `main()` reads both sides' `raw.json`,
flattens each via the imported `toSnapshotEntries`, runs the comparison, prints the
per-scenario table, and sets the exit/step-summary — all I/O at the edge. It is unit-tested
in `tooling/test/unit/bench-check.test.ts` with synthetic entries (no bench run). The CI job
invokes it in place of the inline heredoc.

## Consequences

- The comparison is deterministically unit-tested off a fixture, independent of any live
  benchmark run.
- The flatten logic stays single-sourced in `bench-to-snapshot.ts` (import, don't
  re-implement); `SnapshotEntry` gains an `export` so both modules share one type.
- `tooling/**` is outside the coverage/mutation `include`, so the test runs (it is in the
  `test:unit` set) but carries no coverage gate — same precedent as the existing
  `tooling/test/unit/bench-to-snapshot.test.ts`.
- The advisory gate's behaviour (ADR-488) is now a reviewable, tested function rather than
  YAML.
