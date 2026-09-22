---
subjects:
  - src/repository/read-repository-format.ts
  - src/application/primitives/config-read.ts
---
# 891 — The open-time config read does not seed the session cache

- **Status:** accepted
- **Date:** 2026-09-22
- **Design:** docs/design/node-io-cold-read-pipeline.md (Brief corrections, DC-11) · **Supersedes/Refines:** refines ADR-850

## Context

The ordered open trace shows `read-repository-format.ts` reading `.git/config` while opening the
repository, after which the first command's operational gate stats and reads the same file
again: the open-time read seeds nothing. Seeding the session config cache from it would save one
`readFile` per open, but ADR-850 ties config freshness to the gate's epoch and the 31.2 session
caches own that lifecycle.

## Options considered

1. **Seed the cache at open** — pros: one `readFile` fewer per open / cons: crosses ADR-850's
   epoch contract and the cache ownership settled in 31.2; a rider on a design that is not about
   it.
2. **Leave it, record a follow-up** — pros: keeps the epoch contract intact; the saving gets its
   own small design / cons: one hop stays. *Recommended by the design.*

## Decision

**Option 2 — adopted-as-recommended (no user judgment).** The open-time read stays as it is. A
backlog follow-up records the measured saving and the ADR-850 constraint it must respect.

## Consequences

- One `readFile` per open remains until the follow-up lands.
- The session cache's epoch rules are not touched by this slice.
