---
subjects:
  - src/application/primitives/internal/alternate-chain.ts
  - src/adapters/memory
  - src/adapters/browser
---
# 916 — An alternate the adapter cannot reach is skipped as `unreachable`

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-3) · **Supersedes/Refines:** refines ADR-914

## Context

The memory adapter has no filesystem outside its root; OPFS resolves absolute paths inside the
origin's sandbox. git never meets this case, so it has no message for it. Issue #302 asks for
"skip with warning rather than throw".

## Options considered

1. **Memory: adapter `PERMISSION_DENIED` → `unreachable` diagnostic, skip; browser: resolve the absolute path in OPFS as-is** (recommended).
2. **Throw** — cons: fails reads git would serve.
3. **Report git's `not-a-directory`** — cons: misstates the cause.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** A distinct `unreachable` reason keeps
the data honest about a case git cannot produce. Errors are classified structurally on `data.code`.

## Consequences

- Parity scenario: memory vs node agree for an in-root alternate; memory reports `unreachable` for an out-of-root one.
