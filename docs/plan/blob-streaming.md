# Plan — blob-streaming

> Source: design doc `docs/design/blob-streaming.md` · ADRs `383–394`
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices for FEATURE code: coverage/interop tests
  fold into the implementation slice whose code they exercise. EXCEPTION:
  test-infra-only and docs-only slices (tooling config, test helpers, fixtures,
  mutation/ADV/property suites, docs/prose) with no `src/` delta ARE standalone.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Ordering & dependency rationale

The read primitive (`streamBlob`) and the `writeStream` port capability are the two
prerequisites for the four consumer conversions (sites A/B/C/D). Order:

1. **Slice 1** — `streamBlob` loose path + `BlobStream` type + read-side unit tests
   (folds the design's "confirm the bridge composes" Slice 1 into the first real code:
   the loose path *is* the bridge composing — `ctx.fs.read` → `createInflateStream` →
   `readableStreamToAsyncIterable` → header strip. No no-op slice.)
2. **Slice 2** — `streamBlob` packed base + deltified fallback + verification + abort,
   completing the primitive; folds its unit tests + the read interop in.
3. **Slice 3** — public surface gates for `streamBlob` (barrel, facade, docs, parity,
   api.json). Lands after the primitive is real and tested.
4. **Slice 4** — `writeStream` port method ×3 adapters + contract test (the write
   prerequisite). Independent of Slices 1–3; placed here so the write consumers below
   have their seam.
5. **Slice 5** — internal streaming write primitives (`writeRegularFileStream` etc.)
   built on Slice 4's `writeStream`.
6. **Slice 6** — consumer A (checkout / `apply-changeset`). Needs Slices 2 + 5.
7. **Slice 7** — consumers B + C (merge clean survivors). Needs Slices 2 + 5.
8. **Slice 8** — consumer D (stash untracked restore). Needs Slices 2 + 5.
9. **Slice 9** — write-side interop (checkout / merge / stash byte-identical to git).
   Folds the design's Slice 10; lands after all consumers are converted.

Each slice lands green on its own and is one atomic conventional commit.

---

## Slice 1 — `streamBlob` loose-blob streaming + `BlobStream` shape

### Context

**Goal:** introduce the new primitive `streamBlob(ctx, id, options?)` returning a
`BlobStream` (`AsyncIterable<Uint8Array>` + `{ materialised: boolean }`), with the
loose-object read path fully working and incremental hash verification default-on
(ADR-383/384/385/387/388/389). The loose path IS the design's "bridge composes"
check, made real — there is no separate no-op slice.

**New file:** `src/application/primitives/stream-blob.ts`. Confirmed absent today.

**Public types decided (planner finalises — see Slice 3 for the gate checklist):**
`streamBlob`, `BlobStream`, `StreamBlobOptions` are **PUBLIC** (reachable as
`repo.primitives.streamBlob`). Define the types in `stream-blob.ts` and export them
from the barrel in Slice 3.

```ts
// src/application/primitives/stream-blob.ts (new)
export interface StreamBlobOptions {
  readonly verifyHash?: boolean; // parity with ReadObjectOptions; default ON (ADR-389)
}
export interface BlobStream extends AsyncIterable<Uint8Array> {
  readonly materialised: boolean; // false = genuinely streamed; true = reconstructed (ADR-386)
}
export function streamBlob(ctx: Context, id: ObjectId, options?: StreamBlobOptions): Promise<BlobStream>;
```

**Reuse / compose (read these first):**
- `src/operators/readable-stream.ts` — `readableStreamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array>` (line 15). Re-exported from `src/operators/index.ts`. The bridge for the inflate output.
- `src/ports/compressor.ts:36` — `createInflateStream(): TransformStream<Uint8Array, Uint8Array>`. Currently has zero production callers — this slice is its first. **Deadlock-safe driving pattern (mirror `test/unit/ports/compressor.contract.ts:78-84`):** wrap the whole compressed loose buffer in a source `ReadableStream` that `enqueue`s it once and `close()`s in `start()`, then `source.pipeThrough(ctx.compressor.createInflateStream())` to get the inflated `ReadableStream`, then `readableStreamToAsyncIterable(...)` it. Do NOT hand-drive `writable.getWriter()` + `close()` then read separately — that risks a backpressure deadlock on large inputs. `pipeThrough` pumps both ends.
- `src/application/primitives/object-resolver.ts` — `tryLoose(ctx, id): Promise<Uint8Array | undefined>` (line 148) does `looseObjectPath` → `ctx.fs.exists` → `ctx.fs.read` → `ctx.compressor.inflate`. **It is NOT exported** (object-resolver exports only `resolveObject`, line 28). The loose-stream path mirrors its *file location* logic but streams the inflate. Extract a small exported helper from object-resolver (e.g. `export const looseCompressedBytes = (ctx, id): Promise<Uint8Array | undefined>` doing `looseObjectPath`/`exists`/`read`, returning the compressed bytes), and call it from `stream-blob.ts`. Do NOT duplicate the path logic.
- `src/application/primitives/path-layout.ts` — `looseObjectPath`, `commonGitDir` (imported by object-resolver).
- `src/domain/objects/header.ts:8` — `parseHeader(rawBytes): { readonly type: ObjectType; readonly size: number; readonly contentOffset: number }` where `ObjectType = 'blob' | 'tree' | 'commit' | 'tag'`; `contentOffset` is the byte index just past the `\0`. Throws `invalidObjectHeader` (from `src/domain/objects/error.js`) on a malformed header. Used to locate where `<type> <size>\0` ends so the header prefix is stripped from the inflated stream, and to read `type` for the non-blob narrow. **Header-strip must handle the NUL landing mid-chunk or across a chunk boundary**: accumulate inflated bytes until the first `0x00`, then `parseHeader` the accumulated prefix, then yield the remainder of that chunk (from `contentOffset`) + all subsequent chunks unchanged.
- `src/application/primitives/read-blob.ts` (lines 7–17) — the type-narrow oracle: `streamBlob` must reject a non-blob id with `unexpectedObjectType('blob', actualType, id)` from `src/domain/objects/error.js`, byte-for-byte like `readBlob`. The streaming path knows the object type from the loose header — narrow there before yielding any content chunk.
- Hash verification (ADR-389): feed each yielded chunk (canonical `<type> <size>\0` header bytes first, then content) into a running hash via `ctx.hash` (see `finalize` in object-resolver, lines 155+, for `ctx.hash.hashHex`). The incremental API: hash the full canonical buffer as it streams; at end-of-stream compare to `id`; throw `objectHashMismatch(id, actual, expected)` (from `src/domain/objects/error.js`) on mismatch. `verifyHash: false` opts out. Default ON. Mismatch surfaces only after the last chunk (documented on the API).
- **Abort:** check `ctx.signal?.aborted` between chunks and throw `operationAborted()` (from `src/domain/error.js`), mirroring `checkAborted` cadence in object-resolver (line 142).

**Loose path `materialised: false`** (genuinely streamed).

