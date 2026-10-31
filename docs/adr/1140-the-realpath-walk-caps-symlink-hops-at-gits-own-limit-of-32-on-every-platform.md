---
subjects:
  - src/application/primitives/internal/alternate-chain.ts
  - src/adapters/node/node-adapter.ts
---
# 1140 — the realpath walk caps symlink hops at git's own limit of 32 on every platform

- **Status:** accepted
- **Date:** 2026-10-31
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** supersedes ADR-1135; refines ADR-1129

## Context

ADR-1135 set the realpath walk's symlink-hop limit to 20 on Linux and 32 elsewhere, reading git's
limit from the C library's symlink-limit macro (glibc and musl define 20). It was never pinned on a Linux
host. The PR's Linux CI leg, with git 2.56.0, refuted it: on a self-loop `git fsck` dies
`fatal: More than 32 nested symlinks on path '.git/refs/heads/b'`, and a chain of 25 links resolves
(exit 0) where tsgit, capped at 20, died (exit 8). git's realpath does not use the C library's value.

## Options considered

1. **One limit of 32 on every platform, the walk's default; no adapter sets it** — pros: git's
   behaviour as measured on Linux and macOS / cons: none found.
2. **Keep the per-platform limit under a divergence ADR** — cons: a measured divergence from git.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The walk caps a chain at git's own limit of
32 hops on every platform. The Node adapter no longer supplies a limit, so `Context.symlinkHopLimit`
is absent and the walk applies its default; a caller may still set it, bounded as before.

Superseded from ADR-1135: the per-platform hop limit (20 on Linux, 32 elsewhere).
Carried forward from ADR-1135: the limit is a named constant consumed by the one realpath walk, and
a value outside a positive safe integer of at most 1024 falls back to it.

## Consequences

- The interop rows pin the loop line and a 25-link chain against git on every CI leg.
- `symlinkHopLimitFor` is removed from the Node adapter.
