# 544 — Commit-graph reader is disabled by shallow-file presence

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/shallow-boundary-commit-walk.md · **Supersedes/Refines:** none

## Context

git refuses to *write* a commit-graph in a shallow repository (silent no-op, pins
C8–C11), and its `commit_graph_compatible` gate makes the *reader* ignore any existing
graph whenever `.git/shallow` exists — even a 0-byte file (decisive pins C4 vs C5/C6: a
graph-only traversal that succeeds without shallow fails with it, exit 128). A stale
graph must never re-introduce a masked parent.

## Options considered

1. **Disable the graph whenever the shallow file exists** (designer's recommendation) —
   pros: matches git's presence-not-content gate exactly (C6/C11) / cons: loses graph
   acceleration in shallow repos.
2. **Disable only when the parsed set is non-empty** — pros: keeps the graph for a 0-byte
   file / cons: diverges from git on exactly that pinned case.
3. **Keep the graph, mask its parents on top** — pros: keeps acceleration / cons: tsgit
   would succeed where git exits 128 — a divergence in the stale-graph case.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. `loadGraph` short-circuits to
absent when `isShallowRepository(ctx)` — a file-*presence* probe, distinct from the
parsed set — so `commitHeader` yields nothing and walks take the body-read path.

## Consequences

Faithful to pins C5/C6/C11, including failing on missing objects exactly where git does.
Accepted cost: no commit-graph acceleration in shallow repos — intrinsically bounded,
since a shallow repo holds ~depth commits and git itself never writes a graph there. The
two signals (presence vs parsed set) must stay distinct in the shallow-set module.
