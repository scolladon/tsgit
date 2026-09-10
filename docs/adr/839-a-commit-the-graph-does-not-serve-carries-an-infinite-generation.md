---
subjects:
  - src/application/primitives/internal/read-commit-meta.ts
---
# 839 — A commit the graph does not serve carries an infinite generation

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-4) · **Supersedes/Refines:** none

## Context

`readCommitMeta` serves parents, committer date and generation from the commit-graph when it
covers the commit and from the object otherwise. The two generation cutoffs (merge-base's
`min_generation` break, name-rev's `commit_is_before_cutoff`) need a value for a commit the graph
does not serve. git's `commit_graph_generation` returns `GENERATION_NUMBER_INFINITY` both for a
commit outside the graph and for a graph that stored generation `0`.

## Options considered

1. **`GENERATION_INFINITY = Number.POSITIVE_INFINITY`, graph value `0` mapped to it too** (recommended, chosen) — pros: both cutoffs become literal transcriptions of git's comparisons (`x < Infinity`, `Infinity < Infinity`) / cons: a sentinel value on a numeric field.
2. **`generation?: number`** — cons: pushes an `undefined` branch into every comparator; comparator mutants multiply.
3. **A `{ source: 'graph' | 'object' }` discriminant** — cons: same branching, more surface.

## Decision

**Adopted-as-recommended (no user judgment).** `CommitMeta.generation` is a number; a graph miss or
a stored `0` yields `GENERATION_INFINITY`, playing git's `GENERATION_NUMBER_INFINITY` role.

## Consequences

With no graph every generation is infinite, so every generation-aware comparator degenerates to
today's date order and every cutoff is inert — the gate is the data, not a flag. A graph-absent
commit met while a graph-covered target sets the cutoff is never pruned, exactly as in git.
