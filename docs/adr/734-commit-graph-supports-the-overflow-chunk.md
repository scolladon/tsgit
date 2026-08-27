---
subjects:
  - src/domain/commit/commit-graph-writer.ts
  - src/domain/commit/commit-graph.ts
  - src/application/primitives/internal/read-commit-graph.ts
---
# 734 — Commit-graph supports the overflow chunk

- **Status:** accepted
- **Date:** 2026-08-27
- **Design:** docs/design/perf-remediation-2026-08.md (§P9, GDO2 pin) · **Supersedes/Refines:** refines ADR-724/731 (the commit-graph task's chunk coverage)

## Context

The implementer-owed pin ran: git 2.55.0 emits a `GDO2` (generation data overflow)
chunk when corrected commit dates overflow the 31-bit `GDA2` offset — reachable only
with pathological far-future commit dates. tsgit's reader refused `GDO2` graphs
(pre-existing posture) and the new writer refused to write graphs needing it, keeping
reader and writer consistent but diverging from git on such repositories.

## Options considered

1. **Refuse and record the divergence** (implementer's landed posture) — pros: never a silently wrong byte; divergence confined to pathological input / cons: a git-written `GDO2` graph is unreadable, and tsgit cannot graph such a repo at all.
2. **Implement `GDO2` read + write** (chosen) — full chunk parity, interop-pinned with overflow-date fixtures.

## Decision

**User-ratified.** The commit-graph reader parses `GDO2` (64-bit corrected-date offsets
for entries whose `GDA2` slot carries the overflow bit) and the writer emits it
byte-identically to `git commit-graph write --reachable` on the same overflow-inducing
commit set. The `COMMIT_GRAPH_GENERATION_OVERFLOW` refusal is retired in favour of the
chunk; refusals remain only for inputs git itself refuses.

## Consequences

Chunk coverage becomes `OIDF OIDL CDAT GDA2 [EDGE] [GDO2]` on both sides. The interop
suite gains an overflow-date fixture pinned byte-for-byte; the round-trip property
widens its date domain past the overflow boundary.
