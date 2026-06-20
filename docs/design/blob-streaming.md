# Design — blob-streaming

> Brief: `readBlob` materialises the whole `Uint8Array`; there is no streaming /
> size-tiered escalation equivalent (matters for multi-MB StaticResource blobs).
> The write side (checkout materialisation) buffers the same blob a second time
> before `fs.write`.
> Sequenced after 24.10's inflate fix (now landed).
> Status: draft → self-reviewed ×3 → accepted → read-side ADRs 383–389 ratified
> → write side pulled in scope → revised (Pass 4) → write-side ADRs 390–393 ratified
> (WC-3 broadened to the comprehensive sweep) → re-sliced against the authoritative
> in-scope site list + self-reviewed (Pass 5) → **WC-5 ratified as ADR-394 (drop the cap
> on B/C/D; `streamBlob` gains no `maxBytes`) → re-threaded + self-reviewed (Pass 6).
> No open decision candidates remain.**

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

- **Write side (the strongest case, now IN scope — comprehensive sweep, ADR-392):** several live sites read a *full* blob and write it to the working tree, holding a 200 MB StaticResource **twice** (the inflated read buffer *plus* the whole-buffer handed to `fs.write`). The hot path is `src/application/primitives/apply-changeset.ts:167`:

  ```ts
  const blob = await readBlob(ctx, entry.id);
  await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);
  ```

  This is the `CHECKOUT_OP = 'checkout:materialize'` path (line 45), reached for every regular-file entry of a checkout / reset / stash / sparse-checkout (`applyChangeset` callers: `checkout.ts`, `reset.ts`, `stash.ts`, `worktree.ts`, `internal/reset-worktree.ts`, `internal/apply-sparse-checkout.ts`). But it is **not** the only full-blob working-tree write. The three-way-merge paths materialise a clean survivor side directly via `readBlob(...).content` → `writeWorkingTreeFile`, bypassing the changeset loop — `merge.ts`'s own `writeOutcomeToTree` (the `merge` command) and `apply-merge-to-worktree.ts`'s `writeConflictWorktree` (the shared cherry-pick / revert / rebase / stash-apply path). Stash's untracked-restore (`stash.ts` `restoreUntracked`) is a third. ADR-392 chose to convert **all** of these (see the authoritative in-scope table). (`materializeFile` in `src/application/commands/internal/working-tree.ts:36` is **dead code** — zero production callers, grep-confirmed — and is **not** a consumer; see Out of scope.)
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
6. **Every in-tree site that materialises a *full* blob to the working tree streams it** read-stream → streaming-write (ADR-392, comprehensive sweep), not just the checkout hot path. The authoritative in-scope list (below) enumerates exactly which sites convert and which are excluded; the excluded sites write synthesised conflict-marker content or non-blob content (symlink target / gitlink). When this ships, no whole-blob working-tree write is left buffered.
7. Streamed working-tree writes are **byte-identical** to canonical `git`'s working-tree output (checkout, and the merge clean-survivor path), and the on-disk replace semantics stay faithful (see W1–W2).
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

## Write-side design (ratified — ADRs 390–393)

Goal: convert **every** in-tree site that materialises a *full* blob to the working tree so the blob flows **read-stream → streaming-write** without ever holding the full inflated content in one buffer (ADR-392, comprehensive sweep). This turns `streamBlob` from an unused primitive into a repo-wide peak-memory win across checkout, reset, stash, sparse-checkout, **and** the merge clean-survivor paths. The four write-side decisions are accepted:

- **`writeStream(path, source)` is the streaming-write port method** (ADR-390).
- **The write always streams regular-file blobs — no size threshold** (ADR-391); symlink/gitlink modes stay buffered.
- **The conversion is the comprehensive sweep, not the single hot path** (ADR-392); the exclusion criterion is enumerated in the authoritative in-scope table below.
- **The streamed write goes straight into the final path after `rmIfExists`, git-faithful and non-atomic** (ADR-393); verification stays end-of-stream (W3).

### Authoritative in-scope site list (the contract the planner slices against)

Every site under `src/` where a `readBlob(...).content` (or equivalent) result is written to the working tree, classified **convert** / **exclude** with a code-grounded reason. The two cap constants referenced are **both 256 MiB**: `MAX_WORKING_TREE_BLOB_BYTES` (`src/application/primitives/types.ts:42`) and `MAX_CONFLICT_OUTPUT_BYTES` (`src/domain/merge/merge-types.ts:98`) — each is a **reject-if-larger security ceiling** (throws `OBJECT_TOO_LARGE`), *not* a content-truncation marker. ADR-392's "length-capped content" exclusion means *synthesised content bounded as content* (conflict markers), **not** "a whole-blob read guarded by a reject ceiling" — so a whole-blob-with-reject-ceiling site still converts. When sites B/C/D convert, they **drop** that reject ceiling entirely (ADR-394): `streamBlob` carries no `maxBytes`, and the user chose to make B/C/D uncapped — matching site A (checkout already reads uncapped) and canonical git (no working-tree file-size limit). The constants themselves remain for the consumers that keep their cap (`add --all`'s read-side guard per ADR-032; the excluded conflict-materialisation sites E–I) — only B/C/D stop passing them.

