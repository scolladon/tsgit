# `merge`

Three-way merge of `target` into `HEAD`, plus the in-progress state-machine verbs. `repo.merge` is a frozen namespace — `run` / `continue` / `abort` (git `merge` / `merge --continue` / `merge --abort`). Conflicts **do not throw**: `run` writes the working tree, index, and merge-state files and returns a discriminated `MergeResult`; the caller resolves and finalises with `continue` (or gives up with `abort`).

## Signature

```ts
repo.merge.run(input: MergeRunInput): Promise<MergeResult>;
repo.merge.continue(input?: MergeContinueInput): Promise<MergeContinueResult>;
repo.merge.abort(): Promise<MergeAbortResult>;

interface MergeRunInput {
  readonly rev: string;
  readonly message?: string;
  readonly fastForward?: 'only' | 'never' | 'allow'; // default 'allow'
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

type MergeResult =
  | { kind: 'up-to-date'; id: ObjectId }
  | { kind: 'fast-forward'; id: ObjectId; branch: RefName }
  | { kind: 'merge'; id: ObjectId; branch: RefName; parents: ReadonlyArray<ObjectId> }
  | { kind: 'conflict';
      conflicts: ReadonlyArray<MergeConflictDescriptor>;
      mergeHead: ObjectId;
      origHead: ObjectId;
    };
```

## Options (`run`)

| Field | Type | Default | Meaning |
|---|---|---|---|
| `target` | `string` | (required) | Ref name, oid, or `'HEAD'` of the branch to merge in. |
| `message` | `string` | auto | Override the merge-commit message. |
| `fastForward` | `'only' \| 'never' \| 'allow'` | `'allow'` | Fast-forward policy (see below). |
| `author` / `committer` | `AuthorIdentity` | from config | Identities for the merge commit. |

### `fastForward`

| Value | git equivalent | Behaviour |
|---|---|---|
| `'allow'` (default) | `--ff` | Fast-forward when possible, else a true merge. |
| `'only'` | `--ff-only` | Refuse with `NON_FAST_FORWARD` when a true merge would be required. |
| `'never'` | `--no-ff` | Always create a merge commit, even when a fast-forward is possible. |

## Working tree and index

A **fast-forward** and a **clean true-merge** both check the result out: the working tree and index advance to the merged tree, exactly like `git merge` (a true merge additionally creates the merge commit on top). If a path the merge would change has uncommitted working-tree modifications — or an untracked file would be clobbered by an incoming add — `run` refuses with `WORKING_TREE_DIRTY` and leaves HEAD, the index, and the working tree untouched. A **conflicting** true-merge refuses the same way: before any conflict is materialised, every path the merge would change is checked, and `run` refuses with `WORKING_TREE_DIRTY` if writing the conflict would overwrite a tracked-and-modified or untracked path — atomically and pre-write, so HEAD, the index, and the working tree are untouched and no `MERGE_HEAD` is written. The offending paths are split across the error's two arrays: `localChanges` for tracked-dirty paths, `untracked` for untracked clashes.

## Conflict handling

When the merge cannot resolve cleanly, `run` returns `{ kind: 'conflict', conflicts, mergeHead, origHead }`:

- Per-path conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) are written to the
  working tree. The open marker is labelled `HEAD` and the close marker the merged
  rev (`>>>>>>> <rev>`), exactly as git labels them. A path's
  `conflict-marker-size` gitattributes value sets the marker run length (default 7).
- The index gains stage-1/2/3 entries for each conflict.
- `.git/MERGE_HEAD`, `.git/MERGE_MSG`, `.git/ORIG_HEAD` persist the merge state.

Resolve the working-tree files, `repo.add` the resolved paths, then `repo.merge.continue({ message })` (equivalently `repo.commit({ message })`, which reads `MERGE_HEAD` for the second parent and clears the merge-state files atomically).

Unsupported conflict types (`rename-rename`, `gitlink`) reject upfront with `UNSUPPORTED_OPERATION` before any disk write.

### Distinct types (file vs symlink)

