# Design — blob-streaming

> Brief: `readBlob` materialises the whole `Uint8Array`; there is no streaming /
> size-tiered escalation equivalent (matters for multi-MB StaticResource blobs).
> Sequenced after 24.10's inflate fix (now landed).
> Status: draft → self-reviewed ×3 → accepted

## Context

### What exists today (verified in this worktree)

`readBlob` is fully-buffered, top to bottom:

- `src/application/primitives/read-blob.ts` — `readBlob(ctx, id, options?: ReadObjectOptions): Promise<Blob>` delegates to `readObject`, then narrows the type. `Blob.content` (`src/domain/objects/blob.ts:3`) is a materialised `Uint8Array`.
- `src/application/primitives/read-object.ts` — `readObject` → `resolveObject(ctx, registry, id, verifyHash, options?.maxBytes)`, plus the partial-clone lazy-fetch retry.
- `src/application/primitives/object-resolver.ts` — `resolveObject` (line 28). Loose path: `tryLoose` (line 148) reads the **whole** compressed file (`ctx.fs.read`) then `ctx.compressor.inflate` to a single buffer. Packed path: post-24.10 reads the **exact** entry slice `[offset, nextOffset)` via `ctx.fs.readSlice` and inflates the whole slice with `ctx.compressor.inflate`. Delta chains resolve the base via recursive `resolveObject` (`resolveBaseForRefDelta`, line 345) and apply instructions in memory (`resolvePackChain`, line 246).
- `src/repository.ts:261` types `readBlob` as `BindCtx<typeof primitives.readBlob>`; `:610` binds it. Barrel: `src/application/primitives/index.ts:47`.

**The 24.10 fix reshapes this brief.** When 24.15 was filed, the suspected blocker was a fixed 64 KiB inflate chunk. 24.10 (ADRs 359–361, `docs/design/streaming-inflate-64kib.md`) already removed `PACK_SLICE_HINT` and moved the packed read to exact-slice + size-unbounded `inflate` (Node caps inflated output at 2 GiB). So **correctness for large blobs is already fixed**; 24.15 is now purely a *peak-memory* feature — letting a caller consume a multi-MB blob without ever holding the full inflated `Uint8Array` (and, on the write side, without buffering it before `fs.write`).

### Latent streaming infrastructure (KEY — currently dead production code)

- `src/ports/compressor.ts:36` — `createInflateStream(): TransformStream<Uint8Array, Uint8Array>` is declared on the port and implemented on all three adapters (`node-compressor.ts:83` stream-aware via `node:zlib createInflate`; `browser-compressor.ts:62` and `memory-compressor.ts:61` are thin `DecompressionStream('deflate')` wrappers). **Grep confirms it is never called by any code under `src/` outside the adapter/port definitions** — only adapter unit tests + the port contract test exercise it. It is tested infrastructure waiting for exactly this consumer.
- `src/operators/readable-stream.ts` — `readableStreamToAsyncIterable(stream)` already bridges a Web `ReadableStream<Uint8Array>` to an `AsyncIterable<Uint8Array>` (used by `fetch-pack` / `upload-pack-client`). `src/operators/index.ts` exports it. The operators module owns AsyncIterable composition (`pipe`, `filter`, `map`, `take`, …).
- `src/ports/file-system.ts` — `FileHandle` (from `openWithNoFollow`) offers incremental `read(buffer, offset, length, position?)`; `readSlice(path, offset, length)` reads a byte range. Loose-blob streaming can feed the compressed file through `createInflateStream`; packed non-delta blobs feed the exact `[offset, nextOffset)` slice through it.
- `src/operators/readable-stream.ts` has **no** Web-stream-construction helper today (only consumption). Node's `createInflateStream` is stream-aware, but browser/memory `streamInflate` is an O(n²) progressive-prefix scan hard-capped at 64 KiB — that limitation lives in `streamInflate`, **not** `createInflateStream` (which delegates to native `DecompressionStream`), so the streaming inflate path is viable cross-adapter.

### The beneficiaries (why streaming matters)

