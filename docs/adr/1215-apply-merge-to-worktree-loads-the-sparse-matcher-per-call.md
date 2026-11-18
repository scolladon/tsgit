---
subjects:
  - src/application/primitives/apply-merge-to-worktree.ts
---
# 1215 — applyMergeToWorktree loads the sparse matcher per call

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/sequencer-sparse-cone-writes.md · **Supersedes/Refines:** applies ADR-226

## Context

The sequencer, `rebase --rebase-merges` and stash all reach `applyMergeToWorktree`. The matcher can
be loaded inside it, or by each caller and passed in.

## Options considered

1. **Load inside `applyMergeToWorktree`, once per call.**
2. Caller-supplied `ApplyMergeInput.sparse`, loaded once per sequence.
3. Both, the input overriding the load.

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off: git re-reads the patterns on every
`unpack_trees`, so option 1 is the faithful one, and it changes no signature.

## Consequences

A pattern change between two steps of a sequence takes effect on the next step, as in git. The read
is one config plus one pattern file per step.
