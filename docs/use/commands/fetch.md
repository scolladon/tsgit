# `fetch`

Fetch refs and objects from a remote. Supports shallow fetch (`depth`), prune (`prune`), and re-applies the stored partial-clone filter so a partial repo stays partial.

## Signature

```ts
repo.fetch(opts?: FetchOptions): Promise<FetchResult>;

interface FetchOptions {
  readonly remote?: string;                    // default 'origin'
  readonly refspecs?: ReadonlyArray<string>;   // default '+refs/heads/*:refs/remotes/<remote>/*'
  readonly prune?: boolean;                    // default false
  readonly depth?: number;                     // shallow fetch boundary
}

interface FetchResult {
  readonly updatedRefs: ReadonlyArray<FetchUpdate>;
  readonly prunedRefs: ReadonlyArray<RefName>;
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
}

interface FetchUpdate {
  readonly name: RefName;
  readonly oldId: ObjectId | undefined;
  readonly newId: ObjectId;
}
```

## Options

| Field | Default | Meaning |
|---|---|---|
| `remote` | `'origin'` | Remote name. Resolved against `.git/config` `[remote "<name>"]`. |
| `refspecs` | branches refspec | Explicit refspec list. |
| `prune` | `false` | Delete `refs/remotes/<remote>/*` entries the server no longer advertises. Local branches and tags are never touched. |
| `depth` | (full) | Shallow fetch depth. Writes `.git/shallow`. |

## Examples

```ts
// Default: fetch all branches from origin
await repo.fetch();

// Shallow fetch of a single branch
await repo.fetch({ remote: 'origin', refspecs: ['refs/heads/main:refs/remotes/origin/main'], depth: 1 });

// Prune deleted remote branches
const result = await repo.fetch({ prune: true });
console.log(result.prunedRefs);
```

## Behaviour

- **Partial clone aware:** if `.git/config` records `partialclonefilter`, the fetch re-applies that filter; the repo stays partial.
- **Atomic ref updates:** all ref updates land under a single lock or none do.
- **Reflog:** updates land in `.git/logs/` via the standard `recordRefUpdate` writer.

## Throws

- `REMOTE_NOT_FOUND` — `remote` is not in `.git/config`.
- `INVALID_URL` — remote URL failed SSRF validation.
- `NETWORK_ERROR` — transport failure (reason varies).
- `INVALID_REFSPEC` — refspec syntactically invalid.

## See also

- Primitives: [`fetchPack`](../primitives/internals.md#fetchpack), [`enumerateRefs`](../primitives/internals.md#enumeraterefs), [`readShallow`](../primitives/internals.md#readshallow), [`updateShallow`](../primitives/internals.md#updateshallow)
- Related commands: [`clone`](clone.md), [`fetchMissing`](fetch-missing.md), [`push`](push.md)
- ADRs: [009](../../adr/009-fetch-shallow-where.md), [010](../../adr/010-fetch-haves-strategy.md), [011](../../adr/011-fetch-ref-update-tx.md), [012](../../adr/012-fetch-prune-semantics.md)
