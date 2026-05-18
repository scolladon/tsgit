# Phase 13.8 — Bounded-size object reads + parallel merge blob fetch

## 1. Goal

Stop `merge`'s `buildContentMerger` from materialising arbitrarily
large blobs in memory. Phase 13.4a's clean-merge tree walk reads
ours/theirs/base sequentially and unconditionally calls `readBlob`
(no cap, no parallelism). Pass-1 perf review flagged the serial
chain as a HIGH; pass-1 security review flagged the
unbounded-memory case as a HIGH and parallelisation was deferred so
the memory pressure stayed sequential. Phase 13.8 unblocks both:

1. Add `readObject({ maxBytes })` so callers can cap the maximum
   serialised size of a returned object. The check fires BEFORE the
   delta chain is fully expanded into memory.
2. Plumb `maxBytes` through `readBlob`.
3. Update `buildContentMerger` to read ours/theirs/base in
   `Promise.all` with `maxBytes: MAX_CONFLICT_OUTPUT_BYTES`.

BACKLOG §13.8 acceptance:

> `readBlob(ctx, id, { maxBytes })` throws `OBJECT_TOO_LARGE` for
> blobs exceeding the cap; `buildContentMerger` reads the three
> blobs in `Promise.all` with `maxBytes: MAX_CONFLICT_OUTPUT_BYTES`;
> a property test confirms merging two adversarial 100 MiB blobs
> throws fast (under 200 ms) rather than OOMing.

## 2. Surface

### 2.1 Primitive option

```typescript
export interface ReadObjectOptions {
  readonly verifyHash?: boolean;
  /**
   * Reject objects whose serialised payload exceeds this byte
   * count, before inflating the full content into memory. Counts
   * the raw object content (not the loose-format header). When
   * unset, no cap applies.
   */
  readonly maxBytes?: number;
}
```

Same shape on `readBlob` since it delegates to `readObject` via
`ReadObjectOptions`.

### 2.2 Error

New `OBJECT_TOO_LARGE` variant in `DomainObjectError`:

```typescript
| {
    readonly code: 'OBJECT_TOO_LARGE';
    readonly id: ObjectId;
    readonly limit: number;
    readonly actualSize: number;
  }
```

Extracted via factory `objectTooLarge(id, actualSize, limit)`.
`extractDetail` formats as
`object too large: id=<id> size=<actualSize> limit=<limit>`.

### 2.3 buildContentMerger

```typescript
const buildContentMerger =
  (ctx: Context): ContentMerger =>
  async (mergeCtx, _baseStub, _oursStub, _theirsStub): Promise<ContentMergeResult> => {
    const [ours, theirs, base] = await Promise.all([
      readBlob(ctx, mergeCtx.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      readBlob(ctx, mergeCtx.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
      mergeCtx.baseId !== undefined
        ? readBlob(ctx, mergeCtx.baseId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })
        : Promise.resolve(undefined),
    ]);
    return mergeContent(base?.content, ours.content, theirs.content);
  };
```

Three concurrent reads — each one bounded — feeding `mergeContent`,
which already has the `isBinary` short-circuit that returns a
conflict marker without computing line diffs. Combined with the
cap, an adversarial 100 MiB binary triple now rejects upfront.

## 3. Where the cap fires

### 3.1 Loose objects

Loose objects record their payload length in the
`<type> <size>\0...` header. We read the compressed file, inflate
it, then call `parseObject`. The simplest correct point is right
after inflate and before `parseObject`: inspect the header's
`<size>` field, reject if `> maxBytes`. We MUST inflate first
because the compressed size is not the post-inflate size — but
loose objects are bounded by disk space, and the parser already
expects to load the full payload. No streaming changes.

Implementation note: we could pre-cap by checking the inflated
buffer's length, but that would also need to parse the header to
get the declared size. We do both: pre-check `inflated.length` (a
rough upper bound on the payload + header) and let `parseObject`
own the precise post-parse size. Pre-check is cheap and avoids
calling `parseObject` for clearly-too-large inputs.

### 3.2 Pack objects (base entries)

A base pack entry's `parsePackEntryHeader` returns the declared
inflated size (`header.length`). We have this BEFORE inflating —
so the cap fires PRE-inflate. The check happens in
`collectDeltaChain` when `isBase(header)` is true, right before
the `streamInflate` call.

### 3.3 Pack objects (delta-resolved)

A delta-resolved object's final size is `applyDelta`'s output
length. The delta header itself encodes the target size as a
varint at the start of the instructions stream (per pack format
§ "Deltified representation"). We can read that varint and cap
PRE-application, but the existing `applyDelta` returns a buffer
sized to the parsed target size. We choose to cap POST-resolution
inside `resolvePackChain` immediately after the bottom-up apply
loop:

