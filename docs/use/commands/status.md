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
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
  readonly clean: boolean;
}

interface ChangeEntry {
  // 'modified' | 'added' | 'deleted' | 'untracked' | 'type-changed' | 'mode-changed'
  readonly kind: ChangeKind;
  readonly path: FilePath;
}

type ConflictKind =
  | 'both-modified' | 'both-added' | 'both-deleted'
  | 'added-by-us' | 'added-by-them' | 'deleted-by-us' | 'deleted-by-them';

interface ConflictStage {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: ConflictStage;   // stage 1 (merge base)
  readonly ours?: ConflictStage;   // stage 2 (our side)
  readonly theirs?: ConflictStage; // stage 3 (their side)
}
```

## Behaviour

- **Two independent columns.** `indexChanges` is the **staged** column — HEAD-tree vs index (git's "Changes to be committed", `git diff-index --cached HEAD`). `workingTreeChanges` is the **working-tree** column — index vs working tree — plus untracked files. A path can appear in both (e.g. removed from the index but still on disk → staged `deleted` **and** `untracked`). `clean` is `true` only when every column **and** `unmerged` are empty.
- **First-class `type-changed` / `mode-changed`.** Both columns distinguish a kind change (file↔symlink, git porcelain `T`) as `type-changed` and a same-blob mode-only change (exec bit, git `M`) as `mode-changed`, alongside content `modified` (ADR-255). A gitlink/submodule entry stays `modified` (git reports a submodule as `M`, not `T`). To reconstruct git's porcelain `XY`, map `type-changed → T` and `mode-changed → M`.
- **Unmerged paths.** `unmerged` reports conflicted paths (index stages 1/2/3 — git's "Unmerged paths"), each with a `kind` (the seven git conflict states, reconstructing the `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD` codes) and the present per-stage blobs (`base`/`ours`/`theirs`). A conflicted path is reported **only** here, never in the other columns (ADR-256).
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
- ADRs: [039](../../adr/039-defer-status-pathspec.md), [254](../../adr/254-status-staged-column-coarse-changekind.md) (superseded), [255](../../adr/255-status-first-class-type-and-mode-change.md), [256](../../adr/256-status-unmerged-paths-field.md)
- Roadmap: Phase 22 — pathspec scoping on `status`
