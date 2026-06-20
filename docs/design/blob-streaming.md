# Design — blob-streaming

> Brief: `readBlob` materialises the whole `Uint8Array`; there is no streaming /
> size-tiered escalation equivalent (matters for multi-MB StaticResource blobs).
> The write side (checkout materialisation) buffers the same blob a second time
> before `fs.write`.
> Sequenced after 24.10's inflate fix (now landed).
> Status: draft → self-reviewed ×3 → accepted → **read-side ADRs 383–389 ratified
> → write side pulled in scope → revised + self-reviewed (Pass 4)**

## Context

### What exists today (verified in this worktree)

`readBlob` is fully-buffered, top to bottom:

- `src/application/primitives/read-blob.ts` — `readBlob(ctx, id, options?: ReadObjectOptions): Promise<Blob>` delegates to `readObject`, then narrows the type (throws `unexpectedObjectType('blob', actual, id)`). `Blob.content` (`src/domain/objects/blob.ts:3`) is a materialised `Uint8Array`.
- `src/application/primitives/read-object.ts` — `readObject` → `resolveObject(ctx, registry, id, verifyHash, options?.maxBytes)`, plus the partial-clone lazy-fetch retry.
- `src/application/primitives/object-resolver.ts` — `resolveObject` (line 28). Loose path: `tryLoose` (line 148) reads the **whole** compressed file (`ctx.fs.read`) then `ctx.compressor.inflate` to a single buffer. Packed path: post-24.10 reads the **exact** entry slice `[offset, nextOffset)` via `ctx.fs.readSlice` and inflates the whole slice with `ctx.compressor.inflate`. Delta chains resolve the base via recursive `resolveObject` (`resolveBaseForRefDelta`, line 345) and apply instructions in memory (`resolvePackChain`, line 246).
- `src/repository.ts:261` types `readBlob` as `BindCtx<typeof primitives.readBlob>`; `:610` binds it. Barrel: `src/application/primitives/index.ts:47`.

**The 24.10 fix reshapes this brief.** When 24.15 was filed, the suspected blocker was a fixed 64 KiB inflate chunk. 24.10 (ADRs 359–361, `docs/design/streaming-inflate-64kib.md`) already removed `PACK_SLICE_HINT` and moved the packed read to exact-slice + size-unbounded `inflate` (Node caps inflated output at 2 GiB). So **correctness for large blobs is already fixed**; 24.15 is now purely a *peak-memory* feature — letting a caller consume a multi-MB blob without ever holding the full inflated `Uint8Array`, and (write side, now in scope) without buffering it again before `fs.write`.

### Latent streaming infrastructure (KEY — currently dead production code)

- `src/ports/compressor.ts:36` — `createInflateStream(): TransformStream<Uint8Array, Uint8Array>` is declared on the port and implemented on all three adapters (`node-compressor.ts` stream-aware via `node:zlib createInflate`; `browser-compressor.ts` and `memory-compressor.ts` are thin `DecompressionStream('deflate')` wrappers). **Grep confirms it is never called by any code under `src/` outside the adapter/port definitions** — only adapter unit tests + the port contract test exercise it. It is tested infrastructure waiting for exactly this consumer (ADR-387).
- `src/operators/readable-stream.ts` — `readableStreamToAsyncIterable(stream)` already bridges a Web `ReadableStream<Uint8Array>` to an `AsyncIterable<Uint8Array>` (used by `fetch-pack` / `upload-pack-client`). `src/operators/index.ts` exports it. The operators module owns AsyncIterable composition (`pipe`, `filter`, `map`, `take`, …). There is **no** Web-stream-*construction* helper today (only consumption).
- `src/ports/file-system.ts` — `read(path): Promise<Uint8Array>` (whole file) and `readSlice(path, offset, length)` (byte range). `FileHandle` (from `openWithNoFollow`) offers incremental `read(buffer, offset, length, position?)` and a whole-buffer `write(buffer)`. **There is no streaming-write method.** `write(path, data: Uint8Array)` takes the whole buffer; `writeExclusive` likewise. The Node adapter's `FileHandle.write` is a single `handle.write(buffer, 0, buffer.length)` (`node-file-system.ts:246`), and `openWithNoFollow` throws `UNSUPPORTED_OPERATION` on browser OPFS — so a `FileHandle`-loop write is **not** uniformly available.

### The beneficiaries (why streaming matters)

- **Write side (the strongest case, now IN scope):** the live checkout materialisation path is `src/application/primitives/apply-changeset.ts:167`:

  ```ts
  const blob = await readBlob(ctx, entry.id);
  await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);
  ```

  This is the `CHECKOUT_OP = 'checkout:materialize'` path (line 45), reached for every regular-file entry of a checkout / reset / merge / stash / sparse-checkout (`applyChangeset` callers: `checkout.ts`, `reset.ts`, `merge.ts`, `stash.ts`, `worktree.ts`, `internal/reset-worktree.ts`, `internal/apply-sparse-checkout.ts`). A 200 MB StaticResource is held **twice** — the inflated read buffer *plus* the whole-buffer handed to `fs.write`. Converting this consumer is where the real peak-memory win lands. (`materializeFile` in `src/application/commands/internal/working-tree.ts:36` is **dead code** — zero production callers, grep-confirmed — and is **not** the consumer; see Out of scope.)
- **Read side:** `read-file-at` (`src/application/commands/read-file-at.ts`), `blame`, `show`, `stash`, `merge` all consume `Blob.content`. Most need the whole buffer (line diff, hashing) and are NOT streaming candidates; `read-file-at` piping to a sink is.

### No working-tree transform blocks a streamed write (verified)

Grepped `autocrlf` / `smudge` / `filter` / `crlf` / `.gitattributes` / `convertEol` across `src/application/commands/` — **none in the checkout path**. tsgit v1 writes blob bytes to the working tree byte-for-byte (no EOL conversion, no smudge filters). A streaming write is therefore byte-identical to the buffered write; no whole-buffer transform is required between inflate and disk. Streaming is genuinely feasible.

### Constraints that bind this doc

