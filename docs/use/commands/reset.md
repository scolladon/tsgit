# `reset`

Move HEAD with `soft` / `mixed` / `hard` semantics. All three modes operate under `.git/index.lock` for atomicity.

## Signature

```ts
repo.reset(opts: ResetOptions): Promise<ResetResult>;

interface ResetOptions {
  readonly mode: 'soft' | 'mixed' | 'hard';
  readonly rev: string;                  // any revision expression naming a commit
}

interface ResetResult {
  readonly mode: 'soft' | 'mixed' | 'hard';
  readonly id: ObjectId;
  readonly branch: RefName | undefined;  // the branch HEAD named, undefined when detached
}
```

## Modes

| Mode | Working tree | Index | HEAD |
|---|---|---|---|
| `soft` | untouched | untouched | moved to `rev` |
| `mixed` | untouched | rebuilt from `rev`'s tree (stat-cache preserved for unchanged paths) | moved to `rev` |
| `hard` | rewritten to match `rev`: every path whose work-tree file is not up to date is overwritten, a clean one is left alone | rebuilt | moved to `rev` |

## Behaviour

- **Work-tree requirement differs per mode, and by a different question each time.** `hard` needs an actual work tree to rewrite — it refuses `WORK_TREE_REQUIRED` when the repository has none (bare, or opened without one). `mixed` only refuses when the repository is bare (`layout.bare`, git's `is_bare_repository()`) — a repository opened with an explicit work tree over `core.bare = true` is not bare and `mixed` proceeds there even though `hard` still needs a resolvable work tree of its own. `soft` never touches the working tree and is never gated.
- **`rev` is any revision expression that peels to a commit.** Branch, tag, `HEAD~2`, an object id; an annotated tag peels to the commit it names, and an object that peels to no commit refuses `UNEXPECTED_OBJECT_TYPE`. The reflog entry echoes `rev` as given.
- **`ORIG_HEAD` and branch state.** Every mode first writes `ORIG_HEAD` with the commit HEAD leaves (an unborn HEAD drops it), then moves HEAD, then clears the stopped operation's state as git's `remove_branch_state` does: `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, `SQUASH_MSG`, a pick's or revert's marker and a finished sequencer.
- **`soft` refuses in the middle of a merge.** While `MERGE_HEAD` stands or the index holds a conflict, a `soft` reset refuses `OPERATION_IN_PROGRESS` (git's `die_if_unmerged_cache`); `mixed` and `hard` run, which is how a merge is abandoned.
- **Sparse-aware:** `mode: 'hard'` and `mode: 'mixed'` honour the active sparse pattern. Out-of-cone paths keep `skipWorktree: true`; their working-tree files are not materialised.
- **Stat-cache donor strategy** (mixed): index entries whose `id + mode` match the prior index preserve their stat fields, so the next `status()` stays fast.
- **Index extensions.** The index rewrite keeps git's extensions: `TREE` is invalidated along the changed paths, `mixed` keeps `REUC` (unless a conflicted path is resolved) and `hard` drops it, and `UNTR` is kept while the tracked set is unchanged; unknown extensions are dropped.
- **`hard` rewrites only stale paths.** As git's one-way merge does, a tracked path is rewritten when its work-tree file is not up to date (edited, deleted, or an occupant in the way); a file whose cached stat matches is not touched, and an assume-unchanged entry keeps its flag. A skip-worktree entry is left alone. A conflicted path is reset to the target, or removed when the target lacks it. The index is written on every `hard` reset, even when the target tree is empty. A symlinked leading directory whose target stat matches is kept.
- **Untracked files outside the target tree** are left alone in `hard` mode — only tracked paths are rewritten.
- **`hard` displaces an occupant as git does.** A regular file or symlink in a leading path of a target entry is replaced by a directory, and a directory at the path of an added or updated entry (not a gitlink) is removed with its content. A tracked path that is now a directory is left in place when the target deletes it, with git's `unable to unlink '<path>'` warning logged; the index drops the entry either way.

## Examples

```ts
// Undo the last commit; keep changes staged
await repo.reset({ mode: 'soft', rev: 'HEAD~1' });

// Unstage everything; working tree intact
await repo.reset({ mode: 'mixed', rev: 'HEAD' });

// Wipe local mods; restore to a known good commit
await repo.reset({ mode: 'hard', rev: 'origin/main' });

// Abort a merge by going back to ORIG_HEAD
await repo.reset({ mode: 'hard', rev: 'ORIG_HEAD' });
```

## Throws

- `WORK_TREE_REQUIRED` — `hard` against a repository with no work tree (bare, or opened without one).
- `BARE_REPOSITORY` — `mixed` against a bare repository (`operation: 'reset --mixed'`) — git refuses to write an `index` file a bare repository never has, even when `hard`'s work-tree check above would have passed.
- `REVPARSE_UNRESOLVED` — `rev` does not resolve.
- `UNEXPECTED_OBJECT_TYPE` — `rev` peels to an object that is not a commit.
- `OPERATION_IN_PROGRESS` — `soft` while a merge is in progress.
- `REF_UPDATE_CONFLICT` — a concurrent writer moved HEAD between the read and the write. `reset` writes through the literal `HEAD`, as git's own reset does, so `name` is `'HEAD'` even when HEAD is attached to a branch; the branch still moves and the coupled split is still logged. A no-move reset records no reflog entry.

## See also

- Primitives: [`materializeTree`](../primitives/internals.md#materializetree), [`buildIndexFromTree`](../primitives/internals.md#buildindexfromtree), [`recordRefUpdate`](../primitives/internals.md#recordrefupdate)
- Related commands: [`checkout`](checkout.md), [`merge`](merge.md), [`revParse`](rev-parse.md)
- ADRs: [021](../../adr/021-reset-mixed-stat-cache-donor.md), [022](../../adr/022-reset-mixed-pathspec-scope.md), [023](../../adr/023-reset-hard-index-stat-source.md), [075](../../adr/075-reset-sparse-integration.md)
- Roadmap: Phase 22 — pathspec scoping for `reset --mixed/--hard`