| # | Site (file:line) | Write primitive | What it writes | Cap | Verdict | Reason |
|---|---|---|---|---|---|---|
| A | `apply-changeset.ts:167-168` (`applyEntry`) | `writeWorkingTreeEntry` (mode dispatch) | whole blob | none | **convert** | The checkout/reset/stash/sparse hot path; uncapped full blob. Regular modes (100644/100755) stream; symlink/gitlink stay buffered (ADR-391). |
| B | `merge.ts:589-590` (`writeOutcomeToTree`, `unchanged`/`resolved-known`) | `writeWorkingTreeFile` | whole blob (merge clean survivor) | none (dropped, ADR-394) | **convert** | A single whole committed blob written verbatim. This is the `merge` command's own clean-survivor materialisation (ADR-392). The 256 MiB reject ceiling it passes today is **dropped** when it converts (ADR-394) — uncapped, like site A and like git. |
| C | `apply-merge-to-worktree.ts:171-174` (`writeConflictWorktree`, `resolved-known`) | `writeWorkingTreeFile` | whole blob (merge clean survivor) | none (dropped, ADR-394) | **convert** | Same whole-blob clean survivor, on the *shared* path for cherry-pick / revert / rebase / stash-apply (parallel to B, not superseded by it — both live; see note). Cap dropped on conversion (ADR-394). |
| D | `stash.ts:380-381` (`restoreUntracked`) | `writeWorkingTreeFile` | whole untracked blob | none (dropped, ADR-394) | **convert** | A genuine full-file restore of an untracked blob. The 256 MiB reject ceiling it passes today is **dropped** when it converts (ADR-394) — uncapped, exactly like A/B/C and like git's `stash apply`. No longer gated on any open candidate. |
| E | `merge.ts:596` (`writeOutcomeToTree`, `resolved-merged`) | `writeWorkingTreeFile` | synthesised merged bytes (`outcome.bytes`, in-memory only) | n/a | **exclude** | Not a single blob — the merged content is computed in memory by the content merger; there is no blob id / stream to consume. |
| F | `apply-merge-to-worktree.ts:166-167` (`writeConflictWorktree`, `resolved-merged`) | `writeWorkingTreeFile` | synthesised merged bytes (`outcome.bytes`) | n/a | **exclude** | Same as E on the shared path. |
| G | `merge.ts:605-619` (`writeConflictToTree` → `materialiseConflictBytes`) | `writeWorkingTreeEntry` | conflict bytes: synthesised markers *or* a whole survivor blob, unified into one buffer | 256 MiB ceiling | **exclude** | Conflict materialisation (ADR-392 names it). The helper returns `Uint8Array \| undefined` where the value may be `conflictContent` (synthesised `<<<<<<<` markers) — the call site cannot stream what may be synthesised. The whole-blob arms (binary/type-change/modify-delete) would each need a stream/buffer-union refactor that ADR-392's "don't force-fit" guard rejects. |
| H | `apply-merge-to-worktree.ts:106-149` (`writeMarkedConflict` → `conflictBytes`) | `writeWorkingTreeEntry` | conflict bytes (same dual nature as G) | 256 MiB ceiling | **exclude** | Same as G on the shared path. |
| I | `write-distinct-types-sides.ts:19-25` | `writeWorkingTreeEntry` ×2 | each side's whole blob at its path | 256 MiB ceiling | **exclude** | Distinct-types **conflict** materialisation. Although each side *is* a whole blob, it is part of the conflict-write family ADR-392 names, is mode-dispatched (a side may be a symlink, which stays buffered), and converting it for the regular arm only would fragment one tight conflict helper. Excluded as conflict materialisation. |

**The "two merge paths" question, resolved.** `merge.ts:writeOutcomeToTree` (caller at `merge.ts:532`) and `apply-merge-to-worktree.ts:applyMergeToWorktree` (callers: `cherry-pick.ts`, `revert.ts`, `stash.ts`) are **both live and parallel** — neither supersedes the other. `merge.ts` is the `merge` command's own working-tree materialisation; `apply-merge-to-worktree.ts` is the shared three-way-apply primitive for cherry-pick / revert / rebase / stash-apply. They share `write-distinct-types-sides.ts` and the same conflict-bytes shape but have separate clean-survivor write loops, so the sweep converts **both** B and C.

