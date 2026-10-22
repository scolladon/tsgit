---
subjects:
  - src/application/commands/checkout.ts
---
# 1038 — `checkout` takes the index lock and reads the index before the pathspec check

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-226; none superseded

## Context

git's `checkout_paths` locks the index and reads it before testing the pathspecs: a held
`index.lock` wins over `did not match` (K1), and a corrupt index refuses on the read even for a
tree source (K4, K5). `add` and `rm` in tsgit already lock first (K2, K3). `checkout.pathRestore`
checks the pathspec before `acquireIndexLock` and, for a tree source with a zero-match glob, never
reads the index — a unit test pins that divergence today.

## Options considered

1. **Lock, read both sources, then enumerate, refuse and materialize under the lock** (designer's
   recommendation) — `materializePathRestore*` receive the held lock and the read index. Pros:
   K1/K4/K5; closes the pre-lock snapshot race the code comments describe. Cons: a wider
   `pathRestore` change than the refusal alone.
2. **Keep the pre-lock refusal; file K1 as a follow-up** — the brief asks for refusal on the same
   lock path `add` uses, and the race stays.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `pathRestore` acquires the index lock,
reads the index (and the source tree when given), enumerates the source universe, refuses every
unmatched positive pathspec (ADR-1037) and only then materializes, all under one lock.

## Consequences

- The unit row pinning the corrupt-index no-op is re-pinned as K4 (refusal on the read).
- C8/C9: the universe for a tree source is the source tree only, as git's.