- **CLAUDE.md prime directive (ADR-226):** replicate git's observable behaviour byte-for-byte. **Structured-output (ADR-249):** the library returns data, never rendered text. Both shape the API: a stream emits raw object content bytes, no framing/markers.
- **Faithfulness context** (`.claude/workflow/faithfulness.md`): faithfulness binds the *data and on-disk state*, not an internal memory strategy. See the pinned matrices below (read side F1–F4; write side W1–W2).
- **24.10 design** (`docs/design/streaming-inflate-64kib.md`) is the depth/format gold standard and the immediate predecessor; this doc builds on its exact-slice pack reads.

## Requirements

When this ships:

1. A caller can read a blob's **content bytes** as a stream/iterable without the library ever holding the full inflated content in a single buffer (loose blobs and non-delta packed blobs at minimum).
2. The streamed bytes are **byte-identical** to `readBlob(id).content` for the same id, across Node / browser-OPFS / memory adapters.
3. Hash verification on the stream path is **incremental and default-on** (ADR-389), matching `readObject`'s posture, with the documented caveat that a mismatch surfaces only at end-of-stream.
4. Deltified packed blobs are **reconstructed in full, then streamed, with `materialised: true`** on the result (ADR-386) — never silently claiming bounded memory.
5. The existing fully-buffered `readBlob` is unchanged (additive read primitive; no regression to any current caller).
6. **The in-tree checkout consumer (`apply-changeset.ts:167`) materialises regular-file blobs by streaming** read-stream → streaming-write, so the PR ships a real internal user and the actual peak-memory win, not just an unused primitive. Symlink and gitlink modes stay buffered (tiny by construction).
7. Streamed checkout writes are **byte-identical** to canonical `git checkout`'s working-tree output, and the on-disk replace semantics stay faithful (see W1–W2).
8. Any new public symbol passes the surface gates (barrel + facade + repository.test snapshot + doc page + browser scenario + README/api.json) — see `.claude/workflow/surface-gates.md`. The plan owns the checklist; this doc flags the new exports.

## Read-side design (ratified — ADRs 383–389)

The seven read-side decisions are **accepted**; they are stated here as the design, not as open candidates.

### Faithfulness framing (empirically pinned — read side)

git's streaming and `core.bigFileThreshold` are an **internal memory strategy**, not observable SHA/on-disk state. Pinned against `git version 2.54.0` in a `mktemp -d` throwaway (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`):

| # | Probe | Command | Result | Faithfulness verdict |
|---|---|---|---|---|
| F1 | Default `core.bigFileThreshold` | `git config --get core.bigFileThreshold` | unset → built-in default **512 MiB** (git-config(1)) | A constant, not observable from objects |
| F2 | Does threshold change the blob SHA? | `git hash-object big.txt` vs `git -c core.bigFileThreshold=1 hash-object big.txt` (600 KB file) | `78d52e6…` **identical** | SHA is **not** threshold-bound |
| F3 | Does threshold change loose object bytes / survive repack? | commit a 300 KB blob, `git -c core.bigFileThreshold=1 gc`, `git rev-parse HEAD:f.txt` | `2a335a2…` **stable** before/after | On-disk object is **not** threshold-bound |
| F4 | What `bigFileThreshold` actually controls | git-config(1) | "stored deflated, without attempting delta compression … treated as if labeled binary" | Affects **packing/delta + diff treatment**, never the object identity |

**Conclusion (ratified as ADR-385):** nothing in blob *reading* is faithfulness-bound. There is no git byte-output to match beyond `git cat-file -p`'s raw content, which is exactly `readBlob(id).content`. `streamBlob` is a new *capability*; it always streams and is **never** keyed off `bigFileThreshold` or any size threshold. tsgit does not honour `bigFileThreshold` anywhere.

### Decided shape

A new **`streamBlob` primitive** beside `readBlob` (ADR-383), returning a **`BlobStream`** (ADR-384):

```ts
// src/application/primitives/stream-blob.ts
export function streamBlob(
  ctx: Context,
  id: ObjectId,
  options?: StreamBlobOptions,        // { verifyHash?: boolean } — parity with ReadObjectOptions, default on
): Promise<BlobStream>;               // BlobStream = AsyncIterable<Uint8Array> + { materialised: boolean }
```

- **`streamBlob`, not an option on `readBlob`** (ADR-383): distinct return shape ⇒ distinct function (CQS, single-shape). `readBlob` and `Blob.content` are untouched.
- **`BlobStream` = `AsyncIterable<Uint8Array>` with metadata attached** (ADR-384): `src/operators/` already composes `AsyncIterable`; `readableStreamToAsyncIterable` already bridges. The `materialised` flag (ADR-386) rides on the same object — no separate handle type.
- **Build on `createInflateStream` as-is** (ADR-387): implemented + contract-tested on all three adapters, dead, awaiting precisely this consumer. 24.10's exact-slice read means the bytes handed to inflate are *exactly one complete zlib member*, so no consumed-bytes signal is needed (that is `streamInflate`'s job on `fetch-pack`). No port churn.

### Streamable vs non-streamable, per storage form

| Storage form | Streamed without full materialisation? | Mechanism |
|---|---|---|
| **Loose** | Yes | `ctx.fs.read(path)` → single `enqueue` → `createInflateStream` → bridge; skip the `<type> <size>\0` header in the inflated prefix. **Whole-file read everywhere** (ADR-388). |
| **Packed, non-delta base** (COMMIT/TREE/**BLOB**/TAG) | Yes | The 24.10 exact-slice `[offset, nextOffset)` is the complete zlib member; feed `chunk.subarray(headerEndInChunk)` through `createInflateStream`. |
| **Packed, OFS_DELTA / REF_DELTA** | **No** | Reconstruct in full via `resolvePackChain` (needs the full base + delta instructions resident), then stream the reconstructed buffer with `materialised: true` (ADR-386). No memory saving on the heavy step, stated honestly. |

**Loose-blob read granularity (ADR-388 — the deviation folded in).** The first draft recommended per-adapter (Node chunked via `FileHandle`, browser/memory whole-file). **The user chose whole-file-everywhere.** Rationale recorded in ADR-388: chunked loose reads would require a *new* `FileSystem` port method (a `createReadStream`-style streaming read; `openWithNoFollow` throws `UNSUPPORTED_OPERATION` on OPFS, so the `FileHandle` loop is not uniform), and the **packed** path — where most large blobs live after `git gc` — already reads the whole compressed slice via `readSlice` and is *not* compressed-bounded either. Chunking only the loose path buys an inconsistency for a minority case. The loose path is therefore uniformly:

