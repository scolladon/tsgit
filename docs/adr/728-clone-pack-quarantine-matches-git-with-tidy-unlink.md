---
subjects:
  - src/application/primitives/fetch-pack.ts
---
# 728 — Clone pack quarantine matches git, with tidy unlink

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-14) · **Supersedes/Refines:** none

## Context

Streaming the received pack to disk needs a quarantine posture. Pinned: git streams to
`objects/pack/tmp_pack_<random>`, renames only after verification, and a hard kill
leaves the partial temp file behind (no cleanup). Whether git unlinks on a *handled*
failure was not pinned.

## Options considered

1. **Match git exactly (no cleanup ever)** — pros: literally faithful for the pinned case.
2. **git's layout + best-effort unlink on handled failure** (recommended, chosen) — pros: same pinned behaviour, tidier on soft errors.
3. **A separate tmp/ directory** — cons: diverges from git's on-disk layout; confuses a host `git gc`.

## Decision

**Adopted-as-recommended (no user judgment).** The pack streams to
`objects/pack/tmp_pack_<random>` with the trailer hashed incrementally; rename to
`pack-<sha>.pack` (+`.idx`/`.rev`) happens only after verification. A handled failure
best-effort-unlinks the temp file; a hard kill leaves it, as git does. Before claiming
parity on the handled-failure path, the implementer pins git's behaviour there
(kill the server side mid-stream, observe the client) and aligns if it differs.

## Consequences

Clone memory becomes O(window) instead of O(pack); the temp-file survival posture is
git's. The rename falls back to plain `rename` where `atomicRename` is absent (OPFS).