- **Write side (the strongest case):** `src/application/commands/internal/working-tree.ts:63` does `await ctx.fs.write(dst, blob)` — checkout/merge materialise the entire blob `Uint8Array` then hand it to `fs.write`. A 200 MB StaticResource is held twice (inflated buffer + the write). A streaming path would inflate→write in bounded chunks.
- **Read side:** `read-file-at` (`src/application/commands/read-file-at.ts`), `blame`, `show`, `stash`, `merge` all consume `Blob.content`. Most need the whole buffer (line diff, hashing) and are NOT streaming candidates; `read-file-at` piping to a sink is.

### Constraints that bind this doc

- **CLAUDE.md prime directive (ADR-226):** replicate git's observable behaviour byte-for-byte. **Structured-output (ADR-249):** the library returns data, never rendered text. Both shape the API: a stream emits raw object content bytes, no framing/markers.
- **Faithfulness context** (`.claude/workflow/faithfulness.md`): faithfulness binds the *data and on-disk state*, not an internal memory strategy. See the pinned matrix below.
- **24.10 design** (`docs/design/streaming-inflate-64kib.md`) is the depth/format gold standard and the immediate predecessor; this doc builds on its exact-slice pack reads.

## Requirements

When this ships:

1. A caller can read a blob's **content bytes** as a stream/iterable without the library ever holding the full inflated content in a single buffer (loose blobs and non-delta packed blobs at minimum).
2. The streamed bytes are **byte-identical** to `readBlob(id).content` for the same id, across Node / browser-OPFS / memory adapters.
3. Hash verification semantics are explicit and documented: either verified incrementally over the stream, or the contract states verification is the caller's job for the streaming path (decision candidate 7).
4. Deltified packed blobs have a **stated, honest** behaviour — never silently "stream" something that was fully materialised without saying so (decision candidate 4).
5. The existing fully-buffered `readBlob` is unchanged (additive feature; no regression to any current caller).
6. Any new public symbol passes the surface gates (barrel + facade + repository.test snapshot + doc page + browser scenario + README/api.json) — see `.claude/workflow/surface-gates.md`. The plan owns the checklist; this doc flags the new export.
7. Size-tiered escalation, if adopted, keys off a **documented, non-faithfulness-bound** threshold (decision candidate 3) — never off `bigFileThreshold` for any observable-state reason.

## Design

### Faithfulness framing (empirically pinned)

git's streaming and `core.bigFileThreshold` are an **internal memory strategy**, not observable SHA/on-disk state. Pinned against `git version 2.54.0` in a `mktemp -d` throwaway (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`):

| # | Probe | Command | Result | Faithfulness verdict |
|---|---|---|---|---|
| F1 | Default `core.bigFileThreshold` | `git config --get core.bigFileThreshold` | unset → built-in default **512 MiB** (git-config(1)) | A constant, not observable from objects |
| F2 | Does threshold change the blob SHA? | `git hash-object big.txt` vs `git -c core.bigFileThreshold=1 hash-object big.txt` (600 KB file) | `78d52e6…` **identical** | SHA is **not** threshold-bound |
| F3 | Does threshold change loose object bytes / survive repack? | commit a 300 KB blob, `git -c core.bigFileThreshold=1 gc`, `git rev-parse HEAD:f.txt` | `2a335a2…` **stable** before/after | On-disk object is **not** threshold-bound |
| F4 | What `bigFileThreshold` actually controls | git-config(1) | "stored deflated, without attempting delta compression … treated as if labeled binary" | Affects **packing/delta + diff treatment**, never the object identity |

**Conclusion:** nothing in blob-streaming is faithfulness-bound. There is no git byte-output to match — `git cat-file -p` *streams* a blob's raw content to stdout, and the raw content is exactly `readBlob(id).content`. The only faithfulness obligation is the one 24.10 already meets: the bytes a stream yields must equal canonical git's `cat-file -p` output for that id. The interop test pins that (reconstruct-and-compare against real git per ADR-249), but introduces **no new faithfulness surface**: streaming is a new *capability*, and any threshold we pick is a tsgit memory policy, deliberately **not** `bigFileThreshold`.

