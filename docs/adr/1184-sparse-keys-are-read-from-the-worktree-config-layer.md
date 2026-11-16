---
subjects:
  - src/application/primitives/read-sparse-checkout.ts
  - src/application/primitives/read-sparse-config.ts
  - src/application/commands/sparse-checkout.ts
---
# 1184 — sparse keys are read from the worktree config layer

- **Status:** accepted
- **Date:** 2026-11-13
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** refines ADR-182, ADR-661

## Context

`git sparse-checkout set` turns on `extensions.worktreeConfig` and writes
`core.sparseCheckout` / `core.sparseCheckoutCone` into `<gitDir>/config.worktree`.
`loadSparseMatcher` reads them through `readConfig`, which reads `<commonDir>/config`
only, so a later `checkout` writes paths git keeps out of the work tree (design row T0,
git 2.56).

## Options considered

1. **A sparse-only `readSparseConfig`** over `readConfig` plus the existing
   extension-gated, gitDir-keyed `readConfigSections({ scope: 'worktree' })` (recommended)
   — pros: fixes every sparse consumer through one reader, reuses ADR-182's cache / cons:
   other `core.*` keys in `config.worktree` stay unread.
2. **Merge `config.worktree` into `readConfig`** for every key — pros: fixes the whole
   class / cons: changes 48 call sites and the local-only contract of `loadConfigEntry`;
   its own pin set.
3. **Option 1 plus a generic layered-core reader** — cons: YAGNI.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 for the faithfulness and ADR-1170
for the perimeter: the change is scoped to the sparse keys; the other keys go to impact
triage. `readSparseConfig(ctx)` resolves `enabled` and `cone` one key at a time, last
entry wins, local then worktree, the worktree file read only when `extensions.worktreeConfig`
is true under git's boolean grammar. Every matcher consumer and the `list` / `set` /
`add` / `reapply` mode reads go through it.

## Consequences

### Positive

- checkout, reset, merge, pull and the one-way reset agree with git on a git-prepared
  sparse repository, in main and linked worktrees alike.

### Negative

- A non-sparse key set in `config.worktree` is still ignored by tsgit.
