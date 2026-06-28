# 421 — bundle create accepts the full rev-selection grammar

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-226 (git-faithfulness), ADR-424 (boundary walk)
- **Decision class:** D-SCOPE (user judgment)

## Context

`git bundle create <file> <git-rev-list-args>` accepts the full rev-list selection
grammar — named refs, the `--all` / `--branches` / `--tags` pseudo-refs, two-dot ranges
(`A..B`), three-dot symmetric difference (`A...B`), and `^`-exclusion. tsgit already
carries rev infrastructure (`revParse` resolution and the rev-list walk machinery) from
earlier work. The question is how much of that grammar the first cut of `create` exposes.

## Options considered

1. **Named refs + `--all`/`--branches`/`--tags` only** — pros: smallest surface; no
   prerequisite computation in the common all-history case; cons: no incremental bundles;
   diverges from the git CLI.
2. **+ two-dot ranges and `^`-exclusion via structured include/exclude lists** *(designer
   recommendation)* — pros: covers incremental bundles without a rev-string parser; cons:
   no three-dot symmetric difference; still short of the CLI grammar.
3. **Full rev grammar** (named refs, pseudo-refs, two-dot, three-dot, `^`-exclusion) —
   pros: byte/behaviour parity with `git bundle create`; reuses the existing rev-list
   machinery rather than a bespoke subset; cons: a wider interop matrix to pin.

## Decision

**Option 3 — ratified by the user**, deviating from the designer's smaller first cut. The
user chose maximal CLI fidelity. `create` accepts the full rev-selection grammar by
composing the existing rev resolution and rev-list walk, not a hand-rolled include/exclude
subset.

## Consequences

- Object enumeration and prerequisite (boundary) computation must handle two-dot,
  three-dot (merge-base), and `^`-exclusion — making the boundary walk of ADR-424
  load-bearing rather than optional.
- The interop suite pins each grammar form against real `git bundle create`.
- No new rev-expression parser is introduced; the grammar is the existing machinery's.