### Streamable vs non-streamable, per storage form (the hard architectural reasoning)

| Storage form | Can we stream content without full materialisation? | Mechanism |
|---|---|---|
| **Loose** | Yes | Feed the compressed file (or `FileHandle` chunks) through `createInflateStream`; skip the `<type> <size>\0` header in the inflated prefix. |
| **Packed, non-delta base** (COMMIT/TREE/**BLOB**/TAG) | Yes | The 24.10 exact-slice `[offset, nextOffset)` is the complete zlib member; feed `chunk.subarray(headerEndInChunk)` through `createInflateStream`. |
| **Packed, OFS_DELTA / REF_DELTA** | **No, not cleanly** | Delta reconstruction needs the **full base object** + the delta instructions in memory to run copy/insert ops against (`applyDelta`, `resolvePackChain`). The reconstructed result exists only as a complete buffer. Best we can do is stream the *already-reconstructed* buffer (no memory saving on the heavy step) or fall back to buffered. |

**Deltified-blob honesty (requirement 4):** a blob stored as a delta must materialise its base (and apply the chain) before a single output byte exists. The design therefore commits to one explicit strategy (decision candidate 4) and the doc/API states it plainly — e.g. a `materialised: boolean` flag on the result handle, or documented "delta blobs are reconstructed in full, then streamed; peak memory ≈ base + result." We do **not** claim bounded memory for deltified blobs.

### Proposed shape (recommendation — the user decides the candidates)

A new **`streamBlob` primitive** sitting beside `readBlob`, returning an `AsyncIterable<Uint8Array>` of raw content bytes:

```ts
// src/application/primitives/stream-blob.ts
export function streamBlob(
  ctx: Context,
  id: ObjectId,
  options?: StreamBlobOptions,
): Promise<BlobStream>;   // BlobStream = AsyncIterable<Uint8Array> (+ optional metadata)
```

Rationale for this default (full alternatives in Decision candidates):