**Not working-tree writes (excluded, stated why):** `snapshot/index-entry.ts:25` and `snapshot/tree-entry.ts:27` (lazy *read* accessors — `read: () => (await readBlob(...)).content`, not a write); `blame.ts:318,368` (read API, in-memory line authorship); `read-file-at.ts:51` (a *read* consumer — it could itself use `streamBlob` to pipe to a sink, but that is a read-API change, out of this feature's write scope; noted, not converted); `materialise-patch-files.ts`, `detect-similarity-renames.ts`, `build-content-merger.ts` (in-memory diff/merge inputs, capped, never written to the working tree); `walk-submodules.ts:114` (reads `.gitmodules`, capped, in-memory). All listed again under Out of scope.

### Faithfulness framing (empirically pinned — write side)

The working-tree write is observable on-disk state, so it **is** faithfulness-bound (unlike the read-side memory strategy). Pinned against `git version 2.54.0` in a `mktemp -d` throwaway (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `commit.gpgsign=false`):

| # | Probe | Method | Result | Faithfulness verdict |
|---|---|---|---|---|
| W1 | Does `git checkout` write in place or to a fresh file object? | commit `f.txt`=AAAA on master, =BBBB on `other`; checkout `other`, capture `ls -i` inode before/after a re-checkout | inode **changes** across checkout | git does **not** truncate-in-place; it replaces the file object (unlink/create-new) |
| W2 | Does the old content survive on the old inode? | hardlink `hl.txt` → `f.txt` while on `other` (content BBBB); `git checkout master`; read `f.txt` and `hl.txt` | `f.txt`=AAAA (new), `hl.txt`=BBBB (old, via hardlink) | git creates a **new** file; the original inode is untouched. A crash before the swap leaves the original intact |

**Conclusion.** Canonical `git checkout` materialises a path by removing/replacing it with a **new** file object, not by truncating the existing one in place (git `entry.c`). tsgit's current `writeRegularFile` already matches this shape: it `rmIfExists` (unlink any occupant, including a dangling/kind-changed symlink) **then** `ctx.fs.write` a fresh file. The `rmIfExists`-then-write order is *also* the symlink-safety mechanism here (a symlink→file kind change self-heals; the memory adapter never keeps a stale symlink entry). A streamed write that preserves the **same order** — `rmIfExists` first, then stream into a fresh path — stays faithful to W1/W2.

What git does *not* guarantee is crash-atomicity of the *new* content: working-tree writes are non-atomic, so a mid-write crash can leave a short/empty new file (the old content is already gone after the unlink, or survives only on a pre-existing hardlink as in W2). A streamed write has the **same** failure shape — a partial new file on crash — so streaming does **not** invent a divergence (it is no less atomic than git, which is itself non-atomic for working-tree content). This is the W3 interaction below; it is faithful, but it must be stated.

**Dropping the B/C/D cap is a faithfulness improvement, not a regression (ADR-394).** Canonical `git` imposes **no** working-tree file-size limit on `checkout`, `merge`, or `stash apply` — `core.bigFileThreshold` changes handling (delta-attempt skipping, diff treatment) but never *rejects* a file. tsgit's 256 MiB reject ceiling on the merge clean-survivor (B/C) and stash untracked-restore (D) paths is therefore a **tsgit-only divergence**: git would write the large file, tsgit threw `OBJECT_TOO_LARGE`. Site A (checkout) never had this divergence — it already runs `readBlob(id)` with no `maxBytes` — so dropping the cap on B/C/D brings them **into line with A and with git**, removing the divergence rather than adding one. The residual exposure this leaves is the **deltified-blob full-reconstruction OOM** edge (a hostile multi-GiB deltified object must be reconstructed in one buffer, ADR-386) — but that is the **same** residual edge site A already carries today, now merely shared by B/C/D, not a new risk introduced by this change.

### The streaming-write port method (ADR-390)

`FileSystem` had no way to write a path from a chunk source without buffering the whole thing. ADR-390 adds one new port capability — `writeStream(path, source: AsyncIterable<Uint8Array>): Promise<void>`, same contract as `write` (creates parent dirs, overwrites, writes bytes verbatim). Cross-adapter feasibility is confirmed:

- **Node:** `stream.pipeline(asyncIterable, fs.createWriteStream(real))` — genuinely bounded.
- **Browser-OPFS:** `handle.createWritable()` returns a `FileSystemWritableFileStream`; loop `writable.write(chunk)` then `writable.close()` — natively streaming (the adapter's `write` already uses `createWritable()` at `browser-file-system.ts:44`).
- **Memory:** concat chunks into a buffer then store (no real bound; parity-only — acceptable, the in-memory adapter has no disk to stream to).

Blast radius of the new method: **1 port declaration + 3 adapter implementations + 1 port contract test** (plus its mode/symlink-safety wiring). It is the dominant new surface of the write side.

### Data flow (write — regular file modes)

Two streaming write entrypoints are needed because the in-scope sites use two different existing buffered entrypoints (`write-working-tree-file.ts`):

- `writeWorkingTreeFileStream(ctx, path, source)` — regular-only, for sites **B / C / D** that call `writeWorkingTreeFile` today.
- `writeWorkingTreeEntryStream(ctx, path, source, mode)` — mode-dispatched, for site **A** (`apply-changeset.ts`) that calls `writeWorkingTreeEntry` today; only the regular arm streams.

Both build on a streaming `writeRegularFile` sibling that preserves the `rmIfExists`-then-write order and the `chmod` tail byte-for-byte:

```
checkout (site A):  applyEntry(ctx, workdir, entry)            // apply-changeset.ts
  regular file (100644 / 100755):
    stream = await streamBlob(ctx, entry.id)                   // read-stream (ADR-383/388)
    await writeWorkingTreeEntryStream(ctx, entry.path, stream, entry.mode)
        rmIfExists(fullPath)                                   // W1/W2 faithfulness + symlink-safety, UNCHANGED order
        ctx.fs.writeStream(fullPath, stream)                  // ADR-390, straight into final path (ADR-393)
        chmod(fullPath, perm)                                  // unchanged
  symlink (120000):  unchanged — decode target, rmIfExists, ctx.fs.symlink (tiny, buffered, ADR-391)
  gitlink (160000):  unchanged — mkdir (no content)

merge clean survivor (sites B / C):  writeOutcomeToTree / writeConflictWorktree
  resolved-known / unchanged:
    stream = await streamBlob(ctx, outcome.id)                 // read-stream (ADR-383/388), no cap (ADR-394)
    await writeWorkingTreeFileStream(ctx, outcome.path, stream)  // regular-only, uncapped

stash untracked restore (site D):  restoreUntracked
  for each untracked entry:
    stream = await streamBlob(ctx, entry.id)                   // read-stream (ADR-383/388), no cap (ADR-394)
    await writeWorkingTreeFileStream(ctx, path, stream)
```

The dispatch lives in `write-working-tree-file.ts`: streaming siblings of `writeWorkingTreeEntry` / `writeWorkingTreeFile` / `writeRegularFile` that take an `AsyncIterable<Uint8Array>` instead of a `Uint8Array` and keep the `rmIfExists`-then-write order and the `chmod` tail byte-for-byte. Symlink and gitlink arms are untouched — their content is tiny (a path string / nothing), so buffering is correct and a streamed write there would be pointless complexity (ADR-391).

### Write-side error & verification interaction (W3, resolved by ADR-393)

The read stream verifies the hash at **end-of-stream** (ADR-389). The write consumes chunks as they arrive, so on a corrupt blob the write completes its chunks and *then* the read stream throws `objectHashMismatch` — leaving a **partial/whole-but-unverified file on disk**. This is a real interaction, not hand-waved:

- It is **no worse than git**: W2 shows git's working-tree writes are non-atomic; a corrupt object would also leave bad bytes on disk.
- It is **no worse than today's buffered path** for the *bytes published*, but it does **lose the buffered path's pre-write verification**: today `readBlob` verifies the *whole* buffer before the write is even called, so a corrupt blob throws *before* any write. The streaming write loses that — a real behaviour change.

**Decided (ADR-393):** the streamed write goes **straight into the final path** after `rmIfExists`, with no temp file or rename — git-faithful and non-atomic. Verification stays end-of-stream; a corrupt/aborted blob may leave a partial file, matching git's non-atomic working-tree write semantics (W1/W2). The temp-path + verify + rename alternative (which would make tsgit *more* atomic than git) was considered and rejected as a deliberate divergence; it remains a documented future opt-in.

### Always-stream the write — no threshold (ADR-391)

The read side always streams (ADR-385, no threshold). **Decided (ADR-391):** the write side mirrors it — every regular-file (100644 / 100755) working-tree materialisation streams, with no size threshold and no `bigFileThreshold` coupling. Symlink (120000) and gitlink (160000) modes stay buffered (content is tiny / absent). A per-small-file-cost-driven threshold remains a documented future option, never a git knob.

## Decision candidates

> REQUIRED. The designer NEVER decides these; the user does, in the ADR phase.

**Read-side candidates — decided (ADRs 383–389):** seven candidates ratified, one deviation (ADR-388, whole-file loose reads). They live in "Read-side design" above.

**Write-side candidates WC-1..WC-4 — decided (ADRs 390–393):** `writeStream(path, source)` port method (ADR-390); always-stream regular files, no threshold (ADR-391); the **comprehensive sweep** of every full-blob site, not the single hot path — the design had recommended the single shared primitive; the user chose the broad sweep (ADR-392); git-faithful straight write into the final path, non-atomic, verify end-of-stream (ADR-393). They live in "Write-side design" above. The sweep (ADR-392) surfaced a wrinkle when it reached site D (stash), captured as WC-5.

**WC-5 — decided (ADR-394): drop the cap on B/C/D; `streamBlob` gains no `maxBytes`.** When the ADR-392 sweep reached site D, the question was how to reconcile the 256 MiB reject ceiling those sites pass today (`stash.ts:380` via `MAX_WORKING_TREE_BLOB_BYTES`; `merge.ts:589` / `apply-merge-to-worktree.ts:173` via `MAX_CONFLICT_OUTPUT_BYTES`) with a `streamBlob` that carries only `{ verifyHash }`. The candidates put to the user were (a) add an optional `maxBytes` to `streamBlob` and pass it through, (b) keep a pre-stream declared-size guard at each call site, or (c) exclude B/C/D from the sweep and leave them buffered+capped. **The user chose none of these — they chose to drop the cap entirely on B/C/D** (ADR-394), a fourth option beyond the enumerated three. The converted sites become uncapped, matching site A (checkout already runs `readBlob(id)` with no `maxBytes`) and matching canonical git (which imposes no working-tree file-size limit — `core.bigFileThreshold` changes handling, never rejects). `streamBlob` is therefore **unchanged**: no `maxBytes` is ever added to its ratified `{ verifyHash }` surface. Sites B/C/D simply **stop passing** `maxBytes: MAX_*` when they convert. See [ADR-394](../adr/394-drop-working-tree-blob-cap-on-streamed-paths.md). This was the only open candidate; with it ratified, **no open decision candidates remain** — read-side (ADRs 383–389), write-side WC-1..WC-4 (ADRs 390–393), and WC-5 (ADR-394) are all decided.

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

> Scope reminder: the consumer conversion must cover **every** in-scope site — A (checkout), B + C (merge clean survivors), D (stash untracked restore) — per the authoritative table (ADR-392). One generalised streaming-write helper pair is built once (Slice 8) and applied at each site (Slices 9 / 9b / 9c). All four sites convert unconditionally; site D is no longer gated — WC-5 is decided (ADR-394, drop the cap), so D converts exactly like A/B/C with no cap argument.

#### Slice 7 — port + adapters: `writeStream` capability (ADR-390)

**Why:** `FileSystem` has no streaming write; every converted consumer needs one to bound write-side memory (requirement 6).

**Files:**
- `src/ports/file-system.ts` — add to the `FileSystem` interface (near `write` line 61 / `writeExclusive` line 77): `readonly writeStream: (path: string, source: AsyncIterable<Uint8Array>) => Promise<void>;` with a doc comment matching the `write` contract (parent-dir creation, overwrite, byte-for-byte). Keep `FileHandle` untouched.
- `src/adapters/node/node-file-system.ts` — implement beside `write` (line 419): `stream.pipeline(source, fs.createWriteStream(real))` inside `runFs`, `mkdir(dirname, { recursive: true })` first (same as `write`). Reuse `checkContainment(path, 'creation')`.
- `src/adapters/browser/browser-file-system.ts` — implement beside `write` (line 42): `resolveFileHandle(path, true)` → `createWritable()` → `for await (chunk) writable.write(chunk)` → `close()` (natively streaming; mirrors the existing `write` at line 44).
- `src/adapters/memory/memory-file-system.ts` — implement beside `write` (line 85): concat chunks into a buffer then store (no real bound; parity-only — acceptable, no disk).
- The port **contract test** (the shared adapter contract suite) — add `writeStream` cases: writes bytes, creates parent dirs, overwrites, round-trips byte-identical to `read`.

**Mutation-resistant patterns:** drive each adapter through the shared contract test (byte-equality round-trip via `read`); assert parent-dir creation on a nested path; assert overwrite of an existing file; feed a multi-chunk async source so a "first-chunk-only" mutant dies.

#### Slice 8 — internal write primitives: streaming siblings (ADR-391/393)

**Why:** the in-scope sites use two buffered entrypoints — `writeWorkingTreeFile` (sites B / C / D) and `writeWorkingTreeEntry` (site A). Both get a streaming sibling, built on one streaming `writeRegularFile`.

**Files:**
- `src/application/primitives/internal/write-working-tree-file.ts` — add three streaming siblings:
  - **`writeRegularFileStream(ctx, fullPath, source: AsyncIterable<Uint8Array>, mode?)`** — mirror of `writeRegularFile` (line 37). Current order: `rmIfExists` (line 43) → `ctx.fs.write` (line 44) → `chmod` (lines 45–50). Streaming version preserves the **exact same order** (W1/W2 faithfulness + symlink-safety): `rmIfExists(ctx, fullPath)` → `ctx.fs.writeStream(fullPath, source)` → `chmod`. Straight into the final path, no temp/rename (ADR-393). The `MODE_REGULAR_PERM`/`MODE_EXEC_PERM` chmod tail (lines 15–16) is preserved byte-for-byte.
  - **`writeWorkingTreeFileStream(ctx, path: FilePath, source)`** — mirror of `writeWorkingTreeFile` (line 53): `writeRegularFileStream(ctx, joinPath(ctx.layout.workDir, path), source)` (no mode → regular perm). For sites B / C / D.
  - **`writeWorkingTreeEntryStream(ctx, path: FilePath, source, mode: FileMode)`** — mirror of `writeWorkingTreeEntry` (line 69) mode dispatch: **symlink (120000)** stays buffered (`rmIfExists` + `ctx.fs.symlink(decode(content), …)` — the target must be decoded whole, ADR-391); **gitlink (160000)** stays buffered (`mkdir`, no content); **regular** modes → `writeRegularFileStream`. For site A. NB: the streaming variant takes a `source`, so callers needing the symlink/gitlink arms keep calling the buffered `writeWorkingTreeEntry` with a decoded buffer — the streaming entry is for the regular arm only (site A dispatches before the call; see Slice 9).

**Current signatures (to mirror):**
- `writeRegularFile(ctx, fullPath: string, content: Uint8Array, mode?: FileMode): Promise<void>` (line 37).
- `writeWorkingTreeFile(ctx, path: FilePath, content: Uint8Array): Promise<void>` (line 53).
- `writeWorkingTreeEntry(ctx, path: FilePath, content: Uint8Array, mode: FileMode): Promise<void>` (line 69).
- `rmIfExists(ctx, fullPath: string): Promise<void>` (line 23) — reused verbatim, it is the symlink-safe unlink.

**Fixtures/helpers:** `test/unit/application/primitives/internal/write-working-tree-file.test.ts` (extend); a small async-source helper that yields a `Uint8Array` in ≥2 chunks.

**Mutation-resistant patterns:** assert `rmIfExists` runs **before** the stream write (spy ordering — kills a reorder mutant that breaks symlink self-heal); assert `chmod` perm matches mode (executable vs regular vs none); separate tests proving `writeWorkingTreeEntryStream`'s symlink arm still buffers and the gitlink arm still `mkdir`s (a mutant routing them through the stream path must die); byte-equality of the written file (via `read`) vs the concatenated source; multi-chunk source so a "first-chunk-only" mutant dies.

#### Slice 9 — consumer A: stream the checkout materialisation (apply-changeset)

**Files:**
- `src/application/primitives/apply-changeset.ts` — `applyEntry` (line 154). Current non-gitlink arm (lines 166–171):
  ```ts
  if (entry.mode !== FILE_MODE.GITLINK) {
    const blob = await readBlob(ctx, entry.id as IndexEntry['id']);
    await writeWorkingTreeEntry(ctx, entry.path, blob.content, entry.mode);
  } else {
    await writeWorkingTreeEntry(ctx, entry.path, new Uint8Array(), entry.mode);
  }
  ```
  Convert: dispatch on mode inside the non-gitlink arm — for **regular** modes (not `SYMLINK`, not `GITLINK`), `const stream = await streamBlob(ctx, entry.id); await writeWorkingTreeEntryStream(ctx, entry.path, stream, entry.mode)`; for **symlink** keep the buffered `readBlob` + `writeWorkingTreeEntry` (target decoded whole, ADR-391). The gitlink arm (line 170) is unchanged. The `buildIndexEntry` lstat tail (line 172) and `CHECKOUT_OP` progress tick (lines 200–207) are unchanged.
- `src/application/primitives/apply-changeset.ts` imports — add `streamBlob` (alongside `readBlob`, line 31) and `writeWorkingTreeEntryStream` (alongside `rmIfExists, writeWorkingTreeEntry`, line 30).

**Current signatures:**
- `applyEntry(ctx, workdir: string, entry: ChangesetEntry): Promise<IndexEntry | undefined>` (line 154).
- `readBlob(ctx, id): Promise<Blob>` — kept for the symlink arm.

**Fixtures/helpers:** `test/unit/application/primitives/apply-changeset.test.ts` (extend) — existing changeset fixtures; spy `streamBlob` / `writeWorkingTreeEntryStream` / `writeWorkingTreeEntry`.

**Mutation-resistant patterns:** existing `apply-changeset` unit tests must still pass byte-for-byte; add a case proving a regular-file entry routes through `streamBlob` + `writeWorkingTreeEntryStream` (spy), and that symlink/gitlink entries still route through the buffered arm (spy) — a mutant collapsing the branch must die.

#### Slice 9b — consumers B + C: stream the merge clean-survivor writes (merge + apply-merge-to-worktree)

**Why:** ADR-392's load-bearing addition over the design's original single-hot-path rec. Both merge worktree-application paths write a whole clean-survivor blob.

**Files:**
- `src/application/commands/merge.ts` — `writeOutcomeToTree` (line 579), `unchanged`/`resolved-known` arm (lines 584–592). Current:
  ```ts
  if (outcome.status === 'unchanged' || outcome.status === 'resolved-known') {
    if (isExcluded(matcher, outcome.path)) return;
    const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
    await writeWorkingTreeFile(ctx, outcome.path, blob.content);
    return;
  }
  ```
  Convert to `const stream = await streamBlob(ctx, outcome.id); await writeWorkingTreeFileStream(ctx, outcome.path, stream);` — **no `maxBytes` argument** (ADR-394, drop the cap). The `isExcluded` sparse guard, the `resolved-merged` arm (line 596, synthesised bytes — **unchanged**, site E), and `resolved-deleted` (line 599) are untouched. Imports: add `streamBlob`, `writeWorkingTreeFileStream`; drop the now-unused `MAX_CONFLICT_OUTPUT_BYTES` import **only if** no other arm in the file still uses it (the excluded conflict-materialisation arms G keep it — see below, so the import likely stays). **Delete** the `Stryker disable next-line ObjectLiteral` comment on the old `{ maxBytes }` argument (`merge.ts:588`) and its two-line cap rationale (`merge.ts:586-587`) — the argument it annotated is gone, so the suppression must be removed, never carried forward or relocated. The *other* `Stryker disable`/cap comments in `merge.ts` (e.g. line 622, on the excluded conflict-survivor read in `materialiseConflictBytes`, site G) **stay** — those sites keep their cap.
- `src/application/primitives/apply-merge-to-worktree.ts` — `writeConflictWorktree` (line 153), `resolved-known` arm (lines 171–175). Current:
  ```ts
  if (outcome.status === 'resolved-known') {
    const blob = await readBlob(ctx, outcome.id, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
    await writeWorkingTreeFile(ctx, outcome.path, blob.content);
  }
  ```
  Convert to `const stream = await streamBlob(ctx, outcome.id); await writeWorkingTreeFileStream(ctx, outcome.path, stream);` — **no `maxBytes`** (ADR-394). The `resolved-merged` arm (line 167, synthesised, site F) and the conflict loop (lines 177–183, sites H/I) are **untouched**. Imports: add `streamBlob`, `writeWorkingTreeFileStream`; keep the `MAX_CONFLICT_OUTPUT_BYTES` import (the excluded conflict arms at lines 115/127 still use it). **Delete** the `Stryker disable next-line ObjectLiteral` comment on the old `{ maxBytes }` argument at the `resolved-known` site (`apply-merge-to-worktree.ts:172`) and its cap rationale — the argument is gone. The `Stryker disable`/cap comments at lines 115 and 127 (the excluded `materialiseConflictBytes` survivor reads, sites H/G family) **stay** — those sites keep their cap.

**Current signatures:**
- `writeOutcomeToTree(ctx, outcome: MergeOutcome, matcher: SparseMatcher | undefined): Promise<void>` (merge.ts:579).
- `writeConflictWorktree(ctx, outcomes, conflicts, changed: ReadonlySet<FilePath>): Promise<void>` (apply-merge-to-worktree.ts:153).
- `MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024` (`src/domain/merge/merge-types.ts:98`) — the reject ceiling B/C carry today; **dropped** on conversion (ADR-394). The constant itself stays for the excluded conflict-materialisation arms (G/H) that still pass it.

**Fixtures/helpers:** `test/unit/application/commands/merge.test.ts` (`writeOutcomeToTree` is exported "for direct unit testing"); `test/unit/application/primitives/apply-merge-to-worktree.test.ts`. Spy `streamBlob` / `writeWorkingTreeFileStream`.

**Mutation-resistant patterns:** assert the `resolved-known`/`unchanged` arm routes through `streamBlob` + `writeWorkingTreeFileStream` (spy); assert `resolved-merged` still routes through the buffered `writeWorkingTreeFile` with synthesised `outcome.bytes` (a mutant streaming it must die — there is no blob id to stream); assert the sparse `isExcluded` guard still short-circuits before the stream open; byte-equality of the written survivor vs `readBlob(outcome.id).content`. **No oversize-rejection test on B/C** — the cap is dropped (ADR-394); a test asserting `OBJECT_TOO_LARGE` on a clean-survivor write would now be wrong and must not be added. (Verified: no such test exists on these paths today — see Slice 9c's existing-test note.)

#### Slice 9c — consumer D: stream the stash untracked restore (stash)

**Why:** the third whole-blob working-tree write; ADR-392 includes it. WC-5 is decided (ADR-394): the 256 MiB reject ceiling it passes today is **dropped** — site D converts unconditionally, exactly like A/B/C, with no cap argument. No longer gated on any open candidate.

**Files:**
- `src/application/commands/stash.ts` — `restoreUntracked` (line 373), loop body (lines 375–382). Current:
  ```ts
  for (const [path, entry] of flat.entries) {
    const blob = await readBlob(ctx, entry.id, { maxBytes: MAX_WORKING_TREE_BLOB_BYTES });
    await writeWorkingTreeFile(ctx, path, blob.content);
  }
  ```
  Convert to (ADR-394, no cap):
  ```ts
  for (const [path, entry] of flat.entries) {
    const stream = await streamBlob(ctx, entry.id);
    await writeWorkingTreeFileStream(ctx, path, stream);
  }
  ```
  Imports: add `streamBlob` and `writeWorkingTreeFileStream`; **drop** the `MAX_WORKING_TREE_BLOB_BYTES` import **iff** no other site in `stash.ts` still uses it (grep — `restoreUntracked` is the only consumer of it in this file today, so the import goes). **Delete** the `Stryker disable next-line ObjectLiteral` comment on the old `{ maxBytes }` argument (`stash.ts:379`) and its cap rationale — the argument it annotated is gone, so the suppression must be removed, not carried forward.

- **Existing-test behaviour change (load-bearing — verified empirically, the planner must see this).** Two facts established by grepping `test/`:
  1. **There is NO existing oversize-rejection test on `restoreUntracked`** (nor on B/C). `test/unit/application/commands/stash.test.ts` exercises `restoreUntracked` only with small untracked files; its rejection tests are `NO_INITIAL_COMMIT` / `STASH_NOT_FOUND` / out-of-range — none assert `OBJECT_TOO_LARGE`. The Pass-5 draft of this slice claimed "the existing oversize-cap test for `restoreUntracked` must still pass"; **that test does not exist** — there is nothing to remove or keep on this path. The same holds for B/C in `merge.test.ts` / `apply-merge-to-worktree.test.ts` (no `OBJECT_TOO_LARGE` assertion on the clean-survivor write).
  2. The `OBJECT_TOO_LARGE` coverage that *does* exist lives on the **cap mechanism** (`object-resolver.test.ts`, `read-blob.test.ts`, `read-object.test.ts`, `read-file-at.test.ts`, `cat-file*.test.ts`, `repository.test.ts`, `walk-submodules.test.ts`) and on **`add --all`** (`add.test.ts`, `WORKING_TREE_FILE_TOO_LARGE`) — all of which **keep their cap** and are **untouched** by this slice. The `MAX_CONFLICT_OUTPUT_BYTES` tests in `three-way-tree.test.ts` assert `INVALID_MERGE_INPUT` against the **content merger** (synthesised bytes, excluded sites E/F/G) — also untouched.
  - **Net for the planner:** dropping the cap on D requires **no test removal or rewrite on the stash path** — there is no oversize regression guard to delete. The implementer must **not** add an `OBJECT_TOO_LARGE` test for `restoreUntracked` (such a test would now be wrong). The behaviour change is real but latent: an oversize untracked stash blob that *would have* thrown `OBJECT_TOO_LARGE` now **restores successfully** (uncapped), matching git's `stash apply`. The slice ships a positive test that a large untracked blob restores rather than throwing (paired byte-equality), making the dropped ceiling observable in coverage.

**Current signatures:**
- `restoreUntracked(ctx: Context, uTree: ObjectId): Promise<void>` (stash.ts:373), called at stash.ts:459 on the clean-apply path.
- `MAX_WORKING_TREE_BLOB_BYTES = 256 * 1024 * 1024` (`src/application/primitives/types.ts:42`) — **stays defined** (still used by `add --all`'s read-side guard, ADR-032); `restoreUntracked` simply stops passing it.

**Fixtures/helpers:** `test/unit/application/commands/stash.test.ts` — the existing untracked-restore cases (extend; **no** oversize-cap case exists to update).

**Mutation-resistant patterns:** assert the restore routes through `streamBlob` + `writeWorkingTreeFileStream` (spy); byte-equality of a restored untracked file vs source; **no `OBJECT_TOO_LARGE` assertion** (the cap is gone). A positive "uncapped restore succeeds" case pins the drop (a mutant re-introducing a `maxBytes` argument would not be caught by byte-equality alone, so spy the `streamBlob` call args and assert it is invoked with no `maxBytes` / `{ verifyHash }`-only options).

#### Slice 10 — interop tests: streamed writes are byte-identical to git (W1/W2/W3)

**Files:**
- `test/integration/blob-streaming-checkout-interop.test.ts` (new). Model on `test/integration/checkout-replace-symlink-with-file-interop.test.ts` (existing checkout interop with symlink self-heal) and the twin-repo helpers (`makePeerPair`/`initBothRepos`/`runGitEnv`).

**Fixtures:**

| # | Site | Setup | Test | Asserts |
|---|---|---|---|---|
| **C1** | A | peer commits a 200 KB regular-file blob on a branch; checkout that branch via tsgit into ours | working-tree file bytes | byte-identical to the peer's checked-out file (and `catFileRaw(peer, id)`) |
| **C2** | A | same, executable mode (100755) | working-tree file + perms | byte-identical content; mode 0755 (chmod tail preserved) |
| **C3** | A | a path that is a **symlink** in the source tree, then a branch where it becomes a regular file; checkout across the kind change | working-tree state | regular file, no stale symlink (`rmIfExists`-before-stream self-heal — pins the W1 replace + symlink-safety order) |
| **C4** | A | checkout a tree with a regular file whose blob is **deltified** in the pack (`materialised: true` upstream) | working-tree file bytes | byte-identical (the write consumer is agnostic to the read stream's materialisation) |
| **C5** | B/C | peer + ours diverge so a 200 KB blob is a **clean survivor** of a three-way merge (changed on one side only); run the merge via tsgit | working-tree file bytes for the survivor path | byte-identical to git's merged working-tree file (`git merge` on the peer). Covers the `merge` command path (B); a cherry-pick variant covers the shared `apply-merge-to-worktree` path (C) |
| **C6** | D | peer creates a stash with a 200 KB **untracked** file; `stash apply` via tsgit | restored untracked file bytes | byte-identical to git's `stash apply` result (site D converts unconditionally — cap dropped, ADR-394). |

**Discipline:** scrubbed-env git helpers; isolate the spawned-git `GIT_*` env (the env-pollution gotcha — never inherit `GIT_DIR`); for any conflict-adjacent merge fixture pin the peer `-c merge.conflictStyle=merge`. Pins requirement 7 and W1/W2 (faithful replace semantics) per ADR-249 — reconstruct git's working-tree output and compare; the library emits no display string.

## Test strategy

- **Unit** (Slices 5, 7, 8, 9, 9b, 9c): routing + header-strip + verification + write-dispatch + per-consumer-branch logic across all four sites (A/B/C/D), mutation-resistant per project conventions. Byte-equality against `readBlob` (read) and against the streamed source (write) is the oracle — independently-tested siblings, not re-implementations, so no tautology. Each consumer slice spies the streaming routing **and** proves the excluded sibling arms (synthesised `resolved-merged` bytes; symlink/gitlink; conflict markers) stay buffered — a mutant collapsing a branch must die.
- **Interop** (Slices 6, 10): byte-identity to real `git cat-file -p` (read) and to real `git`'s working-tree output for checkout (C1–C4), merge clean survivor (C5), and stash-apply untracked restore (C6) (write). The write side is the only **new** faithfulness surface this PR adds (W1/W2 pinned); the read side restates 24.10's obligation on the streaming surface.
- **Parity** (cross-adapter): if the browser-surface audit covers primitives, a `streamBlob` scenario proves memory-adapter byte-equality. The streaming-write adapter implementations are covered by the port contract test across all three adapters. Cross-adapter parity does NOT prove faithfulness (only interop does) — both run.
- **Property-based — evaluated against the four lenses, result: skip** (read and write). `streamBlob` is a one-way decode whose oracle is the already-tested `readBlob` (not a parse/serialize round-trip, matcher, total-function-over-grammar, or counting invariant); generating valid packed/deltified blobs requires driving the production write path (the oracle would re-implement it). `writeStream` is an I/O port wrapper — belongs in the contract/interop tier, not property tests (per CLAUDE.md "I/O wrappers … belong in integration/parity tests"). Noted here rather than shipping a tautological property.
- **Edge matrix:** empty blob (zero content bytes); blob whose content is exactly one chunk; header NUL on a chunk boundary; deltified blob; wrong-type id; aborted signal; executable-mode write (perm tail); symlink→file kind change on checkout (write-side self-heal); the largest test size that still runs fast (~200 KB inflated).

## Out of scope

- **Excluded working-tree write sites (per the ADR-392 exclusion criterion — synthesised or non-blob content).** Enumerated in the authoritative in-scope table; restated here so the boundary is explicit:
  - **Synthesised merged bytes** — `merge.ts:596` (site E) and `apply-merge-to-worktree.ts:166-167` (site F), both `resolved-merged` writing `outcome.bytes` computed in memory by the content merger. No blob id / stream to consume.
  - **Conflict-bytes materialisation** — `merge.ts:605-619` (site G, `writeConflictToTree`/`materialiseConflictBytes`) and `apply-merge-to-worktree.ts:106-149` (site H, `writeMarkedConflict`/`conflictBytes`). Their unified return may be synthesised `<<<<<<<` marker content (`conflictContent`); the buffer call site cannot stream what may be synthesised, and splitting the whole-blob arms (binary/type-change/modify-delete) out would fragment one tight conflict helper — ADR-392's "don't force-fit" guard. Excluded as conflict materialisation.
  - **Distinct-types conflict sides** — `write-distinct-types-sides.ts:19-25` (site I). Although each side is a whole blob, it is mode-dispatched (a side may be a symlink, which stays buffered, ADR-391) and is part of the conflict-write family ADR-392 names; converting only its regular arm would fragment one tight helper. Excluded as conflict materialisation.
  - **Symlink / gitlink modes everywhere** — the target string is decoded whole / there is no content (ADR-391).
- **Removing the cap constants `MAX_WORKING_TREE_BLOB_BYTES` / `MAX_CONFLICT_OUTPUT_BYTES`.** ADR-394 drops the cap **only at the B/C/D call sites** (they stop passing `maxBytes`); the constants themselves **remain defined and in use** — `MAX_WORKING_TREE_BLOB_BYTES` by `add --all`'s read-side guard (ADR-032, `WORKING_TREE_FILE_TOO_LARGE`) and `MAX_CONFLICT_OUTPUT_BYTES` by the excluded conflict-materialisation sites E–I and the `mergeTrees` content-merger oversize check (`INVALID_MERGE_INPUT`). Deleting either constant is **out of scope** and would break those still-capped consumers. The cap *mechanism* in `object-resolver.ts` (`enforcePackBaseCap` / `enforceLooseCap` / `enforcePackDeltaPreApplyCap` and their `Stryker disable` annotations) is likewise untouched — it still serves every `readObject({ maxBytes })` caller.
- **Read consumers that are not working-tree writes** (the `readBlob` calls the sweep deliberately leaves alone): `snapshot/index-entry.ts:25` & `snapshot/tree-entry.ts:27` (lazy *read* accessors); `blame.ts:318,368` (in-memory line authorship); `materialise-patch-files.ts`, `detect-similarity-renames.ts`, `build-content-merger.ts`, `walk-submodules.ts:114` (in-memory diff/merge/`.gitmodules` inputs, capped, never written to the working tree). **`read-file-at.ts:51`** is a *read* consumer that could itself stream to a sink via `streamBlob` — noted as a read-API extension, but it is **out of this feature's write scope** (no working-tree write to convert).
- **`materializeFile` dead-code removal** (`src/application/commands/internal/working-tree.ts:36`). Grep-confirmed zero production callers (only its own definition + `test/unit/application/commands/internal/working-tree.test.ts`). It is *not* a consumer (the consumers are A/B/C/D above), so this feature does not touch it. Removing it (and its test) is a **refactor-phase dead-code candidate**, not scope-crept into this feature — flagged here so it is not silently left rotting.
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

### Pass 5 — ADR-390–393 ratification revision (this revision)

Triggered by the write-side ADR conversation: WC-1, WC-2, WC-4 ratified as recommended; **WC-3 was broadened — the user chose the comprehensive sweep (ADR-392), not the design's single-shared-primitive recommendation.** Re-sliced the write side against an authoritative, empirically-verified in-scope site list.

- **Authoritative in-scope table built from a full grep, not the brief's pre-enumeration.** Verified every `readBlob → writeWorkingTree*` site in `src/`. The brief's line numbers were slightly off: the merge **whole-blob clean-survivor** writes are `apply-merge-to-worktree.ts:171-174` (`resolved-known`, site C) and `merge.ts:584-590` (`unchanged`/`resolved-known`, site B) — *not* the `:167`/`:149` lines, which are the synthesised `resolved-merged` writes (sites E/F, excluded). Classified nine write sites convert/exclude with code-grounded reasons.
- **Both merge paths confirmed live and parallel.** `merge.ts:writeOutcomeToTree` (the `merge` command, caller line 532) and `apply-merge-to-worktree.ts:applyMergeToWorktree` (shared cherry-pick/revert/rebase/stash-apply, callers in `cherry-pick.ts`/`revert.ts`/`stash.ts`) — neither supersedes the other; both clean-survivor loops convert (B and C).
- **Cap semantics grounded.** Grepped both constants: `MAX_WORKING_TREE_BLOB_BYTES` and `MAX_CONFLICT_OUTPUT_BYTES` are **both 256 MiB reject-if-larger ceilings** (`objectTooLarge`/`OBJECT_TOO_LARGE`), not truncation markers. Reconciled this with ADR-392's "length-capped content" exclusion: that means *synthesised content bounded as content* (conflict markers), not "a whole-blob read with a reject ceiling" — so whole-blob-with-ceiling sites (B/C/D) convert, and the dropped ceiling is precisely the WC-5 wrinkle.
- **WC-5 surfaced (the new open candidate).** `streamBlob` (ADR-383/389) carries only `{ verifyHash }` — no `maxBytes`. Converting stash's `restoreUntracked` (site D, capped 256 MiB) drops the ceiling. Verified the buffered ceiling is a **pre-materialisation declared-size check** (`enforcePackBaseCap`/`enforceLooseCap`/`enforcePackDeltaPreApplyCap`, `object-resolver.ts:62-138`) — so adding `maxBytes` to `streamBlob` is cheap parity, not a new mechanism. Three options (add to `streamBlob` / pre-stream guard at the call site / exclude D), recommended (a), left open for the ADR round. Sites B/C carry the same ceiling, so the WC-5 answer governs them too.
- **Re-sliced the write side.** Slice 8 now builds three streaming primitives (`writeRegularFileStream`, `writeWorkingTreeFileStream`, `writeWorkingTreeEntryStream`) because the in-scope sites use two buffered entrypoints. Consumer conversion split into Slice 9 (site A, checkout), Slice 9b (sites B+C, merge clean survivors), Slice 9c (site D, stash — gated on WC-5). Slice 10 interop extended with C5 (merge clean survivor) and C6 (stash restore). Each carries a pre-chewed context block (file, line, current snippet, signature, fixture).
- **Convergence:** re-read requirement 6/7 ↔ write-side design ↔ in-scope table ↔ Decision candidates ↔ Slices 7–10 ↔ Out of scope. Every converted site (A/B/C/D) appears in exactly one slice; every excluded site (E/F/G/H/I + read-not-write set) is in the table and Out of scope with the same reason; the only open candidate is WC-5; WC-1..WC-4 are stated as accepted (ADRs 390–393) with no lingering "decision candidate" framing. Converged.

### Pass 6 — WC-5 ratification (ADR-394, drop the cap) re-thread

Triggered by the WC-5 ADR conversation. The user chose an option **beyond** the three this doc enumerated: not (a) add `maxBytes` to `streamBlob`, not (b) a call-site size guard, not (c) exclude D — but **drop the 256 MiB cap on B/C/D entirely**, making them uncapped like site A and like canonical git (ADR-394). `streamBlob` is therefore **unchanged** (its ratified `{ verifyHash }` surface stays; no `maxBytes` is ever added); sites B/C/D simply stop passing `maxBytes: MAX_*` on conversion, and site D is no longer gated.

- **Decision candidates re-threaded.** WC-5 moved from the open table to a decided paragraph citing ADR-394. The closing line now states explicitly that **no open decision candidates remain** (read-side 383–389, write-side 390–393, WC-5 394 all decided). The status header records Pass 6 and the same "no open candidates" fact.
- **In-scope table B/C/D.** Removed the "256 MiB ceiling" cap column entries and the `convert*`/"gated on WC-5" footnotes; B/C/D are plain **convert**, cap "none (dropped, ADR-394)". E–I stay excluded unchanged. The cap-semantics paragraph above the table now says the ceiling is dropped on conversion, with the constants surviving for the still-capped consumers.
- **Data-flow + slice sketches de-capped.** Removed every `/* WC-5 cap */`, `{ maxBytes: MAX_* }`, and "ceiling must be preserved"/"WC-5 governs the cap" comment from the B/C/D conversion sketches — they call `streamBlob(id)` (verifyHash default) with no cap. Recorded that the `Stryker disable next-line ObjectLiteral` cap-suppression comments on the old `{ maxBytes }` arguments (`merge.ts:588`, `apply-merge-to-worktree.ts:172`, `stash.ts:379`) are **deleted, not relocated** — the argument they annotated is gone; the suppressions on the *excluded* conflict-survivor reads (which keep their cap) stay.
- **Slices 9b/9c un-gated and corrected for the test-behaviour change.** 9c is no longer "GATED ON WC-5"; both 9b and 9c drop the `maxBytes` argument. **The load-bearing empirical correction:** the Pass-5 draft asserted "the existing oversize-cap test for `restoreUntracked` must still pass" — I grepped `test/` and found **no such test exists** (stash's rejection tests are `NO_INITIAL_COMMIT`/`STASH_NOT_FOUND`/out-of-range; neither merge.test.ts nor apply-merge-to-worktree.test.ts asserts `OBJECT_TOO_LARGE` on a clean-survivor write). So dropping the cap on B/C/D requires **no test removal or rewrite on those consumer paths** — there is no oversize regression guard to delete. The `OBJECT_TOO_LARGE`/`WORKING_TREE_FILE_TOO_LARGE` tests that *do* exist (object-resolver, read-blob, read-object, read-file-at, cat-file*, repository, walk-submodules, add; and the `INVALID_MERGE_INPUT` content-merger tests in three-way-tree) all sit on cap consumers that **keep** their cap and are untouched. Stated in 9c so the planner does not hunt a phantom test, and flagged that the implementer must **not** add an `OBJECT_TOO_LARGE` test for the de-capped sites; the behaviour change (an oversize untracked stash blob now restores rather than throwing) gets a positive coverage case instead.
- **Faithfulness note added.** Recorded that dropping the cap **removes a tsgit-only divergence** (git imposes no working-tree file-size limit; merge/stash now match checkout and git), a faithfulness improvement; the residual deltified-blob OOM edge is the same one site A already carries, now shared, not newly introduced.
- **Out of scope.** Added an explicit bullet: the cap constants and the `object-resolver` cap mechanism **remain** (used by `add --all`/ADR-032 and the excluded E–I sites); only B/C/D stop passing them — deleting the constants is out of scope.
- **Convergence:** re-grepped my own doc for `WC-5`, `maxBytes`, `256 MiB`, `ceiling`, `gated`, `MAX_WORKING_TREE_BLOB_BYTES`, `MAX_CONFLICT_OUTPUT_BYTES`, `Stryker` — every hit now reflects drop-cap (WC-5 framed as decided; `maxBytes` only on the unchanged read-side cap mechanism and the *historic* current-code snippets; `256 MiB`/`ceiling` only as "dropped"/"stays for E–I & add"; no "gated"; the constants framed as remaining; the B/C/D Stryker suppressions framed as deleted). No contradiction remains. Converged.
