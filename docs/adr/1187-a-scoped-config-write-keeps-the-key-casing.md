---
subjects:
  - src/application/primitives/update-config.ts
---
# 1187 — a scoped config write keeps the key casing

- **Status:** accepted
- **Date:** 2026-11-13
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** refines ADR-074, ADR-082

## Context

The writers must put `sparseCheckout`, `sparseCheckoutCone`, `worktreeConfig` and
`index.sparse` into a chosen scope file with git's casing (rows B1, B5, P-dis).
`setConfigEntry` lowercases key names through `parseConfigKey`.

## Options considered

1. **A new `updateScopedConfigEntries(ctx, scope, entries)`**, one read-modify-write per
   file, caller's casing kept (recommended).
2. **Sequential `setConfigEntry` calls** — cons: writes `sparsecheckout`; three writes.
3. **An optional scope on `updateConfigEntries`** — cons: changes an exported signature.

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off: option 1 is the only one that
gives git's bytes without changing a public signature. It resolves the path with
`resolveConfigScopePath`, folds `setConfigEntryInText` over the entries and invalidates
both config caches.

## Consequences

### Neutral

- `updateCoreConfig` loses its last internal caller and stays exported.
