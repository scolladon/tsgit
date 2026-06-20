# `readBlob`

Read a blob by id. Optional per-blob byte cap throws `OBJECT_TOO_LARGE` upfront — bypasses the inflate/parse path on loose objects.

## Signature

```ts
repo.primitives.readBlob(id: ObjectId, options?: { maxBytes?: number }): Promise<Blob>;

interface Blob {
  readonly type: 'blob';
  readonly id: ObjectId;
  readonly content: Uint8Array;
}
```

## Example

```ts
const blob = await repo.primitives.readBlob(oid);
console.log(blob.content.byteLength);

// Refuse adversarial blobs upfront
const bounded = await repo.primitives.readBlob(oid, { maxBytes: 4 * 1024 * 1024 });
```

## Throws

- `OBJECT_TOO_LARGE` — blob exceeds `maxBytes`.
- `OBJECT_NOT_FOUND` — id is missing locally and no promisor remote resolves it.

## See also

- Tier-1: [`catFile`](../commands/cat-file.md)
- Related primitives: [`readObject`](read-object.md), [`catFileBatch`](cat-file-batch.md), [`streamBlob`](stream-blob.md) — bounded-memory streaming for large blobs
- ADRs: [024](../../adr/024-bounded-reads-where-cap-fires.md)