```typescript
let current = phase1.baseContent;
for (let i = phase1.deltas.length - 1; i >= 0; i -= 1) {
  // ...applyDelta...
}
if (maxBytes !== undefined && current.length > maxBytes) {
  throw objectTooLarge(targetId, current.length, maxBytes);
}
```

This is the simplest correct point. A future optimisation could
inspect the target-size varint in the topmost delta to short-
circuit BEFORE applying deltas, but the chains we care about are
short (MAX_DELTA_CHAIN_DEPTH = 50) and the dominant memory cost
is `current` itself — which the post-apply check has already
seen. Cheaper, simpler, and the cap fires before
`prependHeader`'s allocation (which would otherwise double the
peak memory footprint).

### 3.4 Where the cap does NOT fire

- Inside `parseObject` — that's a domain function with no opinion
  on per-call limits.
- Inside `serializeObject` — used by `resolveBaseForRefDelta` to
  cache base content. Capping here would block legitimate large
  base objects from being cached even when no caller specified
  `maxBytes`. Skip.
- Inside the LRU `deltaCache` — content already present in cache
  bypasses the cap entirely. This is fine: if a previous read
  with no cap loaded a large object, a subsequent capped read
  can still see it via cache. The cap protects against unbounded
  memory growth from NEW reads; it is NOT a security perimeter.

## 4. Behaviour

### 4.1 Cap semantics

- `maxBytes` is an inclusive upper bound: `size === maxBytes` is
  accepted, `size === maxBytes + 1` rejected.
- The unit is the **serialised object content** (post-inflate,
  pre-header). For a blob, that's `Blob.content.length`. For a
  tree, that's the binary tree byte count. For a commit/tag,
  that's the canonical text length.
- When `maxBytes` is undefined, no cap applies (matches today's
  unrestricted behaviour).
- `maxBytes <= 0` is treated as "reject everything > 0 bytes" by
  the comparison `size > maxBytes`. We deliberately don't add a
  separate validation pass for `maxBytes < 0` — the comparison
  handles it monotonically and we don't want to add error noise
  for an edge case no caller hits.

### 4.2 Cache interaction

`resolvePackChain` always caches the final reconstructed object
via `cacheEntry(ctx.deltaCache, targetId, fullBytes)`. We DO NOT
cache when the cap rejects — the partial work (`current`) is
released and `targetId` stays out of the cache. A subsequent
call without a cap is free to load and cache the full object.

### 4.3 Error data

`OBJECT_TOO_LARGE` carries `id` (so callers can decide whether to
retry with a higher cap), `actualSize` (the post-resolve byte
count), and `limit` (the cap that was breached). The error message
is `object too large: id=<id> size=<actualSize> limit=<limit>`.

### 4.4 Parallelisation cost

`Promise.all` on three blob reads has the same total work as the
sequential chain (each `readBlob` is independent in I/O). The
benefit is wall-time concurrency. The risk is that three blobs
that each pass the cap individually still cumulatively allocate
3 × `MAX_CONFLICT_OUTPUT_BYTES` (256 MiB × 3 = 768 MiB peak).
That's acceptable for the merge contract: the cap protects
against a SINGLE adversarial blob; the merge operation is allowed
to materialise three legitimate blobs concurrently. If the cumulative
limit ever needs tightening, a follow-up can wrap `Promise.all` in
a semaphore.

## 5. Module layout

```
src/application/primitives/
├── types.ts                # extend ReadObjectOptions with maxBytes
├── read-object.ts          # pass maxBytes through to resolveObject
├── read-blob.ts             # already forwards options — no change
└── object-resolver.ts      # cap fires in two places (3.1, 3.2/3.3)
src/domain/objects/
└── error.ts                # add OBJECT_TOO_LARGE variant + factory
src/domain/
└── error.ts                # extractDetail case for the new code
src/application/commands/
└── merge.ts                 # Promise.all + maxBytes in buildContentMerger

test/unit/application/primitives/
├── read-object.test.ts      # extended: maxBytes loose + pack + cache miss
└── read-blob.test.ts        # extended: maxBytes passthrough
test/unit/application/commands/
└── merge.test.ts            # extended: 100 MiB adversarial conflict timing
```

## 6. Testing strategy

### 6.1 Unit — `read-object.test.ts` extension

- Loose object exactly at the cap → accepted, returns the blob.
- Loose object one byte over → throws `OBJECT_TOO_LARGE` with
  matching `id`, `actualSize`, `limit`.
