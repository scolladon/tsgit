# `fetchMissing`

Prefetch promisor-remote objects in a single round trip. Useful before bulk reads on a partial clone (`blob:none`, `blob:limit`, `tree:N`) where transparent lazy-fetch would otherwise cost N round trips.

## Signature

```ts
repo.fetchMissing(opts: FetchMissingOptions): Promise<FetchMissingResult>;

interface FetchMissingOptions {
  readonly oids: ReadonlyArray<ObjectId>;
}

interface FetchMissingResult {
  readonly remote: string;   // promisor remote name (typically 'origin')
  readonly fetched: ReadonlyArray<ObjectId>;
  readonly alreadyPresent: ReadonlyArray<ObjectId>;
}
```

## Behaviour

- Objects already present locally are filtered before the network call.
- The fetch goes to the promisor remote recorded in `.git/config`; an error is thrown if none exists.
- Lazy-fetch sends **no filter** — the requested oids are delivered in full.
- Concurrent calls for the same oid share one in-flight fetch.

## Examples

```ts
// Prefetch a known working set before iterating
await repo.fetchMissing({ oids: [blobA, blobB, blobC] });

// Now reads are local
for (const oid of [blobA, blobB, blobC]) {
  const blob = await repo.primitives.readBlob(oid);
  process(blob.content);
}
```

## Throws

- `NO_PROMISOR_REMOTE` — repository has no promisor remote in `.git/config`.
- `NETWORK_ERROR` — transport failure.
- `REMOTE_FILTER_UNSUPPORTED` — promisor remote does not advertise `allowfilter` (rare; misconfigured server).

## See also

- Primitives: [`fetchPack`](../primitives/fetch-pack.md), [`readObject`](../primitives/read-object.md) (transparent lazy-fetch)
- Related commands: [`clone`](clone.md) (records the promisor), [`fetch`](fetch.md), [`catFile`](cat-file.md)
- Recipes: [partial clone with lazy-fetch](../recipes.md#partial-clone)
- ADRs: [079](../../adr/079-lazy-fetch-automatic-plus-batch.md), [080](../../adr/080-lazy-fetch-sends-no-filter.md), [081](../../adr/081-promisor-remote-port.md)