```
ctx.fs.read(path) → single enqueue into createInflateStream → bridge → strip header → yield
```

No `FileHandle` chunking, no new `createReadStream` port method. Peak memory is bounded on the **inflated** side only (the multi-MB quantity that motivated the feature) — the compressed loose file is briefly held whole (bounded by its compressed size), the same posture as the packed path.

### Data flow (read, all cases)

```
streamBlob(ctx, id)
  ├─ loose?  tryLooseStream(ctx, id)
  │     ctx.fs.read(path) → single enqueue → createInflateStream → readableStreamToAsyncIterable
  │     → drop the `<type> <size>\0` header prefix → yield content chunks      (ADR-388)
  └─ packed?  registry.lookup → offsetTable → nextOffsetForEntry
        ├─ base entry:  readSlice([offset, nextOffset)) → subarray(headerEndInChunk)
        │               → createInflateStream → bridge → yield content chunks
        └─ delta entry: reconstruct via resolvePackChain (FULL buffer)
                        → yield from the reconstructed buffer (materialised: true)   (ADR-386)
  (every yielded chunk fed into a running hash; objectHashMismatch thrown at
   end-of-stream if the recomputed id differs — default on, ADR-389)
```

### Read-side error & verification semantics (decided)

- **Wrong object type:** `streamBlob` resolves the entry header / object type first and throws `unexpectedObjectType('blob', actual, id)` **before** yielding any chunk — never mid-stream.
- **Hash verification (ADR-389):** default **on**. Each yielded chunk is fed into a running hash over canonical `<type> <size>\0` + content; `objectHashMismatch` is thrown at end-of-stream if the recomputed id differs. `verifyHash: false` opts out (parity with `ReadObjectOptions`). Consumers must treat the stream as provisional until it completes (documented). On the write side this interacts with partial files — see W3 below.
- **Decompression failure mid-stream:** the adapter's `createInflateStream` already `controller.error(decompressFailed(...))`s; the `AsyncIterable` rejects on `next()`. No swallowed errors.
- **Abort:** `ctx.signal` checked between chunks (mirror `checkAborted` cadence in `resolveObject`).

### Cross-adapter feasibility (read)

- **Node:** `createInflateStream` is genuinely stream-aware (`node:zlib createInflate`) — true bounded-memory streaming. ✓
- **Browser-OPFS:** `createInflateStream` is `DecompressionStream('deflate')` (native, streaming). The 64 KiB O(n²) cap lives on `streamInflate`, **not** here. ✓
- **Memory:** same `DecompressionStream` path; whole-buffer enqueue is acceptable for the in-memory adapter (no disk to stream from). Faithfulness/interop pins run on Node; parity runs on memory. ✓

## Write-side design (NEW — in scope)

Goal: convert the live checkout materialisation consumer (`apply-changeset.ts:167`) so a regular-file blob flows **read-stream → streaming-write** without ever holding the full inflated content in one buffer. This is what turns `streamBlob` from an unused primitive into a real peak-memory win.

### Faithfulness framing (empirically pinned — write side)

