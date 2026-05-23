# `catFileBatch`

Streaming object reader. `AsyncIterable<CatFileBatchEntry>` in strict input order, one entry per id, sequentially.

## Signature

```ts
repo.primitives.catFileBatch(
  ids: AsyncIterable<ObjectId> | Iterable<ObjectId>,
  options?: { maxBytes?: number },
): AsyncIterable<CatFileBatchEntry>;

type CatFileBatchEntry =
  | { ok: true; id: ObjectId; type: GitObject['type']; size: number; object: GitObject }
  | { ok: false; id: ObjectId; reason: 'missing' };
```

## Behaviour

- Strict input order. Sequential reads — one in-flight `readObject` at a time.
- Missing objects yield `{ ok: false, id, reason: 'missing' }`. Other resolver errors propagate.
- Partial-clone lazy-fetch is transparent.
- `maxBytes` is forwarded to `readObject`; a long batch over untrusted ids cannot exhaust the heap.

## Example

```ts
async function* ids() { yield oid1; yield oid2; yield oid3; }

for await (const entry of repo.primitives.catFileBatch(ids(), { maxBytes: 16 * 1024 * 1024 })) {
  if (entry.ok && entry.type === 'blob') process(entry.object);
}
```

## See also

- Tier-1: [`catFile`](../commands/cat-file.md) — collects this stream into an array
- Related primitives: [`readObject`](read-object.md), [`readBlob`](read-blob.md)
- ADRs: [087](../../adr/087-cat-file-api-shape.md), [088](../../adr/088-cat-file-missing-per-entry.md), [089](../../adr/089-cat-file-contents-only.md), [090](../../adr/090-cat-file-strict-order-sequential.md)
