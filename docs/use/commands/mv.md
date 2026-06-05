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

type MvSkipReason = 'source-not-tracked' | 'bad-source' | 'destination-exists' | 'into-self';

interface MvResult {
  readonly moved: ReadonlyArray<MvMove>; // one per moved index entry, sorted by `from`
  readonly skipped: ReadonlyArray<{ readonly source: FilePath; readonly reason: MvSkipReason }>;
}
```

The destination is treated as a **directory** when it is an existing directory,
ends with `/`, or there is more than one source — each source then moves into it
keeping its basename. Otherwise it is a single rename.

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `force` | `boolean` | `false` | Overwrite an existing destination (a file source only). |
| `dryRun` | `boolean` | `false` | Validate and report the plan without touching index or working tree. |
| `skipErrors` | `boolean` | `false` | Skip refused source pairs (collected in `skipped`) instead of aborting. |

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
- `BARE_REPOSITORY` — `mv` is not valid in a bare repository.

The first four are per-source and, under `skipErrors`, are collected in
`skipped` instead of thrown; the rest are structural and always thrown.

## See also

- Primitives: [`readIndex`](../primitives/read-index.md)
- Related commands: [`rm`](rm.md), [`add`](add.md)
