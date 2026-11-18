---
subjects:
  - src/application/primitives/apply-merge-to-worktree.ts
  - src/application/commands/merge.ts
---
# 1212 — A conflict stop retires clean out-of-pattern files

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/sequencer-sparse-cone-writes.md · **Supersedes/Refines:** applies DOCTRINE(D-2)

## Context

git's `unpack_trees` re-applies the sparse patterns to every index path, not only to changed ones.
An out-of-pattern file that is present, clean and not skip-worktree is removed and marked `S` by a
conflicted cherry-pick (row pscf) and a conflicted `merge` (mpscf). tsgit's clean path already does
this through `materializeTree`'s movers; neither conflict path does.

## Options considered

1. **One shared mover helper for the sequencer/stash conflict path and `merge`'s conflict writers.**
2. Sequencer/stash only; mpscf goes to the ledger.
3. Defer both.

## Decision

**adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): the shared half is folded whole, with
an interop pin per consumer.

## Consequences

A clean untouched mover keeps its id and mode and gains the bit; a changed one takes the result's.
A dirty mover follows ADR-1213.