When both sides **change** to different kinds — one a regular file and one a symlink — the conflict is `distinct-types`. The regular side is renamed to `<path>~<label>` (that side's conflict label with `/` flattened to `_`, made unique with `_0`, `_1`, … against tracked paths) while the symlink keeps the original path. Each side lands at its recorded path — no content merge, and the behaviour is identical whether or not a merge base exists:

- **No base (add/add).** Both sides add; each lands as a single-stage entry at its recorded path (`ourPath` / `theirPath`), with stages 2/3 only.
- **With base (both sides changed).** The base's stage-1 entry travels with the side whose kind matches the base: base file ⇒ stage 1 at the renamed regular side's path (so that path carries two stages); base symlink ⇒ stage 1 at the original path alongside the symlink side's stage. The conflict carries `basePath` recording where stage 1 was emitted.

An untracked working file at the rename target refuses with `WORKING_TREE_DIRTY` before anything is written (the target lands in the error's `untracked` array, covered by the conflict-wide guard above).

### Both-added paths

When both sides **add** the same path (no merge-base entry):

- **Regular-file pairs** content-merge against an empty base — markers wrap only
  the truly conflicting regions, and a `merge=union` (or clean external) driver
  resolves the path cleanly. The conflict keeps `type: 'add-add'` and carries
  `contentVerdict` (`'content'`, `'binary'`, or `'clean'` when the bytes merged
  but the file modes disagree) alongside the materialised `conflictContent`.
  The index gains stage-2/3 entries only (no base → no stage 1).
- **Symlink vs symlink** (and any pair involving a gitlink) keeps ours in the
  working tree with plain stage-2/3 entries.

### Same-kind files with kind-changed base

When both sides are regular files but the merge base is a different kind (symlink or other):

- The content merge runs with the base treated as **absent for content** (two-way merge; `union` resolves cleanly), yet the base's stage-1 entry is recorded per the standard merge rules.
- The conflict type is `'content'` with the merged bytes in `conflictContent`.
- Clean content + equal modes → resolved (no conflict).
- Clean content + differing modes → conflict, `contentVerdict: 'clean'`, worktree carries ours' mode (executable bit preserved).

### Symlink vs symlink (both changed)

When both sides are symlinks, the conflict is a bare `'content'` conflict (no markers, no `conflictContent`):

- All three stages (base, ours, theirs) are recorded at the path.
- The working tree keeps **ours' symlink** as-is — link targets are never merged.
- This applies whether or not the base is a symlink.

### Conflict writes (worktree mode preservation)

All conflict materialisation is mode-aware. Conflicted paths appear in the working tree with their merged/surviving side's mode:

- Marker-file conflicts (`conflictContent`) carry ours' or the resolved mode, preserving the executable bit.
- Bare take-ours conflicts (symlink pairs, distinct-types outcomes) re-create the kind correctly — symlinks as symlinks (mode 120000), not as regular files.

The same behaviour applies wherever the shared 3-way merge runs: `stash apply`,
`cherry-pick`, `revert`, and `rebase`.

## Custom merge drivers

The per-path content merge honours `.gitattributes` `merge=<driver>` selection,
shared with `stash apply` / `cherry-pick` / `revert` / `rebase`:

- `merge` / `merge=text` (or unspecified) → the built-in 3-way line merge.
- `merge=union` → the built-in line merge, resolving each overlapping region by
  keeping **both** sides concatenated (no conflict markers) — git's
  `XDL_MERGE_FAVOR_UNION`.
- `-merge` / `merge=binary` (incl. via the `binary` macro) → take *ours* and
  declare a conflict.
- `merge=<name>` with `[merge "<name>"] driver = <cmd>` in the config → run the
  command (`%O %A %B %L %P %S %X %Y` substituted; exit 0 ⇒ clean, non-zero ⇒
  conflict). `%L` is the resolved `conflict-marker-size` (default 7); `%S` / `%X`
  / `%Y` are the base / ours / theirs conflict labels.

When a path selects `merge=<name>` and the chosen `merge.<name>.driver` or
`merge.<name>.name` is present but valueless (git NULL), the content merge refuses
`CONFIG_MISSING_VALUE` (`{ key, source, line }`) rather than falling back to the
built-in driver. An absent `[merge "<name>"]` section keeps the built-in fallback.

In Node the driver runs by default; pass `openRepository({ command: false })` to
disable external drivers (they fall back to the built-in merge). The browser /
memory adapters have no command runner, so external drivers always fall back
there. See the [RUNBOOK](../../../RUNBOOK.md) "Operating custom merge drivers" section.

## State machine — `merge.continue` and `merge.abort`

A conflicting merge leaves the repository in an "in-progress" state recorded by `.git/MERGE_HEAD`, `.git/MERGE_MSG`, and `.git/ORIG_HEAD`. Two verbs end that state:

```ts
interface MergeContinueInput {
  readonly message?: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly noVerify?: boolean;
}
type MergeContinueResult = CommitResult;
interface MergeAbortResult { readonly origHead: ObjectId; readonly branch: RefName; }
```

- `repo.merge.abort()` — hard-reset the working tree, index, and current branch back to `ORIG_HEAD`, then delete `MERGE_HEAD` and `MERGE_MSG`. `ORIG_HEAD` is preserved so `reset --hard ORIG_HEAD` remains a meaningful follow-up (ADR-173). Returns `{ origHead, branch }`.
- `repo.merge.continue({ message?, author?, committer?, noVerify? })` — finalise the resolution as a two-parent merge commit. Equivalent to `repo.commit({ ... })` plus a precondition that `MERGE_HEAD` exists. An empty/omitted `message` falls back to `MERGE_MSG`'s draft.

Both refuse with `NO_OPERATION_IN_PROGRESS` (`operation: 'merge'`) when `MERGE_HEAD` is absent. `merge.abort` additionally requires `ORIG_HEAD` to be present.

`merge.abort` uses simple hard-reset semantics — any pre-merge uncommitted local changes are lost. (ADR-170 — canonical git's `--merge` variant that preserves them is out of scope for v1.)

```ts
const m = await repo.merge.run({ rev: 'feature/x' });
if (m.kind === 'conflict') {
  // Option A — give up on the merge.
  await repo.merge.abort();

  // Option B — resolve, stage, then continue.
  // … edit working-tree files, call repo.add(paths) …
  await repo.merge.continue({ message: 'resolve merge' });
}
```

## Examples

```ts
const result = await repo.merge.run({
  rev: 'feature/x',
  author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
});

switch (result.kind) {
  case 'up-to-date':
    break;
  case 'fast-forward':
    console.log('advanced to', result.id);
    break;
  case 'merge':
    console.log('merge commit', result.id);
    break;
  case 'conflict':
    // edit each conflicted file, then:
    await repo.add(result.conflicts.map(c => c.path));
    await repo.merge.continue({ message: 'resolve merge' });
    break;
}
```

## Throws

- `UNSUPPORTED_OPERATION` — conflict type not supported in v1 (e.g. rename/rename), or HEAD is detached. Also surfaced by `merge.abort` when HEAD is detached.
- `NON_FAST_FORWARD` — `fastForward: 'only'` and no fast-forward is possible.
- `WORKING_TREE_DIRTY` — a fast-forward, clean, or conflicting merge would overwrite uncommitted working-tree changes (or clobber an untracked file); nothing is written. Tracked-dirty paths arrive in `localChanges`, untracked clashes in `untracked`.
- `REF_NOT_FOUND` — `target` does not resolve.
- `NO_OPERATION_IN_PROGRESS` — `merge.continue` / `merge.abort` called outside an in-progress merge.

## See also

- Primitives: [`mergeBase`](../primitives/merge-base.md), [`diffTrees`](../primitives/diff-trees.md)
- Related commands: [`commit`](commit.md) (clears merge state), [`reset`](reset.md) (`mode: 'hard'` to `ORIG_HEAD` is the manual equivalent of `merge.abort`)
- ADRs: [025](../../adr/025-merge-parallel-blob-reads.md), [026](../../adr/026-merge-conflict-returns-not-throws.md), [027](../../adr/027-merge-conflict-write-order.md), [028](../../adr/028-merge-msg-content.md), [076](../../adr/076-merge-conflict-materialization.md), [170](../../adr/170-abort-merge-hard-reset-semantics.md), [171](../../adr/171-no-operation-in-progress-error.md), [172](../../adr/172-flat-abort-continue-surface.md), [173](../../adr/173-abort-merge-preserves-orig-head.md), [174](../../adr/174-continue-merge-delegates-to-commit.md), [263](../../adr/263-merge-namespace-reshape.md), [264](../../adr/264-fast-forward-tristate.md), [265](../../adr/265-merge-internal-reflog-channel.md), [293](../../adr/293-merge-materialises-non-conflict-outcomes.md), [318](../../adr/318-distinct-types-with-base-shape.md), [319](../../adr/319-symlink-pair-content-conflict.md), [320](../../adr/320-content-verdict-on-content-conflicts.md), [321](../../adr/321-mode-aware-conflict-writes.md)
```
