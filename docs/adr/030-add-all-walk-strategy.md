# ADR-030: New `walkWorkingTree` primitive (do not reuse `walkTree`)

## Status

Accepted (at `5ecd61a`)

## Context

`add --all` (§14.1) needs a working-tree walk: enumerate every
file/symlink reachable from `ctx.layout.workDir`, skip `.git` and
embedded repos, surface `lstat` for each leaf.

The codebase already has a `walkTree` primitive
(`src/application/primitives/walk-tree.ts`). Its name is suggestive,
but its semantics are not what `add --all` needs:

- `walkTree` walks **git tree objects** — yields entries from a
  `Tree` (`{ id, name, mode }`), recursing via `readObject` into
  sub-trees.
- It has no `FileSystem` involvement. It does not know about
  `readdir`, `lstat`, or `workDir`.
- Its abort + cap semantics (cycle detection on `ObjectId`, max-depth
  on stored trees, max-entries on flattened tree) are calibrated to
  git-object pathology, not to filesystem traversal.

Forcing `walkTree` to also walk the working tree would either (a)
require a second adapter wrapping each `DirEntry` as a synthetic
`Tree`, which is contrived and round-trips through the domain layer
for no benefit, or (b) split `walkTree` into two primitives that
share nothing but the name. Either path bloats the API surface and
muddles the layering.

## Decision

Introduce a new primitive `walkWorkingTree(ctx, options?)` in
`src/application/primitives/walk-working-tree.ts`. It is a
filesystem-shaped DFS walker; it yields
`{ path: FilePath, stat: FileStat }` leaves. It reuses `validatePath`
+ `isForbiddenGitComponent` from `commands/internal/working-tree.ts`
for defence in depth, but has no dependency on `walkTree`.

`walkWorkingTree` is exposed at the primitives barrel and at
`repo.primitives.walkWorkingTree` so consumers can build their own
walks (e.g. a custom pathspec filter — §14.2 will compose on top).

## Consequences

### Positive

- Each walker has a single, well-defined responsibility — easier to
  test, easier to reason about, easier to mutate-test.
- Adding §14.2 (pathspec globs) and §14.3 (real ignore) becomes
  straightforward: filter / decorate the iterable returned by
  `walkWorkingTree`. No churn on `walkTree`.
- The shape parallels Phase 7's other "walk*" primitives, keeping
  the API discoverable.

### Negative

- One more primitive to maintain. Test count grows by ~13 specs.
- Slight DRY tension with `walkTree`'s abort + depth-cap pattern.
  Mitigated by reusing the same factory functions
  (`treeDepthExceeded`, `treeEntryLimitExceeded`,
  `operationAborted`).

### Neutral

- The yielded shape carries `stat: FileStat` (not just `path`) so
  the caller can avoid a second `lstat`. Callers that don't need
  the stat are free to ignore it.
