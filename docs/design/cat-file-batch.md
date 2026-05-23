# Design — `cat-file --batch` equivalent (Phase 17.6)

**Status:** Accepted (at <main-sha>).

Backlog: **17.6** — _“`git-cat-file --batch` equivalent on the primitive
layer for high-throughput readers.”_

## 1. Goal

Expose a streaming, high-throughput object reader that mirrors the
batching ergonomics of `git cat-file --batch` without the
stdin/stdout indirection. The deliverable is a Tier-2 primitive that
takes an `AsyncIterable<ObjectId>` and yields one entry per id, in
input order, plus a thin Tier-1 command for callers who prefer a
request/response shape.

Non-goals (this phase):

- `--batch-check` / info-only mode (deferred — single-mode keeps the
  API small; see ADR-087 §_Consequences_).
- `--batch-command` (mixed `contents` / `info` / `flush` in one
  stream) — not aligned with our `AsyncIterable` substrate; would
  require a Duplex shape.
- Raw / unparsed bytes payload — `readObject` parses on the way out,
  so a raw mode would force a second resolver path. Defer until a
  caller actually proves a parse-cost bottleneck.
- Unordered / bounded-parallel reads — the bottleneck on a packed repo
  is in-memory (fanout binary search + inflate) and `readObject` is
  already cache-shared across a Context. Parallel reads also need a
  re-buffering layer to restore input order; not free.

## 2. Surface

### 2.1 Tier-2 primitive

```ts
// src/application/primitives/cat-file-batch.ts
export async function* catFileBatch(
  ctx: Context,
  ids: AsyncIterable<ObjectId> | Iterable<ObjectId>,
): AsyncIterable<CatFileBatchEntry>;
```

```ts
// src/application/primitives/types.ts (added)
export type CatFileBatchEntry =
  | {
      readonly ok: true;
      readonly id: ObjectId;
      readonly type: GitObject['type'];
      readonly size: number;
      readonly object: GitObject;
    }
  | {
      readonly ok: false;
      readonly id: ObjectId;
      readonly reason: 'missing';
    };
```

Behaviour:

- One entry yielded per input id, in **input order**, **sequentially**
  (one in-flight `readObject` at a time).
- A successful read yields `{ ok: true, id, type, size, object }`
  where `size` is the canonical payload size (matches
  `Object.serialize(object).length` minus the header — i.e., the body
  length used by the git header). For blobs, `size === blob.content
  .byteLength`; for trees/commits/tags it is the serialised body
  length, computed by the existing `payloadByteLength` domain helper
  (extracted in §4.1).
- A missing object yields `{ ok: false, id, reason: 'missing' }` —
  the stream does **not** throw on a per-id miss. Other
  `readObject`-thrown errors (corrupt pack, hash mismatch, decompress
  fail, etc.) propagate unchanged (ADR-088).
- Partial-clone lazy-fetch is transparent: `readObject` already
  fetches once per missing id from the promisor remote and refreshes
  the registry. If the lazy fetch fails to deliver the id, the entry
  is `{ ok: false, reason: 'missing' }` — same behaviour as a
  non-partial repo.
- Cancellation: `ctx.signal.aborted` is checked **before** each
  `readObject` call and **after** each yield, mirroring `walkCommits`.
  An aborted signal throws `OPERATION_ABORTED`.
- `verifyHash`: hashes are verified, same default as `readObject`.
  Not exposed on the surface for v1 — every caller wants integrity;
  trusted-input bypass is YAGNI.

### 2.2 Tier-1 command

```ts
// src/application/commands/cat-file.ts
export type CatFileInput = {
  readonly action?: 'batch';
  readonly ids: ReadonlyArray<ObjectId | string>;
};

export type CatFileResult = {
  readonly kind: 'batch';
  readonly entries: ReadonlyArray<CatFileBatchEntry>;
};

export const catFile = async (
  ctx: Context,
  opts: CatFileInput,
): Promise<CatFileResult>;
```

Behaviour:

- Validates and coerces each string id via `ObjectId.from` at the
  boundary (an invalid id throws `TsgitError(INVALID_OBJECT_ID)`
  **before** any read happens — fail-fast, not per-entry).
- Drains the primitive into an array and returns it. No streaming on
  the Tier-1 surface (matches `submodules` / `log`'s collected
  shape).
- The streaming iterable is reachable as
  `repo.primitives.catFileBatch` for callers who need it.

