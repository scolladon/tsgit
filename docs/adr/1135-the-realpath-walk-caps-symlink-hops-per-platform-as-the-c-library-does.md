---
subjects:
  - src/application/primitives/internal/alternate-chain.ts
---
# 1135 — the realpath walk caps symlink hops per platform, as the C library does

- **Status:** accepted
- **Date:** 2026-10-30
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md (DC-6) · **Plan:** docs/plan/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-1129

## Context

git's realpath caps symlink hops at the C library's limit: 20 on Linux (glibc and musl), 32 on macOS. tsgit's
`realpathAllowingMissingLeaf` caps at 32 everywhere.

## Options considered

1. **A platform-keyed cap in the walk** (planner's recommendation).
2. **32 everywhere** — cons: a Linux divergence on the 21–32 hop band.

## Decision

**Ratified by the user: option 1.** The hop cap is a named constant per platform: 20 on Linux, 32 elsewhere.
