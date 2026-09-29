---
subjects:
  - test/integration/rename-similarity-interop.test.ts
  - test/integration/rename-exact-interop.test.ts
---
# 905 — Rename-parity pins extend the existing interop suites

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§7, D8) · **Supersedes/Refines:** refines ADR-896

## Context

The four parity items each belong to a pass that already has an interop suite.

## Options considered

1. **Extend `rename-similarity-interop` and `rename-exact-interop`; blame rows in
   `blame-interop`** — *recommended by the design.*
2. A new `rename-parity-interop.test.ts`.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

## Consequences

- Each row sits next to the pass it pins.
