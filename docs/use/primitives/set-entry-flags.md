# `setEntryFlags`

Flip flags (`assumeValid`, `skipWorktree`, `intentToAdd`) on an existing index entry without rehashing the blob.

## Signature

```ts
repo.primitives.setEntryFlags(
  path: FilePath,
  flags: Partial<IndexEntryFlags>,
  opts?: { breakStaleLockMs?: number },
): Promise<IndexEntry>;
```

## Behaviour

- Merges `flags` over the existing entry's flags (`{ ...entry.flags, ...flags }`).
- Multi-stage entries (`stage > 0`): the overlay applies to every stage matching `path`. Return value is the lowest-stage entry (typically stage-0).
- The on-disk index is auto-promoted to v3 by the serializer when an extended flag flips true.

## Example

```ts
// Mark a generated artifact as "assume valid" so `status` skips re-stat'ing it.
await repo.primitives.setEntryFlags('dist/bundle.js' as FilePath, { assumeValid: true });
```

## Throws

- `OPERATION_ABORTED` — `ctx.signal` is aborted at entry.
- `INVALID_INDEX_ENTRY` — `path` fails the index path-validator.
- `PATHSPEC_NO_MATCH` — the path is not tracked. `data.pattern` carries the requested path.
- `BARE_REPOSITORY` — the repository is bare.
- `RESOURCE_LOCKED` — `${gitDir}/index.lock` is held.

## See also

- Related primitives: [`stageEntry`](stage-entry.md), [`unstageEntry`](unstage-entry.md), [`readIndex`](read-index.md)
- ADRs: [`ADR-164`](../../adr/164-update-index-three-verbs.md)
- Roadmap: Phase 20.2 — Standalone primitives
