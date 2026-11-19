# `mv`

Rename or move tracked paths, updating **both** the index and the working tree —
faithful to `git mv`. The working file is renamed as-is and the source's index
entry (blob id + mode) is copied to the destination; no blob is re-hashed, so an
unstaged edit travels with the file while the staged content is preserved.

Every `(source → target)` pair is validated up front: on any refusal nothing is
moved (unless `skipErrors`).

## Signature

```ts
repo.mv(
  sources: ReadonlyArray<string>,
  destination: string,
  opts?: {
    force?: boolean;
    dryRun?: boolean;
    skipErrors?: boolean;
  },
): Promise<MvResult>;

interface MvMove {
  readonly from: FilePath;
  readonly to: FilePath;
}

type MvSkipReason = 'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self' | 'rename-failed';

interface MvResult {
  readonly moved: ReadonlyArray<MvMove>; // one per moved index entry, sorted by `from`
  readonly skipped: ReadonlyArray<{ readonly source: FilePath; readonly reason: MvSkipReason }>;
}
```

The destination is treated as a **directory** when it is an existing directory,
ends with `/`, or there is more than one source — each source then moves into it
keeping its basename. Otherwise it is a single rename.

A directory moves in one step on the node and memory adapters, so a refusal leaves it
untouched. On the browser adapter it moves entry by entry, and a failure midway can leave it
partially moved.

Case-only renames: under `core.ignorecase=true` a **file** whose destination differs only in
ASCII case moves. A directory whose destination exists by case is refused whatever the setting.

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `force` | `boolean` | `false` | Overwrite an existing destination (a file source only). |
| `dryRun` | `boolean` | `false` | Validate and report the plan without touching index or working tree. |
| `skipErrors` | `boolean` | `false` | Skip refused source pairs, and pairs whose working-tree rename the file system refuses (collected in `skipped`), instead of aborting. |

> Breaking a stale `.git/index.lock` is repository-environment policy, set once on `openRepository({ config: { breakStaleLockMs } })` — not a per-call option. It applies to every index-mutating command.

## Examples

```ts
// Rename a file (index + working tree)
await repo.mv(['a.txt'], 'b.txt');

// Move files into an existing directory
await repo.mv(['a.txt', 'b.txt'], 'src');

// Rename a directory (every tracked entry under it is reparented)
await repo.mv(['old'], 'new');

// Overwrite an existing destination
await repo.mv(['a.txt'], 'keep.txt', { force: true });

// Preview without mutating anything
const { moved } = await repo.mv(['a.txt'], 'b.txt', { dryRun: true });

// Best-effort: skip bad pairs, move the rest
const { moved, skipped } = await repo.mv(['a.txt', 'ghost.txt'], 'dir', { skipErrors: true });
```

## Skipping errors deletes data as git does

`skipErrors` mirrors `git mv -k`, including its data loss:

- A refused **file** rename leaves the file where it is, in the index and on disk.
- A refused **directory** rename still moves its tracked entries in the index, then deletes the
  source directory with everything in it: untracked files, and anything another source of the
  same call moved into it.

Both are reported in `skipped` with reason `'rename-failed'`; a directory's members also appear
in `moved`. On the entry-by-entry adapter, a move failing partway under `skipErrors` also removes
what it placed at the destination; without `skipErrors` the partial move stays.

## Windows paths

Under a Windows host (node runtime on win32, whatever filesystem the caller passes) a path containing `\` is refused with `INVALID_INDEX_ENTRY` and reason `backslash rejected under Windows path syntax`, as git for Windows does; parsing an index, `write-tree` and `archive` do not refuse it.

## Byte-exact paths

A directory source selects its members by raw path bytes. A lossy member (a non-UTF-8 name) is a bad source (`MV_BAD_SOURCE`), or skipped under `skipErrors`, since lossy entries are never touched on disk. A directory holding a lossy member keeps its source, and a partial move of it stays at the destination. Every moved path is re-validated against git's index-entry rules before the index is written.

## Throws

- `MV_SOURCE_NOT_TRACKED` — a source is not in the index.
- `MV_BAD_SOURCE` — a tracked source is missing from the working tree.
- `MV_DESTINATION_EXISTS` — the destination already exists and `force` was not set (or the source is a directory).
- `MV_INTO_SELF` — a source is moved onto itself or into its own subtree.
- `MV_DESTINATION_NOT_DIRECTORY` — multiple sources but the destination is not a directory.
- `MV_DESTINATION_DIRECTORY_MISSING` — the destination directory does not exist (`mv` never creates it).
- `MV_MULTIPLE_SOURCES_SAME_TARGET` — two sources resolve to the same destination path.
- `MV_OVERLAPPING_SOURCES` — a source is a directory containing another source (`mv a a/b dir`).
- `EMPTY_PATHSPEC` — no sources were given.
- `WORK_TREE_REQUIRED` — the repository has no work tree (bare, or opened without one).
- `PATH_TOO_LONG` — the file system refused a destination as too long; `path` names that destination, repository-relative (inside a directory move, the directory's destination; entry by entry, the leaf's destination). Nothing is moved and the index is unchanged, unless `skipErrors`.

The first four are planning refusals and, under `skipErrors`, are collected in
`skipped` under their own reason; a working-tree rename the file system refuses is collected as
`'rename-failed'`; the rest always throw.

## See also

- Primitives: [`readIndex`](../primitives/read-index.md)
- Related commands: [`rm`](rm.md), [`add`](add.md)
