---
subjects:
  - tooling/profile-registry.ts
---
# 892 — The profile tool gains an explicit `open` workload

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (D10, DC-12) · **Supersedes/Refines:** none

## Context

The `profile` tool's `pack-read` workload opens a fresh repository on every iteration, so its
8000 iterations profile `openRepository` rather than the packed read they are named for. The
workload's baseline series is published and continuous.

## Options considered

1. **Add an explicit `open` workload and keep `pack-read`** — pros: the baseline series stays
   continuous; open gets an honest profile of its own / cons: two workloads. *Recommended by the
   design.*
2. **Rename `pack-read` to `open-read`** — cons: breaks the series name.
3. **Leave it** — cons: the profile keeps measuring the wrong thing under the right name.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** `tooling/profile-registry.ts` gains an
`open` workload that measures `openRepository` alone; `pack-read` keeps its name and is made to
profile the packed read on an already-open repository.

## Consequences

- The published profile series gains one row and keeps the existing ones comparable.
