# ADR-212: `stash apply`/`pop` use faithful conflict handling

## Status

Accepted (at `5fa805d6`)

## Context

`stash apply` performs a 3-way merge (base = stash base `b`, ours = current index
tree, theirs = stashed working tree `w_tree`). The merge can conflict. git
writes conflict markers to the working tree, leaves stage-1/2/3 unmerged entries
in the index (but **no** `MERGE_HEAD` — apply is not a merge-in-progress), and
aborts upfront when the merge would clobber overlapping unstaged/untracked
working-tree changes ("Your local changes … would be overwritten"). The project
mandate is git-faithfulness; the alternative is a clean-only MVP that refuses on
any conflict.

## Decision

Implement the **faithful** behaviour:

- **Clean merge** → materialise the merged tree onto the working tree; the index
  stays at the current index tree (changes appear unstaged), matching git.
- **Content conflict** → write `<<<<<<<`/`=======`/`>>>>>>>` markers to the
  working tree + stage-1/2/3 unmerged index entries; **no** `MERGE_HEAD`; return
  `{ kind: 'conflict', conflicts }`. The stash is **retained**.
- **Overwrite guard** → before writing, if a path the merge would change is dirty
  in the working tree relative to the index AND the merge target differs from the
  working content, refuse atomically with `STASH_APPLY_WOULD_OVERWRITE` (no
  partial write), mirroring git's pre-merge abort.
- **`pop` on conflict** → does **not** drop the stash (git retains it); returns
  the conflict result.

A conflict is a **result kind**, not a thrown error — consistent with `merge`'s
`{ kind: 'conflict' }`.

## Consequences

### Positive

- Byte-faithful to `git stash apply`, including the resolve-then-`add` recovery
  path and stash retention on conflict.
- Builds the conflict-markers-into-working-tree machinery Phase 22
  (cherry-pick/revert/rebase) reuses (see ADR-215).

### Negative

- Largest of the considered options: needs the overwrite guard, marker writing,
  and unmerged index-entry construction (reusing `merge`'s writers).

### Neutral

- After a conflicted apply the index carries unmerged entries with no
  `MERGE_HEAD`; a subsequent `commit` is correctly blocked until resolution —
  identical to git.

## Alternatives considered

1. **Clean-only (refuse on any conflict)** — rejected: diverges from git (no
   markers), violating the faithfulness mandate; would force a follow-up phase to
   add marker writing anyway.
2. **Markers without the overwrite guard** — rejected: silently clobbering
   unstaged working-tree changes is data loss git explicitly prevents.