The working-tree write is observable on-disk state, so it **is** faithfulness-bound (unlike the read-side memory strategy). Pinned against `git version 2.54.0` in a `mktemp -d` throwaway (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`):

| # | Probe | Method | Result | Faithfulness verdict |
|---|---|---|---|---|
| W1 | Does `git checkout` write in place or to a fresh file object? | commit `f.txt`=AAAA on master, =BBBB on `other`; checkout `other`, capture `ls -i` inode before/after a re-checkout | inode **changes** across checkout | git does **not** truncate-in-place; it replaces the file object (unlink/create-new) |
| W2 | Does the old content survive on the old inode? | hardlink `hl.txt` → `f.txt` while on `other` (content BBBB); `git checkout master`; read `f.txt` and `hl.txt` | `f.txt`=AAAA (new), `hl.txt`=BBBB (old, via hardlink) | git creates a **new** file; the original inode is untouched. A crash before the swap leaves the original intact |

**Conclusion.** Canonical `git checkout` materialises a path by removing/replacing it with a **new** file object, not by truncating the existing one in place (git `entry.c`). tsgit's current `writeRegularFile` already matches this shape: it `rmIfExists` (unlink any occupant, including a dangling/kind-changed symlink) **then** `ctx.fs.write` a fresh file. The `rmIfExists`-then-write order is *also* the symlink-safety mechanism here (a symlink→file kind change self-heals; the memory adapter never keeps a stale symlink entry). A streamed write that preserves the **same order** — `rmIfExists` first, then stream into a fresh path — stays faithful to W1/W2.

What git does *not* guarantee is crash-atomicity of the *new* content: working-tree writes are non-atomic, so a mid-write crash can leave a short/empty new file (the old content is already gone after the unlink, or survives only on a pre-existing hardlink as in W2). A streamed write has the **same** failure shape — a partial new file on crash — so streaming does **not** invent a divergence (it is no less atomic than git, which is itself non-atomic for working-tree content). This is the W3 interaction below; it is faithful, but it must be stated.

### The missing capability — a streaming-write port method

`FileSystem` has no way to write a path from a chunk source without buffering the whole thing. The write side needs one new port capability (exact shape is decision candidate **WC-1**). Cross-adapter feasibility is confirmed:

- **Node:** `stream.pipeline(asyncIterable, fs.createWriteStream(real))` — genuinely bounded.
- **Browser-OPFS:** `handle.createWritable()` returns a `FileSystemWritableFileStream`; loop `writable.write(chunk)` then `writable.close()` — natively streaming (the adapter's `write` already uses `createWritable()` at `browser-file-system.ts:44`).
- **Memory:** concat chunks into a buffer then store (no real bound; parity-only — acceptable, the in-memory adapter has no disk to stream to).

Blast radius of the new method: **1 port declaration + 3 adapter implementations + 1 port contract test** (plus its mode/symlink-safety wiring). This is the dominant new surface of the write side and the reason WC-1 is the first candidate.

### Data flow (write — regular file modes)

```
applyEntry(ctx, workdir, entry)   // apply-changeset.ts
  regular file (100644 / 100755):
    stream = await streamBlob(ctx, entry.id)        // read-stream (ADR-383/388)
    await writeWorkingTreeEntryStream(ctx, entry.path, stream, entry.mode)
        rmIfExists(fullPath)                         // W1/W2 faithfulness + symlink-safety, UNCHANGED order
        ctx.fs.<writeStream>(fullPath, stream)       // NEW port capability (WC-1)
        chmod(fullPath, perm)                        // unchanged
  symlink (120000):  unchanged — decode target, rmIfExists, ctx.fs.symlink (tiny, buffered)
  gitlink (160000):  unchanged — mkdir (no content)
```

The dispatch lives in `write-working-tree-file.ts`: a streaming sibling of `writeWorkingTreeEntry` / `writeRegularFile` that takes an `AsyncIterable<Uint8Array>` instead of a `Uint8Array` and keeps the `rmIfExists`-then-write order and the `chmod` tail byte-for-byte. Symlink and gitlink arms are untouched — their content is tiny (a path string / nothing), so buffering is correct and a streamed write there would be pointless complexity (decision candidate **WC-3**).

### Write-side error & verification interaction (W3)

The read stream verifies the hash at **end-of-stream** (ADR-389). The write consumes chunks as they arrive, so on a corrupt blob the write completes its chunks and *then* the read stream throws `objectHashMismatch` — leaving a **partial/whole-but-unverified file on disk**. This is a real interaction, not hand-waved:

- It is **no worse than git**: W2 shows git's working-tree writes are non-atomic; a corrupt object would also leave bad bytes on disk.
- It is **no worse than today's buffered path**: today `readBlob` verifies the *whole* buffer before `writeWorkingTreeEntry` is even called, so today a corrupt blob throws *before* any write. The streaming write **loses that pre-write verification** — a real behaviour change to surface.

This tension is decision candidate **WC-4** (atomicity / verify-before-publish). Options range from "accept git-faithful non-atomic partial writes" to "stream to a temp path, verify, then rename into place" (which would make tsgit *more* atomic than git — a deliberate, documented choice, not an accidental divergence).

### Always-stream vs auto-escalate the write (WC-2)

The read side always streams (ADR-385, no threshold). The write side has the same question: stream every regular-file write, or buffer small files and stream only large ones. Symlink/gitlink modes stay buffered regardless (tiny). This is decision candidate **WC-2**, recommended below to mirror ADR-385's always-stream posture for consistency unless the per-small-file overhead proves to matter.

## Decision candidates

> REQUIRED. The designer NEVER decides these; the user does, in the ADR phase. The **read-side** candidates are now **decided** (ADRs 383–389) and live in "Read-side design" above. This section holds only the **new write-side** candidates. ADR numbering continues from the current max (389) → **390+**.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| WC-1 | **Streaming-write port shape** | (a) New `ctx.fs.writeStream(path, source: AsyncIterable<Uint8Array>): Promise<void>` — high-level, mirrors `write`; the adapter owns the piping (`pipeline` / `createWritable` loop / concat). (b) New `ctx.fs.createWriteStream(path): WritableStream<Uint8Array>` — lower-level; the primitive owns the piping. (c) Reuse the `FileHandle` chunked-write loop via `openWithNoFollow`. | **(a) `writeStream(path, source)`** | Symmetry with the read decisions: high-level method, adapters hide the platform stream just as `createInflateStream` does. Blast radius is 1 port method ×3 adapters + 1 contract test, same posture as `read`/`readSlice`. (b) leaks a Web type into every call site and duplicates the bridge. (c) is **not uniform** — `openWithNoFollow` throws `UNSUPPORTED_OPERATION` on OPFS, so it can't be the cross-adapter write path. Symlink-safety stays the `rmIfExists`-then-stream order (the no-follow guard is unavailable on OPFS anyway). |
| WC-2 | **Always-stream vs auto-escalate the write** | (a) Always stream every regular-file write. (b) Buffer below a tsgit constant (e.g. 16 MiB), stream above it. (c) Escalate off a caller option. | **(a) Always stream** | Mirrors ADR-385's always-stream read posture (one code path, no magic threshold, no faithfulness coupling). Symlink/gitlink stay buffered regardless (tiny). Pick (b)/(c) only if a measured per-small-file overhead justifies a second path — and if so, the threshold is a documented tsgit memory policy, never `bigFileThreshold`. |
| WC-3 | **Call-site scope** | (a) Checkout `apply-changeset.ts:167` only (regular-file modes). (b) Also the merge conflict materialisation that shares `writeWorkingTreeEntry` (per its doc comment). (c) A broader sweep of every `applyChangeset` caller. | **(a) checkout regular-file modes (via the shared write primitive)** | `apply-changeset.ts:167` is the single hot path and every `applyChangeset` caller (checkout/reset/merge/stash/sparse) routes through it, so converting the shared `writeWorkingTreeEntry` regular-file arm covers them with one change. The merge **conflict** materialisation writes small synthesised conflict-marker content (not a raw large blob), so it gains nothing from streaming — fold it in only if it already shares the streaming primitive for free; do not expand the surface for it. Symlink/gitlink arms unchanged in all cases. |
| WC-4 | **Crash / partial-write atomicity & verify-before-publish** | (a) Stream straight into the final path after `rmIfExists` (git-faithful non-atomic write; W3 leaves a partial/unverified file on crash or corruption). (b) Stream into a temp path in the same dir, drain the read stream (which verifies at end, ADR-389), then `rename` into place on success — atomic publish, **more** atomic than git, deliberately documented. (c) Keep buffered+verify-then-write for this consumer and only ship the read primitive streaming (no write-side memory win). | **(a) git-faithful straight write** *(call out (b) explicitly for the ADR round)* | W1/W2 pin that git itself does non-atomic working-tree writes, so (a) is faithful and the simplest — it does not invent a divergence, and it preserves the `rmIfExists`-then-write order that is also the symlink-safety. (b) is genuinely attractive because it *closes the W3 hole* (no partial/unverified file ever published) and OPFS `rename` is emulated anyway — but it makes tsgit deliberately *more* atomic than git and adds temp-name + rename + cleanup-on-failure logic; surface it as a real option, do not pick it silently. (c) abandons requirement 6 (the actual memory win) and is the fallback only if (a)/(b) both prove infeasible. |

## Slices

Pre-chewed context per slice. Public-vs-internal and the surface-gate checklist are the **planner's** to finalise; `streamBlob`, `BlobStream`, `StreamBlobOptions` are **public** (reachable as `repo.primitives.streamBlob`); the streaming-write port method and the internal write primitive are **internal** (port/adapter + `application/primitives/internal/`).

### Read-side slices

#### Slice 1 — operators: confirm the Web-stream → AsyncIterable bridge composes (likely no-op)

**Why:** `createInflateStream()` returns a `TransformStream<Uint8Array, Uint8Array>`; its `.readable` is a `ReadableStream<Uint8Array>` directly consumable by the existing `readableStreamToAsyncIterable`. Verify no new helper is needed; if it composes, this slice collapses into Slice 2/3.

**Files:**
- `src/operators/readable-stream.ts` — current: only `readableStreamToAsyncIterable` (line 15).
- `src/operators/index.ts` — barrel (exports the existing bridge).

**Fixtures/helpers:** existing operator unit tests under `test/unit/operators/`.

#### Slice 2 — primitive: loose-blob stream path (whole-file read, ADR-388)

**Files:**
- `src/application/primitives/stream-blob.ts` (new).
- `src/application/primitives/object-resolver.ts` — `tryLoose` (line 148): `ctx.fs.read(path)` → `ctx.compressor.inflate`. Reference for the loose path; extract a `tryLooseStream` helper or compose.
- `src/application/primitives/path-layout.ts` — `looseObjectPath`, `commonGitDir` (imported by resolver).
- `src/application/primitives/read-blob.ts` — `readBlob` signature (lines 7–17) is the oracle and the type-narrow reference (`unexpectedObjectType`).

**Current signatures:**
- `tryLoose(ctx: Context, id: ObjectId): Promise<Uint8Array | undefined>` (line 148).
- `parseHeader(inflated)` (`src/domain/objects/index.ts`) — yields the `<type> <size>\0` content offset; needed to skip the prefix when streaming (the header arrives in the first inflated chunk — buffer until the NUL, then yield the remainder + subsequent chunks).

**Mechanism (ADR-388):** `ctx.fs.read(path)` → **single `enqueue`** into `ctx.compressor.createInflateStream()` → bridge → strip header prefix → yield content chunks. No `FileHandle` chunking. Header-strip must handle the NUL landing mid-chunk or across chunk boundaries (accumulate until first `0x00`). Hash verification incremental, default-on (ADR-389).

**Fixtures/helpers:** `buildSeededContext` / `buildSeededRepo` in `test/unit/application/primitives/fixtures.ts`; write a loose blob via the existing `writeObject` primitive.

#### Slice 3 — primitive: packed non-delta base stream path + delta fallback (ADR-386)

**Files:**
- `src/application/primitives/stream-blob.ts` (extend).
- `src/application/primitives/object-resolver.ts` — `readEntryHeaderWithChunk` (returns `{ header, chunk, headerEndInChunk }`); `isBase`; `resolvePackChain` (line 246) for the delta fallback; `collectDeltaChain` (line 182).
- `src/application/primitives/pack-registry.ts` — `nextOffsetForEntry(table, offset)` (line 110); `offsetTable()` (line 76); `PackLookupHit` (line 32); `registry.lookup` (line 148).

**Current signatures:**
- `readEntryHeaderWithChunk(ctx, hit, nextOffset): Promise<{ header; chunk; headerEndInChunk }>` — gives the exact-slice chunk + data offset.
- `resolvePackChain(ctx, registry, hit, targetId, maxBytes): Promise<Uint8Array>` — the buffered reconstruction reused for the delta fallback.

**Mechanism:**
- Base entry: `chunk.subarray(headerEndInChunk)` is the complete zlib member → `createInflateStream` → bridge → yield (no header to strip; pack entries carry no loose-format header). Type check via `header.type === PACK_ENTRY_TYPE.BLOB`.
- Delta entry (ADR-386): `resolvePackChain` produces the full reconstructed buffer (which carries the loose `<type> <size>\0` header via `prependHeader`); strip the loose header → yield from the buffer; set `materialised: true`.

**Fixtures/helpers:** `buildSyntheticPack`, `writeSyntheticPack`, `EntrySpec` in `test/unit/application/primitives/pack-fixture.ts`; `stubRegistry` pattern in `test/unit/application/primitives/object-resolver.test.ts`.

#### Slice 4 — facade + surface gates (public export)

**Files:**
- `src/application/primitives/index.ts` — add `export { streamBlob } from './stream-blob.js';` (line ~47, alphabetical near `readBlob`).
- `src/repository.ts` — add `readonly streamBlob: BindCtx<typeof primitives.streamBlob>;` to the `primitives` interface block (lines 253–275, alphabetical) **and** the guarded binding (near line 610, beside `readBlob`).
- `test/unit/repository/repository.test.ts` — add the key to the sorted `Object.keys(sut.primitives)` surface-snapshot assertion.
- `reports/api.json` — regenerate via `npm run docs:json` (prepush gate; new public export makes it stale).
- `docs/use/` — add a primitive doc page if primitives are doc-gated (planner confirms; surface-gates.md §"New Tier-1 command" is command-scoped — primitives may be lighter).
- `test/parity/scenarios/` — add a `streamBlob` call to a scenario `run()` if the browser-surface audit covers primitives, or allowlist with reason.

**Note:** confirm in-slice whether `audit-browser-surface` and `check:doc-coverage` apply to **primitives** (the surface-gates doc enumerates the Tier-1 command set explicitly). Pre-pay whatever applies in this slice, not at phase-boundary validate.

#### Slice 5 — unit tests (read paths + verification + delta + type/abort)

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
  And the result reports materialised: true                 (ADR-386)

Given an id whose object is a tree (not a blob)
  When streamBlob is called
  Then it throws unexpectedObjectType('blob', 'tree', id) before any chunk

Given verifyHash default-on and a corrupt blob               (ADR-389)
  When the stream is drained
  Then objectHashMismatch is thrown at end-of-stream

Given verifyHash: false and a corrupt blob                   (ADR-389)
  When the stream is drained
  Then no objectHashMismatch is thrown (opt-out parity with readObject)

Given ctx.signal aborted between chunks
  When streamBlob is being drained
  Then operationAborted is thrown
```

**Mutation-resistant patterns:** assert exact byte-equality (not just length); assert the header NUL-strip boundary with a header that spans a chunk edge; try/catch + `.data` assertions for `unexpectedObjectType` / `objectHashMismatch` / `operationAborted` (not bare `toThrow(ErrorClass)`); separate tests for loose vs base-pack vs delta-pack so a mutant fixing only one path survives nowhere; assert `createInflateStream` IS used on the loose/base path and `resolvePackChain` IS used on the delta path (spy) to pin routing; test `materialised: false` on loose/base and `true` on delta to kill a constant-flag mutant.

#### Slice 6 — interop test: large packed/loose/delta blob streams byte-identical to git

**Files:**
- `test/integration/blob-streaming-interop.test.ts` (new). Model on `test/integration/large-object-pack-interop.test.ts` (twin-repo `makePeerPair`/`initBothRepos`, `runGitEnv`, `copyPackFiles` (line 49), binary-safe `catFileRaw` (line 65)).

**Fixtures:**

| # | Setup | Test | Asserts |
|---|---|---|---|
| **S1** | commit a 200 KB random-bytes blob in peer; `git gc`; `copyPackFiles` into ours | drain `streamBlob(ours, id)` | concatenated bytes `=== catFileRaw(peer, id)` (byte-identical to canonical `git cat-file -p`) |
| **S2** | same packed blob | drain with default `verifyHash` (ADR-389) | no `OBJECT_HASH_MISMATCH` thrown |
| **S3** | same 200 KB blob stored **loose** (no gc) | drain `streamBlob(ours, id)` | byte-identical to `catFileRaw` (loose whole-file streaming path, ADR-388) |
| **S4** | a deltified blob (commit base, then a near-copy so git stores a delta; `git gc`) | drain `streamBlob` | byte-identical; `materialised: true` (ADR-386) — proves the delta fallback yields correct bytes |

**Discipline:** all `git` via the scrubbed-env helpers (`runGitEnv`, `GIT_CONFIG_NOSYSTEM=1`, isolated `HOME`, `commit.gpgsign=false`). Distinct random seeds per blob. Run `git fsck --strict` on `ours` after copying packs (24.10 interop pattern). Pins requirement 2 per ADR-249 (reconstruct-and-compare; the library emits no display string).

### Write-side slices

#### Slice 7 — port + adapters: streaming-write capability (WC-1)

**Why:** `FileSystem` has no streaming write; the checkout consumer needs one to bound write-side memory (requirement 6). Decided shape comes from WC-1 (recommended: `writeStream(path, source)`).

**Files:**
- `src/ports/file-system.ts` — add to the `FileSystem` interface (near `write` line 61 / `writeExclusive` line 77): `readonly writeStream: (path: string, source: AsyncIterable<Uint8Array>) => Promise<void>;` with a doc comment matching the `write` contract (parent-dir creation, overwrite, byte-for-byte). Keep `FileHandle` untouched.
- `src/adapters/node/node-file-system.ts` — implement beside `write` (line 419): `stream.pipeline(source, fs.createWriteStream(real))` inside `runFs`, `mkdir(dirname, { recursive: true })` first (same as `write`). Reuse `checkContainment(path, 'creation')`.
- `src/adapters/browser/browser-file-system.ts` — implement beside `write` (line 42): `resolveFileHandle(path, true)` → `createWritable()` → `for await (chunk) writable.write(chunk)` → `close()` (natively streaming; mirrors the existing `write` at line 44).
- `src/adapters/memory/memory-file-system.ts` — implement beside `write` (line 85): concat chunks into a buffer then store (no real bound; parity-only — acceptable, no disk).
- The port **contract test** (the shared adapter contract suite) — add `writeStream` cases: writes bytes, creates parent dirs, overwrites, round-trips byte-identical to `read`.

**Mutation-resistant patterns:** drive each adapter through the shared contract test (byte-equality round-trip via `read`); assert parent-dir creation on a nested path; assert overwrite of an existing file; feed a multi-chunk async source so a "first-chunk-only" mutant dies.

#### Slice 8 — internal write primitive: streaming `writeWorkingTreeEntry` sibling (WC-3 scope, WC-4 atomicity)

**Files:**
- `src/application/primitives/internal/write-working-tree-file.ts` — add a streaming sibling of `writeRegularFile` (line 37) and `writeWorkingTreeEntry` (line 69). Current `writeRegularFile` does `rmIfExists` (line 43) → `ctx.fs.write` (line 44) → `chmod` (line 45). The streaming version preserves the **exact same order** (W1/W2 faithfulness + symlink-safety): `rmIfExists(ctx, fullPath)` → `ctx.fs.writeStream(fullPath, source)` → `chmod`. Per WC-4(a) it writes straight into the final path; if WC-4(b) is chosen, it streams to a temp path then `rename`s.
- The mode dispatch (`writeWorkingTreeEntry`, lines 69–86) gains a streaming variant: **symlink (120000)** arm unchanged (`rmIfExists` + `ctx.fs.symlink(decode(content), …)`, tiny, buffered — WC-3); **gitlink (160000)** arm unchanged (`mkdir`, no content); **regular** modes route to the new streaming `writeRegularFile`.

**Current signatures:**
- `writeRegularFile(ctx, fullPath: string, content: Uint8Array, mode?: FileMode): Promise<void>` (line 37).
- `writeWorkingTreeEntry(ctx, path: FilePath, content: Uint8Array, mode: FileMode): Promise<void>` (line 69).
- `rmIfExists(ctx, fullPath: string): Promise<void>` (line 23) — reused verbatim, it is the symlink-safe unlink.

**Mechanism:** new `writeWorkingTreeEntryStream(ctx, path, source: AsyncIterable<Uint8Array>, mode)` (regular modes only call the stream path; symlink/gitlink fall back to the buffered arms since they need decoded content / no content). The `MODE_REGULAR_PERM`/`MODE_EXEC_PERM` chmod tail (lines 15–16, 45–50) is preserved byte-for-byte.

**Mutation-resistant patterns:** assert `rmIfExists` runs **before** the stream write (spy ordering — kills a reorder mutant that would break symlink self-heal); assert `chmod` perm matches mode (executable vs regular); separate tests proving the symlink arm still buffers and the gitlink arm still `mkdir`s (a mutant routing them through the stream path must die); byte-equality of the written file vs the source.

#### Slice 9 — consumer: stream the checkout materialisation (apply-changeset, WC-3)

**Files:**
- `src/application/primitives/apply-changeset.ts` — `applyEntry` (line 154). Current regular-file arm (lines 166–168):
  ```ts
  if (entry.mode !== FILE_MODE.GITLINK) {
    const blob = await readBlob(ctx, entry.id as IndexEntry['id']);
    await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);
  } else {
    await writeWorkingTreeEntry(ctx, entry.path, new Uint8Array(), entry.mode);
  }
  ```
  Convert the non-gitlink arm to: for **regular** modes, `const stream = await streamBlob(ctx, entry.id); await writeWorkingTreeEntryStream(ctx, entry.path, stream, entry.mode)`; for **symlink** mode keep the buffered `readBlob` + `writeWorkingTreeEntry` (the target string must be decoded whole — WC-3). The gitlink arm (line 170) is unchanged. The `buildIndexEntry` lstat tail (line 172) and `CHECKOUT_OP` progress tick (lines 200–207) are unchanged.
- `src/application/primitives/apply-changeset.ts` imports — add `streamBlob` (alongside `readBlob`, line 31) and the streaming write primitive (alongside `writeWorkingTreeEntry`, line 30).

**Current signatures:**
- `applyEntry(ctx, workdir: string, entry: ChangesetEntry): Promise<IndexEntry | undefined>` (line 154).
- `readBlob(ctx, id): Promise<Blob>` (read-blob.ts) — kept for the symlink arm.

**Decision dependency:** WC-3 (checkout regular-file modes via the shared primitive); the symlink/gitlink arms stay buffered. WC-2 (always-stream) means every regular-file write streams; if WC-2(b) is chosen instead, branch on a size hint here.

**Mutation-resistant patterns:** the existing `apply-changeset` unit tests (`test/unit/application/primitives/apply-changeset.test.ts`) must still pass byte-for-byte; add a case proving a large regular-file entry routes through `streamBlob` + the streaming write primitive (spy), and that symlink/gitlink entries still route through the buffered arm (spy) — a mutant collapsing the branch must die.

#### Slice 10 — interop test: streamed checkout is byte-identical to git checkout (W1/W2/W3)

**Files:**
- `test/integration/blob-streaming-checkout-interop.test.ts` (new). Model on `test/integration/checkout-replace-symlink-with-file-interop.test.ts` (the existing checkout interop with symlink self-heal coverage) and the twin-repo helpers (`makePeerPair`/`initBothRepos`/`runGitEnv`).

**Fixtures:**

| # | Setup | Test | Asserts |
|---|---|---|---|
| **C1** | peer commits a 200 KB regular-file blob on a branch; checkout that branch via tsgit into ours | working-tree file bytes | byte-identical to the peer's checked-out file (and to `catFileRaw(peer, id)`) |
| **C2** | same, executable mode (100755) | working-tree file + perms | byte-identical content; mode 0755 (chmod tail preserved) |
| **C3** | a path that is a **symlink** in the source tree, then a branch where it becomes a regular file; checkout across the kind change | working-tree state | regular file, no stale symlink (`rmIfExists`-before-stream self-heal — pins the W1 replace + symlink-safety order) |
| **C4** | checkout a tree containing a regular file whose blob is **deltified** in the pack (`materialised: true` upstream) | working-tree file bytes | byte-identical (the write consumer is agnostic to the read stream's materialisation) |

**Discipline:** scrubbed-env git helpers; isolate the spawned-git `GIT_*` env (the integration-test env-pollution gotcha — never inherit `GIT_DIR`). Pins requirements 7 and W1/W2 (faithful replace semantics) per ADR-249.

## Test strategy

- **Unit** (Slices 5, 7, 8, 9): routing + header-strip + verification + write-dispatch + consumer-branch logic, mutation-resistant per project conventions. Byte-equality against `readBlob` (read) and against the streamed source (write) is the oracle — independently-tested siblings, not re-implementations, so no tautology.
- **Interop** (Slices 6, 10): byte-identity to real `git cat-file -p` (read) and to real `git checkout`'s working-tree output (write). The write side is the only **new** faithfulness surface this PR adds (W1/W2 pinned); the read side restates 24.10's obligation on the streaming surface.
- **Parity** (cross-adapter): if the browser-surface audit covers primitives, a `streamBlob` scenario proves memory-adapter byte-equality. The streaming-write adapter implementations are covered by the port contract test across all three adapters. Cross-adapter parity does NOT prove faithfulness (only interop does) — both run.
- **Property-based — evaluated against the four lenses, result: skip** (read and write). `streamBlob` is a one-way decode whose oracle is the already-tested `readBlob` (not a parse/serialize round-trip, matcher, total-function-over-grammar, or counting invariant); generating valid packed/deltified blobs requires driving the production write path (the oracle would re-implement it). `writeStream` is an I/O port wrapper — belongs in the contract/interop tier, not property tests (per CLAUDE.md "I/O wrappers … belong in integration/parity tests"). Noted here rather than shipping a tautological property.
- **Edge matrix:** empty blob (zero content bytes); blob whose content is exactly one chunk; header NUL on a chunk boundary; deltified blob; wrong-type id; aborted signal; executable-mode write (perm tail); symlink→file kind change on checkout (write-side self-heal); the largest test size that still runs fast (~200 KB inflated).

## Out of scope

- **`materializeFile` dead-code removal** (`src/application/commands/internal/working-tree.ts:36`). Grep-confirmed zero production callers (only its own definition + `test/unit/application/commands/internal/working-tree.test.ts`). It is *not* the checkout consumer (that is `apply-changeset.ts:167`), so this feature does not touch it. Removing it (and its test) is a **refactor-phase dead-code candidate**, not scope-crept into this feature — flagged here so it is not silently left rotting.
- **`core.bigFileThreshold` support anywhere in tsgit.** F1–F4 show it's not faithfulness-bound; honouring it (delta-attempt skipping during packing) is a *write/packing* concern unrelated to blob reads or working-tree writes.
- **Streaming non-blob objects** (commit/tree/tag). They're small by construction; no memory case.
- **Range / partial reads** of a blob (`streamBlob(id, { start, end })`). Not needed by any current consumer; the feature is whole-content streaming.
- **Reshaping `streamInflate` / its `bytesConsumed` contract** (the `fetch-pack` path). Untouched; `createInflateStream` is the streaming seam here.
- **A streaming-*read* `FileSystem` port method** (`createReadStream`). ADR-388 chose whole-file loose reads precisely to avoid this; the compressed read stays whole on both loose and packed paths. A future option if a concrete compressed-read-bounding need appears.
- **Changing `readBlob` / `Blob.content`.** Additive feature; the buffered read API stays for the many callers that need the whole buffer (diff, blame, show, hashing).

## Self-review log

### Pass 1 — contradiction & stale-premise hunt

- **Brief premise vs reality:** the brief implies a missing streaming fix; verified 24.10 (ADRs 359–361) already landed exact-slice + size-unbounded `inflate` in `object-resolver.ts`, so large-blob *correctness* is fixed. Reframed 24.15 from "fix" to "bounded-memory capability". The single most load-bearing correction.
- **Dead-code claim:** grepped `createInflateStream` — confirmed zero production callers (only adapter tests + port contract).
- **Faithfulness:** did not describe git from memory; ran F1–F4 in a `mktemp` throwaway. Recorded the matrix; `bigFileThreshold` is not faithfulness-bound (SHA stable).

### Pass 2 — unstated-assumption hunt

- **Deltified blobs:** made it a first-class decision candidate with a `materialised` flag so the API cannot silently claim bounded memory. Cross-checked `resolvePackChain` — the reconstruction genuinely yields one buffer.
- **Header strip:** loose objects carry the `<type> <size>\0` prefix; pack base entries do not. Corrected.
- **Browser/memory cap:** the 64 KiB cap lives on `streamInflate`, NOT `createInflateStream`. Streaming viable cross-adapter.
- **Hash verification:** surfaced as a decision candidate rather than silently dropping verification.

### Pass 3 — missing-edge-behaviour & convergence

- **Surface gates:** flagged `streamBlob` as public; listed barrel + facade + repository.test snapshot + api.json with the primitive-gate caveat.
- **Empty blob / boundary sizes:** added to the edge matrix.
- **Property tests:** ran the four lenses and recorded why they don't fit.

### Pass 4 — ADR-ratification revision (this revision)

Triggered by the ADR conversation: read-side candidates 1–7 ratified as ADRs 383–389 (with one deviation), and the write side pulled into scope.

- **ADR-388 deviation folded in.** The draft recommended per-adapter loose-read granularity (candidate 6 → Node chunked); the **user chose whole-file-everywhere**. Rewrote the loose path throughout (storage-form table, data flow, Slice 2) to `ctx.fs.read(path)` → single enqueue → `createInflateStream`, with no `FileHandle` chunking and no new `createReadStream` port method. Added the ADR-388 rationale (packed path is not compressed-bounded either, so chunking only loose buys inconsistency) and recorded the deviation explicitly in the storage-form section and Out of scope.
- **Read-side candidates moved out of "Decision candidates".** Candidates 1–7 are now the accepted "Read-side design" (ADRs 383–389 cited inline at every load-bearing point). "Decision candidates" now holds only the new write-side candidates WC-1..WC-4, renumbered to ADR-390+.
- **Consumer correction (the load-bearing fix).** The draft named `working-tree.ts:63` (`materializeFile`) as the write consumer. Verified against the worktree: `materializeFile` is **dead** (zero production callers), and the live checkout path is `apply-changeset.ts:167` calling `writeWorkingTreeEntry` → `writeRegularFile`. Rewrote the beneficiaries, write-side design, Slice 9, and Out of scope around the correct consumer; reclassified `materializeFile` as a refactor-phase dead-code removal (not scope-crept).
- **Write-side faithfulness pinned, not assumed.** Ran W1/W2 in a `mktemp` throwaway: inode changes across checkout, and a hardlink proves git creates a *new* file (old inode/content untouched). Concluded git does non-atomic, replace-not-truncate working-tree writes — so a straight streamed write into the final path after `rmIfExists` is faithful (it does **not** invent a divergence), and the `rmIfExists`-then-write order is also the symlink-safety. Made the crash/verify interaction explicit as W3 and WC-4 rather than hand-waving atomicity.
- **W3 verify-before-publish interaction surfaced.** ADR-389 verifies at end-of-stream; the buffered path today verifies *before* writing. The streaming write therefore loses pre-write verification — a real behaviour change. Did not bury it: it is the core of WC-4, with option (b) (temp+rename, verify-then-publish) called out as the way to *close* the hole at the cost of being more atomic than git.
- **No-transform feasibility verified.** Grepped autocrlf/smudge/filter/crlf/.gitattributes across the checkout path — none. A streamed write is byte-identical to the buffered write; streaming is genuinely feasible (no whole-buffer transform required). Recorded in Context.
- **New surface accounted.** Write side adds 1 port method ×3 adapters + contract test (Slice 7), an internal streaming write primitive (Slice 8), the consumer conversion (Slice 9), and a checkout interop (Slice 10). The streaming-write port method and internal primitive are internal (no public surface-gate beyond the contract test); only `streamBlob`/`BlobStream`/`StreamBlobOptions` remain public.
- **ADR numbering:** confirmed current max ADR is 389; write-side candidates map to 390+.
- **Convergence:** re-read Context ↔ Read-side design ↔ Decision candidates ↔ Slices ↔ Out of scope after the rewrite. No contradictions remain (the only `materializeFile` mention is now the Out-of-scope dead-code note; every write-consumer reference points at `apply-changeset.ts:167`). Converged.
