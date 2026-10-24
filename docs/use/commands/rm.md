# `rm`

Remove files from the index, and by default from the working tree. Accepts the same pathspec syntax as [`add`](add.md#pathspec-syntax): git's pathspec glob, where `*` and `?` cross `/`.

## Signature

```ts
repo.rm(
  paths: ReadonlyArray<string>,
  opts?: { cached?: boolean; force?: boolean; recursive?: boolean },
): Promise<RmResult>;

interface RmResult {
  readonly removed: ReadonlyArray<FilePath>;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `cached` | `boolean` | `false` | Index only — leave the working-tree file in place. |
| `force` | `boolean` | `false` | Override the safety valve (`-f`) — remove even staged or locally-modified paths. |
| `recursive` | `boolean` | `false` | Allow a pathspec naming a directory to remove everything tracked beneath it (`-r`). |

> Breaking a stale `.git/index.lock` is repository-environment policy, set once on `openRepository({ config: { breakStaleLockMs } })` — not a per-call option. It applies to every index-mutating command.

## Safety valve

Like `git rm`, `rm` refuses to destroy un-recoverable changes (validated up front
— a refusal removes nothing). For a path whose working file exists:

| State | Plain `rm` | `{ cached: true }` | `{ force: true }` |
|---|---|---|---|
| index differs from `HEAD` (staged) | refuses `RM_STAGED_CHANGES` | removes index entry | removes |
| working tree differs from index (local) | refuses `RM_LOCAL_MODIFICATIONS` | removes index entry | removes |
| both staged **and** local | refuses `RM_STAGED_AND_LOCAL_CHANGES` | still refuses | removes |
| clean (matches index and `HEAD`) | removes | removes | removes |

A path whose working file is already gone is never refused. `cached` keeps the
working file in every case; `force` overrides the valve entirely.

## Submodules

`rm` prepares a submodule (a gitlink entry) in git's order before anything leaves the working tree:

1. A working `.gitmodules` that differs by content from its staged entry is refused `GITMODULES_NOT_STAGED` — under `cached` and `force` too, with nothing removed. A `.gitmodules` rewritten with the same bytes, or absent from the work tree, does not trigger it.
2. Unless `cached` is set, every populated submodule is absorbed as git's `absorb_git_dir_into_superproject` does: a repository kept in the submodule's own `.git` directory moves to `.git/modules/<name>` with `core.worktree` set and a gitfile left behind, so its history survives; a nested submodule carrying its own `.git` directory moves under the outer module's `modules/` the same way. The move is refused `SUBMODULE_NAME_NOT_FOUND { path }` when no `.gitmodules` row names the path (the rows come from the working file, else from the staged blob), `SUBMODULE_GIT_DIR_NESTED { name, inside }` when a leading part of the name already is a repository under `.git/modules/`, and `DIRECTORY_NOT_EMPTY` when `.git/modules/<name>` is occupied. A path running through a symbolic link — the path itself or a leading directory — is refused `SUBMODULE_PATH_IS_SYMLINK { path, component? }` before anything is read, as git's `validate_submodule_path`. Like git, an absorption happens even when the safety valve then refuses the removal.
3. Unless `force` is set, the safety valve judges each submodule as git's `check_local_mod` does. A regular file or symbolic link in place of the submodule, or a checkout whose HEAD moved off the recorded commit, is a local modification. A populated directory whose `.git` is not a gitfile (none at all, or a repository the absorption could not reach under `cached`), or whose nested submodules do not all use gitfiles, is a local modification too. Otherwise the checkout's own status decides — run with every nested gitlink's ignore mode forced to `none` and untracked files counted, as git runs `status --porcelain --ignore-submodules=none -uall` in the submodule. An empty directory is clean. Under `cached`, a submodule with only local modifications is removed from the index (git keeps the files), so a symbolic link in its place goes quietly; the symbolic-link validation above still runs on a populated directory.

Then the removal:

- A submodule's directory is removed with everything beneath it. A submodule that was never initialized has no directory; only its index entry goes.
- The `[submodule "<name>"]` section whose `path` is the removed path leaves `.gitmodules`, and the edited file is staged. A `.gitmodules` without such a section, or absent from the work tree, is left alone and not staged. A `.gitmodules` the index holds unmerged is refused `GITMODULES_UNMERGED` — after the submodule's directory is gone and before the index is written, exactly as git dies there.
- In a linked worktree the module moves into that worktree's own admin directory (`.git/worktrees/<wt>/modules/<name>`) and `core.worktree` is the relative path from there to the worktree's directory, as git writes it.
- `cached` removes only the index entry: the directory and `.gitmodules` stay, and nothing is absorbed.
- `force` skips the safety valve only; the `.gitmodules` check and the absorption still run.

## Merges in progress and resolve-undo

- `rm` runs during a pending merge, cherry-pick, revert or rebase; it no longer refuses `OPERATION_IN_PROGRESS`.
- Removing an unmerged path records resolve-undo (`REUC`) data for it, as git does.
- Other conflicted paths keep all their stages.

## Byte-exact paths and the work tree

- A glob that matches a tracked path by wildcard (`d*` against `dir/f`) removes it without `recursive`; one that reaches a directory only by the verbatim-prefix rule (`a?` against `a?/f`, no `ab`) is refused `RM_RECURSIVE_WITHOUT_R`, as git's `not removing … recursively without -r`.
- On a POSIX host a `\` in a pathspec is a matching escape; under Windows path syntax it is refused `PATHSPEC_OUTSIDE_REPO`.
- On a POSIX host a tracked file whose name holds `\` is removed, from the index and from disk; under Windows path syntax that name is refused `PATHSPEC_OUTSIDE_REPO`.
- A literal pathspec never selects a lossy twin: an entry whose name is not valid UTF-8 is matched only by a pathspec that decodes to the same bytes, never by its U+FFFD view alone.
- A lossy entry is never unlinked on disk; only its index entry is removed.
- Without `cached`, directories the removal leaves empty are pruned, as git does.
- The `HEAD` comparison looks the path up by raw bytes.

## Examples

```ts
// Remove from index AND working tree
await repo.rm(['old.txt']);

// Index only (file stays on disk)
await repo.rm(['secret.env'], { cached: true });

// Force removal of a staged / modified path
await repo.rm(['wip.txt'], { force: true });

// A whole directory (git's -r)
await repo.rm(['build'], { recursive: true });

// Glob
await repo.rm(['*.log']);
```

## Throws

- `PATHSPEC_NO_MATCH { pattern, patterns }` — a positive pathspec, literal or glob, matched no index entry; the first failing pathspec in argument order wins. Nothing is removed.
- `RM_RECURSIVE_WITHOUT_R` — a pathspec reached only paths beneath a directory (a literal, or a glob matching a directory through the verbatim-prefix rule) and `recursive` was not set; `data.pattern` is the pathspec as given. Nothing is removed.
- `WORK_TREE_REQUIRED` — the repository has no work tree (bare, or opened without one).
- `GITMODULES_NOT_STAGED` — a submodule is being removed while the working `.gitmodules` carries unstaged changes. Nothing is removed.
- `SUBMODULE_NAME_NOT_FOUND { path }` — an embedded repository sits in the submodule's `.git` directory and no `.gitmodules` row names the path. Nothing is removed.
- `SUBMODULE_GIT_DIR_NESTED { name, inside }` — the embedded repository would move under `.git/modules/<name>` while `.git/modules/<inside>`, a leading part of that name, already is a repository. Nothing is removed.
- `SUBMODULE_PATH_IS_SYMLINK { path, component? }` — a populated submodule's path, or one of its leading directories (`component`), is a symbolic link. Nothing is removed.
- `GITMODULES_UNMERGED` — the index holds `.gitmodules` unmerged while a submodule's section must leave it; the submodule's directory is already gone, the index untouched.
- `WORKING_TREE_FILE_TOO_LARGE { path, size, limit }` — the working `.gitmodules` is past the size the library reads.
- `RM_STAGED_CHANGES` / `RM_LOCAL_MODIFICATIONS` / `RM_STAGED_AND_LOCAL_CHANGES` — the safety valve refused (see above); each `data.paths` lists the refused paths.

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`add`](add.md), [`checkout`](checkout.md) (share the pathspec syntax)
