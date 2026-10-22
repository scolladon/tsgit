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

## Merges in progress and resolve-undo

- `rm` runs during a pending merge, cherry-pick, revert or rebase; it no longer refuses `OPERATION_IN_PROGRESS`.
- Removing an unmerged path records resolve-undo (`REUC`) data for it, as git does.
- Other conflicted paths keep all their stages.

## Byte-exact paths and the work tree

- A glob that matches a tracked path by wildcard (`d*` against `dir/f`) removes it without `recursive`; one that reaches a directory only by the verbatim-prefix rule (`a?` against `a?/f`, no `ab`) is refused `RM_RECURSIVE_WITHOUT_R`, as git's `not removing … recursively without -r`.
- On a POSIX host a `\` in a pathspec is a matching escape; under Windows path syntax it is refused `PATHSPEC_OUTSIDE_REPO`.
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
- `RM_STAGED_CHANGES` / `RM_LOCAL_MODIFICATIONS` / `RM_STAGED_AND_LOCAL_CHANGES` — the safety valve refused (see above); each `data.paths` lists the refused paths.

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`add`](add.md), [`checkout`](checkout.md) (share the pathspec syntax)
