---
subjects:
  - src/domain/diff/userdiff-binary.ts
  - src/application/commands/internal/grep-binary-override.ts
---
# 1180 — grep resolves the diff driver's binary verdict as git's userdiff does

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** refines ADR-226

## Context

Pinned against git 2.56: `-diff` / `binary` force binary and bare `diff` forces text;
`diff=<name>` uses `diff.<name>.binary` when the driver exists (configured, or one of 27
builtin names, case-sensitive) and the sniff when its `binary` is unset or `auto`; an
unspecified path, `!diff`, or an unknown driver name falls to the `default` driver's
`diff.default.binary`, else the sniff. `textconv` never changes grep's verdict.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 and ADR-1170 (a change matches git on
every path it touches). A pure domain function `userdiffBinaryOverride(value, drivers)` maps
the resolved attribute and the configured drivers to `'binary' | 'text' | undefined`.

If the bundle size gate turns red, the fallback is the narrower rule (`-diff` / `diff` plus
`diff.<name>.binary`) with `diff.default.binary` recorded in the ledger.

Rejected: the narrower rule as the target (leaves the pinned default-driver rows wrong) and
switching `diff`'s readers to the same function (outside this change's perimeter).

## Consequences

### Positive

- Every pinned driver row matches git; the function is table-driven and property-testable.

### Negative

- A `[diff "x"]` section with no keys counts as a driver in tsgit's config map but not in
  git: residual recorded in `docs/known-divergences.md`.
- The size gate went red; the narrower rule would have saved at most ~330 B of the overage,
  so the user ruled to keep the full rule and raise the caps once review converged:
  browser bundle 365 → 365.7 kB (measured 365.68), full library 424.2 → 424.8 kB (424.75),
  commands-internal chunk 93.4 → 93.5 kB (93.48), tarball 1520 → 1522 KiB (1 558 419 B).
- The builtin name set must follow git releases.
