# ADR-215: extract an `applyMergeToWorktree` primitive shared with Phase 22

## Status

Accepted (at `5fa805d6`)

## Context

`stash apply` needs to run a 3-way tree merge and apply the result to the
working tree + index (clean → materialise; conflict → markers + unmerged
entries). `merge.ts` already does this, but its clean-outcome and conflict
writers are partly inline and only some helpers are exported
(`writeOutcomeToTree`, `runBounded`, `writeNestedTree`); the clean-merge path in
`merge` does not even materialise to the working tree (it only commits the tree).
Phase 22 (cherry-pick / revert / rebase) will need the identical "apply a 3-way
merge to the working tree" step. The backlog frames 21.3 as introducing
"working-tree snapshot infra reused by 22".

## Decision

Extract a focused primitive
`primitives/apply-merge-to-worktree.ts`:

```
applyMergeToWorktree(ctx, { baseTree, oursTree, theirsTree, … })
  → { kind: 'clean';    mergedTree: ObjectId }
  | { kind: 'conflict'; conflicts: ReadonlyArray<MergeConflict> }
```

It composes the **domain** `mergeTrees` / `mergeContent` (already 100%-covered,
pure) with the working-tree writers, materialising the merged outcomes (clean) or
markers + stage-1/2/3 entries (conflict). `stash apply` consumes it; Phase 22's
apply step will consume the same primitive. `merge.ts`'s **public behaviour is
unchanged** — this phase does not refactor `merge`'s commit path; it factors out
the shared worktree-application step so two callers do not duplicate it.

## Consequences

### Positive

- One tested seam for "3-way merge → working tree + index"; Phase 22 reuses it
  instead of re-deriving it.
- `stash apply` does not depend on `merge`'s commit/ref-update machinery (which
  it must not trigger — apply writes no commit and no `MERGE_HEAD`).

### Negative

- A new primitive plus its own 100%-coverage + mutation burden; some overlap with
  `merge`'s existing inline writers until a future phase migrates `merge` onto it.

### Neutral

- Migrating `merge.ts` itself onto the primitive is explicitly out of scope here
  (would risk `merge`'s mutation-tested invariants); tracked for a later cleanup.

## Alternatives considered

1. **Inline the merge-apply in `stash.ts`** — rejected: Phase 22 would duplicate
   it; the backlog explicitly wants shared infra.
2. **Refactor `merge.ts` to expose its path** — rejected for this phase: large,
   risky to `merge`'s 100%-mutation invariants; deferred.
