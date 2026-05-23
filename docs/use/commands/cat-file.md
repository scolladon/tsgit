# `catFile`

Batch read of git objects in strict input order. Equivalent to `git cat-file --batch` but yields parsed `GitObject`s instead of raw bytes. A missing object yields a per-entry sentinel rather than throwing — long batches survive sparse misses.

For back-pressure-friendly streaming over very large batches, use the Tier-2 [`catFileBatch`](../primitives/cat-file-batch.md) primitive directly.

## Signature

```ts
repo.catFile(opts: CatFileInput): Promise<CatFileResult>;

interface CatFileInput {
  readonly ids: ReadonlyArray<ObjectId | string>;
  readonly maxBytes?: number;
}

interface CatFileResult {
  readonly kind: 'batch';
  readonly entries: ReadonlyArray<CatFileBatchEntry>;
}

type CatFileBatchEntry =
  | { ok: true; id: ObjectId; type: GitObject['type']; size: number; object: GitObject }
  | { ok: false; id: ObjectId; reason: 'missing' };
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `ids` | `ReadonlyArray<ObjectId \| string>` | (required) | Object ids. String ids are coerced through `ObjectId.from` (fail-fast `INVALID_OBJECT_ID`). |
| `maxBytes` | `number` | (none) | Per-object byte cap; forwarded to `readObject`. A long batch over untrusted ids cannot exhaust the heap. |

## Behaviour

- Entries land in **strict input order**, sequentially, one per id.
- A missing object yields `{ ok: false, id, reason: 'missing' }` — the batch survives.
- Other resolver errors (corrupt pack, hash mismatch, transport failure on a promisor remote) propagate.
- Partial-clone lazy-fetch is transparent: calling `catFile` on a `blob:none` clone pulls each missing blob exactly once from the promisor remote.

## Examples

```ts
const { entries } = await repo.catFile({
  ids: [oid1, oid2, missingOid],
  maxBytes: 16 * 1024 * 1024,
});
for (const entry of entries) {
  if (entry.ok) console.log(entry.id, entry.type, entry.size);
  else console.log(entry.id, 'missing');
}
```

## Throws

- `INVALID_OBJECT_ID` — a string id failed `ObjectId.from` parsing.
- `OBJECT_TOO_LARGE` — a resolved object exceeds `maxBytes`.

## See also

- Primitives: [`catFileBatch`](../primitives/cat-file-batch.md), [`readObject`](../primitives/read-object.md)
- Related commands: [`log`](log.md), [`diff`](diff.md)
- Recipes: [streaming object reader](../recipes.md#streaming-object-reader)
- ADRs: [087](../../adr/087-cat-file-api-shape.md), [088](../../adr/088-cat-file-missing-per-entry.md), [089](../../adr/089-cat-file-contents-only.md), [090](../../adr/090-cat-file-strict-order-sequential.md)