- **Separate primitive, not an option on `readBlob`** — `readBlob` returns `Promise<Blob>` (a struct with `.content`); a streaming variant returns something fundamentally different. Overloading the return type by an option is a `boolean`-param + union-return smell. A sibling primitive keeps each function single-shaped (CQS, Object Calisthenics).
- **`AsyncIterable<Uint8Array>`, not a raw Web `ReadableStream`** — `src/operators/` already composes `AsyncIterable` (`pipe`/`map`/`take`), `readableStreamToAsyncIterable` already exists, and `AsyncIterable` is the lowest-common-denominator across Node + browser. A caller wanting a Web stream can adapt trivially; the reverse forces every operator consumer through an adapter.
- **Build on `createInflateStream`** — it is implemented, contract-tested, and dead; this feature is its intended first consumer. Reshaping it is unnecessary for loose + non-delta packed blobs (the cleanly-streamable cases). The deltified case never reaches the streaming inflate seam anyway (it's reconstructed by `applyDelta`).

### Data flow (read, non-delta cases)

```
streamBlob(ctx, id)
  ├─ loose?  tryLooseStream(ctx, id)
  │     compressed file → createInflateStream → readableStreamToAsyncIterable
  │     → drop the `<type> <size>\0` header prefix → yield content chunks
  └─ packed?  registry.lookup → offsetTable → nextOffsetForEntry
        ├─ base entry:  readSlice([offset, nextOffset)) → subarray(dataOffset)
        │               → createInflateStream → bridge → yield content chunks
        └─ delta entry: reconstruct via resolvePackChain (FULL buffer)
                        → yield from the reconstructed buffer (materialised: true)
```

### Error semantics

- Wrong object type: `streamBlob` resolves the entry header / object type first and throws `unexpectedObjectType('blob', actual, id)` **before** yielding any chunk (same error code `readBlob` throws), so a type mismatch never surfaces mid-stream.
- Missing object: `objectNotFound(id)` (partial-clone lazy-fetch retry preserved by routing through `readObject`/resolver, or documented as not-supported on the stream path — decision candidate 6/7).
- Decompression failure mid-stream: the adapter's `createInflateStream` already `controller.error(decompressFailed(...))`s; the `AsyncIterable` rejects on `next()`. No swallowed errors.
- Abort: `ctx.signal` checked between chunks (mirror `checkAborted` cadence in `resolveObject`).

### Cross-adapter feasibility

- **Node:** `createInflateStream` is genuinely stream-aware (`node:zlib createInflate`) — true bounded-memory streaming. ✓
- **Browser-OPFS:** `createInflateStream` is `DecompressionStream('deflate')` (native, streaming). Feeding the compressed slice/file streams natively. Note `streamInflate`'s 64 KiB O(n²) cap does **not** apply here — that cap is on `streamInflate`, not `createInflateStream`. Loose-file chunked read uses `FileHandle.read` or whole-`read` then a single `enqueue` (decision candidate 6). ✓ (with caveat)
- **Memory:** same `DecompressionStream` path; whole-buffer enqueue is acceptable for the in-memory adapter (no disk to stream from). The faithfulness/interop pin runs on Node; parity (cross-adapter byte-equality) runs on memory. ✓

## Decision candidates

> REQUIRED. The designer NEVER decides these; the user does, in the ADR phase. ADR numbering continues from the current max (382) → **383+**.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **API shape** | (a) New `streamBlob` primitive beside `readBlob`. (b) Option on `readBlob` (`{ stream: true }`) switching the return type. (c) Size-tiered auto-escalation inside `readBlob` (buffer small, stream large, same return type). | **(a) `streamBlob`** | Distinct return shape ⇒ distinct function (CQS, single-shape). (b) is a boolean-param + union-return smell. (c) cannot return a unified type and hides a perf cliff; escalation, if wanted, belongs *inside* `streamBlob`. |
| 2 | **Return type** | (a) `AsyncIterable<Uint8Array>`. (b) Web `ReadableStream<Uint8Array>`. (c) A handle object `{ stream(): AsyncIterable; size; materialised }`. | **(a) `AsyncIterable`** *(or (c) if metadata is wanted)* | `src/operators/` composes `AsyncIterable`; bridge already exists; lowest-common-denominator across runtimes. (c) is attractive if we must surface `materialised` / declared size — fold into (a) as the recommendation if candidate 4 needs the flag. |
| 3 | **Threshold / escalation policy** | (a) No threshold — `streamBlob` always streams; caller decides when to call it. (b) tsgit constant (e.g. `STREAM_BLOB_THRESHOLD = 16 MiB`) for an auto-escalating `readBlob`. (c) Caller-supplied `minStreamBytes` option. | **(a) No threshold** | Keeps `streamBlob` a pure capability; faithfulness probe (F1–F4) shows no observable reason to mirror `bigFileThreshold`. Never key escalation off `bigFileThreshold`. (b)/(c) only matter if candidate 1=(c). |
| 4 | **Deltified-blob streaming strategy** | (a) Reconstruct fully, then stream from the buffer; expose `materialised: true`. (b) Reconstruct fully, return buffered `Blob` (caller asked to stream, gets a buffer — no flag). (c) Refuse: throw "delta blob not streamable" and tell caller to use `readBlob`. | **(a) reconstruct-then-stream + `materialised` flag** | Honest (requirement 4), uniform iterable interface, lets the caller observe that memory wasn't bounded. (b) silently lies about memory; (c) pushes branching onto every caller and breaks the uniform contract. |
| 5 | **Build on dead `createInflateStream` vs reshape** | (a) Use it as-is for loose + non-delta packed. (b) Reshape the port (e.g. add a consumed-bytes signal) before using. (c) Add a new `inflateStreamFromSlice` port method. | **(a) use as-is** | It is implemented + contract-tested on all three adapters and dead, awaiting precisely this consumer. Exact-slice (24.10) means the whole slice IS one zlib member — no consumed-bytes signal needed (that's `streamInflate`'s job in `fetch-pack`). No port churn. |
| 6 | **Loose-blob read granularity (browser/memory)** | (a) Whole-file `fs.read` → single `enqueue` → `createInflateStream` (bounded on inflate output only). (b) `FileHandle.read` chunked loop feeding the stream (bounded on both compressed read and inflate). (c) Node uses (b); browser/memory use (a). | **(c) per-adapter** | Node `FileHandle` gives real chunked reads; OPFS chunked reads add complexity for marginal gain on the compressed side (inflate is the streaming win). Pick the simplest path that still bounds the *inflated* output, which is the multi-MB quantity. |
| 7 | **Hash verification on the stream path** | (a) Verify incrementally: hash chunks as they pass, throw `objectHashMismatch` at end-of-stream. (b) Don't verify; document that the streaming path trades verification for memory and tell callers to `readBlob` when they need it. (c) Verify only when `options.verifyHash === true` (default off for streaming, opposite of `readObject`'s default-on). | **(a) incremental verify, default on** | Matches `readObject`'s default-on faithfulness posture without buffering — git's own object read verifies. End-of-stream throw means a corrupt blob is caught (caller must treat last chunk as provisional, documented). (b)/(c) weaken the contract; only choose if incremental hashing proves too costly for the prime use case. |

