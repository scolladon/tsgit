# `stageEntry`

Stage a single index entry from raw bytes or a known OID. Granular CRUD counterpart to `add` (which walks pathspecs); commits one entry atomically under `${gitDir}/index.lock`.

## Signature

```ts
repo.primitives.stageEntry(
  path: FilePath,
  source: { content: Uint8Array; mode?: FileMode } | { id: ObjectId; mode: FileMode },
  opts?: { breakStaleLockMs?: number; flags?: Partial<IndexEntryFlags> },
): Promise<IndexEntry>;
```

## Behaviour

- `source.content`: writes the blob (via `hashBlob({ write: true })`) and stages a stage-0 entry at `path`. `mode` defaults to `'100644'`; pass `'120000'` for symlinks (content is the link target bytes) or `'100755'` for executables.
- `source.id`: trusts the supplied OID — the object is NOT verified to exist. Mirrors `git update-index --cacheinfo`.
- `opts.flags` overlays on top of `STAGE0_FLAGS`. Use to seed `intentToAdd: true` etc. The on-disk index is auto-promoted to v3 when an extended flag flips true.
- Replaces any existing entry at `(path, flags.stage)`.

## Example

```ts
const oid = await repo.primitives.hashBlob(content, { write: true });
const entry = await repo.primitives.stageEntry('a.txt' as FilePath, { id: oid, mode: '100644' });
```

## Throws

- `OPERATION_ABORTED` — `ctx.signal` is aborted at entry.
- `INVALID_INDEX_ENTRY` — `path` is absolute, contains `..` / `.`, or has invalid segments / control characters.
- `BARE_REPOSITORY` — the repository is bare.
- `RESOURCE_LOCKED` — `${gitDir}/index.lock` is held.

## See also

- Related primitives: [`hashBlob`](hash-blob.md), [`unstageEntry`](unstage-entry.md), [`setEntryFlags`](set-entry-flags.md), [`readIndex`](read-index.md)
- ADRs: [`ADR-164`](../../adr/164-update-index-three-verbs.md)
- Roadmap: Phase 20.2 — Standalone primitives
