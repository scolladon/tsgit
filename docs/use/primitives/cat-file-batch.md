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
- `maxBytes` is forwarded to `readObject`; a long batch over untrusted ids cannot exhaust the heap. It measures a loose object's real inflated bytes, never its header's claim.
- **`size` is the stored size, as `git cat-file --batch` reports it.** For a loose object that is the header's own claim, read off disk and passed through untouched; every other route reports the content length. The two are the same number for every object whose stored header is honest. A loose **blob** whose header lies is still served — `object` carries its real bytes while `size` carries the claim, which is the pair git's `--batch` record prints ([ADR-863](../../adr/863-a-size-lying-loose-header-serves-a-blobs-bytes-and-refuses-other-types.md)). A loose commit, tree or tag whose header lies refuses `INVALID_OBJECT_HEADER`, and that refusal propagates — it is not a per-entry `missing` sentinel.
- For a size independent of how the object happens to be stored, read [`readObjectMetadata`](read-object.md#object-size) instead: its `uncompressedSize` comes from the object's content, so it survives a `gc` repack unchanged.

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
