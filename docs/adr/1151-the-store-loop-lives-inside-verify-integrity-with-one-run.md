---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
---
# 1151 — the store loop lives inside verifyIntegrity with one run across stores

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1150

## Context

With ADR-1150, the ref-content pass visits several stores. git's `refs verify` is one child
process: a link whose realpath fails (`fatal: Invalid path`) ends the whole verify, so every
later store is skipped (pins P4, P5, Q7). The store loop can sit inside `RefStore.verifyIntegrity()`
or in `refs-verify.ts`, calling a per-store method.

## Options considered

1. **Inside `verifyIntegrity()`, no signature change, one `IntegrityRun` shared across stores**
   — pros: the method keeps meaning "git's `refs verify`"; the run's end crosses stores for
   free; the reftable backend keeps its no-argument method / cons: the files backend grows a
   loop. The designer's recommendation.
2. **`verifyIntegrity(store)` per store, looped in `refs-verify.ts`** — cons: the end-of-run
   state has to travel between calls; the reftable backend is called once per store or needs a
   special case; the port's shape changes.

## Decision

**Adopted-as-recommended (no user judgment) — no trade-off beyond mechanics: option 1.**
`verifyIntegrity()` keeps its signature. Internally it iterates an `IntegrityStore` list
(`gitDir`, `prefix`) under one `IntegrityRun`; a `refsVerifyEnded` finding in one
store stops the loop.

## Consequences

- `refs-verify.ts` keeps one call; its per-store concerns (the root-ref stop, ADR-1155) key on
  the finding's prefix.
- The reftable `verifyIntegrity` is unchanged.
