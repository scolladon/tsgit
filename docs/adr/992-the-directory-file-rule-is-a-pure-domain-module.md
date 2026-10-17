---
subjects:
  - src/domain/git-index/directory-file-conflict.ts
---
# 992 — The directory/file rule is a pure domain module

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

The rule is a pure invariant over sorted index entries, with no I/O. `add.ts` is already over 1,000
lines.

## Options considered

1. A pure module in `src/domain/git-index/`, not exported from the public barrel (recommended).
2. Private helpers inside `add.ts`.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1, aligned with the hexagonal dependency rule
(domain holds pure index invariants, next to `compareEntryPath`). It gets example and property tests.

## Consequences

- `reports/api.json` is unaffected unless a public type changes.
