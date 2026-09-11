---
subjects:
  - src/application/primitives/merge-base.ts
supersedes:
  - adr: "191"
    scope: "the single-base selection rule (lexicographically smallest reduced base)"
---
# 845 — The single merge base is the newest, as git prints it

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-10) · **Supersedes/Refines:** supersedes ADR-191 (selection rule only); refines ADR-190

## Context

ADR-191 routed the single-result `mergeBase` through the paint-down-to-common core and chose the
lexicographically smallest reduced base, describing it as mirroring `git merge-base`. Pinning a
criss-cross history against git 2.55.0 with and without a commit-graph (design Pin P5) shows git
prints the **newest** base: `merge-base d1 e1` returns `C` (committer date 1700000200) where the
lexicographic rule returns `B` (1700000100); `merge-base --all` lists them date-sorted, newest
first. `show_merge_base` prints the head of git's date-ordered result list. This is a pre-existing
faithfulness defect on a result-bearing surface, surfaced because this change pins merge-base with
a graph, and the paint loop is being rewritten for the generation cutoff.

## Options considered

1. **Fix in this change and supersede ADR-191** (recommended, chosen) — pros: faithful; the loop is open anyway; everything rides in the current change / cons: a behaviour change inside a performance change; also changes which base `merge` picks in criss-cross histories.
2. **A separate backlog item** — pros: this change stays behaviour-preserving for merge-base / cons: leaves a known result defect in place and splits the interop pin.
3. **Keep ADR-191 as a recorded divergence** — cons: a permanent divergence on a result-bearing surface.

## Decision

**User-ratified, refined after measurement.** The single-result `mergeBase` returns what
`git merge-base` prints: the FIRST base its paint pops. Without a graph every generation is
infinite, so the paint runs to completion, drops the stale results, and a stable date-descending
sort over the results in the order they were discovered (pop order) puts the newest base first.
With a graph, git breaks the paint at the first base it records whenever that base has a finite
generation, so the single result is the first base popped in the queue's order (ADR-840) — which
legitimately differs from the newest-dated base in some criss-cross shapes, and differs between
`merge-base d e` and `merge-base e d` when the bases tie on generation and date. Both rules are
pinned against git 2.55.0 with and without a written commit-graph: the newest-over-lexicographic
shape, the same-second tie, and a shape whose answer changes when the graph appears.

Superseded from ADR-191: the lexicographically-smallest selection rule and its claim to mirror
git.

Carried forward from ADR-191: the unification of the single-base path through the one
paint-down-to-common core, the deletion of the legacy bidirectional BFS and of the `a === b`
shortcut, and `merge`'s `const [base] = …` consumption of the array API.

## Consequences

`mergeBase()` and `git merge-base` agree in criss-cross histories, graph or no graph. `merge`
and `rebase` consume the default result, so on a criss-cross they now start from the base
`git merge-base` prints rather than the lexicographically smallest one; `git merge` itself uses
every base through a recursive virtual ancestor, a divergence this record does not close. ADR-840's generation-then-date paint can order a same-second pair differently from
git's date-only main paint on a topo-level (v1) graph — that is the one residual the tie row must
exercise with a graph present. The primitive's documentation replaces "lexicographically smallest"
with "newest". The completed backlog entry for the original work keeps its citation, annotated with
this supersession.