### 2.3 Repository facade additions

```ts
// repository.ts
readonly catFile: BindCtx<typeof commands.catFile>;
// inside primitives:
readonly catFileBatch: BindCtx<typeof primitives.catFileBatch>;
```

## 3. Module structure

```
src/application/
├── primitives/
│   ├── cat-file-batch.ts        # new — the streaming primitive
│   ├── types.ts                 # +CatFileBatchEntry
│   └── index.ts                 # +export
├── commands/
│   ├── cat-file.ts              # new — tier-1 wrapper
│   └── index.ts                 # +export
src/domain/objects/
└── size.ts                      # new — payloadByteLength helper (extracted)
test/unit/application/
├── primitives/cat-file-batch.test.ts
├── commands/cat-file.test.ts
test/integration/cat-file-batch-promisor.test.ts   # lazy-fetch on partial clone
```

`primitives/index.ts` and `commands/index.ts` add one export each;
`repository.ts` adds the binding entries. `src/index.ts` re-exports
the new `CatFileBatchEntry` and `CatFileInput` / `CatFileResult`
types.

## 4. Implementation sketch

### 4.1 `payloadByteLength` (domain)

The existing `serializeXxxContent` functions (`serializeBlobContent`,
`serializeTreeContent`, `serializeCommitContent`,
`serializeTagContent`) each return the object's body bytes — exactly
what would follow the `<type> <size>\0` header on disk. The "size"
we surface is that body's `byteLength`. To avoid the primitive
reaching across domain layers, we add a single helper:

```ts
// src/domain/objects/size.ts
export const payloadByteLength = (
  object: GitObject,
  hash: HashConfig,
): number => {
  switch (object.type) {
    case 'blob':
      return object.content.byteLength;
    case 'tree':
      return serializeTreeContent(object, hash).byteLength;
    case 'commit':
      return serializeCommitContent(object).byteLength;
    case 'tag':
      return serializeTagContent(object).byteLength;
  }
};
```

For blobs the cost is O(1). For tree/commit/tag we re-serialise the
body once; this matches what `serializeObject` does on the write
path. Cost is small relative to a real-world consumer that parses or
hashes the object. If profiling later shows a hot spot, the
resolver can thread the on-disk payload length through (parsed in
`parseHeader`) — out of scope for 17.6.

`HashConfig` only matters for trees (raw-SHA byte width — 20 vs 32);
`ctx.hashConfig` is the source.

### 4.2 The primitive

```ts
export async function* catFileBatch(
  ctx: Context,
  ids: AsyncIterable<ObjectId> | Iterable<ObjectId>,
): AsyncIterable<CatFileBatchEntry> {
  for await (const id of ids as AsyncIterable<ObjectId>) {
    throwIfAborted(ctx.signal);
    const entry = await readOne(ctx, id);
    yield entry;
    throwIfAborted(ctx.signal);
  }
}

async function readOne(ctx: Context, id: ObjectId): Promise<CatFileBatchEntry> {
  try {
    const object = await readObject(ctx, id);
    return {
      ok: true,
      id,
      type: object.type,
      size: payloadByteLength(object, ctx.hashConfig),
      object,
    };
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'OBJECT_NOT_FOUND') {
      return { ok: false, id, reason: 'missing' };
    }
    throw err;
  }
}
```

Both `Iterable` and `AsyncIterable` work because `for await … of`
accepts either. We type the parameter as the union so callers see
both forms are supported (and TypeScript widens to `AsyncIterable<…>`
at the loop site).

### 4.3 Tier-1 wrapper

```ts
export const catFile = async (
  ctx: Context,
  opts: CatFileInput,
): Promise<CatFileResult> => {
  await assertRepository(ctx);
  const ids = opts.ids.map(coerceObjectId); // throws INVALID_OBJECT_ID
  const entries: CatFileBatchEntry[] = [];
  for await (const entry of catFileBatch(ctx, ids)) {
    entries.push(entry);
  }
  return { kind: 'batch', entries };
};

const coerceObjectId = (id: ObjectId | string): ObjectId =>
  typeof id === 'string' ? ObjectId.from(id) : id;
```

`ObjectId.from` already throws `INVALID_OBJECT_ID` for malformed
strings — no extra validator needed.

## 5. Testing strategy

### 5.1 Unit — `cat-file-batch.test.ts`

