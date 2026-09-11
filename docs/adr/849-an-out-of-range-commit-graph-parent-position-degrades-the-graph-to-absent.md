---
subjects:
  - src/application/primitives/internal/read-commit-graph.ts
---
# 849 — An out-of-range commit-graph parent position degrades the graph to absent

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/closure-history-walks.md (D6, review finding) · **Supersedes/Refines:** refines ADR-544 and ADR-848

## Context

The commit-graph reader resolved a parent position by layer offset alone and never checked it
against the layer's commit count. A position equal to the count handed back the bytes after the OID
table as a fabricated parent (the first commit's root tree), and a far position surfaced
`INVALID_OBJECT_ID` — a caller-input code — out of every graph-first reader. The exposure grew with
this change: the not-side marker, merge-base, name-rev and bisect now trust graph-named parents.
git 2.55.0 refuses the same graph at use time: `fatal: invalid parent position N`, exit 128
(`insert_parent_or_die`). The reader's own posture for a graph that fails to decode — a corrupt
file, a truncated `EDGE` chunk — is to treat the graph as absent for the rest of the session and
answer from objects.

## Options considered

1. **Refuse the position as a decode fault and let the existing degrade-to-absent path answer from
   objects** (recommended, chosen) — pros: one posture for every internal inconsistency; results are
   correct because the bodies are read; the session records the verdict / cons: git dies where
   tsgit answers, a divergence on an error surface.
2. **Surface git's die** — pros: exit-128 parity / cons: a corrupt cache file then fails every commit
   read for the session where the object store holds the truth; inconsistent with the parse-fault
   posture already shipped.
3. **Leave the reader alone** — cons: silent fabrication of a parent, and a caller-input error code
   for a corrupt file.

## Decision

**Adopted-as-recommended (no user judgment).** `findLayerForGlobalPosition` refuses a position at or
past the resolved layer's commit count with `INVALID_COMMIT_GRAPH_CHUNK`, which `commitHeader`'s
existing decode-fault handling turns into "graph absent for this session". Nothing is ever read from
the bytes past the OID table.

## Consequences

A graph naming an impossible parent position no longer fabricates ancestry or leaks
`INVALID_OBJECT_ID`; every graph-first reader falls back to the object store and stays correct. The
recorded divergence: git exits 128 on such a graph, tsgit answers from objects. Pinned by two unit
rows (position equal to the count, position far beyond it) that assert the degrade, the session's
absent verdict, and a walk that still yields the true ancestry.
