# `streamBlob`

Stream a blob by id as an `AsyncIterable<Uint8Array>`. Chunks arrive as they inflate — no full-buffer materialisation on the happy path. Deltified pack entries reconstruct in full before yielding (`materialised: true`).

## Signature

```ts
repo.primitives.streamBlob(id: ObjectId, options?: StreamBlobOptions): Promise<BlobStream>;

interface StreamBlobOptions {
  readonly verifyHash?: boolean; // default: false
}

interface BlobStream extends AsyncIterable<Uint8Array> {
  readonly materialised: boolean;
}
```

`materialised` reflects how the blob was read:

- `false` — genuinely streamed: loose objects and packed base entries yield chunks as they inflate.
- `true` — reconstructed in full before yielding: deltified pack entries must be reconstructed from their delta chain before streaming can begin.

## Example

```ts
const stream = await repo.primitives.streamBlob(oid);
console.log(stream.materialised); // false for loose / packed base

for await (const chunk of stream) {
  process.stdout.write(chunk);
}

// Opt in to hash verification
const stream2 = await repo.primitives.streamBlob(oid, { verifyHash: true });
```

## Hash verification

Hash verification is **off by default** (`verifyHash: false`) — matching canonical git, an ordinary read does not re-hash the object on every access (ADR-718). Pass `{ verifyHash: true }` to opt in: the running SHA is fed the `<type> <size>\0` header bytes **as they are stored** followed by each content chunk as it arrives, and the comparison happens **after the last chunk is yielded** — if the digest does not match `id`, `OBJECT_HASH_MISMATCH` is thrown at end-of-stream. Draining the iterable completely is required for verification to run (parity with `readObject`). Corruption detection otherwise lives in `fsck` and `bundle verify`.

## A loose header whose size lies

A loose blob whose header size disagrees with its body still streams, and streams the bytes that are actually there — the claim bounds nothing, matching git's streaming tier, which is what git uses for every user-facing blob read ([ADR-863](../../adr/863-a-size-lying-loose-header-serves-a-blobs-bytes-and-refuses-other-types.md)). Under `verifyHash: true` the digest is taken over the header **as stored**, so such a blob refuses `OBJECT_HASH_MISMATCH` at end-of-stream where an honest one passes. A size-lying loose commit, tree or tag is a different matter — [`readObject`](read-object.md) refuses it `INVALID_OBJECT_HEADER`; reaching one through `streamBlob` refuses on type first, below.

## A non-blob id refuses at the `await`

`UNEXPECTED_OBJECT_TYPE` is thrown by the **`await` on `streamBlob` itself**, before any chunk is yielded and before there is an iterable to consume — the object's type is settled at open, the loose route reading its header eagerly for exactly this reason, and the partially drained inflate pipeline is cancelled on the way out. A `try` around the `for await` is not what catches it; the `await` is.

## No `maxBytes`

`streamBlob` is uncapped. There is no `maxBytes` option — the caller streams through an
`AsyncIterable` and decides when to stop consuming. Callers that need a size gate should
count bytes as chunks arrive and abort via `AbortSignal` when the limit is reached.

## Throws

- `OBJECT_NOT_FOUND` — id is missing locally.
- `UNEXPECTED_OBJECT_TYPE` — id resolves to a non-blob object (commit, tree, tag); thrown by the `await`, never mid-iteration.
- `OBJECT_HASH_MISMATCH` — recomputed id does not match (thrown at end-of-stream, only when `verifyHash: true`).
- `OPERATION_ABORTED` — `ctx.signal` was aborted between chunks.

## See also

- Related primitive: [`readBlob`](read-blob.md) — buffered read with optional `maxBytes` cap.
- Related primitive: [`catFileBatch`](cat-file-batch.md) — streaming multi-object reader.
