# `unstageEntry`

Drop a single index entry without touching the working tree. Granular CRUD counterpart to `rm`: no pathspec, no working-tree deletion. Removes every stage (0, plus conflict stages 1/2/3 if present) matching `path`.

## Signature

```ts
repo.primitives.unstageEntry(
  path: FilePath,
  opts?: { breakStaleLockMs?: number },
): Promise<{ readonly removed: boolean }>;
```

## Behaviour

- Idempotent — `removed: false` when no entry matched. The lock-and-commit still ran (releasing the lock cleanly).
- The working-tree file is never touched. Use `repo.rm` (without `--cached`) for the porcelain that also removes the file.

## Example

```ts
const { removed } = await repo.primitives.unstageEntry('a.txt' as FilePath);
if (removed) console.log('unstaged a.txt');
```

## Throws

- `OPERATION_ABORTED` — `ctx.signal` is aborted at entry.
- `INVALID_INDEX_ENTRY` — `path` fails the index path-validator.
- `BARE_REPOSITORY` — the repository is bare.
- `RESOURCE_LOCKED` — `${gitDir}/index.lock` is held.

## See also

- Related primitives: [`stageEntry`](stage-entry.md), [`setEntryFlags`](set-entry-flags.md), [`readIndex`](read-index.md)
- ADRs: [`ADR-164`](../../adr/164-update-index-three-verbs.md)
- Roadmap: Phase 20.2 — Standalone primitives