## Slices

Pre-chewed context per slice. Public-vs-internal and the surface-gate checklist are the **planner's** to finalise; `streamBlob` and `BlobStream`/`StreamBlobOptions` are flagged as **public** (reachable as `repo.primitives.streamBlob`).

### Slice 1 — operators: Web-stream construction bridge (if needed)

**Why:** `readableStreamToAsyncIterable` consumes a Web stream; we additionally need to *produce* an `AsyncIterable` from a `TransformStream` output (or confirm the existing bridge suffices when piping `createInflateStream`'s readable side). Likely a thin addition, possibly a no-op if piping suffices.

**Files:**
- `src/operators/readable-stream.ts` — current: only `readableStreamToAsyncIterable` (line 15).
- `src/operators/index.ts` — barrel (line 7 exports the existing bridge).

**Current state:** `createInflateStream()` returns a `TransformStream<Uint8Array, Uint8Array>`; its `.readable` is a `ReadableStream<Uint8Array>` directly consumable by `readableStreamToAsyncIterable`. **Verify in the slice that no new helper is required** — if the existing bridge composes, this slice collapses into Slice 3.

**Fixtures/helpers:** existing operator unit tests under `test/unit/operators/`.

### Slice 2 — primitive: loose-blob stream path

**Files:**
- `src/application/primitives/stream-blob.ts` (new).
- `src/application/primitives/object-resolver.ts` — `tryLoose` (line 148): `ctx.fs.read(path)` → `ctx.compressor.inflate`. Reference for the loose path; extract a `tryLooseStream` helper or compose.
- `src/application/primitives/path-layout.ts` — `looseObjectPath`, `commonGitDir` (imported by resolver).

**Current signatures:**
- `tryLoose(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined>` (line 148).
- `parseHeader(inflated)` (`src/domain/objects/index.ts`) — yields `{ contentOffset }`; needed to skip the `<type> <size>\0` prefix when streaming (the header arrives in the first inflated chunk — buffer until the NUL, then yield the remainder + subsequent chunks).

**Mechanism:** compressed file → `ctx.compressor.createInflateStream()` → bridge → strip header prefix → yield content chunks. Header-strip must handle the NUL landing mid-chunk or across chunk boundaries (accumulate until first `0x00`).

**Fixtures/helpers:** `buildSeededContext` / `buildSeededRepo` in `test/unit/application/primitives/fixtures.ts`; write a loose blob via existing `writeObject` primitive.

### Slice 3 — primitive: packed non-delta base stream path + delta fallback

**Files:**
- `src/application/primitives/stream-blob.ts` (extend).
- `src/application/primitives/object-resolver.ts` — `readEntryHeaderWithChunk` (line 327, returns `{ header, chunk, headerEndInChunk }`); `isBase` (line 310); `resolvePackChain` (line 246) for the delta fallback; `collectDeltaChain` (line 182).
- `src/application/primitives/pack-registry.ts` — `nextOffsetForEntry(table, offset)` (line 110); `offsetTable()` (line 76); `PackLookupHit` (line 32); `registry.lookup` (line 148).

**Current signatures:**
- `readEntryHeaderWithChunk(ctx, hit, nextOffset): Promise<{ header; chunk; headerEndInChunk }>` — gives the exact-slice chunk + `dataOffset`.
- `resolvePackChain(ctx, registry, hit, targetId, maxBytes): Promise<Uint8Array>` — the buffered reconstruction reused for the delta fallback.

**Mechanism:**
- Base entry: `chunk.subarray(headerEndInChunk)` is the complete zlib member → `createInflateStream` → bridge → yield (no header to strip; pack entries carry no loose-format header). Type check via `header.type === PACK_ENTRY_TYPE.BLOB`.
- Delta entry: per decision candidate 4(a) → `resolvePackChain` produces the full reconstructed `prependHeader(...)` buffer; strip the loose header (`splitHeader`-style) → yield from the buffer; set `materialised: true`.

**Fixtures/helpers:** `buildSyntheticPack`, `writeSyntheticPack`, `EntrySpec` in `test/unit/application/primitives/pack-fixture.ts`; `stubRegistry` pattern in `test/unit/application/primitives/object-resolver.test.ts`.

### Slice 4 — facade + surface gates (public export)

**Files:**
- `src/application/primitives/index.ts` — add `export { streamBlob } from './stream-blob.js';` (line ~47, alphabetical near `readBlob`).
- `src/repository.ts` — add `readonly streamBlob: BindCtx<typeof primitives.streamBlob>;` to the `primitives` interface block (lines 253–275, alphabetical) **and** the guarded binding (near line 610, beside `readBlob`).
- `test/unit/repository/repository.test.ts` — add the key to the sorted `Object.keys(sut.primitives)` surface-snapshot assertion.
- `reports/api.json` — regenerate via `npm run docs:json` (prepush gate; new public export makes it stale).
- `docs/use/` — if primitives have doc pages, add one (the planner confirms whether primitives are doc-gated like Tier-1 commands; surface-gates.md §"New Tier-1 command" is command-scoped — primitives may be lighter).
- `test/parity/scenarios/` — add a `streamBlob` call to a scenario `run()` if the browser-surface audit covers primitives, or allowlist with reason.

**Note:** confirm in-slice whether `audit-browser-surface` and `check:doc-coverage` apply to **primitives** (the surface-gates doc enumerates the Tier-1 command set explicitly; primitives bound under `.primitives.*` may have a narrower gate). Pre-pay whatever applies in this slice, not at phase-boundary validate.

### Slice 5 — unit tests (read paths + verification + delta + type/abort)

**Files:**
- `test/unit/application/primitives/stream-blob.test.ts` (new).

**Context:** `buildSeededContext` (`fixtures.ts`); `buildSyntheticPack`/`pack-fixture.ts`; collect chunks via a small `async function collect(it: AsyncIterable<Uint8Array>)` helper → concat → compare to `readBlob(id).content`.

**Cases (GWT/AAA/sut):**
```
Given a loose blob larger than one inflate chunk
  When streamBlob is called and fully drained
  Then the concatenated chunks equal readBlob(id).content
  And the `<type> <size>\0` header never appears in any yielded chunk

Given a packed non-delta blob (exact-slice path)
  When streamBlob is called and fully drained
  Then the concatenated chunks equal readBlob(id).content

Given a packed deltified blob
  When streamBlob is called
  Then it yields readBlob(id).content
  And the result reports materialised: true            (decision candidate 4)

Given an id whose object is a tree (not a blob)
  When streamBlob is called
  Then it throws unexpectedObjectType('blob', 'tree', id) before any chunk

Given verifyHash on and a corrupt blob                  (decision candidate 7)
  When the stream is drained
  Then objectHashMismatch is thrown at end-of-stream

Given ctx.signal aborted between chunks
  When streamBlob is being drained
  Then operationAborted is thrown
```

**Mutation-resistant patterns:** assert exact byte-equality (not just length); assert the header NUL-strip boundary with a header that spans a chunk edge; try/catch + `.data` assertions for `unexpectedObjectType` / `objectHashMismatch` / `operationAborted` (not bare `toThrow(ErrorClass)`); separate tests for loose vs base-pack vs delta-pack so a mutant fixing only one path survives nowhere; assert `createInflateStream` IS used on the loose/base path and `resolvePackChain` IS used on the delta path (spy) to pin routing.

### Slice 6 — interop test: large packed/loose blob streams byte-identical to git

**Files:**
- `test/integration/blob-streaming-interop.test.ts` (new). Model on `test/integration/large-object-pack-interop.test.ts` (twin-repo `makePeerPair`/`initBothRepos`/`git`/`runGitEnv`, `copyPackFiles`, binary-safe `catFileRaw`).

**Fixtures:**

| # | Setup | Test | Asserts |
|---|---|---|---|
| **S1** | commit a 200 KB random-bytes blob in peer; `git gc`; copy `.git/objects/pack/*` into ours | drain `streamBlob(ours, id)` | concatenated bytes `=== catFileRaw(peer, id)` (byte-identical to canonical `git cat-file -p`) |
| **S2** | same packed blob | drain with `verifyHash: true` (candidate 7(a)) | no `OBJECT_HASH_MISMATCH` thrown |
| **S3** | same 200 KB blob stored **loose** (no gc) | drain `streamBlob(ours, id)` | byte-identical to `catFileRaw` (loose streaming path) |
| **S4** | a deltified blob (commit base, then a near-copy so git stores a delta; `git gc`) | drain `streamBlob` | byte-identical; `materialised: true` (candidate 4) — proves the delta fallback yields correct bytes |

**Discipline:** all `git` via the scrubbed-env helpers (`runGitEnv`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, `commit.gpgsign=false`). Distinct random seeds per blob. Run `git fsck --strict` on `ours` after copying packs (pattern from the 24.10 interop). This pins requirement 2 (byte-identity to git) per ADR-249 (reconstruct-and-compare; the library emits no display string).

## Test strategy

- **Unit** (Slice 5): the routing + header-strip + verification logic, mutation-resistant per project conventions. Byte-equality against `readBlob` is the oracle (an *independently tested* sibling — not a re-implementation, so no tautology).
- **Interop** (Slice 6): byte-identity to real `git cat-file -p` for packed, loose, and deltified blobs — the only faithfulness obligation (and it's 24.10's obligation restated for the streaming surface; no new faithfulness surface).
- **Parity** (cross-adapter): if the browser-surface audit covers primitives, a `streamBlob` scenario proves memory-adapter byte-equality. Cross-adapter parity does NOT prove faithfulness (only interop does) — both run.
- **Property-based — evaluated against the four lenses, result: skip.** `streamBlob` is not a parse/serialize round-trip (it's a one-way decode whose oracle is the already-tested `readBlob`), not a compositional matcher, not a total function over a grammar, and not idempotent/counting. The cleanest "property" — *drain(streamBlob(id)) ≡ readBlob(id).content for any blob* — is a byte-equality assertion better expressed as parameterised example sweeps over a size matrix (sub-chunk, header-spanning, multi-chunk, multi-MB) than as a `fast-check` arbitrary, since generating valid packed/deltified blobs requires driving the production write path (the oracle would re-implement it). Note the gap and the reason here rather than ship a tautological property.
- **Edge matrix:** empty blob (zero content bytes); blob whose content is exactly one chunk; header NUL on a chunk boundary; blob = the largest test size that still runs fast (~200 KB inflated); deltified blob; wrong-type id; aborted signal.

## Out of scope

- **Streaming on the write side** (`working-tree.ts:63` inflate→`fs.write` in chunks). The strongest memory case, but it's a *checkout/merge* change, not a `readBlob` change; sequence as a follow-up that consumes `streamBlob`. Flagged loudly here, not silently deferred — surface in the PR description so the user can pull it in or split it.
- **`core.bigFileThreshold` support anywhere in tsgit.** F1–F4 show it's not faithfulness-bound; honouring it (delta-attempt skipping during packing) is a *write/packing* concern unrelated to blob reads.
- **Streaming non-blob objects** (commit/tree/tag). They're small by construction; no memory case.
- **Reshaping `streamInflate` / its `bytesConsumed` contract** (the `fetch-pack` path). Untouched; `createInflateStream` is the streaming seam here.
- **Changing `readBlob` / `Blob.content`.** Additive feature; the buffered API stays for the many callers that need the whole buffer.

## Self-review log

### Pass 1 — contradiction & stale-premise hunt

- **Brief premise vs reality:** the brief implies a missing streaming fix; verified 24.10 (ADRs 359–361) already landed exact-slice + size-unbounded `inflate` in `object-resolver.ts`, so large-blob *correctness* is fixed. Reframed 24.15 from "fix" to "bounded-memory capability" and stated it explicitly in Context. This is the single most load-bearing correction — without it the whole doc would re-litigate a solved bug.
- **Dead-code claim:** grepped `createInflateStream` — confirmed zero production callers (only adapter tests + port contract). Claim in Context is accurate.
- **Faithfulness:** did not describe git from memory; ran F1–F4 in a `mktemp` throwaway (writes isolated, never the worktree `.git`). Result inverts a naive assumption: one might think `bigFileThreshold` is faithfulness-bound — it is not (SHA stable). Recorded the matrix.

### Pass 2 — unstated-assumption hunt

- **Deltified blobs:** the brief's hard constraint demanded an honest answer. Pass 1 hand-waved "stream after reconstruct"; Pass 2 made it a first-class decision candidate (4) with a `materialised` flag so the API cannot silently claim bounded memory. Cross-checked against `resolvePackChain` (line 246) — the reconstruction genuinely yields one buffer; no streaming is possible upstream of `applyDelta`.
- **Header strip:** loose objects carry the `<type> <size>\0` prefix in the inflated stream; pack base entries do **not** (the pack header is separate, stripped by `dataOffset`). Initially conflated the two; corrected — loose path strips a NUL-terminated prefix that may span chunks (Slice 2 calls this out), pack path does not.
- **Browser/memory cap:** nearly carried the 64 KiB `streamInflate` cap into the streaming design. Verified the cap lives on `streamInflate` (O(n²) progressive prefix), NOT on `createInflateStream` (native `DecompressionStream`). The streaming path is viable cross-adapter. Corrected the cross-adapter section.
- **Hash verification:** `readObject` defaults `verifyHash` ON; a streaming path can't buffer to hash at the end without re-buffering. Surfaced as decision candidate 7 rather than silently dropping verification.

### Pass 3 — missing-edge-behaviour & convergence

- **Surface gates:** flagged `streamBlob` as public (reachable via `repo.primitives.streamBlob`); listed barrel + facade + repository.test snapshot + api.json. Added the caveat that `audit-browser-surface` / `check:doc-coverage` are written command-scoped in surface-gates.md and the planner must confirm primitive coverage — did not assert a gate that may not apply.
- **Empty blob / boundary sizes:** added to the edge matrix (zero content, single-chunk, header-on-boundary).
- **Property tests:** ran the four lenses explicitly and recorded *why* they don't fit (one-way decode, oracle would re-implement the write path) rather than omitting — per CLAUDE.md "surface the gap or note why."
- **ADR numbering:** confirmed current max ADR is 382; candidates map to 383+.
- **Write-side out-of-scope:** the biggest memory win is checkout's `fs.write(dst, blob)`. Kept it out of scope (it's not a `readBlob` change) but flagged loudly per "discuss follow-ups first" — not a silent ticket.
- No contradictions remain between Context, Design, Decision candidates, and Slices. Converged.
