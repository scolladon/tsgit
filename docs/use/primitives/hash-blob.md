# `hashBlob`

Compute a blob's canonical OID for arbitrary bytes; optionally persist the loose object. Mirrors `git hash-object [-w]`.

## Signature

```ts
repo.primitives.hashBlob(
  content: Uint8Array,
  options?: { write?: boolean },
): Promise<ObjectId>;
```

## Behaviour

- Always returns the canonical blob OID under the active hash configuration. The OID matches `writeObject({ type: 'blob', id: '' as ObjectId, content })` byte-for-byte.
- `options.write !== true` (the default) skips all `fs` writes — hot path for callers that want the OID but write via a different store (a packfile builder, a remote uploader).
- `options.write === true` files the loose object via the same code path as `writeObject`, inheriting its `FILE_EXISTS` idempotency and mkdir behaviour.

## Example

```ts
const oid = await repo.primitives.hashBlob(new TextEncoder().encode('hello'));
console.log(oid); // e.g. 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0'
```

## Throws

- `OPERATION_ABORTED` — `ctx.signal` is aborted at entry or between serialise and write.
- Errors from `writeObject` when `write: true` (`OBJECT_HASH_MISMATCH` is impossible here — the OID is computed from the content the caller supplied — but other low-level `fs` failures propagate).

## See also

- Related primitives: [`writeObject`](write-object.md), [`readBlob`](read-blob.md)
- ADRs: [`ADR-162`](../../adr/162-hashblob-write-flag.md)
- Roadmap: Phase 20.2 — Standalone primitives
