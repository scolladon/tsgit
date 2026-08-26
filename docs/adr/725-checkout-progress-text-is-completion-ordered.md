---
subjects:
  - src/application/primitives/apply-changeset.ts
---
# 725 — Checkout progress text is completion-ordered

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-3) · **Supersedes/Refines:** none

## Context

Bounded-parallel materialisation changes what per-entry progress can promise. The
`ProgressReporter.update` contract documents `current` as a processed-count and `text` as
sideband-style auxiliary text; it promises nothing about `text` ordering.

## Options considered

1. **Shared completion counter; `text` in completion order** (recommended, chosen) — pros: full parallelism, contract-honest.
2. **Buffer to changeset order** — cons: preserves a property nobody promised at the cost of the parallelism the change exists for.
3. **Counts only, drop `text`** — cons: silent capability removal.

## Decision

**User-ratified.** Under parallel materialisation, `current` stays strictly monotone via
a shared completion counter; `text` carries the path of the entry that just completed,
in completion order. `total` is unchanged.

## Consequences

Consumers rendering a filename keep one; consumers asserting changeset ordering of
`text` (none known; the port never promised it) would need the sequential path. Hook
invocation counts are unaffected.