**Fixtures/helpers:**
- `test/unit/application/primitives/fixtures.ts` — `buildSeededContext(parts?)` (line 22) builds a seeded `Context`; `instrumentedContext(base)` (line 71) wraps the fs and returns a `.calls()` log of `{ method, path }` for spying which fs methods ran (use it to assert `read` was called and `readSlice` was not, pinning the loose route).
- Write the loose blob under test via the existing `writeObject` primitive (it writes loose `<type> <size>\0` + deflate).
- New test file `test/unit/application/primitives/stream-blob.test.ts`. Add a small `async function collect(it: AsyncIterable<Uint8Array>): Promise<Uint8Array>` (drain + concat) and compare against `(await readBlob(ctx, id)).content` as the oracle (independently-tested sibling, not a re-implementation).

### TDD steps

RED (write `stream-blob.test.ts` first; each fails because `stream-blob.ts` does not exist / the path is unimplemented):
1. Given a loose blob, When `streamBlob(id)` is drained → Then concatenated bytes byte-equal `readBlob(id).content` (not just length). Fails: no module.
2. Given an empty (zero-content) loose blob, When drained → Then yields zero content bytes and completes without error (header fully consumed, no spurious chunk).
3. Given a loose blob whose content is exactly one inflate chunk, When drained → Then byte-equal oracle (boundary: content begins mid-first-chunk after the header NUL).
4. Given a loose blob crafted so the header `\0` lands across an inflate chunk boundary, When drained → Then byte-equal oracle (header-strip accumulates across chunks). Use a fixture whose header length forces the split; if `createInflateStream` chunking is not controllable, assert the strip on a small + a ~200 KB blob so both single- and multi-chunk strips are exercised.
5. Given a loose **non-blob** object (e.g. a commit) id, When `streamBlob(id)` is called/drained → Then throws `unexpectedObjectType` with `data` `{ expected: 'blob', actual: 'commit', id }` (try/catch + `.data` assertion, NOT bare `toThrow(Class)`).
6. Given a loose blob, When drained with default options → Then no `objectHashMismatch` thrown (verification passes on a good blob).
7. Given a loose blob whose stored bytes are corrupted so the recomputed id differs, When drained to completion → Then throws `objectHashMismatch` with `.data` `{ id, actual, expected }` at end-of-stream. (Corrupt by writing a loose file whose inflated content does not hash to its filename id — see object-resolver's corruption fixtures pattern.)
8. Given the same corrupted loose blob, When drained with `{ verifyHash: false }` → Then no `objectHashMismatch` thrown (opt-out parity with `readObject`).
9. Given a `ctx.signal` aborted before/between chunks, When `streamBlob(id)` is drained → Then throws `operationAborted` (`.data.code === 'OPERATION_ABORTED'`).
10. Given a loose blob, When the resulting `BlobStream.materialised` is read → Then it is `false` (kills a constant-`true` flag mutant on the loose path).

GREEN: implement `stream-blob.ts` loose path. Structure `streamBlob` as: `const compressed = await looseCompressedBytes(ctx, id); if (compressed !== undefined) return <stream the loose bytes>; throw objectNotFound(id);`. The `throw objectNotFound(id)` is the honest loose-miss terminal for THIS slice (a loose-only `streamBlob`); Slice 2 inserts the packed branch *before* that throw, so the throw stays reachable only for genuine not-found ids and Slice 2 never rewrites the loose branch. This is not a placeholder/suppression — it is a correct (if not-yet-complete) terminal. Slice 1's tests use only loose blobs, so the packed-not-yet gap is never exercised here. Loose streaming: single-enqueue the compressed bytes into `createInflateStream`, bridge via `readableStreamToAsyncIterable`, strip the `<type> <size>\0` header (NUL-accumulating), narrow type via the parsed header, run the incremental hash, yield content chunks, set `materialised: false`. Export the new `looseCompressedBytes` helper from `object-resolver.ts`. Import `objectNotFound` from `src/domain/objects/error.js`.

REFACTOR: extract the header-strip state machine and the incremental-hash wrapper into small named helpers inside `stream-blob.ts` (early returns, ≤20-line functions, no nesting >2). No public surface added yet (Slice 3 owns the barrel/facade).

### Gate

```
npx vitest run test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/object-resolver.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/stream-blob.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/stream-blob.test.ts
```

### Commit

```
feat(primitives): stream loose blobs via streamBlob
```

## Slice 2 — `streamBlob` packed base streaming + deltified reconstruct-then-stream

### Context

**Goal:** complete `streamBlob` for packed storage: non-delta ("base") pack entries
stream genuinely (`materialised: false`); deltified entries reconstruct in full via
the existing buffered pack-chain path, then yield from the buffer with
`materialised: true` (ADR-386). Read interop (byte-identity to real `git cat-file -p`)
folds into this slice.

**Files:**
- `src/application/primitives/stream-blob.ts` (extend with the packed branch).
- `src/application/primitives/object-resolver.ts` — needs new internal exports for the packed seam. Currently **private**: `readEntryHeaderWithChunk(ctx, hit, nextOffset): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }>` (line 327), `isBase(h): h is PackEntryHeader & { type: 1|2|3|4 }` (line 310), `resolvePackChain(ctx, registry, hit, id, maxBytes): Promise<Uint8Array>` (line 246, returns the full reconstructed `<type> <size>\0...` loose-format buffer). Export the ones `stream-blob.ts` needs (`readEntryHeaderWithChunk`, `isBase`, and either `resolvePackChain` or a thin `reconstructPackedObject` wrapper that calls it with `maxBytes` undefined). Keep `resolveObject` as-is. The base-arm inflate mirrors object-resolver lines 207–214 (`enforcePackBaseCap` is the cap step — DO NOT call it from the packed base stream arm; `streamBlob` is uncapped, ADR-394).
- `src/application/primitives/read-object.ts` — `getPackRegistry(ctx): PackRegistry` (line 22) is the **exported** registry seam (per-Context WeakMap-cached). `streamBlob`'s packed branch calls `getPackRegistry(ctx).lookup(id)` to get the `PackLookupHit`, exactly as `resolveObject` does via its injected `registry`.
- `src/application/primitives/pack-registry.ts` — `nextOffsetForEntry(table, offset)` (line 110, **exported**), `PackLookupHit` (line 32), `PackRegistry.lookup` / `pack.offsetTable()` (interface line 37). Base-entry slice: `readSlice([offset, nextOffset))` then `chunk.subarray(headerEndInChunk)` → `createInflateStream` → bridge → yield (mirrors object-resolver lines 198–214).

**Data flow (packed):**
```
hit = await getPackRegistry(ctx).lookup(id)   // objectNotFound(id) if undefined
table = await hit.pack.offsetTable()
nextOffset = nextOffsetForEntry(table, hit.offset)
{ header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(ctx, hit, nextOffset)
isBase(header)
  ? single-enqueue chunk.subarray(headerEndInChunk) → createInflateStream → bridge → yield (materialised: false)
  : reconstruct full buffer via resolvePackChain (no maxBytes — streamBlob is uncapped, ADR-394)
    → strip its `<type> <size>\0` header → yield content from the buffer (materialised: true)
```
Type-narrow (`unexpectedObjectType` for non-blob) applies to both packed arms, using the entry/header type. Incremental hash verification (ADR-389) applies uniformly — for the deltified arm it is effectively end-of-buffer but uses the same machinery. Abort check between chunks. **No `maxBytes`** anywhere in `streamBlob` (ADR-394).

**Fixtures/helpers (unit):**
- `test/unit/application/primitives/pack-fixture.ts` — `buildSyntheticPack` (verify the exact export name) builds a pack with base and delta entries; used by object-resolver tests today. Reuse for base-pack and delta-pack fixtures.
- `buildSeededContext` / `instrumentedContext` as in Slice 1; assert the packed base route calls `readSlice` (not whole-file `read`), and the delta route runs `resolvePackChain` (spy via module mock or via the fs-call log showing the base+delta slice reads).

**Interop (new file):** `test/integration/blob-streaming-interop.test.ts`. Model on
`test/integration/large-object-pack-interop.test.ts`: twin-repo helpers
`makePeerPair`/`initBothRepos`/`runGitEnv` from `test/integration/interop-helpers.ts`;
local `copyPackFiles(peer, ours)` (line 49 of the model) and binary-safe
`catFileRaw(dir, oid)` (line 65 of the model). Scrub `GIT_*` via `runGitEnv()` (env-pollution gotcha) and sign off.

| # | Setup | Test | Asserts |
|---|---|---|---|
| S1 | commit a ~200 KB random-bytes blob in peer; `git gc`; `copyPackFiles` into ours | drain `streamBlob(ours, id)` | concatenated bytes `=== catFileRaw(peer, id)` (byte-identical to canonical `git cat-file -p`) |
| S2 | same packed blob | drain with default `verifyHash` | no `objectHashMismatch` thrown |
| S3 | same ~200 KB blob stored **loose** (no `git gc`) in ours | drain `streamBlob(ours, id)` | byte-identical to `catFileRaw` (the loose path from Slice 1, end-to-end against real git) |
| S4 | a blob deltified in the pack: commit two near-identical large blobs (≈200 KB, differing in a few bytes so git's delta heuristic engages), `git gc`/repack in the peer, `copyPackFiles` into ours; identify the deltified id (the one stored as OFS/REF delta — verify via `git verify-pack -v` or by which id `resolvePackChain` walks a delta for) | drain `streamBlob(ours, id)` | byte-identical to `catFileRaw`; `BlobStream.materialised === true` |

### TDD steps

RED (extend `stream-blob.test.ts` + new interop file; fail because the packed branch is unimplemented):
1. Given a packed **base** (non-delta) blob, When drained → Then byte-equal `readBlob(id).content`; `materialised === false`.
2. Given a packed base blob, When drained → Then `readSlice` is recorded and whole-file `read` is not (pins the packed route, kills a route-collapse mutant).
3. Given a **deltified** packed blob, When drained → Then byte-equal `readBlob(id).content`; `materialised === true` (kills a constant-`false` flag mutant on the delta path).
4. Given a packed non-blob (e.g. a tree) id, When drained → Then `unexpectedObjectType` with `.data` `{ expected: 'blob', actual: 'tree', id }`.
5. Given an id present in neither loose nor pack, When `streamBlob(id)` is called → Then `objectNotFound` with `.data.id` (try/catch + `.data`).
6. Given a corrupted packed base entry (recomputed id differs), When drained to completion → Then `objectHashMismatch`; and with `{ verifyHash: false }` → no throw.
7. Interop S1–S4 as tabled.

Separate tests for loose / base-pack / delta-pack so a mutant fixing only one route survives nowhere.

GREEN: implement the packed branch in `stream-blob.ts` (base + delta arms); add the needed internal exports to `object-resolver.ts`.

REFACTOR: unify the "yield-from-buffer + incremental hash" tail shared by the loose, base, and delta arms into one helper; keep the storage-form dispatch flat (early returns). Confirm the loose path from Slice 1 is unchanged.

### Gate

```
npx vitest run test/unit/application/primitives/stream-blob.test.ts test/unit/application/primitives/object-resolver.test.ts test/integration/blob-streaming-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/stream-blob.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/stream-blob.test.ts test/integration/blob-streaming-interop.test.ts
```

### Commit

```
feat(primitives): stream packed and deltified blobs
```

## Slice 3 — public surface gates for `streamBlob`

### Context

**Goal:** wire the now-complete, tested primitive through every public surface gate so
`validate` and `prepush` stay green. `streamBlob`/`BlobStream`/`StreamBlobOptions` are
PUBLIC (`repo.primitives.streamBlob`). This is a surface/wiring slice with no new
behaviour — its tests are the surface-snapshot + a facade smoke call.

**Definitive surface-gate checklist for a PUBLIC PRIMITIVE (verified against this repo's
tooling — both `check:doc-coverage` and `audit-browser-surface` cover primitives, not
just Tier-1 commands):**

1. **Barrel** — `src/application/primitives/index.ts`. Add
   `export { streamBlob } from './stream-blob.js';` and
   `export type { BlobStream, StreamBlobOptions } from './stream-blob.js';`.
   Placement: the barrel is grouped by source-file path; slot `stream-blob.js` between
   `shallow-file.js` (line 68) and `synthesize-tree-from-index.js` (line 69).
2. **Facade interface** — `src/repository.ts`. In the `primitives` interface block
   (lines 253–275), add `readonly streamBlob: BindCtx<typeof primitives.streamBlob>;`
   alphabetically **between `runHook` (line 266) and `updateRef` (line 267)**. Bump the
   block's count comment `Tier-2 primitives (21)` → `(22)` (line 251).
3. **Facade binding** — `src/repository.ts`. In the `primitives: Object.freeze({ ... })`
   block (starts line 581), add the guarded binding alphabetically **between `runHook`
   (ends line 633) and `updateRef`**:
   ```ts
   streamBlob: ((id, options) => {
     guard();
     return primitives.streamBlob(ctx, id, options);
   }) as Repository['primitives']['streamBlob'],
   ```
4. **repository.test.ts surface snapshot** — `test/unit/repository/repository.test.ts`.
   Add `'streamBlob'` (alphabetically, between `'runHook'` and `'updateRef'`) to the
   `Object.keys(sut.primitives).sort()` expected array (the assertion at line 253). NB:
   there is **no numeric primitive-count assertion** in this test — the array is the
   gate. Add a smoke `it` proving `sut.primitives.streamBlob` is callable (e.g. write a
   blob, drain the stream, byte-equal) following the existing `catFileBatch` smoke
   pattern (lines 763–807).
5. **`check:doc-coverage`** — add `docs/use/primitives/stream-blob.md` (model on
   `docs/use/primitives/read-blob.md`; document the `BlobStream` async-iterable shape,
   `materialised` flag, default-on `verifyHash`, end-of-stream verification timing, no
   `maxBytes`). Add the index row to `docs/use/primitives/README.md`: the tool's exact
   expected substring is `` [`streamBlob`](stream-blob.md) `` — place it alphabetically
   in the table. Bump the README count line `25 primitives` → `26 primitives` (line 5).
6. **`audit-browser-surface`** — add a `repo.primitives.streamBlob(...)` call inside a
   `test/parity/scenarios/*.scenario.ts` `run()` (the matcher is
   `\brepo\.primitives\.([a-zA-Z]\w*)\s*\(`). Reuse an existing scenario that already
   writes a blob (so an id is available to stream) rather than allowlisting; only
   allowlist (`tooling/audit-browser-surface.allowlist.json`) with a written reason if
   no scenario fits.
7. **api.json (prepush gate, not validate)** — regenerate with `npm run docs:json` and
   commit `reports/api.json`. The huge typedoc-id diff is expected. Pre-pay here, in
   this slice — a stale api.json is rejected only at prepush, so it cannot be deferred.

### TDD steps

RED:
1. Extend the `repository.test.ts` primitives surface-snapshot expectation to include `'streamBlob'` → fails (binding not yet present).
2. Add the facade smoke `it` for `sut.primitives.streamBlob` → fails (undefined).

GREEN: apply gates 1–4 (barrel, interface, binding, test array). Then gates 5–6 (docs page + README row + parity scenario). Then gate 7 (`npm run docs:json`, commit `reports/api.json`).

REFACTOR: none expected (pure wiring). Verify the binding's `as Repository['primitives']['streamBlob']` cast typechecks and the `guard()` ordering matches the sibling bindings.

### Gate

```
npx vitest run test/unit/repository/repository.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/index.ts src/repository.ts test/unit/repository/repository.test.ts
```

(Run `npm run docs:json` in-slice and commit `reports/api.json`; `check:doc-coverage` and `audit-browser-surface` run under `npm run validate` at the phase boundary, but pre-pay the docs page, README row, and parity scenario here so they do not surface later.)

### Commit

```
feat(repository): expose streamBlob on the primitives facade
```

## Slice 4 — `writeStream` FileSystem port method + three adapters + contract test

### Context

**Goal:** add the streaming-write port capability `writeStream(path, source)` (ADR-390),
implement it on all three adapters, and cover it in the shared port contract test. This
is the write prerequisite. The port method + primitives below are **INTERNAL** (no
public surface gate beyond the contract test) — `writeStream` is a port method, not a
`Repository` binding.

**Files:**
- `src/ports/file-system.ts` — add to the `FileSystem` interface, beside `write`
  (line 61) / `writeExclusive` (line 77):
  ```ts
  /** Stream bytes to file from an async source, creating parent directories as needed. Overwrites if exists. Writes bytes verbatim. */
  readonly writeStream: (path: string, source: AsyncIterable<Uint8Array>) => Promise<void>;
  ```
  Same contract as `write` (parent-dir creation, overwrite, byte-for-byte). Leave
  `FileHandle` (line 34) untouched.
- `src/adapters/node/node-file-system.ts` — implement beside `write` (line 419, an
  arrow class-field `write = async (path, data) => { ... }`). Match that style:
  ```ts
  writeStream = async (path: string, source: AsyncIterable<Uint8Array>): Promise<void> => {
    const real = await this.checkContainment(path, 'creation');
    await runFs(async () => {
      await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
      await pipeline(source, fs.createWriteStream(real));
    }, path);
  };
  ```
  `runFs` (line 170) and `checkContainment(path, 'creation')` are reused verbatim (same
  as `write`). `fs.createWriteStream` is available via the existing `import * as fs from 'node:fs'`
  (line 1). Add a NEW import `import { pipeline } from 'node:stream/promises';` —
  `node:stream/promises` is not currently imported in this file.
- `src/adapters/browser/browser-file-system.ts` — implement beside `write` (line 42, a
  method `async write(path, data) { ... }` using `resolveFileHandle(path, true)` →
  `createWritable()` → `write` → `close()`). Match that style:
  ```ts
  async writeStream(path: string, source: AsyncIterable<Uint8Array>): Promise<void> {
    const handle = await this.resolveFileHandle(path, true);
    const writable = await handle.createWritable();
    for await (const chunk of source) {
      await writable.write(chunk as FileSystemWriteChunkType);
    }
    await writable.close();
  }
  ```
- `src/adapters/memory/memory-file-system.ts` — implement beside `write` (line 85, an
  arrow class-field). No real bound (parity-only, no disk): concat chunks then store.
  ```ts
  writeStream = async (path: string, source: AsyncIterable<Uint8Array>): Promise<void> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of source) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    await this.write(path, out); // reuse write's normalize+ensureParentDirs+touch
  };
  ```
- **Port contract test** — `test/unit/ports/file-system.contract.ts`. It has a
  `pathCalls` table (lines 18–50, drives FILE_NOT_FOUND/containment cases per method)
  and per-behaviour `describe` blocks. Two touches:
  1. Add `{ name: 'writeStream', invoke: (e, p) => e.fs.writeStream(p, (async function* () { yield new Uint8Array(); })()) }` to the `pathCalls` table so containment/error cases cover it.
  2. Add a `writeStream` behaviour `describe` (model on the existing `write` behaviour cases): writes bytes round-trip byte-identical via `read`; creates parent dirs on a nested path; overwrites an existing file; a **multi-chunk** async source concatenates in order.

**Cross-cutting touch (REQUIRED, or the build breaks):**
`test/unit/application/primitives/fixtures.ts` — `instrumentedContext` (line 71) builds
a `wrappedFs: FileSystem` mirroring **every** `FileSystem` method. Adding `writeStream`
to the port makes this object structurally incomplete → a type error across the whole
unit suite. Add a `writeStream` wrapper here in this slice:
```ts
writeStream: async (p, source) => { record('writeStream', p); return base.fs.writeStream(p, source); },
```
Grep for any other object that structurally implements `FileSystem` (test doubles,
in-memory stubs) and extend them too — `npm run check:types` is the ground truth that
catches all of them.

### TDD steps

RED (extend `file-system.contract.ts`; fails because no adapter implements `writeStream`):
1. Given a source yielding bytes, When `writeStream(path, source)` then `read(path)` → Then bytes byte-equal the concatenated source (drive all three adapters via the shared contract harness).
2. Given a nested path whose parent does not exist, When `writeStream` → Then parent dirs are created and the file exists.
3. Given an existing file, When `writeStream` overwrites it → Then the new bytes replace the old (no append).
4. Given a **multi-chunk** async source (≥2 chunks), When `writeStream` → Then the file equals the in-order concatenation (a "first-chunk-only" mutant dies).
5. The `pathCalls` containment/FILE_NOT_FOUND cases now include `writeStream` (table-driven).

GREEN: add the port method + three adapter implementations + the `instrumentedContext` wrapper (and any other `FileSystem` implementers `check:types` flags).

REFACTOR: ensure each adapter reuses its existing `write` machinery where possible (memory delegates to `write`; node/browser reuse `checkContainment`/`resolveFileHandle`). Keep each impl ≤20 lines.

### Gate

```
npx vitest run test/unit/ports/file-system.contract.ts test/unit/adapters/node test/unit/adapters/memory && npm run check:types && ./node_modules/.bin/biome check src/ports/file-system.ts src/adapters/node/node-file-system.ts src/adapters/browser/browser-file-system.ts src/adapters/memory/memory-file-system.ts test/unit/ports/file-system.contract.ts test/unit/application/primitives/fixtures.ts
```

### Commit

```
feat(ports): add streaming writeStream to the FileSystem port
```

## Slice 5 — internal streaming write primitives (regular / entry / file)

### Context

**Goal:** add the three streaming siblings the consumers need, built on one streaming
`writeRegularFileStream` that preserves the exact `rmIfExists` → write → `chmod` order
(W1/W2 faithfulness + symlink self-heal), writing straight into the final path with no
temp/rename (ADR-391/393). INTERNAL primitives — no public surface gate.

**File:** `src/application/primitives/internal/write-working-tree-file.ts`. Current
signatures to mirror:
- `writeRegularFile(ctx, fullPath: string, content: Uint8Array, mode?: FileMode)` (line 37). Order: `rmIfExists(ctx, fullPath)` (line 43) → `ctx.fs.write(fullPath, content)` (line 44) → `chmod` (lines 45–50, `MODE_EXEC_PERM` 0o755 / `MODE_REGULAR_PERM` 0o644 from lines 15–16).
- `writeWorkingTreeFile(ctx, path: FilePath, content: Uint8Array)` (line 53): `writeRegularFile(ctx, joinPath(ctx.layout.workDir, path), content)`.
- `writeWorkingTreeEntry(ctx, path: FilePath, content: Uint8Array, mode: FileMode)` (line 69): mode dispatch — `FILE_MODE.SYMLINK` → `rmIfExists` + `ctx.fs.symlink(decode(content), fullPath)` (lines 76–79); `FILE_MODE.GITLINK` → `ctx.fs.mkdir(fullPath)` (lines 81–83); else → `writeRegularFile(ctx, fullPath, content, mode)` (line 85).
- `rmIfExists(ctx, fullPath: string)` (line 23) — the symlink-safe `lstat`-probe-then-`rm`. Reused verbatim.
- `FILE_MODE` from `../../../domain/objects/index.js` (line 9). `joinPath` from `./join-working-tree-path.js` (line 11).

**Add the streaming siblings (same module). DECISION: the entry-stream variant is
regular-only — no symlink/gitlink branches.** Verified against site A's dispatch
(`apply-changeset.ts:166-171`): gitlink is the outer `else` arm (buffered
`writeWorkingTreeEntry` with empty content) and symlink stays buffered inside the
non-gitlink arm (Slice 6); so `writeWorkingTreeEntryStream` is only ever invoked with a
regular mode (100644/100755). A symlink/gitlink branch here would be dead code (CLAUDE.md
"watch for dead code in guards") — omit them. The `mode` parameter exists only to drive
the chmod exec/regular bit. Net: two real new functions (`writeRegularFileStream` is the
core; `writeWorkingTreeFileStream` and `writeWorkingTreeEntryStream` are thin
joinPath/mode wrappers over it).
```ts
// preserves rmIfExists → writeStream → chmod (ADR-393, straight into final path)
export const writeRegularFileStream = async (ctx, fullPath: string, source: AsyncIterable<Uint8Array>, mode?: FileMode): Promise<void> => {
  await rmIfExists(ctx, fullPath);
  await ctx.fs.writeStream(fullPath, source);
  if (mode !== undefined) await ctx.fs.chmod(fullPath, mode === FILE_MODE.EXECUTABLE ? MODE_EXEC_PERM : MODE_REGULAR_PERM);
};
// regular-only; for sites B / C / D (no mode → regular perm, matching writeWorkingTreeFile)
export const writeWorkingTreeFileStream = async (ctx, path: FilePath, source): Promise<void> => {
  await writeRegularFileStream(ctx, joinPath(ctx.layout.workDir, path), source);
};
// regular-only; for site A's regular arm. Carries `mode` purely for the chmod bit.
// Symlink/gitlink are NOT reached here — site A dispatches them to buffered writeWorkingTreeEntry.
export const writeWorkingTreeEntryStream = async (ctx, path: FilePath, source, mode: FileMode): Promise<void> => {
  await writeRegularFileStream(ctx, joinPath(ctx.layout.workDir, path), source, mode);
};
```
Note: `writeWorkingTreeFileStream` and `writeWorkingTreeEntryStream` differ only in
whether `mode` is forwarded (file = no mode → regular perm; entry = mode → exec/regular
perm). Keep both as named functions matching the two buffered entrypoints the consumers
replace, rather than collapsing them, so each call site reads as the direct streaming
analogue of its current buffered call.

**Fixtures/helpers:** `test/unit/application/primitives/internal/write-working-tree-file.test.ts` (extend). Add a small `async function* chunks(...parts: Uint8Array[])` helper yielding ≥2 chunks. Use `buildSeededContext` for a real fs and an `instrumentedContext`-style spy / `vi.spyOn` to assert call ordering (`rmIfExists` before `writeStream`).

### TDD steps

RED (extend the internal write-working-tree-file test; fails because the streaming siblings do not exist):
1. Given a multi-chunk source, When `writeWorkingTreeFileStream(ctx, path, source)` → Then the working-tree file byte-equals the concatenated source.
2. Given an executable mode, When `writeRegularFileStream(ctx, fullPath, source, FILE_MODE.EXECUTABLE)` → Then `chmod` is called with 0o755; with `FILE_MODE.REGULAR` → 0o644; with no mode → `chmod` not called (three isolated tests, one per perm branch).
3. Given a path currently occupied (e.g. a stale symlink / old file), When the streaming write runs → Then `rmIfExists` runs **before** `writeStream` (spy call-order; kills a reorder mutant that breaks symlink self-heal).
4. Given a multi-chunk source + `FILE_MODE.REGULAR`, When `writeWorkingTreeEntryStream(ctx, path, source, FILE_MODE.REGULAR)` → Then byte-equality and it routes through `writeRegularFileStream` with 0o644 (spy).
5. Given a multi-chunk source + `FILE_MODE.EXECUTABLE`, When `writeWorkingTreeEntryStream(...)` → Then byte-equality and chmod 0o755 (covers the entry-stream's mode-forwarding distinct from `writeWorkingTreeFileStream`'s no-mode path).

GREEN: add the three streaming functions; export them from the module (internal — consumers import them via the same `internal/write-working-tree-file.js` path).

REFACTOR: factor any shared chmod-perm computation already present in `writeRegularFile`; keep the streaming and buffered siblings visibly parallel so a reviewer can diff them. Confirm `writeRegularFile`/`writeWorkingTreeFile`/`writeWorkingTreeEntry` are unchanged (additive).

### Gate

```
npx vitest run test/unit/application/primitives/internal/write-working-tree-file.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/write-working-tree-file.ts test/unit/application/primitives/internal/write-working-tree-file.test.ts
```

### Commit

```
feat(primitives): add streaming working-tree write siblings
```

## Slice 6 — consumer A: stream the checkout materialisation (apply-changeset)

### Context

**Goal:** convert site A — checkout/reset/stash/sparse hot path — so a regular-file blob
flows read-stream → streaming-write. Regular modes (100644/100755) stream; symlink
(120000) stays buffered (target decoded whole, ADR-391); gitlink (160000) unchanged.

**File:** `src/application/primitives/apply-changeset.ts`.
- `applyEntry` (line 154), non-gitlink arm (lines 166–171):
  ```ts
  if (entry.mode !== FILE_MODE.GITLINK) {
    const blob = await readBlob(ctx, entry.id as IndexEntry['id']);
    await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);
  } else {
    await writeWorkingTreeEntry(ctx, entry.path, new Uint8Array(), entry.mode);
  }
  ```
  Convert: inside the non-gitlink arm, dispatch on mode —
  - `entry.mode === FILE_MODE.SYMLINK` → keep buffered: `const blob = await readBlob(ctx, entry.id); await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);` (target decoded whole).
  - regular (100644/100755) → stream: `const stream = await streamBlob(ctx, entry.id as IndexEntry['id']); await writeWorkingTreeEntryStream(ctx, entry.path, stream, entry.mode);`.
  The gitlink `else` arm (line 170) is unchanged. The `buildIndexEntry` lstat tail (line 172) and the `CHECKOUT_OP` progress tick (lines 200–207) are unchanged.
- Imports (lines 30–31): add `streamBlob` (`import { streamBlob } from './stream-blob.js';`, alongside `readBlob`) and `writeWorkingTreeEntryStream` (extend the `from './internal/write-working-tree-file.js'` import that currently brings `rmIfExists, writeWorkingTreeEntry`). Keep `readBlob` and `writeWorkingTreeEntry` (still used by the symlink + gitlink arms).
- `FILE_MODE` is already imported (line 21); `FileMode`/`IndexEntry` types already present (lines 19, 134).

**Current signatures:**
- `applyEntry(ctx, workdir: string, entry: ChangesetEntry): Promise<IndexEntry | undefined>` (line 154).
- `streamBlob(ctx, id, options?): Promise<BlobStream>` (Slice 1/2).
- `writeWorkingTreeEntryStream(ctx, path, source, mode)` (Slice 5).

**Fixtures/helpers:** `test/unit/application/primitives/apply-changeset.test.ts`
(extend). Existing changeset fixtures cover regular/symlink/gitlink entries. Spy
`streamBlob` / `writeWorkingTreeEntryStream` / `readBlob` / `writeWorkingTreeEntry`
(module spies via `vi.spyOn` on the imported modules, or via the fs-call log).

### TDD steps

RED (extend `apply-changeset.test.ts`; the routing assertions fail before conversion):
1. Given a **regular** (100644) changeset entry, When `applyEntry` runs → Then it routes through `streamBlob` + `writeWorkingTreeEntryStream` (spy); the written working-tree file byte-equals `readBlob(entry.id).content`.
2. Given an **executable** (100755) entry → Then routes through the stream path AND the file mode is 0755 (chmod tail preserved end-to-end).
3. Given a **symlink** (120000) entry → Then routes through buffered `readBlob` + `writeWorkingTreeEntry` (NOT the stream path) and the symlink target is correct (a mutant collapsing symlink into the stream path dies).
4. Given a **gitlink** (160000) entry → Then the gitlink arm is unchanged (mkdir, empty content).
5. All existing `apply-changeset` unit tests still pass byte-for-byte (regression guard).

GREEN: apply the mode-dispatch conversion + imports.

REFACTOR: extract the non-gitlink mode dispatch into a small named helper if it pushes `applyEntry` over 20 lines / nesting >2; early returns. No behaviour change beyond the stream routing.

### Gate

```
npx vitest run test/unit/application/primitives/apply-changeset.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts
```

### Commit

```
refactor(checkout): stream blob materialisation in apply-changeset
```

## Slice 7 — consumers B + C: stream merge clean-survivor writes (merge + apply-merge-to-worktree)

### Context

**Goal:** convert sites B and C — the two parallel merge worktree-application paths that
write a whole clean-survivor blob — to read-stream → streaming-write, **dropping the
256 MiB reject ceiling** (ADR-394; uncapped, matching site A and canonical git). Delete
the two cap `Stryker disable` suppressions that annotated the dropped `{ maxBytes }`
arguments.

**File 1:** `src/application/commands/merge.ts` — `writeOutcomeToTree` (line 579),
`unchanged`/`resolved-known` arm (lines 584–591):
```ts
if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
  if (isExcluded(matcher, outcome.path)) return;
  // Cap with MAX_CONFLICT_OUTPUT_BYTES so a hostile clean-tree blob          <- DELETE (586-587)
  // cannot OOM the merge consumer during a conflicting merge.                <- DELETE
  // Stryker disable next-line ObjectLiteral: ...                             <- DELETE (588)
  const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
  await writeWorkingTreeFile(ctx, outcome.path, blob.content);
  return;
}
```
Convert to:
```ts
if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
  if (isExcluded(matcher, outcome.path)) return;
  const stream = await streamBlob(ctx, outcome.id);
  await writeWorkingTreeFileStream(ctx, outcome.path, stream);
  return;
}
```
No `maxBytes` (ADR-394). Delete lines 586–588 (the two-line cap rationale + the
`Stryker disable next-line ObjectLiteral` at line 588). The `resolved-merged` arm
(line 596, site E, synthesised `outcome.bytes`) and `resolved-deleted` (line 599) are
**unchanged**. **Keep** the OTHER Stryker/cap comments in this file — `READ_BLOB_OPTS`
suppression at line 622 (site G, `materialiseConflictBytes`, keeps its cap). Imports:
add `streamBlob` (`from '../primitives/stream-blob.js'`) and `writeWorkingTreeFileStream`
(extend the `from '../primitives/internal/write-working-tree-file.js'` import at lines
38–42). **Keep** `readBlob` (still used at 627, 651), `writeWorkingTreeFile` (still used
at 596), and `MAX_CONFLICT_OUTPUT_BYTES` (still used at 623) — verified all three remain
in use after the conversion.

**File 2:** `src/application/primitives/apply-merge-to-worktree.ts` —
`writeConflictWorktree` (line 153), `resolved-known` arm (lines 171–175):
```ts
if (outcome.status === 'resolved-known') {
  // Stryker disable next-line ObjectLiteral: ...                             <- DELETE (172)
  const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
  await writeWorkingTreeFile(ctx, outcome.path, blob.content);
}
```
Convert to:
```ts
if (outcome.status === 'resolved-known') {
  const stream = await streamBlob(ctx, outcome.id);
  await writeWorkingTreeFileStream(ctx, outcome.path, stream);
}
```
Delete only the `Stryker disable next-line ObjectLiteral` at line 172 (the cap
suppression on the dropped `{ maxBytes }`). **Keep** the SEPARATE `Stryker disable
next-line ConditionalExpression` at line 170 — it annotates the `resolved-known` branch
guard (logic), not the cap, and the branch still exists. The `resolved-merged` arm
(lines 166–168, site F) and the conflict loop (lines 177–183, sites H/I via
`writeMarkedConflict`/`writeDistinctTypesSides`) are **unchanged**. **Keep** the
`Stryker disable`/cap suppressions at lines 115 and 127 (sites H, `conflictBytes`
survivor reads, keep their cap). Imports: extend the
`from './internal/write-working-tree-file.js'` block (ends line 41) with
`writeWorkingTreeFileStream`, and add `import { streamBlob } from './stream-blob.js';`
(beside the `readBlob` import at line 43). **Keep** `readBlob` (used at 116, 128),
`writeWorkingTreeFile` (used at 167), `MAX_CONFLICT_OUTPUT_BYTES` (imported at line 24,
used at 116, 128).

**Current signatures:**
- `writeOutcomeToTree(ctx, outcome: MergeOutcome, matcher: SparseMatcher | undefined): Promise<void>` (merge.ts:579) — exported "for direct unit testing".
- `writeConflictWorktree(ctx, outcomes, conflicts, changed: ReadonlySet<FilePath>): Promise<void>` (apply-merge-to-worktree.ts:153).
- `MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024` (`src/domain/merge/index.js`) — the ceiling B/C carry today; dropped on conversion (ADR-394). The constant stays defined and in use by sites E–I and the content-merger oversize check.

**Fixtures/helpers:** `test/unit/application/commands/merge.test.ts` (`writeOutcomeToTree`
is exported for direct unit tests); `test/unit/application/primitives/apply-merge-to-worktree.test.ts`. Spy `streamBlob` / `writeWorkingTreeFileStream`.

**Drop-cap test-behaviour reality (verified — DO NOT hunt a phantom test):** there is
**no existing oversize-rejection test on B or C** (no `OBJECT_TOO_LARGE` assertion on a
clean-survivor write in either test file). Dropping the cap requires no test removal or
rewrite on these paths. The implementer must **NOT** add an `OBJECT_TOO_LARGE` test on
the de-capped B/C sites (such a test would now be wrong). The `OBJECT_TOO_LARGE` /
`INVALID_MERGE_INPUT` tests that exist sit on the cap mechanism and the content merger
(excluded sites) — untouched.

### TDD steps

RED (extend both test files; routing assertions fail before conversion):
1. Given a `resolved-known`/`unchanged` outcome in `writeOutcomeToTree`, When it runs → Then it routes through `streamBlob` + `writeWorkingTreeFileStream` (spy); the written survivor byte-equals `readBlob(outcome.id).content`.
2. Given a `resolved-merged` outcome, When `writeOutcomeToTree` runs → Then it still routes through buffered `writeWorkingTreeFile` with the synthesised `outcome.bytes` (a mutant streaming it dies — there is no blob id to stream).
3. Given a sparse-`isExcluded` survivor path, When `writeOutcomeToTree` runs → Then it short-circuits before opening any stream (the `isExcluded` guard precedes the stream open).
4. Same routing + byte-equality + `resolved-merged`-stays-buffered triplet for `writeConflictWorktree` (site C).
5. **Positive uncapped case (pins the dropped ceiling):** Given a `resolved-known` survivor whose blob is large-ish, When the write runs → Then it succeeds (no throw) AND `streamBlob` is invoked with no `maxBytes` (spy the call args; byte-equality alone would not catch a re-introduced cap argument). Apply to both B and C.

GREEN: apply both conversions; delete the two cap suppressions (merge.ts:588 + its 586-587 rationale; apply-merge:172); add/keep imports as specified.

REFACTOR: confirm the two parallel arms read identically post-conversion; no dead imports (re-grep `MAX_CONFLICT_OUTPUT_BYTES`, `readBlob`, `writeWorkingTreeFile` in both files to confirm they are still referenced — they are).

### Gate

```
npx vitest run test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/merge.ts src/application/primitives/apply-merge-to-worktree.ts test/unit/application/commands/merge.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts
```

### Commit

```
refactor(merge): stream clean-survivor writes and drop the size cap
```

## Slice 8 — consumer D: stream the stash untracked restore (stash)

### Context

**Goal:** convert site D — stash's untracked-restore loop — to read-stream →
streaming-write, **dropping the 256 MiB ceiling** (ADR-394; site D converts
unconditionally, exactly like A/B/C). Delete the cap `Stryker disable` suppression.

**File:** `src/application/commands/stash.ts` — `restoreUntracked` (line 373), loop
(lines 375–382):
```ts
for (const [path, entry] of flat.entries) {
  // Cap the read so a hostile crafted `refs/stash` cannot load an unbounded  <- DELETE (376-378)
  // untracked blob (a tsgit-created stash never exceeds this — push hashes   <- DELETE
  // working files under the same limit).                                     <- DELETE
  // Stryker disable next-line ObjectLiteral: ...                            <- DELETE (379)
  const blob = await readBlob(ctx, entry.id, { maxBytes: MAX_WORKING_TREE_BLOB_BYTES });
  await writeWorkingTreeFile(ctx, path, blob.content);
}
```
Convert to:
```ts
for (const [path, entry] of flat.entries) {
  const stream = await streamBlob(ctx, entry.id);
  await writeWorkingTreeFileStream(ctx, path, stream);
}
```
No `maxBytes` (ADR-394). Delete lines 376–379 (the cap rationale + the `Stryker disable
next-line ObjectLiteral`).

**Import cleanup (verified — `restoreUntracked` is the SOLE consumer of both):**
- `readBlob` (imported line 41) — only use is at 380 → **drop the import**.
- `MAX_WORKING_TREE_BLOB_BYTES` (imported line 55) — only use is at 380 → **drop the import**. The constant itself stays defined in `src/application/primitives/types.ts:42` (used by `add --all`, ADR-032) — do NOT delete the constant.
- `writeWorkingTreeFile` (imported in the block lines 36–39 with `removeWorkingTreeFile`) — its only use was at 381; after conversion it is unused → drop it from the import block, **keep** `removeWorkingTreeFile`.
- Add `streamBlob` (`from '../primitives/stream-blob.js'`) and `writeWorkingTreeFileStream` (add to the `from '../primitives/internal/write-working-tree-file.js'` import block).
- Confirm with a re-grep after the edit: `readBlob`, `MAX_WORKING_TREE_BLOB_BYTES`, and `writeWorkingTreeFile` must have zero remaining references in `stash.ts`.

**Current signatures:**
- `restoreUntracked(ctx: Context, uTree: ObjectId): Promise<void>` (stash.ts:373), called on the clean-apply path (around line 459).
- `MAX_WORKING_TREE_BLOB_BYTES = 256 * 1024 * 1024` (`src/application/primitives/types.ts:42`) — stays defined; `restoreUntracked` simply stops passing it.

**Drop-cap test-behaviour reality (verified — load-bearing):** there is **NO existing
oversize-rejection test on `restoreUntracked`**. `test/unit/application/commands/stash.test.ts`
exercises it only with small untracked files; its rejection tests are
`NO_INITIAL_COMMIT` / `STASH_NOT_FOUND` / out-of-range — none assert `OBJECT_TOO_LARGE`.
Dropping the cap requires **no test removal or rewrite** here. The implementer must
**NOT** add an `OBJECT_TOO_LARGE` test for `restoreUntracked`. The behaviour change is
real but latent (an oversize untracked stash blob now restores rather than throwing,
matching git's `stash apply`) — ship a **positive** coverage case instead.

**Fixtures/helpers:** `test/unit/application/commands/stash.test.ts` — extend the
existing untracked-restore cases. Spy `streamBlob` / `writeWorkingTreeFileStream`.

### TDD steps

RED (extend `stash.test.ts`; routing + uncapped assertions fail before conversion):
1. Given an untracked stash with a regular file, When `restoreUntracked` runs (clean-apply) → Then it routes through `streamBlob` + `writeWorkingTreeFileStream` (spy); the restored file byte-equals the source.
2. **Positive uncapped case (pins the dropped ceiling):** Given an untracked stash whose blob is large-ish, When restore runs → Then it succeeds (no throw) AND `streamBlob` is invoked with no `maxBytes` (spy the call args — byte-equality alone cannot catch a re-introduced cap). No `OBJECT_TOO_LARGE` assertion.
3. Existing stash untracked-restore + rejection tests (`NO_INITIAL_COMMIT` / `STASH_NOT_FOUND`) still pass (regression guard).

GREEN: apply the conversion; drop the three now-unused imports; add the two new imports; delete the cap suppression + rationale.

REFACTOR: keep the loop body flat; confirm via re-grep that no dead import remains.

### Gate

```
npx vitest run test/unit/application/commands/stash.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts
```

### Commit

```
refactor(stash): stream untracked restore and drop the size cap
```

## Slice 9 — write-side interop: streamed writes byte-identical to git (W1/W2)

### Context

**Goal:** prove the write side is byte-identical to real `git`'s working-tree output and
faithful to git's replace-not-truncate, non-atomic write semantics (W1/W2) across all
four converted sites. The write side is the only **new** faithfulness surface this PR
adds. This is the design's Slice 10. Per ADR-249, reconstruct git's working-tree output
and compare — the library emits no display string.

**File (new):** `test/integration/blob-streaming-checkout-interop.test.ts`. Model on
`test/integration/checkout-replace-symlink-with-file-interop.test.ts` (existing checkout
interop with symlink self-heal) and the twin-repo helpers
`makePeerPair`/`initBothRepos`/`runGitEnv` from `test/integration/interop-helpers.ts`.
Reuse `catFileRaw` from the read-interop model where a blob-byte oracle is needed.

**Discipline:** scrubbed-env git helpers (`runGitEnv()`) — never inherit `GIT_DIR`
(env-pollution gotcha). For any conflict-adjacent merge fixture, pin the peer with
`-c merge.conflictStyle=merge` (the diff3 trap). Sign off (`commit.gpgsign=false`).

**Fixtures:**

| # | Site | Setup | Test | Asserts |
|---|---|---|---|---|
| C1 | A | peer commits a ~200 KB regular-file blob on a branch; checkout that branch via tsgit into ours | working-tree file bytes | byte-identical to the peer's checked-out file (and `catFileRaw(peer, id)`) |
| C2 | A | same, executable mode (100755) | working-tree file + perms | byte-identical content; mode 0755 (chmod tail preserved end-to-end) |
| C3 | A | a path that is a **symlink** in the source tree, then a branch where it becomes a regular file; checkout across the kind change via tsgit | working-tree state | regular file, no stale symlink (the `rmIfExists`-before-stream self-heal — pins the W1 replace + symlink-safety order) |
| C4 | A | checkout a tree with a regular file whose blob is **deltified** in the pack (`materialised: true` upstream) | working-tree file bytes | byte-identical (the write consumer is agnostic to the read stream's materialisation) |
| C5 | B/C | peer + ours diverge so a ~200 KB blob is a **clean survivor** of a three-way merge (changed on one side only); run `merge` via tsgit (B); a cherry-pick/`applyMergeToWorktree` variant covers the shared path (C) | working-tree file for the survivor path | byte-identical to git's merged working-tree file (`git merge` on the peer) |
| C6 | D | peer creates a stash with a ~200 KB **untracked** file; `stash apply` via tsgit | restored untracked file bytes | byte-identical to git's `stash apply` result (site D converts unconditionally — cap dropped, ADR-394) |

### TDD steps

RED (new interop file; C1–C6 fail before the consumer conversions land — but since this
slice runs after Slices 6/7/8, they should pass on first green; write them to fail only
if a conversion regresses):
1. C1 — checkout a large regular blob → working-tree bytes byte-identical to git.
2. C2 — executable mode → content + 0755 match git.
3. C3 — symlink→file kind change → regular file, no stale symlink (W1 self-heal).
4. C4 — deltified blob checkout → byte-identical (materialisation-agnostic write).
5. C5 — merge clean survivor (B path) + cherry-pick variant (C path) → byte-identical to git's merge.
6. C6 — stash-apply untracked restore → byte-identical to git's `stash apply`.

GREEN: no `src/` change expected (consumers already converted) — this slice is the
faithfulness pin. If any case is red, the fix belongs in the relevant consumer slice's
code, not here.

REFACTOR: extract a shared "checkout branch X via tsgit, read working file, compare to
peer" helper local to the file to keep each case small.

### Gate

```
npx vitest run test/integration/blob-streaming-checkout-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/blob-streaming-checkout-interop.test.ts
```

### Commit

```
test(interop): pin streamed working-tree writes byte-identical to git
```

---

## Phase-boundary gate

After Slice 9 lands, run the full quality gate before closing the implement phase:

```
npm run validate
```

This is where `check:doc-coverage` and `audit-browser-surface` (Slice 3's docs page +
README row + parity scenario) and the full unit/coverage/type/lint suite are confirmed
together. `reports/api.json` staleness is a `prepush` gate — confirm it was regenerated
in Slice 3 (`npm run docs:json`).

## Test-strategy notes (carried from the design)

- **Property-based — evaluated against the four lenses, result: SKIP** (read and write),
  justified in the design and carried forward verbatim: `streamBlob` is a one-way decode
  whose oracle is the already-tested `readBlob` (not a parse/serialize round-trip,
  matcher, total-function-over-grammar, or counting invariant); generating valid
  packed/deltified blobs requires driving the production write path (the oracle would
  re-implement it). `writeStream` is an I/O port wrapper — belongs in the
  contract/interop tier, not property tests (CLAUDE.md: "I/O wrappers … belong in
  integration/parity tests"). Do NOT add a tautological property.
- **Cross-adapter parity** does NOT prove faithfulness (only interop does) — both run.
  The streaming-write adapters are covered by the port contract test across all three
  adapters (Slice 4); a `streamBlob` parity scenario (Slice 3) proves memory-adapter
  byte-equality if the browser-surface audit reaches it.
- **Mutation-resistant patterns** (per CLAUDE.md): try/catch + `.data` assertions for
  every error (`unexpectedObjectType` / `objectHashMismatch` / `operationAborted` /
  `objectNotFound`); separate isolated tests per storage route (loose / base-pack /
  delta-pack) and per consumer branch (regular / symlink / gitlink / resolved-merged /
  resolved-known); spy routing AND spy call-args (to catch a re-introduced `maxBytes`);
  assert `materialised` true/false to kill constant-flag mutants; multi-chunk sources to
  kill first-chunk-only mutants; spy `rmIfExists`-before-write ordering.
