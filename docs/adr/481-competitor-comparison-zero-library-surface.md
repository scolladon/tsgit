# 481 — Competitor comparison adds zero library surface; ADR-249 not in tension

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/competitor-benchmarks.md · **Supersedes/Refines:** refines [ADR-249](249-describe-structured-data-only.md)

## Context

[ADR-249](249-describe-structured-data-only.md) mandates that the library returns
structured data and callers own rendering — no command option whose only job is to steer
rendered text. A competitor benchmark comparison is inherently about rendered numbers and
tables, which looks like a tension worth ratifying before review flags a false positive.

## Options considered

1. **Ratify explicitly that the comparison adds zero library/command surface** (design
   recommendation) — pros: all rendering lives in tooling/reports/README, never in a
   command; ADR-249 binds the library surface, which is untouched, so this is a clarifying
   ratification, not a divergence. / cons: none beyond writing it down.
2. **Treat it as a genuine tension and carve an ADR-249 exception** — pros: none. / cons:
   there is nothing to except — no `openRepository`/command API gains a comparison-,
   formatting-, or rendering-bearing option; carving an exception would misrepresent the
   change.

## Decision

The competitor comparison **adds zero library or command surface**. It touches only
`test/bench/**`, `tooling/**`, `docs/**`, `README.md`, `package.json` (devDeps/scripts),
and `.github/workflows/**`. No command or `openRepository` option gains a comparison,
formatting, or rendering job. [ADR-249](249-describe-structured-data-only.md) governs the
library surface and is **not in tension** — this is a ratification of that boundary, marked
**adopted-as-recommended (no user judgment)**.

## Consequences

- Review may treat any claim that this change adds a rendering option to the library as a
  false positive — the rendering is confined to reports and docs by construction.
- Mirrors the precedent of [ADR-477](477-profiler-tool-shape-tooling-only.md)
  (tooling-only, no library surface change) for a measurement/reporting feature.
- The bench-file, DSL, summarizer, and doc edits carry no coverage or mutation obligation:
  `test/bench/**` and `tooling/**` are outside the coverage `include`.
