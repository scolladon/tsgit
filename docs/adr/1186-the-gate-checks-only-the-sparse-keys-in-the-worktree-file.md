---
subjects:
  - src/application/primitives/internal/repo-state.ts
---
# 1186 — the gate checks only the sparse keys in the worktree file

> **Superseded by [ADR-1233](1233-the-eager-gate-refuses-a-bad-core-filemode-in-local-and-the-worktree-file.md)**
> for `core.fileMode`: the worktree-file gate now also refuses a bad `core.fileMode`. The gate
> running only when the extension is on, and every other eager key staying unchecked there, are
> carried forward.

- **Status:** superseded by ADR-1233
- **Date:** 2026-11-13
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** refines ADR-1185

## Context

The eager gate checks a set of `core` booleans in the local file. git checks the same
keys in `config.worktree` when the extension is on.

## Options considered

1. **The two sparse booleans only** (recommended) — pros: the keys this change starts
   reading; pinned by R10, R12 / cons: other eager keys in the worktree file still pass.
2. **Every eager key** — cons: the wider worktree-layer gap, with its own pin set.
3. **None** — cons: `status` passes on R10 / R12 where git refuses.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-1170: the perimeter is the keys tsgit
now reads from the file; the wider gap goes to impact triage. The check covers
`core.sparseCheckout` and `core.sparseCheckoutCone` only.

## Consequences

### Negative

- A bad `core.ignorecase` (or any other eager key) in `config.worktree` is not refused.
