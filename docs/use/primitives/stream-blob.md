# `streamBlob`

Stream a blob by id as an `AsyncIterable<Uint8Array>`. Chunks arrive as they inflate — no full-buffer materialisation on the happy path. Deltified pack entries reconstruct in full before yielding (`materialised: true`).

## Signature

```ts
repo.primitives.streamBlob(id: ObjectId, options?: StreamBlobOptions): Promise<BlobStream>;

interface StreamBlobOptions {
  readonly verifyHash?: boolean; // default: true
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

// Opt out of hash verification
const stream2 = await repo.primitives.streamBlob(oid, { verifyHash: false });
```

## Hash verification

Hash verification is **on by default** (`verifyHash: true`). The running SHA is fed the canonical `<type> <size>\0` header bytes followed by each content chunk as it arrives. The comparison happens **after the last chunk is yielded** — if the digest does not match `id`, `OBJECT_HASH_MISMATCH` is thrown at end-of-stream. Draining the iterable completely is required for verification to run. Pass `{ verifyHash: false }` to skip verification (parity with `readObject`).

## No `maxBytes`

`streamBlob` is uncapped. There is no `maxBytes` option — the caller streams through an
`AsyncIterable` and decides when to stop consuming. Callers that need a size gate should
check `BlobStream.materialised` and abort early via `AbortSignal`.

## Throws

- `OBJECT_NOT_FOUND` — id is missing locally.
- `UNEXPECTED_OBJECT_TYPE` — id resolves to a non-blob object (commit, tree, tag).
- `OBJECT_HASH_MISMATCH` — recomputed id does not match (thrown at end-of-stream, only when `verifyHash: true`).
- `OPERATION_ABORTED` — `ctx.signal` was aborted between chunks.

## See also

- Related primitive: [`readBlob`](read-blob.md) — buffered read with optional `maxBytes` cap.
- Related primitive: [`catFileBatch`](cat-file-batch.md) — streaming multi-object reader.
