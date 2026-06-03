# ADR-254: `status` staged column reuses the coarse `ChangeKind` (type-change folds into `modified`)

## Status

Accepted (at `240cc89e`) — superseded by [ADR-255](255-status-first-class-type-and-mode-change.md)

## Context

`status` is gaining its real **staged** column (index-vs-HEAD, git's "Changes to
be committed", `git diff-index --cached HEAD`), wiring the already-built domain
function `diffIndexAgainstTree`. That function emits the full diff vocabulary:
`add`, `delete`, `modify`, **and `type-change`** (HEAD has a regular file, the
index has a symlink/gitlink — git porcelain code `T`).

`StatusResult` reports both columns with one coarse enum:

```ts
type ChangeKind = 'modified' | 'added' | 'deleted' | 'untracked';
```

The existing **working-tree** column already projects every mode/type/content
difference onto `'modified'` (`compareWorkingTreeEntry` returns
`absent | modified | unchanged`); it cannot represent `T` either. So the staged
column must decide how to project `diffIndexAgainstTree`'s `type-change`:

- **A. Collapse `type-change` → `modified`** — keep one coarse `ChangeKind`,
  symmetric across both columns.
- **B. Add a first-class `'type-change'` to `ChangeKind`** — reconstruct git's
  porcelain `T` faithfully for the staged column.

The prime directive favours byte-for-byte data faithfulness, so the divergence in
(A) must be recorded here. The counter-forces: the domain layer (and the `diff`
command) already capture `type-change` losslessly — the coarsening is purely a
`status`-summary projection; (B) is asymmetric unless the working-tree column is
*also* upgraded (a `compareWorkingTreeEntry` change), which widens the slice's
blast radius well beyond "add the staged column"; and 23.2b's deliverable is the
staged add/modify/delete column, not a `ChangeKind` enrichment.

## Decision

Adopt **A**: the staged column maps `diffIndexAgainstTree`'s `type-change` to
`ChangeKind.modified`, matching the working-tree column's existing projection.
Both `status` columns share one coarse `ChangeKind`. A faithful `type-change` (and
mode-only) `ChangeKind`, applied to **both** columns together, is deferred to a
logged backlog follow-up.

Faithfulness pinning excludes `type-change` from the `status-interop` XY
reconstruction (which covers add/modify/delete, both columns, unborn HEAD, clean);
the `T`→`modified` mapping is pinned by a unit test instead. The lossless
distinction remains available through the domain `diff` surface.

## Consequences

### Positive

- Symmetric, minimal `status` surface — one `ChangeKind` for both columns; no
  asymmetry where staged emits `type-change` but working-tree cannot.
- Bounded slice: no `compareWorkingTreeEntry` change, no public-API widening.
- Reuses the unit-tested `diffIndexAgainstTree` verbatim.

### Negative

- `status`'s structured output cannot reconstruct git porcelain `T` (typechange)
  for the staged column — a documented, deliberate coarsening at the summary
  projection (the underlying distinction is still reachable via `diff`).

### Neutral

- Renames never arise: `diffIndexAgainstTree` runs no rename detection.
- A future follow-up may promote `type-change`/mode changes to first-class
  `ChangeKind` values across both columns; this ADR would then be revisited.
