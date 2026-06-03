# `status`

Compare the working tree, the index, and HEAD. Returns a structured `StatusResult` — caller-side filtering is straightforward via array methods (pathspec filtering at the command level is deferred per ADR-039).

## Signature

```ts
repo.status(): Promise<StatusResult>;

interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly indexChanges: ReadonlyArray<ChangeEntry>;
  readonly workingTreeChanges: ReadonlyArray<ChangeEntry>;
  readonly clean: boolean;
}

interface ChangeEntry {
  readonly kind: ChangeKind;     // 'modified' | 'added' | 'deleted' | 'untracked'
  readonly path: FilePath;
}
```

## Behaviour

- **Two independent columns.** `indexChanges` is the **staged** column — HEAD-tree vs index (git's "Changes to be committed", `git diff-index --cached HEAD`): `added` / `deleted` / `modified` per path. `workingTreeChanges` is the **working-tree** column — index vs working tree — plus untracked files. A path can appear in both (e.g. removed from the index but still on disk → staged `deleted` **and** `untracked`). `clean` is `true` only when every column is empty.
- **Coarse `ChangeKind`.** Both columns project onto one enum; a staged type change (git porcelain `T`) folds into `modified` (ADR-254).
- **Unborn HEAD.** With no commit yet, the HEAD tree is empty, so every staged entry is `added`.
- **Stat-cache fast path:** entries whose `mtime/ctime/size/ino` match the index's recorded stat fields are not re-hashed. This is the hot path that `add`/`commit`/`reset --mixed` populate.
- **Sparse-aware:** out-of-cone paths marked `skip-worktree` are not reported as deletions.
- **`.gitignore` integration:** untracked files matched by an ignore rule are filtered out before `clean` is computed.
- **Detached HEAD:** `branch` is `undefined` and `detached: true` when HEAD points directly at a commit.

## Examples

```ts
const { clean, branch, indexChanges, workingTreeChanges } = await repo.status();
if (!clean) console.log(`on ${branch}, ${indexChanges.length} staged, ${workingTreeChanges.length} unstaged`);

// Caller-side filter — only TS files
const ts = workingTreeChanges.filter(c => c.path.endsWith('.ts'));
```

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`walkWorkingTree`](../primitives/walk-working-tree.md), [`diffTrees`](../primitives/diff-trees.md)
- Related commands: [`add`](add.md), [`diff`](diff.md), [`checkout`](checkout.md), [`describe`](describe.md)
- ADRs: [039](../../adr/039-defer-status-pathspec.md), [254](../../adr/254-status-staged-column-coarse-changekind.md)
- Roadmap: Phase 22 — pathspec scoping on `status`
