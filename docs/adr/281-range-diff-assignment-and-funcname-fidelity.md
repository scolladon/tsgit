# ADR-281: `range-diff` ports git's exact assignment and default funcname heuristic

## Status

Accepted

## Context

The range-diff correspondence is **observable** (it is `git range-diff -s`), so
the prime directive binds it: our matching must agree with git's byte-for-byte.
Git's matching is (1) exact patch matches (hash of the line-number-stripped `## `
diff text), then (2) a min-cost bipartite assignment over a cost matrix solved by
`compute_assignment` (the Jonker-Volgenant LAP in `linear-assignment.c`). The
costs are `diffsize` (a 3-context line count) between the two `## ` diff texts,
with creation/deletion costs `diffsize * creationFactor / 100` (integer division,
default factor 60). Both the cost and the `=`/`!` status depend on the exact `## `
patch text — including the **hunk section heading** git appends to `@@` lines
(its `XDL_EMIT_FUNCNAMES` funcname). Without a userdiff driver git uses the
built-in `def_ff` heuristic (nearest preceding old-file line whose first byte is
alpha/`_`/`$`, trailing-ws-stripped, ≤80 bytes).

Two fidelity questions:

- **Matching algorithm:** port `compute_assignment` verbatim (identical
  tie-breaking ⇒ identical assignment) vs. a simpler greedy/heuristic matcher
  (risks diverging on reorderings and near-ties).
- **Funcname headings:** implement the `def_ff` heuristic now (so the `## ` `@@`
  lines — hence the cost, the `=`/`!` status, and the diff-of-diffs — match git on
  source files) vs. omit it (byte-faithful only for content with no
  funcname-detectable context: prose, data, sequences).

## Decision

Port git's **exact** engine and the **default funcname** heuristic:

- `domain/range-diff/linear-assignment.ts` is a verbatim port of
  `compute_assignment` (column reduction → reduction transfer → two
  augmenting-row-reduction phases → augmentation), preserving tie-breaking. The
  cost matrix, `COST_MAX = INT_MAX`, integer creation cost, and the exact-match
  pass (diff-string equality, LIFO on duplicate keys to mirror git's hashmap)
  reproduce `get_correspondences`/`find_exact_matches`.
- `domain/range-diff/funcname.ts` ports `def_ff` + the backward old-file scan
  (`get_func_line`: scan from `firstOldLine - 1` toward the previous hunk's start;
  nearest `def_ff` match; retain the prior hunk's heading when none is found).
  The `@@` line becomes `@@ <newPath>: <funcname>` when found, else `@@`.

**Userdiff-driver funcname patterns** (`.gitattributes diff=<lang>`) are deferred
— no `.gitattributes` support exists anywhere (backlog 24.9 territory). For the
default git config (no driver), the headings are byte-faithful.

## Consequences

### Positive

- The assignment is byte-identical to git's for all inputs (verbatim LAP), so
  `git range-diff -s` reconstructs from the structured entries on reorderings,
  near-ties, and the integer-division small-patch split.
- The `## ` text — and therefore the cost, the `=`/`!` status, and the
  diff-of-diffs — is byte-faithful on source files (funcname headings), not just
  prose. The diff-of-diffs body interop-reconstructs exactly.

### Negative

- A verbatim C-to-TS port of a dense LAP plus the funcname scan is a substantial,
  intricate pure core to test to 100% line/branch + 0 mutants. Mitigated by
  property tests (LAP returns a permutation; cost ≤ identity; mutual inverses) and
  by hand-computed optima.

### Neutral

- `creationFactor` is the one behavioural knob exposed (default 60); it changes
  the *matching*, so it is a real selector, not rendering.
- The default-only funcname boundary is the single faithful divergence, scoped to
  repos that configure a userdiff driver — re-addable additively once
  `.gitattributes` lands.
