# `worktree`

Manage **linked working trees** over one object store — git's `git worktree`.
A linked worktree is a second checkout that shares the repository's objects and
shared refs but keeps its own `HEAD` / `index` / per-worktree state under an
admin directory `<commonDir>/worktrees/<id>/`. Nested-namespace surface
(`repo.worktree.list/add/move/remove`).

Results are **structured data only**: `list` returns the per-worktree fields
(path, head oid, branch, detached, bare, locked, prunable); the `git worktree
list [--porcelain]` rendering is a caller projection.

## Signature

```ts
repo.worktree.list(): Promise<WorktreeListResult>;
repo.worktree.add(opts: WorktreeAddOptions): Promise<WorktreeAddResult>;
repo.worktree.move(from: string, to: string, opts?: WorktreeMoveOptions): Promise<WorktreeMoveResult>;
repo.worktree.remove(path: string, opts?: WorktreeRemoveOptions): Promise<WorktreeRemoveResult>;

interface WorktreeEntry {
  readonly id?: string;          // admin id; absent for the main worktree
  readonly path: FilePath;       // absolute worktree path
  readonly head?: ObjectId;      // HEAD oid; absent for an unborn branch / bare main
  readonly branch?: RefName;     // full branch refname; absent when detached/bare
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked?: { readonly reason: string };
  readonly prunable?: { readonly reason: string };
  readonly main: boolean;
}
interface WorktreeListResult { readonly entries: ReadonlyArray<WorktreeEntry>; }

interface WorktreeAddOptions {
  readonly path: string;         // worktree-relative or absolute target dir
  readonly commitish?: string;   // start point; default 'HEAD'
  readonly branch?: string;      // -b: create this new branch
  readonly detach?: boolean;     // --detach: detached HEAD at the start point
  readonly force?: boolean;      // override existing-branch / checked-out refusals
}
interface WorktreeAddResult {
  readonly path: FilePath;
  readonly id: string;
  readonly head: ObjectId;
  readonly branch?: RefName;     // created/checked-out branch; absent when detached
  readonly detached: boolean;
}

interface WorktreeMoveOptions { readonly force?: boolean; }   // move a locked worktree
interface WorktreeMoveResult { readonly from: FilePath; readonly to: FilePath; readonly id: string; }

interface WorktreeRemoveOptions { readonly force?: boolean; } // remove a dirty/locked worktree
interface WorktreeRemoveResult { readonly path: FilePath; readonly id: string; }
```

## Behaviour

- **`add` modes** — with no `commitish`/`branch`/`detach`, creates a branch named
  after the path basename at `HEAD`; `branch` (`-b`) creates that branch at the
  start point; a `commitish` that names an existing local branch checks it out;
  anything else (or `detach`) gives a detached HEAD. The working tree + a
  per-worktree index are materialised, the admin pointer files
  (`HEAD`/`commondir`/`gitdir`/`ORIG_HEAD`/`logs/HEAD`) and the worktree `.git`
  gitfile are written byte-for-byte to git's format.
- **`list`** — the main worktree first, then linked worktrees sorted by path.
  The main entry's path is always derived from the common dir (a trailing
  `/.git` stripped), so `list` run from inside a linked worktree still reports
  the *main* worktree first with its own path — never the linked worktree the
  call happened to run from — matching `git worktree list --porcelain`.
  `locked` is present when `<admin>/locked` exists (`reason` is its trimmed
  content); `prunable` is present when the worktree directory is gone.
- **Opening from inside a linked worktree.** `openRepository({ cwd: <worktree
  path> })` resolves the worktree's `.git` gitfile pointer to its admin
  directory and the admin dir's own `commondir` file, so every command works
  the same from inside a linked worktree as from the main one: shared refs,
  objects, `packed-refs`, `config`, and `shallow` are read/written in the
  common dir; `HEAD`, the index, and the other per-worktree state stay in the
  admin dir.
- **`move`** — renames the worktree directory and re-points the admin `gitdir`
  file; the `.git` gitfile moves with the directory and still points at the
  (unchanged) admin dir.
- **`remove`** — refuses a dirty worktree (modified or untracked files) unless
  `force`, then deletes the worktree directory and its admin dir; the branch is
  left intact.
- **Worktrees outside the repo** — a worktree path may be a sibling or any
  absolute location; the library reaches it through a containment-confined
  filesystem capability (the worktree path + the common dir only) so the
  workDir guard is not dropped (ADR-298). Sandboxed adapters (memory/browser)
  confine worktrees under their root.
- **Caller projection — `git worktree list`.** Reconstruct each porcelain block
  from the fields: `worktree <path>` / `HEAD <head>` / (`branch <branch>` |
  `detached`) / optional `locked` / `prunable` / `bare`.

## Examples

```ts
// A sibling worktree on a new branch
const wt = await repo.worktree.add({ path: '../feature', branch: 'feature' });

// List, reconstructing the porcelain
for (const e of (await repo.worktree.list()).entries) {
  const ref = e.detached ? 'detached' : e.branch;
  console.log(e.path, e.head, ref, e.locked ? 'locked' : '');
}

// Relocate then remove
await repo.worktree.move('../feature', '../feature-2');
await repo.worktree.remove('../feature-2', { force: true });
```

## Throws

- `WORKTREE_PATH_EXISTS` — the target (or move destination) exists and is not empty.
- `BRANCH_EXISTS` — `add -b <branch>` where the branch already exists (no force).
- `BRANCH_CHECKED_OUT` — the requested branch is already used by another worktree.
- `WORKTREE_LOCKED` — `move`/`remove` on a locked worktree (no force).
- `WORKTREE_DIRTY` — `remove` on a worktree with modified/untracked files (no force).
- `NOT_A_WORKTREE` — `move`/`remove` on a path that is not a linked worktree.
- `INVALID_OPTION` — `move`/`remove` targeting the main worktree.
- `OBJECT_NOT_FOUND` / `REVPARSE_UNRESOLVED` — the start point does not resolve.

## Non-goals (v1)

`lock` / `unlock` / `prune` / `repair` verbs (lock state is read-only here;
deferred by [ADR-297](../../adr/297-worktree-lock-read-only-verbs-deferred.md)),
`add` flags beyond the four modes above (`--track`/`--orphan`/`--no-checkout`),
and sparse-checkout inheritance on `add`.

## See also

- Primitives: [`resolveRef`](../primitives/internals.md)
- Related commands: [`branch`](branch.md), [`checkout`](checkout.md), [`status`](status.md)
