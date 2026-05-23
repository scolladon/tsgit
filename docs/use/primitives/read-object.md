# `readObject`

Read any git object by id. The single chokepoint for loose / packed / promisor reads. Transparent partial-clone lazy-fetch: a missing object on a partial clone fires a single-shot fetch from the promisor remote and retries.

## Signature

```ts
repo.primitives.readObject(id: ObjectId, options?: { maxBytes?: number }): Promise<GitObject>;

type GitObject = Blob | Tree | Commit | Tag;
```

## Behaviour

- **Resolution order:** loose object → packed object (via fanout binary search) → promisor lazy-fetch.
- **Delta resolution:** packed objects with `OBJ_REF_DELTA` / `OBJ_OFS_DELTA` are resolved against the LRU base cache.
- **`maxBytes`:** caps the parsed payload size. Loose objects cap at the post-inflate header parse; pack base entries cap pre-inflate via the declared header size; delta-resolved entries cap post-apply.
- **Concurrent reads** of the same missing oid share one in-flight promisor fetch.

## Example

```ts
const obj = await repo.primitives.readObject(oid);
switch (obj.type) {
  case 'blob':   process(obj.content);     break;
  case 'tree':   process(obj.data.entries); break;
  case 'commit': process(obj.data.message); break;
  case 'tag':    process(obj.data.message); break;
}
```

## Throws

- `OBJECT_NOT_FOUND` — id missing locally and (if applicable) the promisor lazy-fetch did not deliver it.
- `OBJECT_TOO_LARGE` — payload exceeds `maxBytes`.
- `OBJECT_HASH_MISMATCH` — bytes don't hash to the requested id.

## See also

- Tier-1: [`catFile`](../commands/cat-file.md), [`log`](../commands/log.md)
- Related primitives: [`readBlob`](read-blob.md), [`readTree`](read-tree.md), [`catFileBatch`](cat-file-batch.md)
- ADRs: [024](../../adr/024-bounded-reads-where-cap-fires.md), [079](../../adr/079-lazy-fetch-automatic-plus-batch.md), [081](../../adr/081-promisor-remote-port.md)
