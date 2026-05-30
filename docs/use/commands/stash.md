# `stash`

Save dirty working-tree + index changes onto a stack and restore them later —
faithful to `git stash`. Nested namespace: `repo.stash.{push,list,apply,pop,drop}`.
The stack is the `refs/stash` reflog (`stash@{0}` is newest); each entry is a
`WIP` commit whose parents are the base commit, the index commit, and (with
`includeUntracked`) an untracked-files commit.

## Signature

```ts
interface StashNamespace {
  push(input?: {
    message?: string; // custom message → "On <branch>: <message>"
    includeUntracked?: boolean; // also stash untracked files (the U commit)
    keepIndex?: boolean; // leave the staged state intact after saving
  }): Promise<
    | { kind: 'saved'; stash: ObjectId; message: string }
    | { kind: 'no-local-changes' }
  >;

  list(): Promise<{
    entries: ReadonlyArray<{
      index: number; // 0 = newest
      selector: string; // "stash@{N}"
      stash: ObjectId; // the WIP commit
      message: string; // reflog message
    }>;
  }>;

  apply(input?: { index?: number; restoreIndex?: boolean }): Promise<
    | { kind: 'applied'; stash: ObjectId }
    | { kind: 'conflict'; conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }> }
  >;

  pop(input?: { index?: number; restoreIndex?: boolean }): Promise<
    | { kind: 'applied'; stash: ObjectId; dropped: ObjectId }
    | { kind: 'conflict'; conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }> }
  >;

  drop(input?: { index?: number }): Promise<{ dropped: ObjectId; remaining: number }>;
}

repo.stash: StashNamespace;
```

The entry selector is a numeric stack `index` (default `0`, the newest); the
`stash@{N}` string form is not accepted at the API (ADR-213).

## Methods

| Method | Purpose |
|---|---|
| `push` | Save tracked changes (and untracked with `includeUntracked`) onto the stack, then reset the working tree to HEAD (or to the index tree with `keepIndex`). Returns `no-local-changes` — not an error — when there is nothing to stash. |
| `list` | Return the stack newest-first. Empty when no stash exists. |
| `apply` | Restore `stash@{index}` onto the working tree via a 3-way merge (base = stash base, ours = current index, theirs = stashed tree). The stash is **retained**. |
| `pop` | `apply` then `drop` on success; on conflict the stash is **retained** and not dropped. |
| `drop` | Remove `stash@{index}` from the stack, repointing `refs/stash` to the new tip (or deleting it when the stack empties). |

## Behaviour

- **Save then reset.** `push` writes the W/I/U commits and the `refs/stash`
  reflog entry *before* resetting the working tree, so a crash never loses data
  before it is saved.
- **Apply leaves changes unstaged.** A clean `apply` materialises the merged
  result onto the working tree but leaves the index at HEAD, so restored changes
  appear as "not staged" — exactly like git. `restoreIndex` (`--index`)
  reinstates the originally-staged state when the index-side merge is clean.
- **Conflicts.** A conflicting `apply`/`pop` writes `<<<<<<<`/`>>>>>>>` markers
  to the working tree and stage-1/2/3 unmerged entries to the index (no
  `MERGE_HEAD` — stash apply is not a merge-in-progress), returns
  `{ kind: 'conflict' }`, and keeps the stash. Resolve, `repo.add(paths)`, then
  `repo.commit(...)` / re-run.
- **Overwrite guard.** `apply` refuses with `STASH_APPLY_WOULD_OVERWRITE` —
  writing nothing — when a path it would change carries uncommitted working-tree
  modifications, or when restoring untracked files would clobber an existing
  file (git's "local changes would be overwritten").

## Examples

```ts
// Stash the current changes, do something on a clean tree, then restore them
const saved = await repo.stash.push({ message: 'wip before refactor' });
if (saved.kind === 'saved') {
  // ... pull, switch branch, etc. ...
  await repo.stash.pop(); // restore + drop
}

// Stash including untracked files
await repo.stash.push({ includeUntracked: true });

// Inspect and selectively drop
const { entries } = await repo.stash.list();
await repo.stash.drop({ index: 0 });

// Restore staged-ness too
await repo.stash.apply({ restoreIndex: true });
```

## Throws

- `NO_INITIAL_COMMIT` — `push` on an unborn branch (no commit yet).
- `STASH_NOT_FOUND` — the selector `index` is out of range.
- `STASH_APPLY_WOULD_OVERWRITE` — `apply`/`pop` would overwrite uncommitted
  working-tree changes or an existing untracked file.
- `INVALID_COMMIT` — `refs/stash` points at a commit that is not a stash entry.

See [`../errors.md`](../errors.md) for the canonical `TsgitError.data.code` list.

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`merge`](merge.md) · [`reset`](reset.md) · [`checkout`](checkout.md)
- Recipes: [`../recipes.md`](../recipes.md)
- ADRs: 210–216
- Roadmap: Phase 21.3
