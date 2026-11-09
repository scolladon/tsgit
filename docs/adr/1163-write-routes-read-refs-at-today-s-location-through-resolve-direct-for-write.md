---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/resolve-ref.ts
  - src/application/primitives/internal/ref-write-chain.ts
---
# 1163 — write routes read refs at today's location through resolveDirectForWrite

> **Superseded by [ADR-1164](1164-the-per-worktree-ref-namespace-routes-writes-to-the-store-the-name-selects.md)** for the two-locator guard: `resolveDirectForWrite` no longer reads at today's `writeLocation`; the write-route readers take the same store mapping as the writers. The inventory of write-route readers and the fake-store test proving which locator each consumes are carried forward.

- **Status:** superseded by ADR-1164
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1158

## Context

ADR-1158 folds the read side of git's `parse_worktree_ref` rule into the files store:
`resolveDirect('main-worktree/<per-worktree name>')` reads at `<common>/<bare name>`. The
write routes stay out of that change because only one write shape is pinned (W14: git accepts
`update-ref main-worktree/HEAD`, `main-worktree/refs/bisect/x` and `worktrees/wt/refs/bisect/y`
from a linked worktree, moving `refs/heads/main` through the main HEAD and writing
`<common>/refs/bisect/x`). Several readers sit on write routes: the store's `checkExpected`
and `refIsPresent`, and `ref-write-chain.ts` (`walkSymbolicChain`, `resolveWithoutDeref`,
`readReferentValue`). If they took the read mapping, a write would compare against one path
and write to another; with a detached main HEAD, `updateRef('main-worktree/HEAD')` would read
`<common>/HEAD` and write a stray `<common>/main-worktree/HEAD`.

## Options considered

1. **Two locators: `resolveDirect` reads at `readLocation`; a new port method
   `resolveDirectForWrite` reads at today's `writeLocation`; every write-route reader that can
   meet a mapped name takes it, and `resolveDirectChain` narrows its store parameter to
   `Pick<RefStore, 'resolveDirect'>` so the write chain hands it the write view** — pros: every
   write route stays byte-identical to today until the write side is pinned; the guard is a
   set of call sites each pinned by a test / cons: one more port method; nothing in the type
   system stops a new write route from calling `resolveDirect`. The designer's recommendation.
2. **Map inside `resolveDirect` for every caller; path builders stay on `refDir`** — cons: a
   write reads at one path and writes at another; the rest of the write side changes without
   pins. Refusing these names on writes is not an option: git accepts all three W14 writes.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-1158 (the write side stays out until
pinned) and no trade-off beyond mechanics: option 1.** `RefStore` gains
`resolveDirectForWrite(name)`; the reftable store aliases it to `resolveDirect`;
`withPseudoRefFiles` routes both. `checkExpected`, `refIsPresent`, `walkSymbolicChain`,
`resolveWithoutDeref` and `readReferentValue` are the write-route readers and use it. Readers
whose names the read locator never maps (`stillHoldsPackedValue`, the `HEAD` read in
`update-ref.ts`, the `refs/heads/*` reads in `branch.ts`) stay on `resolveDirect`. The doc
comment on `resolveDirectForWrite` names the rule for future write routes.

## Consequences

- A fake-store test proves each write-route reader consumes only `resolveDirectForWrite`.
- The write side's W14 behaviour is unchanged by this change and is pinned when the write
  side is taken up.
