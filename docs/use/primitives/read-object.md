# `readObject`

Read any git object by id. The single chokepoint for loose / packed / promisor reads. Transparent partial-clone lazy-fetch: a missing object on a partial clone fires a single-shot fetch from the promisor remote and retries.

## Signature

```ts
repo.primitives.readObject(id: ObjectId, options?: { maxBytes?: number; verifyHash?: boolean }): Promise<GitObject>;

type GitObject = Blob | Tree | Commit | Tag;
```

## Behaviour

- **Resolution order:** packed object (via fanout binary search) → loose object → promisor lazy-fetch, matching git's own `do_oid_object_info_extended` for buffered content. A full miss — no pack claims the id and no loose file exists for it either — re-scans the pack directory once (`reprepare_packed_git`'s own retry) and retries the lookup once before falling through to the promisor fetch or `OBJECT_NOT_FOUND`; the re-scan is incremental (every already-known pack, its parsed `.idx`, handle, window-cache entries, and a loaded multi-pack-index all survive — only a vanished or newly-listed pack changes) and single-flighted across concurrent misses in the same session.
- **Delta resolution:** packed objects with `OBJ_REF_DELTA` / `OBJ_OFS_DELTA` are resolved against the LRU base cache.
- **A packed entry whose inflated bytes disagree with its own declared size:** a base entry's or a delta's instruction stream's inflated length must equal its header's own claim, in either direction — a mismatch refuses `INVALID_PACK_ENTRY { offset, reason: 'bad object: inflated size differs from declared size' }`, git's uniform `unpack_entry_data` check applied on read.
- **A loose header whose size disagrees with its body:** a **blob** is read anyway and serves the bytes actually stored — `readObject`, [`readBlob`](read-blob.md), [`catFile`](../commands/cat-file.md), [`streamBlob`](stream-blob.md) and `checkout` all return the real content, the way git's streaming tier does for every user-facing blob read. Such a blob is deliberately **never admitted to the object cache**, so a later read re-derives it from disk rather than from an entry whose stored header no longer describes it. A **commit, tree or tag** refuses `INVALID_OBJECT_HEADER` with `reason: 'size mismatch: header says <declared>, actual content is <actual>'`, in either direction — git's buffered tier allocates from the claim and refuses an over-run the same way. Nothing in tsgit is ever *sized* from the claim (ADR-863).
  - One divergence, in the strict direction: where the claim is **larger** than the body, git zero-pads the shortfall and accepts the object (`log`, `status` and `cat-file -p` all succeed on it); tsgit refuses. Fabricating the missing bytes to keep a corrupt object readable is not a behaviour worth transcribing.
- **`maxBytes`:** caps the payload size. A loose object is capped on the **bytes actually inflated**, never on the header's claim — a hostile object cannot claim a tiny size and ship a huge body. Pack base entries still cap pre-inflate against the pack entry header's declared size, and delta-resolved entries cap again post-apply against the real length, so a pack entry that declares small and inflates large is caught on the way out rather than on the way in.
- **`verifyHash`:** defaults to **`false`** — matching canonical git, an ordinary read does not re-hash the object on every access (ADR-718). Pass `{ verifyHash: true }` to hash the object exactly as it is stored — the header read off disk, size claim included, followed by the content — and verify the digest against `id`, throwing `OBJECT_HASH_MISMATCH { expected, actual }` on a mismatch, where `actual` is the digest of those stored bytes. A size-lying blob therefore reads fine by default and refuses under `verifyHash: true`. Corruption detection otherwise lives in `fsck` and `bundle verify`.
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
- `OBJECT_HASH_MISMATCH` — the stored bytes don't hash to the requested id (`verifyHash: true` only).
- `INVALID_OBJECT_HEADER` — a malformed loose header, or a loose commit / tree / tag whose header size disagrees with its body. A loose blob's size claim is not enforced.
- `INVALID_PACK_ENTRY` — a packed entry's inflated bytes disagree with its own header-declared size.

## Object size

Two sizes travel with an object, and they answer different questions.

`readObjectMetadata`'s `uncompressedSize` is the **object's own content length** — the contract is that it is a property of the object, not of the form it currently sits in, so a `gc` repack that moves an object between loose and packed storage never changes it. On the loose route it is measured from the inflated body; a size-lying loose header is reported at its real length, never at its claim.

The `size` [`catFile`](../commands/cat-file.md) and [`catFileBatch`](cat-file-batch.md) report is the **stored** size, exactly as `git cat-file --batch` prints it: for a loose object the header's own claim, passed through untouched. For every object whose stored header is honest — all of them, outside deliberate corruption — the two are the same number.

## See also

- Tier-1: [`catFile`](../commands/cat-file.md), [`log`](../commands/log.md)
- Related primitives: [`readBlob`](read-blob.md), [`readTree`](read-tree.md), [`catFileBatch`](cat-file-batch.md)
- ADRs: [024](../../adr/024-bounded-reads-where-cap-fires.md), [079](../../adr/079-lazy-fetch-automatic-plus-batch.md), [081](../../adr/081-promisor-remote-port.md), [863](../../adr/863-a-size-lying-loose-header-serves-a-blobs-bytes-and-refuses-other-types.md)
