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
(`insert_parent_or_die`), and it bounds a parent by the CHILD's own layer —
`pos >= g->num_commits + g->num_commits_in_base`, where `g` is the layer that owns the child
after `fill_commit_in_graph` walks down to it — so a position naming a commit in a HIGHER layer of
the chain is refused even though it is a real slot for some layer. The reader's own posture for a graph that fails to decode — a corrupt
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

**Adopted-as-recommended (no user judgment).** `resolveParentIds` refuses a parent position at or
past the CHILD's own-layer bound (`layerOffsets[childLayer] + layer.commitCount`, git's
`num_commits + num_commits_in_base`) with `INVALID_COMMIT_GRAPH_CHUNK` before resolving it;
`findLayerForGlobalPosition` keeps the same check against the resolved layer as the single-layer and
whole-chain guard. `commitHeader`'s existing decode-fault handling turns either refusal into "graph
absent for this session", and the session's cached headers are dropped so nothing served before the
fault lingers. Nothing is ever read from the bytes past the OID table, and an upward cross-layer
reference — a real slot for a higher layer — is refused exactly where git dies.

## Consequences

A graph naming a parent position past the child's own layer — whether beyond the whole chain or an
upward cross-layer reference into a higher layer — no longer fabricates ancestry or leaks
`INVALID_OBJECT_ID`; every graph-first reader falls back to the object store and stays correct, and
headers served from the graph before the fault are discarded with it. The recorded divergence: git
exits 128 on such a graph, tsgit answers from objects. Pinned by four unit rows — position equal to
the layer count, position far beyond every layer, an upward cross-layer position in a two-layer
chain, and a header served before the fault returning undefined after the degrade; the equal-count
and cross-layer rows also assert a walk that still yields the true ancestry.
