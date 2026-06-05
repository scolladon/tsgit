# `status`

Compare the working tree, the index, and HEAD. Returns a structured `StatusResult` — caller-side filtering is straightforward via array methods (pathspec filtering at the command level is deferred per ADR-039).

## Signature

```ts
repo.status(): Promise<StatusResult>;

interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly changes: ReadonlyArray<ChangedPath>;
  readonly untracked: ReadonlyArray<FilePath>;
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
  readonly clean: boolean;
}

// 'modified' | 'added' | 'deleted' | 'type-changed' | 'mode-changed'
type ChangeKind = string;

interface BlobSide {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface WorktreeSide {
  readonly mode: FileMode;       // mW — no oid (working file is not in the object store)
}

interface ChangedPath {
  readonly path: FilePath;
  readonly staged?: ChangeKind;   // X — index vs HEAD
  readonly unstaged?: ChangeKind; // Y — working tree vs index
  readonly head?: BlobSide;       // hH / mH
  readonly index?: BlobSide;      // hI / mI
  readonly worktree?: WorktreeSide;
}

type ConflictKind =
  | 'both-modified' | 'both-added' | 'both-deleted'
  | 'added-by-us' | 'added-by-them' | 'deleted-by-us' | 'deleted-by-them';

interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: BlobSide;   // stage 1 (merge base)
  readonly ours?: BlobSide;   // stage 2 (our side)
  readonly theirs?: BlobSide; // stage 3 (their side)
}
```

## Behaviour

- **One correlated record per path.** `changes` holds one `ChangedPath` per tracked path with a change — the structured form of `git status --porcelain=v2`'s ordinary line. `staged` (git's X, index vs HEAD) and `unstaged` (git's Y, working tree vs index) live on the **same** record, so correlating the two columns is a lookup, not a join. `clean` is `true` only when `changes`, `untracked`, **and** `unmerged` are all empty.
- **Self-describing endpoints → hunks.** Each record carries the blobs that form its diffs: `head`/`index` (`{ id, mode }`) and `worktree` (`{ mode }` only — git prints `mW` but no working oid). The hunks for any path are one read away — staged: `readBlob(head)` vs `readBlob(index)`; unstaged: `readBlob(index)` vs the working file at `path`. A side is omitted when the path does not exist there (staged add → no `head`; staged delete → no `index`; deleted in the worktree → no `worktree`).
- **Untracked.** `untracked` is the separate set of untracked paths (git's `?` lines). A path removed from the index but kept on disk (`git rm --cached`) appears as a staged `deleted` record in `changes` **and** in `untracked` — git's `D ` + `??`.
- **First-class `type-changed` / `mode-changed`.** Both columns distinguish a kind change (file↔symlink, git porcelain `T`) as `type-changed` and a same-blob mode-only change (exec bit, git `M`) as `mode-changed`, alongside content `modified` (ADR-255). A gitlink/submodule entry stays `modified` (git reports a submodule as `M`, not `T`). To reconstruct git's porcelain `XY`, map `type-changed → T` and `mode-changed → M`.
- **Unmerged paths.** `unmerged` reports conflicted paths (index stages 1/2/3 — git's "Unmerged paths"), each with a `kind` (the seven git conflict states, reconstructing the `UU`/`AA`/`DD`/`AU`/`UA`/`DU`/`UD` codes) and the present per-stage blobs (`base`/`ours`/`theirs`). A conflicted path is reported **only** here, never in `changes`/`untracked` (ADR-256).
- **Unborn HEAD.** With no commit yet, the HEAD tree is empty, so every staged entry is `added` (no `head` side).
- **Stat-cache fast path:** entries whose `mtime/ctime/size/ino` match the index's recorded stat fields are not re-hashed. This is the hot path that `add`/`commit`/`reset --mixed` populate.
- **Sparse-aware:** out-of-cone paths marked `skip-worktree` are not reported as deletions.
- **`.gitignore` integration:** untracked files matched by an ignore rule are filtered out before `clean` is computed.
- **Detached HEAD:** `branch` is `undefined` and `detached: true` when HEAD points directly at a commit.

## Examples

```ts
const { clean, branch, changes, untracked } = await repo.status();
if (!clean) {
  const staged = changes.filter(c => c.staged !== undefined).length;
  const unstaged = changes.filter(c => c.unstaged !== undefined).length;
  console.log(`on ${branch}, ${staged} staged, ${unstaged} unstaged, ${untracked.length} untracked`);
}

// Caller-side filter — only TS files
const ts = changes.filter(c => c.path.endsWith('.ts'));

// Hunks for a staged change, straight from its endpoints
const c = changes.find(x => x.path === 'src/app.ts');
if (c?.head && c.index) {
  const before = await repo.primitives.readBlob(c.head.id);
  const after = await repo.primitives.readBlob(c.index.id);
  // diffLines(before.content, after.content) → the staged hunks
}
```

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`walkWorkingTree`](../primitives/walk-working-tree.md), [`diffTrees`](../primitives/diff-trees.md), [`readBlob`](../primitives/read-blob.md)
- Related commands: [`add`](add.md), [`diff`](diff.md), [`checkout`](checkout.md), [`describe`](describe.md)
- ADRs: [039](../../adr/039-defer-status-pathspec.md), [254](../../adr/254-status-staged-column-coarse-changekind.md) (superseded), [255](../../adr/255-status-first-class-type-and-mode-change.md), [256](../../adr/256-status-unmerged-paths-field.md), [269](../../adr/269-status-correlated-changed-path-record.md)
- Roadmap: Phase 22 — pathspec scoping on `status`
