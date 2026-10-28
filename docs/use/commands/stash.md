# `stash`

Save dirty working-tree + index changes onto a stack and restore them later —
faithful to `git stash`. Nested namespace: `repo.stash.{push,list,apply,pop,drop}`.
The stack is the `refs/stash` reflog (`stash@{0}` is newest); each entry is a
`WIP` commit whose parents are the base commit, the index commit, and (whenever
`includeUntracked` is set) an untracked-files commit.

## Signature

```ts
interface StashNamespace {
  push(input?: {
    message?: string; // custom message → "On <branch>: <message>"
    includeUntracked?: boolean; // also stash untracked files (the U commit)
    keepIndex?: boolean; // leave the staged state intact after saving
  }): Promise<
    | {
        kind: 'saved';
        stash: ObjectId;
        message: string;
        eolNotices: ReadonlyArray<EolNotice>; // core.safecrlf=warn; see add.md
      }
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
    | {
        kind: 'conflict';
        conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }>;
        untrackedNotRestored?: { existing: ReadonlyArray<FilePath>; blockedAt?: FilePath };
      }
  >;

  pop(input?: { index?: number; restoreIndex?: boolean }): Promise<
    | { kind: 'applied'; stash: ObjectId; dropped: ObjectId }
    | {
        kind: 'conflict';
        conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }>;
        untrackedNotRestored?: { existing: ReadonlyArray<FilePath>; blockedAt?: FilePath };
      }
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
| `push` | Save tracked changes (and untracked with `includeUntracked`) onto the stack, then reset the working tree to HEAD (or to the index tree with `keepIndex`). With `includeUntracked` the stashed untracked files are removed first, and W has three parents even when nothing untracked was found. Returns `no-local-changes` — not an error — when there is nothing to stash. |
| `list` | Return the stack newest-first. Empty when no stash exists. |
| `apply` | Restore `stash@{index}` onto the working tree via a 3-way merge (base = stash base, ours = current index, theirs = stashed tree), then restore its untracked files. The stash is **retained**. |
| `pop` | `apply` then `drop` on success; on conflict the stash is **retained** and not dropped. |
| `drop` | Remove `stash@{index}` from the stack, repointing `refs/stash` to the new tip (or deleting it when the stack empties). |

## Behaviour

- **Save then reset.** `push` writes the W/I/U commits and the `refs/stash`
  reflog entry *before* resetting the working tree, so a crash never loses data
  before it is saved.
- **Push opens with an index refresh.** Before saving anything, `push` refreshes
  the stat of stage-0 entries whose content is unchanged and writes the index, as
  git's `refresh_and_write_cache` does. An unmerged index then refuses
  `MERGE_HAS_CONFLICTS`; the refreshed index stays on disk, and no object, ref or
  reflog entry is written.
- **Push ends as `reset --hard HEAD` does.** After a save, the reset rewrites only
  the files whose work-tree stat is not up to date, writes `ORIG_HEAD`, and, on an
  attached HEAD, appends a `reset: moving to HEAD` entry to the HEAD reflog. There
  is no pending-operation gate: a resolved merge, cherry-pick, revert or rebase does
  not refuse, and the push clears `MERGE_HEAD`, `CHERRY_PICK_HEAD` and `REVERT_HEAD`
  and keeps `REBASE_HEAD`. With `keepIndex`, `post-checkout` runs with the saved
  HEAD id twice and the file flag `0`.
- **Push with `includeUntracked` cleans before it resets.** The stashed untracked
  files are removed before the reset, then every untracked directory holding no file
  (empty, or holding only such directories) and each parent those removals leave
  empty, deepest first, as git's `clean -d` does. A directory holding tracked or
  ignored content, a path the index tracks (an unpopulated gitlink's directory) and
  the work-tree root stay. Empty directories never enter the untracked tree and never
  count as a local change: with nothing else to save the push returns
  `no-local-changes` and the directory stays. The untracked (U) commit is always
  written when `includeUntracked` is set, as the empty tree with no parent when no
  untracked file was found, so W has three parents. `keepIndex` cleans the same way.
- **Apply opens with an index refresh.** After the stash is resolved, `apply`/`pop`
  refresh the stat of stage-0 entries whose content is unchanged and write the index,
  as git's `refresh_and_write_cache` does, even when the apply then refuses. An
  unmerged index then refuses `MERGE_HAS_CONFLICTS` with the refreshed index left on
  disk. A missing stash refuses `STASH_NOT_FOUND` and leaves the index untouched.
- **Apply runs during a pending operation.** `apply`/`pop` do not refuse while a
  merge, cherry-pick, revert or rebase is pending; its state files and markers stay.
- **Apply leaves changes unstaged.** A clean `apply` materialises the merged
  result onto the working tree and writes the index as git's
  `unstage_changes_unless_new` does: a path the merge changed goes back to its
  pre-apply entry, so restored changes appear as "not staged"; a path new in the
  stash stays staged; a restored entry that clashes with a file or directory
  already kept is dropped. `restoreIndex` (`--index`)
  reinstates the originally-staged state; when the stash staged nothing, or the
  index already equals what was staged, it takes the same path as without it.
- **The stashed index is judged before the merge.** With `restoreIndex`, when the
  stashed index differs from both the stash base and the current index, it is judged
  before anything is written by git's `apply --cached` rule: the base-to-stashed-index
  hunks must apply onto the current index's blobs with exact context (offsets
  allowed, a hunk at line 1 or with no trailing context anchored at the start or the
  end). A creation onto a path the index already holds, a deletion, binary or type
  change whose current content differs from the base, a path the current index lacks,
  a name git's `verify_path` refuses, or a file/directory clash refuses
  `STASH_INDEX_CONFLICT { paths }`. No work-tree change, no `AUTO_MERGE`, no untracked
  file restored; the stash is kept and `pop` drops nothing. The `diff` attribute
  decides binary as `diff-tree --binary` does. A judge that passes supplies the
  index that is reinstated, with no second index-side merge.
- **Reinstating needs an index at HEAD.** When the staged state is reinstated and
  the current index differs from HEAD, the index is reset to HEAD (stats refreshed)
  and the apply refuses `STASH_APPLY_WOULD_OVERWRITE` listing the paths where HEAD
  and the current index differ in `localChanges`. The work tree is not merged, the
  untracked files are still restored, and the stash is kept, as git does.
- **Conflict stages refuse.** `apply`/`pop` against an index that holds conflict
  stages refuse with `MERGE_HAS_CONFLICTS`; only the opening refresh is written and
  the stash is kept.
- **A stash equal to its base merges nothing.** When the stash's work tree equals its
  base tree, no merge runs and no `AUTO_MERGE` is written; the index step runs as for
  a clean merge.
- **Gitlinks are not local changes.** Like git's stash, `push` ignores submodules:
  a moved or edited submodule, staged or not, never counts, and alone it returns
  `no-local-changes`. When other changes are stashed, the gitlink's index id rides
  into the stash trees unchanged and the submodule's own checkout is untouched.
- **A file or symlink at a gitlink's path is stashed.** Only the submodule
  checkout's own changes are ignored; a gitlink whose path holds a directory (or
  whose name holds bytes outside UTF-8) rides on its index id. A regular file or a
  symlink standing there is recorded in the W tree (blob or symlink) and brought
  back by `apply`, when the gitlink is newly staged, staged over a different HEAD
  entry, or lost from the index. When HEAD and the index hold the same gitlink,
  the occupant is recorded unless that gitlink sorts before every other changed
  tracked path: then W keeps the gitlink's index id and the reset discards the
  occupant, as git does on 2.55 and 2.56. Deleted gitlinks, lost gitlinks and
  untracked files do not count as changed paths for that rule. A gitlink with
  nothing at its path is dropped from W.
- **A gitlink path's work-tree state alone is no local change.** With nothing else
  changed, `push` returns `no-local-changes`, writes no stash and leaves the path
  untouched, whether a file, a symlink, nothing, or a path beyond a symlinked
  leading directory stands there.
- **Beyond a symbolic link.** A tracked path whose leading directory became a
  symbolic link refuses `PATHSPEC_BEYOND_SYMLINK { path }` (git's `'d/f' is beyond
  a symbolic link`), with `includeUntracked` too; nothing is created. The push
  classifies every tracked path against one shared leading-path scan.
- **The work-tree (W) tree follows git's path set.** Every stage-0 index entry plus every HEAD entry absent from the index is considered. A directory at a tracked non-gitlink path keeps the index entry. An index entry absent from HEAD whose work file is missing or unreachable keeps the index entry and is never refused as beyond a symlink. A HEAD entry absent from the index is recorded from the work tree when a file or symlink stands there (mode from its stat), is left out when a directory stands there or nothing does, and refuses `PATHSPEC_BEYOND_SYMLINK` when it lies beyond a symlink. The reset that follows is `reset --hard`: it displaces occupants as [`reset`](reset.md#behaviour) does and, at a deleted index-only path that is now a directory, keeps the directory and logs `unable to unlink '<path>'`.
- **Push is pooled.** `push` fans its work-tree comparisons and hashing through
  the `ioBound` pool and compares against the stat cache; a configured clean
  driver still hears the paths in index order.
- **Conflicts.** A conflicting `apply`/`pop` writes `<<<<<<<`/`>>>>>>>` markers
  to the working tree and stage-1/2/3 unmerged entries to the index (no
  `MERGE_HEAD` — stash apply is not a merge-in-progress), returns
  `{ kind: 'conflict' }`, and keeps the stash. Resolve, `repo.add(paths)`, then
  `repo.commit(...)` / re-run.
- **Overwrite guard.** `apply` refuses with `STASH_APPLY_WOULD_OVERWRITE` —
  writing no tracked path — when a path the merge would change carries uncommitted
  working-tree modifications, or sits where an untracked file blocks it (git's
  "local changes would be overwritten"). The error keeps git's two classes apart:
  `localChanges` and `untracked`, with `paths` their concatenation.
- **Untracked files are restored after the merge.** Whatever the merge's outcome
  (clean, conflict or refusal), `apply`/`pop` then restore the stash's untracked
  files with the rules of git's `checkout-index` without `--force`, in index order:
  a path where anything already exists (file, directory, symlink, dangling symlink)
  is skipped and reported, later entries are still restored; a leading component
  that is a file or a symlink stops the restore at that entry, is kept as it is, and
  is reported as `blockedAt`; nothing is ever displaced. A report fails the command
  with `STASH_UNTRACKED_NOT_RESTORED { existing, blockedAt? }` after the merge is
  written, and `pop` keeps the stash. On a conflict the `conflict` result carries the
  report as `untrackedNotRestored`; on a refusal it rides on
  `STASH_APPLY_WOULD_OVERWRITE`.
- **Untracked entries are name-validated before the first one is restored.**
  `apply`/`pop` of a stash saved with `includeUntracked` checks every path in
  the untracked tree against git's index-entry name rules before writing the
  first untracked file — a stash carrying a hostile name (a `.git` alias, or a
  traversal) is refused wholesale with `INVALID_INDEX_ENTRY`, and no untracked
  file is written. The check runs after the tracked merge, which is already
  written. Under a Windows host (node runtime on win32, whatever filesystem the caller passes) an untracked path containing `\` is refused with `INVALID_INDEX_ENTRY` and reason `backslash rejected under Windows path syntax`, as git for Windows does; parsing an index, `write-tree` and `archive` do not refuse it.
- **The tracked 3-way merge gets the same whole-set, pre-write check,
  separately.** Before any conflict is materialised, every outcome/conflict
  path the tracked merge (base = stash base, ours = current index, theirs =
  stashed tree) is about to write is checked in one pass against the same
  index-entry name rules — a hostile path anywhere in that set refuses the
  whole write with `INVALID_INDEX_ENTRY`, atomically, whether or not it is the
  path a straightforward per-entry write would reach first. This runs on
  every `apply`/`pop`, independent of `includeUntracked` and the untracked
  check above.

- **Line-ending conversion on the object writes.** The index, untracked and
  working-tree objects are hashed through the same check-in conversion as
  [`add`](add.md#line-ending-conversion-coreautocrlf-coreeol-text-eol-ident)
  (`core.autocrlf`, `core.eol`, `text`/`eol`/`ident` attributes, clean filter
  drivers), so a CRLF worktree file under `core.autocrlf=true` is stashed as LF.
  The raw-size cap (`WORKING_TREE_FILE_TOO_LARGE`, 256 MiB) applies to the file
  as read, before conversion. Symlink targets are stored verbatim.
- **`core.safecrlf`.** `warn` (default) collects one `EolNotice`
  (`{ path, loss, crlf, loneLf }`) per path whose line endings would not round
  trip, on `eolNotices` of the `saved` result: untracked files first, then the
  tracked ones in index order. `false` yields `[]`. `true` refuses the push with
  `EOL_ROUND_TRIP_UNSAFE`. Objects are written in git's order (index commit,
  untracked, then working tree, one path at a time), so a refusal leaves the
  same unreachable objects git leaves, and no `refs/stash` entry.
- **Restore direction.** `apply`/`pop` write the merged result, conflict
  markers and restored untracked files through the checkout conversion (LF to
  CRLF, `ident` expansion, smudge filter), reading attributes from the result
  index. `-X renormalize` is not a stash option; `merge.renormalize=true` makes
  the apply's 3-way merge renormalise (see [`merge`](merge.md#renormalize)).

## Byte-exact paths

`push`, `apply` and `pop` carry non-UTF-8 path names as raw bytes through the stash commits and the index. A restore never writes an escaped or lossy path to the work tree; results report the U+FFFD view.

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
- `PATHSPEC_BEYOND_SYMLINK { path }` — `push` found a tracked path whose leading directory is a symbolic link. Nothing is saved.
- `MERGE_HAS_CONFLICTS` — `push` while the index holds conflict stages; nothing is saved.
- `STASH_NOT_FOUND` — the selector `index` is out of range.
- `STASH_APPLY_WOULD_OVERWRITE { paths, localChanges, untracked, untrackedNotRestored? }`
  — `apply`/`pop` would overwrite uncommitted working-tree changes (`localChanges`)
  or an untracked file in the merge's way (`untracked`); `paths` lists both. It no
  longer covers the untracked restore, whose report is `untrackedNotRestored` or
  `STASH_UNTRACKED_NOT_RESTORED`. Also raised when `restoreIndex` reinstates onto an
  index that differs from HEAD (`localChanges` = the paths that differ).
- `STASH_UNTRACKED_NOT_RESTORED { existing, blockedAt? }` — the merge was written
  clean but the restore left untracked files unwritten: `existing` are the paths
  that already existed, `blockedAt` the leading file or symlink that stopped the
  restore. `pop` keeps the stash. The probe does not follow symbolic links, so a
  **dangling** symlink at a restore path counts as existing.
- `STASH_INDEX_CONFLICT { paths }` — `apply`/`pop` with `restoreIndex`: the stashed
  index does not apply to the current one (the failing paths in index order, or
  only the first file/directory clash once every other check passed). Nothing is
  written beyond the opening refresh and the stash is kept.
- `INVALID_INDEX_ENTRY` — an untracked entry in the stash fails git's own
  index-entry name rules (`apply`/`pop` restores no untracked file); or, separately, a
  conflicting tracked-merge outcome/conflict path fails the same rules (every
  path in that batch is checked before any of them is written, so a hostile
  path anywhere refuses the whole conflict write, atomically).
- `EOL_ROUND_TRIP_UNSAFE { path, loss, crlf, loneLf }` — `push` with `core.safecrlf=true` and a file whose line endings would not round trip.
- `CONFIG_BAD_BOOLEAN_VALUE` — a malformed `core.autocrlf` / `core.safecrlf` (checked by every verb), or `merge.renormalize` on `apply`/`pop`.
- `MERGE_HAS_CONFLICTS` — `apply`/`pop` while the index holds conflict stages; nothing is written and the stash is kept.
- `INVALID_COMMIT` — `refs/stash` points at a commit that is not a stash entry.
- `CONFIG_BAD_NUMERIC_VALUE` — a malformed `core.maxTreeDepth` /
  `core.deltaBaseCacheLimit` (the repo-settings class), checked by every verb
  — `push`, `list`, `drop`, `apply`, `pop` — right after the work-tree check,
  transcribing git's own per-builtin prologue. The order matters: a bare
  repository reports `WORK_TREE_REQUIRED` first, unlike
  [`sparseCheckout`](sparse-checkout.md), which reports the config class
  first. See [`internals.md`](../primitives/internals.md#assertrepossettingsvalid).

See [`../errors.md`](../errors.md) for the canonical `TsgitError.data.code` list.

## See also

- Primitives: [`readObject`](../primitives/read-object.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`merge`](merge.md) · [`reset`](reset.md) · [`checkout`](checkout.md)
- Recipes: [`../recipes.md`](../recipes.md)
- ADRs: 210–216, 625, 627–628, 950, 952–954, 956, 1106
- Roadmap: Phase 21.3
