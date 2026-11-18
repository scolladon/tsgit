---
subjects:
  - src/application/primitives/apply-merge-to-worktree.ts
  - src/application/commands/merge.ts
supersedes:
  - adr: "076"
    scope: "the rule that an excluded resolved-merged outcome is always written"
---
# 1211 — An excluded line-merged path is staged skip-worktree, not written

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/sequencer-sparse-cone-writes.md · **Supersedes/Refines:** supersedes ADR-076 (resolved-merged clause)

## Context

ADR-076 ruled that a conflicting merge writes an out-of-pattern `resolved-merged` outcome to the
working tree, because the working-tree file was the merged bytes' only home. Both premises are now
false. git 2.56.0 hashes the line-merged blob, stages it at stage 0 with skip-worktree and leaves
the file off disk: `merge` (row mcf3), `cherry-pick` (cf3), a rebase pick (cf3rb) and a conflicted
`stash apply` (scf3) all leave `S 1f29e7f a/f` with no file. And tsgit's conflict paths already
hash those bytes into blobs, so the working-tree write is not their sole persistence.

## Options considered

1. **Supersede the clause for `merge` and the sequencer/stash conflict path**: one shared rule.
2. Apply git's rule to the sequencer/stash conflict path only; keep ADR-076 for `merge` and record
   mcf3 as a known divergence.
3. Keep ADR-076 and extend it to the sequencer; cf3/cf3rb/scf3/mcf3 stay red.

## Decision

**ratified by the user** — option 1, per ADR-226.

Superseded from ADR-076: an excluded `resolved-merged` outcome is always written. It is now staged
at stage 0 with `skipWorktree: true` under its merged blob id and not written, in `merge` and in
`applyMergeToWorktree`'s conflict path alike.

Carried forward from ADR-076: an excluded blob-backed clean outcome (`unchanged`/`resolved-known`)
is not written and is staged skip-worktree; a conflicted path is always written and its stages
carry no bit; `resolved-deleted` needs no guard.

## Consequences

One predicate decides materialisation for both conflict paths: a clean outcome is written only
inside the patterns; a conflict always is. `AUTO_MERGE` still records the merged blob.
