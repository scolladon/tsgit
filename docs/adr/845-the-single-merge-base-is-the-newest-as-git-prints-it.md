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

**User-ratified.** The single-result `mergeBase` returns the reduced base with the newest committer
date. Equal committer dates are ordered exactly as git orders its result list; the implementation
reproduces that order and **pins it** with a criss-cross interop row whose two bases share a
committer second, run with and without a written commit-graph — the tie rule is measured against
git, never assumed from prose.

Superseded from ADR-191: the lexicographically-smallest selection rule and its claim to mirror
git.

Carried forward from ADR-191: the unification of the single-base path through the one
paint-down-to-common core, the deletion of the legacy bidirectional BFS and of the `a === b`
shortcut, and `merge`'s `const [base] = …` consumption of the array API.

## Consequences

`mergeBase()` and `git merge-base` agree in criss-cross histories; `merge` picks the same base git
would name. ADR-840's generation-then-date paint can order a same-second pair differently from
git's date-only main paint on a topo-level (v1) graph — that is the one residual the tie row must
exercise with a graph present. The primitive's documentation replaces "lexicographically smallest"
with "newest". The completed backlog entry for the original work keeps its citation, annotated with
this supersession.