- Pack object base entry one byte over → same.
- Pack object delta-resolved one byte over → same. (Requires a
  fixture that produces a delta chain whose final output exceeds
  the cap.)
- Cap = undefined → matches the current "no cap" behaviour.
- Cap = 0 → any non-empty object throws.

### 6.2 Unit — `read-blob.test.ts` extension

- Cap passthrough: pass `{ maxBytes: 1 }`, oversize blob throws.
- Cap accepts → returns the blob unchanged.

### 6.3 Unit — `merge.test.ts` extension

- Adversarial conflict scenario: two blobs of `MAX_CONFLICT_OUTPUT_BYTES + 1`
  each, base undefined. `repo.merge` must throw OBJECT_TOO_LARGE
  in under 200 ms (the property test).
- Parallel behaviour test: stub `readBlob` to track call order;
  three calls fire before any resolves (i.e., overlap is true).
- Regression: existing clean-merge tests still pass (cap is large
  enough that real merge fixtures fit).

### 6.4 Mutation

Stryker on `src/application/primitives/object-resolver.ts` and
`src/application/commands/merge.ts`. Target: 0 new survivors.
Specific high-risk mutants:

- Off-by-one on the `size > maxBytes` boundary → killed by the
  "exactly at cap" + "one over" pair.
- Removed throw branch → killed by the "one over throws" case.
- Swapped `Promise.all` for sequential → not directly killable by
  unit assertions (same output); document as equivalent-mutant if
  Stryker reports it.

### 6.5 Property test note

The 200 ms timing assertion in §6.3 is wall-clock and can flake on
slow CI. Implementation: build two `Uint8Array(MAX_CONFLICT_OUTPUT_BYTES + 1)`
buffers, seed them as blobs in a memory adapter, call
`repo.merge`, and assert `OBJECT_TOO_LARGE` is thrown. The
timing budget is a hint, not a strict deadline — the value of the
test is that allocation never reaches `mergeContent`'s
`isBinary`/`diffLines` path, which is provable by stubbing
`mergeContent` to fail-fast.

## 7. Open questions

- **Q1: Should `maxBytes` live on `Context` (project-wide cap)
  instead of per-call?** No — different operations have legitimately
  different size budgets (a `log` walk should not be capped by
  `merge`'s threshold). Per-call is the right knob.
- **Q2: Should we also expose a `maxLooseBytes` so loose files
  that fail to inflate can be rejected pre-inflate (DOS via
  hostile compressed payload)?** Out of scope. Loose files come
  from disk; the adversary would need write access to `.git/`.
  Phase 16.x can revisit if a remote-source path for loose
  objects emerges.
- **Q3: Should we also cap `clone` / `fetch` pack-write paths?**
  Out of scope — they already use `PACK_TOO_LARGE` at the object
  count layer (`MAX_PUSH_OBJECTS`). Per-blob caps inside fetch
  belong in a later phase if they prove necessary.

## 8. Constants

`MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024` (already exists
in `src/domain/merge/merge-types.ts`). We reuse it; no new
constant.

## 9. Self-review log

### Pass 1 → Pass 2

- Initially proposed capping inside `parseObject` (cleanest
  single point). Rejected at design time: `parseObject` is a
  pure domain function, agnostic of caller policy. Pushed the
  cap to the resolver where the call is already authority-
  aware.
- §3.4 added — without it, reviewers will ask why the cap
  doesn't apply uniformly to every code path that produces
  bytes. Explicit non-goal answers the question once.
- §4.4 added — peak memory under parallelisation is the
  immediate question after "why parallelise"; answer it inline.

### Pass 2 → Pass 3

- §3.3 refined: the original proposal was to inspect the
  delta's target-size varint pre-application. The actual win
  is marginal (delta chains are short) and the post-apply
  check is one branch. Simpler.
- §4.2 added — without explicit cache semantics, a reader would
  assume the cap also gates cache hits. State the contract.
- §6.4 added the equivalent-mutant note for `Promise.all` vs
  serial. Without it, the Stryker run will surface a survivor
  that nobody can kill without timing instrumentation.
- §3.1 amplified — the "pre-check inflated.length" hint
  prevents a future maintainer from removing what looks like
  redundant work.

### Pass 3 → final

- Renamed §3.4 from "Where the cap fires NOT" to "Where the
  cap does NOT fire" — clearer English.
- Renamed `objectTooLarge` factory args order to
  `(id, actualSize, limit)` — alphabetical-then-relevance
  match with `objectHashMismatch(expected, actual)` doesn't
  apply (we have three params not two); chose
  identifier-first as the dominant pattern in `error.ts`.
- §4.1 clarified `maxBytes <= 0` semantics — without it, a
  reader might add a precondition check (unnecessary code).