- _Given an empty id iterable, When iterated, Then yields nothing._
- _Given one stored blob id, When iterated, Then yields `{ ok: true,
  type:'blob', size: content.byteLength, object }`._
- _Given a stored tree id, Then `size` equals serialised tree body
  length._
- _Given a stored commit / tag id, Then `size` matches the payload
  length._
- _Given a missing id, Then yields `{ ok: false, reason: 'missing' }`
  and the iterator continues._
- _Given a mix of hits + misses, Then entries are in input order._
- _Given an aborted signal before iteration, Then throws
  `OPERATION_ABORTED` on first `next()`._
- _Given an aborted signal mid-stream, Then throws on the next
  `next()` after the abort._
- _Given a corrupt object (hash mismatch), Then propagates
  `HASH_MISMATCH` — not swallowed as missing._
- _Given a sync `Iterable`, Then iterates equally._

### 5.2 Unit — `cat-file.test.ts` (tier-1)

- _Given a non-repo ctx, When invoked, Then throws
  `NOT_A_REPOSITORY`._
- _Given a malformed string id, Then throws `INVALID_OBJECT_ID`
  before any read._
- _Given a mix of `ObjectId` and `string` inputs, Then both are
  accepted._
- _Given some hits and some misses, Then `entries` mirrors the
  primitive's per-entry shape._

### 5.3 Integration — lazy-fetch parity

`test/integration/cat-file-batch-promisor.test.ts` — clone a
`blob:none` partial repo from a fixture, then call
`repo.catFile({ ids: [blobOid] })` and assert `ok: true` (lazy fetch
happened). Mirrors the existing partial-clone integration tests.

### 5.4 Mutation expectations

Hot spots to defend explicitly:

- The `instanceof TsgitError && code === 'OBJECT_NOT_FOUND'` guard —
  one test per leg (non-Tsgit error rethrown; non-`OBJECT_NOT_FOUND`
  Tsgit error rethrown).
- Input-order preservation — assert exact `entries.map(e => e.id)`
  equals the input.
- `payloadByteLength` per-type switch — one test per object type
  asserting the numeric size against a known serialisation.

## 6. Performance notes

- `readObject` already caches the PackRegistry per Context (WeakMap)
  and shares its delta-base LRU. A batch of N reads on a single
  packfile triggers one `.idx` parse and one delta cache.
- Sequential reads are the right default for packed repos because
  `applyDelta` chains are CPU-bound — parallelism only helps when
  I/O dominates (cold loose objects on slow disks), which is
  marginal in our target use cases (browser / Node services).
- The primitive itself adds one `try` + one error-class check per id.
  No measurable overhead vs. a hand-rolled `for (const id of ids)
  await readObject(ctx, id)` loop.

## 7. Edge cases

| Case | Behaviour |
|------|-----------|
| Duplicate id in input | Each occurrence yields its own entry (no de-dup) — matches git's `cat-file --batch`. |
| Iterable that throws | Error propagates out of the primitive — consumer's contract. |
| Promisor configured but `fetch` rejects | `readObject` rethrows the underlying network error; we don't swallow as `missing`. Only `OBJECT_NOT_FOUND` after a successful-but-empty fetch becomes `missing`. |
| Repository disposed mid-stream | `readObject` throws `REPOSITORY_DISPOSED`; not caught — propagates. |

## 8. Open questions (none blocking)

- Should `Iterable<string>` be accepted by the primitive too, with
  inline coercion? **No** — keeping the primitive's input branded
  preserves the Tier-2 invariant ("primitives accept already-validated
  domain types"). Tier-1 owns coercion.
- Should we expose `info` (type+size only) as a future option? When a
  caller proves the parse cost matters. The current type allows a
  non-breaking extension (`mode?: 'contents' | 'info'`) — but we will
  not add it speculatively.

## 9. Self-review log

- **Pass 1** — added §4.1 to specify that `size` is the canonical
  payload length and to call out the helper extraction; without it,
  the design left "size" ambiguous (header vs. body bytes — git's
  `--batch` reports body). Verified actual exported names
  (`serializeTreeContent`, `serializeCommitContent`, …) and that
  trees take a `HashConfig` argument; threaded that through.
- **Pass 2** — clarified §2.1 cancellation rules to match the
  `walkCommits` pattern, and added §7's promisor-error row to make
  the "lazy fetch failed at the network" path explicit.
- **Pass 3** — converged (no further changes).
