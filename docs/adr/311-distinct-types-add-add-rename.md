# ADR-311: distinct-types add/add — implement git's `path~<label>` rename

## Status

Accepted (at `<sha-after-merge>`)

## Context

When both sides add the same path with **different object kinds** (regular file
vs symlink), git's ort strategy does not take one side or write markers — it
reports `CONFLICT (distinct types)` and **renames the regular-file side** to
`<path>~<side-label>` so each version can be recorded somewhere:

- the **symlink keeps the original path** (worktree + its single stage entry);
- the **regular file** lands at `<path>~<label>` (worktree + its single stage
  entry), where `<label>` is that side's conflict label (`HEAD` for ours; the
  rev/`<abbrev> (<subject>)` string for theirs) with `/` flattened to `_`;
- the rename target is made **unique** against every path in the three input
  trees (`_0`, `_1`, … appended while occupied);
- a dirty/untracked working file at the rename target makes the merge
  **refuse** ("untracked working tree files would be overwritten"), like any
  other would-be-clobbered path.

All rows verified against git 2.x ort on twin repos (both side orders, slashed
branch names, cherry-pick labels, tracked `~` collisions, untracked-target
refusal). tsgit today emits a bare take-ours `add-add` conflict for these
pairs — a silent divergence.

The alternative was deferring to a backlog follow-up and keeping the bare
add/add conflict (the shape originally proposed by the 24.9f design).

## Decision

Implement the rename now, as part of 24.9f. A new conflict type:

```ts
{
  type: 'distinct-types',
  path,                  // the original colliding path
  ourId, ourMode, theirId, theirMode,
  ourPath, theirPath,    // where each side is recorded (one === path)
}
```

- `mergeTrees` gains the per-operation `labels` (the existing `MergeLabels`
  strings — the same values the conflict markers and `%X`/`%Y` use, per
  ADR-307) to build the rename suffix; uniqueness is computed against the
  union path set of the three trees plus previously generated renames.
- Stage emission places each side's single stage entry at its **own** recorded
  path (stage 2 at `ourPath`, stage 3 at `theirPath`).
- Worktree materialisation writes both paths, symlink-aware (mode 120000 →
  `fs.symlink`, like `apply-changeset`).
- The overwrite guard covers **both** recorded paths, reproducing git's
  refusal.

Scope: regular-file vs symlink only. Pairs involving a gitlink keep the bare
`add-add` conflict (submodule merging is out of tsgit v1's merge surface);
symlink vs symlink stays a bare `add-add` (git does not content-merge link
targets — verified).

## Consequences

### Positive

- Closes a silent faithfulness divergence on the worktree, index, and refusal
  surfaces, byte-for-byte pinned by interop.
- The rename label reuses ADR-307's `MergeLabels` verbatim — no second label
  computation, and cherry-pick/rebase/revert/stash inherit faithful suffixes
  for free.

### Negative

- `MergeConflict` grows a second per-side-path shape that stage emission and
  both worktree writers must special-case.
- `mergeTrees`'s signature widens (labels), touching every caller.

### Neutral

- `git status` classification needs no change: the renamed entries are
  ordinary single-stage unmerged paths (`AU`/`UA`), already classified.
- The conflict-resolution porcelain (`add`/`rm` the renamed path) is the
  consumer's, as in git.
