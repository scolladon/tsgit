# Design — whitespace drop-pass fast path

> Brief: the residual `ignoreWhitespace` slowness is **many small modified pairs**, and
> the cost is **not** scanning — it is the per-blob WHATWG stream + `createInflate`
> pipeline the drop-pass predicate builds twice per pair. Reproduced locally
> (2,500 pairs of ~56-byte Java classes): **258–271 ms warm** against a **6.4–7.1 ms**
> plain recursive diff of the same trees and **111–113 ms** for the same 5,000 blobs
> read buffered through `readBlob`. A CPU profile attributes only **~2.8 %** to tsgit's
> own scanning frames; **16.4 %** is web-streams machinery, **6.2 %** `node:zlib`
> instance/async churn, and **4.4 %** is `NodeError` construction — all of which the
> profile traces to a single line. Replace the streaming pipeline with a buffered
> read + a synchronous line-digest scan below a size gate; keep streaming above it.
> Status: draft → self-reviewed ×3 → **decisions open**. All nine candidates (DC-1 … DC-9)
> are the user's to settle; DC-1, DC-2, DC-3, DC-7 and DC-8 additionally move a documented
> invariant (ADR-385, the memory posture, the prime directive, an adapter contract) and are
> tagged **USER DECISION** in the table.

## Context

### Subsystems this touches

| Part | File / symbol | Tier |
|------|---------------|------|
| P1 | **new** `src/domain/diff/line-digest-scanner.ts` → the synchronous chunk-fed line/digest state machine (today's `LineSourceState`, `concatBytes`, `scanForNul`, `trackLineCaps`, `takeLine`, `nextLine`, `nextSignificantDigest` lifted out of the application layer) | domain |
| P2 | **new** internal blob-source seam (working name `src/application/primitives/internal/blob-source.ts`) → `openBlobSource(ctx, id, maxBufferedBytes)` returning `{ kind: 'bytes' } \| { kind: 'stream' }`; `src/application/primitives/stream-blob.ts` → `streamBlob` re-expressed over it, public contract unchanged | primitive |
| P3 | `src/application/primitives/internal/whitespace-drop-predicate.ts` → `isWhitespaceOnlyModify(ctx, change: ModifyChange, lineKey: LineKey, ignoreBlankLines: boolean): Promise<boolean>` — two arms (sync buffered / async streamed) over the P1 scanner | primitive |
| P4 | `src/adapters/browser/browser-compressor.ts`, `src/adapters/memory/memory-compressor.ts` → `inflate` (optional, DC-8) | adapter |
| P5 | `test/bench/diff-whitespace.bench.ts` (+ a new many-small-modified-pairs fixture) — the current bench does not reach the code being changed (§Pin D-3) | bench |

Everything here is a **read path**. `diff-trees.ts` needs no change for batching: the
drop pass is *already* `boundedMap(diff.changes, MAX_CONCURRENT_OBJECT_LOADS = 32, …)`
(§Pin D-1).

### Prior decisions that constrain this design

| ADR | What it binds | How this design stands to it |
|---|---|---|
| **ADR-383** | `streamBlob` is a sibling of `readBlob`; size-tiered auto-escalation *inside `readBlob`* was rejected | respected — `readBlob` untouched |
| **ADR-385** | "`streamBlob` always streams. No streaming decision is ever keyed off … any size threshold." Its closing note: *"If escalation is ever wanted, it lives inside `streamBlob`, not in `readBlob`."* | **the load-bearing tension.** DC-1 chooses between a shared seam below `streamBlob` (contract intact) and superseding ADR-385 |
| **ADR-386** | a deltified blob is reconstructed **in full** then streamed, `materialised: true` | exploited — that arm is already a buffer; the gate is a no-op there |
| **ADR-387** | streaming inflate reuses `Compressor.createInflateStream` as-is; no port change | respected — and the profile shows this is the exact cost centre for small blobs |
| **ADR-388** | the loose arm reads the **whole compressed file** (`ctx.fs.read`) before inflating | exploited — on the loose arm the compressed length is known *for free*, so the gate costs no extra I/O |
| **ADR-392** | no full-blob **working-tree materialisation** is left buffered | not in scope: this is a read-and-scan, not a worktree write. The memory posture for genuinely large blobs is preserved by the gate (DC-3) |
| **ADR-513** | the drop-pass predicate streams both blobs and folds a per-line rolling digest; the `withStat` path interns lines for Myers; the two verdicts must stay provably consistent | preserved — the digest primitives are untouched; only the *transport* changes |
| **ADR-249** | structured data, no rendered output | unaffected |
| **ADR-226** | git-faithfulness prime directive | this change must not move any verdict (§Requirements 1); §Pin C records two *pre-existing* divergences it uncovered |

`docs/design/raw-tree-cursor-diff.md` §Out of scope already names this work: *"The
whitespace-mode per-modify-pair stream setup. A separate lever; re-profile after this
lands."* This is that re-profile.

### Current code shape (the tax being removed)

Per **modify** change, `changeShouldDrop` → `isWhitespaceOnlyModify` builds two
independent pipelines:

```
streamBlob(ctx, id)
  └─ looseCompressedBytes → ctx.fs.read(whole compressed file)      [ADR-388]
     └─ inflateOneShot: new ReadableStream (1 enqueue + close)
        └─ .pipeThrough(ctx.compressor.createInflateStream())        [ADR-387]
           └─ NodeCompressor: new createInflate()  → Zlib instance
              → 'data' → controller.enqueue         (async processChunk)
              → 'end'  → controller.terminate()     ← the NodeError site
        └─ readableStreamToAsyncIterable(readable)  → getReader()
     └─ yieldAndVerifyChunks (async generator, hash verify, stripHeader)
```

and drives them through `nextSignificantDigest` with a **`Promise.all` per line pair**.
For a ~56-byte blob the scaffolding above dwarfs the ~3 lines of content.

`streamBlob` also **never consults `ctx.deltaCache`** — `resolveObjectBytes` checks it
first, `streamBlob` goes straight to the loose probe. On a packed repo that costs the
predicate a full pack re-resolve on every call (§Pin B).

## Empirically pinned matrices

All measurements on this host (darwin 25.5.0, Node v22.22.3, git 2.55.0), against a
scratch repo of **2,500 files** of the shape `package a;\npublic class C<i> {\n  int f<i> = <i>;\n}\n`
(**~56 bytes** each — 278 340 bytes over 5 000 blobs, measured) in 50 directories,
committed twice — the second commit a **whitespace-only** rewrite.
Repro scripts under the session scratchpad; the fixture builder is reproduced verbatim
in §Test strategy as the new bench fixture.

### Pin A — where the time goes (`node --cpu-prof` over `dist-profile/`, 5 iterations, 1 458.7 ms sampled)

| share | self-time | frame |
|---|---|---|
| 6.90 % + 6.54 % + 2.93 % | 100.6 + 95.4 + 42.7 ms | Node's three web-streams implementation modules (`ReadableStream`, `WritableStream`, `TransformStream`) — **16.4 % web-streams machinery** |
| 6.18 % | 90.2 ms | `node:zlib` (`processChunk` 3.40 %, `Zlib` ctor 0.95 %, `Inflate` 0.60 %, `processChunkSync` 0.43 %) |
| **4.39 %** | **64.1 ms** | **`NodeError`** |
| 3.73 % | 54.4 ms | `runMicrotasks` |
| 3.22 % | 47.0 ms | garbage collector |
| 2.76 % + 1.21 % + 0.88 % | 40.2 + 17.6 + 12.8 ms | `realpath` (native) + `realpath@promises` + `isContainedInAnyRoot` — the loose-read containment gate, paid by **both** designs |
| **2.83 %** | **41.3 ms** | **the actual scan**: `isWhitespaceOnlyModify` 1.13 % + `nextLine` 0.67 % + `nextSignificantDigest` 0.52 % + `takeLine` 0.51 % |

**Every one of the 64.1 ms of `NodeError` self-time has a single call chain:**

```
NodeError ← transformStreamDefaultControllerTerminate ← terminate
          ← <NodeCompressor.createInflateStream 'end' handler>
          ← emit ← endReadableNT ← processTicksAndRejections
```

That is `controller?.terminate()` inside `inflate.on('end', …)` — the **normal, successful
completion** of every inflate stream. WHATWG `terminate()` constructs an `ERR_INVALID_STATE`
`TypeError` to error the writable side (`transformStreamErrorWritableAndUnblockWrite`), and
each construction captures a stack. A secondary ~10 ms comes from
`writableStreamDefaultWriterEnsureReadyPromiseRejected` / `…EnsureClosedPromiseRejected`
via `writableStreamDefaultWriterRelease ← finalize` — also the normal pipe-completion path.

### Pin B — the ceiling the buffered path already reaches

| repo shape | today's `diff -w` (warm) | plain recursive diff | `readBlob` × 5 000 | native `git diff-tree -r -w` |
|---|---|---|---|---|
| **loose** (as committed) | 258 / 271 ms *(cold 365)* | 6.4–7.1 ms | 111–113 ms → **22.3–22.6 µs/blob** | 160 ms *(incl. process start)* |
| **packed** (`git repack -ad`) | 165 / 176 ms *(cold 272)* | 2.9–3.2 ms | 87.6 ms cold → **6.9–7.0 ms warm (1.4 µs/blob)** | 77 ms |

The packed warm number is `ctx.deltaCache`: `resolvePackChain` caches the reconstructed
loose-format buffer, so the *second* pass over the same 5,000 ids costs 1.4 µs each. The
streaming predicate cannot reach that cache at all.

**Projection** (reads + the untouched tree walk + a synchronous scan over 278 kB total):
loose ≈ **120 ms** (from 258 ms, native 160 ms); packed ≈ **91 ms cold / ~10 ms warm**
(from 165 ms, native 77 ms). It is anchored on Pin B's measured read cost, **not** on
subtracting Pin A's shares — those shares are computed over a sampled total that also
carries `(program)`, `(idle)` and module compilation, so they are a lower bound on the
removable fraction and the two estimates are not meant to reconcile arithmetically.
Labelled a projection, not a result — §Test strategy names the go/no-go measurement.

### Pin C — git 2.55.0 whitespace-drop edge matrix, and two live tsgit divergences

Pinned in a `mktemp -d` throwaway (isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
scrubbed, `commit.gpgsign=false`), tree-to-tree via
`git diff-tree --no-ext-diff -r <flag> --name-only HEAD~1 HEAD`; tsgit via
`repo.diff({ from:'HEAD~1', to:'HEAD', recursive:true, … })` on the same repo
(`3.1.2`, node adapter). **Shown = survives the diff.**

| # | file | change | git plain | git `-w` | tsgit `'all'` | git `--ignore-space-at-eol` | tsgit `'at-eol'` |
|---|---|---|---|---|---|---|---|
| C1 | `no-newline.txt` | ws-only, **last line unterminated** (`a b\nc d` → `a   b\nc    d`) | shown | dropped | **dropped** ✓ | shown | shown ✓ |
| C2 | `binary.txt` | ws-only inside a **NUL-bearing** file | shown | shown (`-  -` numstat) | **shown** ✓ | shown | shown ✓ |
| C3 | `blank.txt` | blank-line-only insertion | shown | shown (`2 0`) | **shown** ✓ | shown | shown ✓ |
| C4 | `eof-newline.txt` | **gains a trailing LF only** (`x y` → `x y\n`) | shown | **dropped** | **shown** ✗ | **dropped** | **shown** ✗ |
| C5 | `long-line.txt` | ws-only on a **70 000-byte line** | shown | **dropped** | **shown** ✗ | **dropped** | **shown** ✗ |

`--ignore-blank-lines --name-only` keeps all five on both tools (the existing "BL1"
finding in `diff-whitespace-modes-interop.test.ts`).

**C1–C3 agree. C4 and C5 are pre-existing prime-directive divergences this pinning
exercise uncovered — neither is caused by, nor fixed by, the perf work.**

- **C4** — `LineDigest.terminated` is compared by `digestsEqual`, so gaining a trailing LF
  is a significant change for tsgit. git treats it as whitespace at end-of-line under both
  `-w` and `--ignore-space-at-eol`. Affects the `withStat` path identically
  (`normalizeLine` preserves the LF, `bytesEqual` sees it).
- **C5** — tsgit's `MAX_LINE_BYTES = 65 536` marks the side binary, and a binary side is
  never dropped. git's text/binary heuristic is NUL-in-the-first-8000-bytes only; it has
  no line-length cap here.

DC-7 decides what happens to them.

### Pin D — premises of the brief checked against the code

| # | brief premise | verdict |
|---|---|---|
| D-1 | *"the drop-pass over N modified pairs is … sequential awaiting; run it through the existing `BoundedReader`"* | **FALSE.** `applyDropPredicate` already runs `boundedMap(diff.changes, MAX_CONCURRENT_OBJECT_LOADS = 32, …)`; within a pair both `streamBlob` calls and both per-line digests are already `Promise.all`. `createBoundedReader` (`internal/bounded-reader.ts`) is a *per-id-deduped* semaphore used by commit walks — it is not the drop pass's mechanism and dedup is worthless here (every id appears once). |
| D-2 | *"the early-exit/teardown path (stream abort / premature-close) … manufactures NodeErrors"* | **FALSE.** There is no abort/destroy anywhere on this path; the predicate abandons its iterators silently. Measured: a content-change workload (predicate exits after the *first* line pair, both streams abandoned) costs **259–268 ms** — indistinguishable from the fully-drained whitespace-only workload (258–271 ms). Pin A traces 100 % of `NodeError` self-time to `controller.terminate()` on the **success** path. "Early exit without exceptions" is a **no-op fix**. A `return()`-on-the-iterator hygiene fix is still worth landing (it releases the reader and the `createInflate` instance instead of leaking them until GC) — as *resource* hygiene, not as a perf lever. |
| D-3 | implicit: `test/bench/diff-whitespace.bench.ts` measures this | **FALSE.** `MEDIUM_FIXTURE` uses the `multi` strategy — every commit writes 4 *new* paths (`d{i/512}/f{i}.dat`). `HEAD~1..HEAD` recursive therefore yields 4 **add** changes, and `changeShouldDrop` returns at `change.type !== 'modify'` **before** `isWhitespaceOnlyModify` is ever called. The existing bench never executes the code this design changes. |
| D-4 | *"whether the `Compressor` port can express a sync inflate at all"* | **No port change is forced.** The port already has `inflate(data): Promise<Uint8Array>`, and `NodeCompressor.inflate` **is** `inflateSync` — the Promise is pre-resolved, no thread-pool hop, no `Zlib` instance churn. The cost the brief attributes to zlib comes entirely from the *other* verb, `createInflateStream()` → `createInflate()`. The fast path simply stops calling it. |
| D-5 | implicit: the win is adapter-neutral | **FALSE.** `BrowserCompressor.inflate` builds `Blob → DecompressionStream → Response`; `MemoryCompressor.inflate` builds a `DecompressionStream` per call. On those adapters buffered inflate is **not** cheaper than streaming inflate, so the fast path is (at best) a wash there. Both, however, already ship a **synchronous zero-dependency whole-member decoder** — `inflateZlibMember` in `src/adapters/inflate.ts`, used by their `streamInflate`. DC-8. |
| D-6 | *"already materialized in the delta cache"* | **Correct, and stronger than stated.** `streamBlob` never reads `ctx.deltaCache`; `resolveObjectBytes` checks it first. Routing through the buffered path both *hits* and *populates* it (Pin B: 87.6 ms → 6.9 ms). |

## Requirements

1. **Verdict identity.** For every `(oldBytes, newBytes, lineKey, ignoreBlankLines)`,
   the buffered arm and the streaming arm return the **same** boolean as today's
   implementation — including the binary rules (NUL in the first `BINARY_DETECTION_BYTES`
   of the *concatenated* stream, `MAX_LINE_BYTES`, `MAX_LINES`), the unterminated-final-line
   case, and `ignoreBlankLines` skipping. Pin C's C4/C5 divergences are reproduced
   **exactly as they are today** unless DC-7 says otherwise.
2. **Error identity.** A missing object, a non-blob oid, a hash mismatch and an aborted
   `ctx.signal` raise the *same* structured error (`OBJECT_NOT_FOUND`,
   `UNEXPECTED_OBJECT_TYPE`, `OBJECT_HASH_MISMATCH`, `OPERATION_ABORTED`) from **both**
   arms, with the same `.data`.
3. **Bounded peak memory above the gate — stated honestly.** A blob whose *gated* size
   exceeds the threshold is still streamed. Under DC-2 option A the gated quantity is the
   **compressed** size, so a sub-threshold object that inflates large *is* newly
   materialised where today it would have streamed; that residual is bounded only by the
   adapter's `MAX_INFLATED_OBJECT_BYTES` (2 GiB), which is exactly `readBlob`'s existing
   posture for every loose object in the library. DC-2 owns that trade and §Blind-spot 1
   is the review hook; the pack-delta arm is excepted outright (ADR-386 already
   materialises it).
4. **No public API change.** `streamBlob`, `BlobStream`, `readBlob`, `DiffChange`,
   `TreeDiff`, `DiffOptions`, `repo.primitives.*` and `reports/api.json` are untouched.
5. **One state machine, not two.** The buffered and streamed arms drive the *same* scanner
   code; the "identical semantics" property holds by construction, and the differential
   test is a check on that, not the only guarantee.
6. **Every equivalent-mutant proof is re-argued against the new structure** — none carried
   forward unexamined (§Design D5).
7. **Measured, not asserted.** A bench that actually reaches the predicate (Pin D-3),
   before(`main`)/after(branch), absolute wall-clock, on one host, ≥2 runs, in the PR body;
   the nightly `bench.yml` artifact is the published authority.
8. **Cross-adapter pinned.** The whitespace drop path gains a parity scenario
   (§Test strategy) — today no `test/parity` scenario exercises `ignoreWhitespace` at all.

## Design

### D1 — one synchronous chunk-fed scanner (`domain/diff/line-digest-scanner.ts`)

The predicate's per-side state machine is lifted out of the application layer, made
**synchronous**, and given a push API. It owns exactly what it owns today — buffering,
LF scanning with a resume cursor, the NUL window, the line caps, digesting, blank skipping —
and nothing about *where bytes come from*.

```ts
export interface LineDigestScanner {
  /** Feed the next chunk. Runs the incremental NUL-window scan. */
  push(chunk: Uint8Array): void;
  /** No more chunks will arrive. */
  end(): void;
  /** Next significant digest, or why not. Never throws. */
  next(): ScanStep;
  readonly binary: boolean;
}

type ScanStep =
  | { readonly kind: 'digest'; readonly digest: LineDigest }
  | { readonly kind: 'needs-input' }   // only reachable before end()
  | { readonly kind: 'exhausted' };    // EOF *or* binary — the caller reads `.binary`
                                       // to tell them apart, exactly as the verdict
                                       // ladder does today
```

`createLineDigestScanner(key: LineKey, ignoreBlankLines: boolean): LineDigestScanner`.

The bodies of `concatBytes`, `scanForNul`, `trackLineCaps`, `takeLine`, `nextLine` and
`nextSignificantDigest` move **verbatim** apart from `await`/`Promise` removal and the
`needs-input` return that replaces `await state.iterator.next()`. `LineSourceState` loses
its `iterator` field and becomes the scanner's private state.

Why this shape settles §Requirements 1 and 5:

- **`scanForNul` is chunk-count-invariant.** `nulScanOffset` accumulates across pushes and
  `end = min(chunk.length, BINARY_DETECTION_BYTES - nulScanOffset)`, so N chunks and one
  concatenated chunk both scan exactly the first 8 000 bytes of the stream.
- **The pending-bytes cap is chunk-count-invariant.** The
  `currentLineBytes + buffer.length >= MAX_LINE_BYTES` check is only *reached* when
  `buffer.indexOf(LF, lfScanFrom) === -1`, i.e. when the buffer holds no terminator — so
  `buffer.length` is always the pending *unterminated* byte count, whether the buffer was
  filled by one push or fifty. A whole-blob push does **not** let a short-line file trip
  the cap.
- **`trackLineCaps`/`takeLine` are unchanged**; the terminated/unterminated split still
  comes from "was an LF found" vs "the exhausted branch", which both drivers reach the
  same way.

Home: `src/domain/diff/`, beside `line-diff.ts` whose `hasNulInWindow` / `exceedsLineCaps` /
`splitLines` this scanner mirrors, and beside `whitespace.ts` whose digest primitives it
consumes. Zero platform dependency, so it belongs in domain (DC-4).

### D2 — the blob-source seam and the size gate

The gate cannot live in the predicate: from outside, a blob's size is unknowable without
reading it. It **can** live where the source is resolved, because there the size — or a
free proxy for it — is already in hand:

| storage form | what the resolution already knows, before inflating | cost of learning it |
|---|---|---|
| `ctx.deltaCache` hit | the full loose-format buffer | zero — it *is* the buffer |
| loose | `compressed.length`, from the `ctx.fs.read` **both** designs must perform (ADR-388) | zero |
| pack **base** entry | `header.size` (declared inflated size) **and** `nextOffset - offset` (exact compressed slice), from `readEntryHeaderWithChunk`, which `streamBlob` already calls | zero |
| pack **delta** entry | nothing pre-inflate — but ADR-386 already reconstructs it in full | n/a: always the buffered arm |

So a size gate placed in the source resolution **costs no I/O at all**. The brief's
objection ("a gate that costs a full read to decide not to read is not a gate") does not
apply: on the loose arm the read is mandatory for both designs, and on the pack arm the
entry header is parsed for both designs.

```ts
type BlobSource =
  // content already split from its header; `type` is the object's real type
  | { readonly kind: 'bytes';  readonly type: ObjectType; readonly content: Uint8Array }
  | { readonly kind: 'stream'; readonly stream: AsyncIterable<Uint8Array>;
      readonly materialised: boolean };

openBlobSource(ctx, id, maxBufferedBytes, options?): Promise<BlobSource>
```

The `bytes` arm carries **split** `{ type, content }`, not loose-format bytes, because the
four sources do not agree on framing: the delta-cache, loose and pack-delta arms hold
`<type> <size>\0<content>` (split with the existing `splitObject`), while a pack **base**
entry's inflated output is raw content with **no** header — its type comes from
`PackEntryHeader.type` and its canonical header (`blob <declaredSize>\0`) is synthesised
for hashing exactly as `yieldAndVerifyPackedBaseChunks` does today. Normalising to
loose-format instead would mean an extra whole-blob copy on the hottest arm.

Resolution order, gated:

0. **`ctx.deltaCache.get(id)` is consulted only when `maxBufferedBytes > 0`.** This is
   load-bearing for DC-1 option A: `streamBlob` passes `0`, so it keeps today's exact
   loose-first-then-pack precedence and never turns a cache hit into a `materialised: true`
   stream where it returns `materialised: false` today. A cache hit *above* the threshold
   is still returned as `bytes` — the buffer is already resident, so streaming it would
   save nothing.
1. loose: `looseCompressedBytes` → if `compressed.length <= maxBufferedBytes`,
   `ctx.compressor.inflate(compressed)` → `bytes`; else today's
   `createInflateStream` pipeline → `stream`.
2. pack base: if the gate passes, `ctx.compressor.inflate(chunk.subarray(headerEndInChunk))`
   → `bytes`; else today's pipeline → `stream`.
3. pack delta: `resolvePackChain` → `bytes` (and the delta cache is populated as today).

The seam reports `type`; the blob-specific `UNEXPECTED_OBJECT_TYPE` refusal stays with the
callers (`streamBlob`'s wrapper and the predicate), so a future non-blob consumer is not
foreclosed. **Refusal *timing* is preserved per arm**, because today's differs: pack base
and pack delta refuse eagerly (`isBase`/`PACK_ENTRY_TYPE.BLOB`, `parseHeader` in
`streamFromBuffer`), while the streamed loose arm refuses lazily, on first drain, inside
`stripHeader`. The *buffered* loose arm necessarily refuses eagerly — it has the header in
hand — which is reachable only for sub-threshold objects and only from the predicate, which
awaits the verdict anyway, so no caller can observe the difference. `streamBlob` (gate `0`)
never reaches it. Hash verification is `ctx.hash.hashHex(<header ++ content>)` raising the
same `OBJECT_HASH_MISMATCH`; `checkAborted` fires at the same points.

**The seam does *not* adopt `resolveObjectBytes`'s virtual empty-tree short-circuit.**
`resolveObjectBytes` answers the empty-tree oid from `EMPTY_TREE_BYTES` without touching
disk; `streamBlob` today misses loose, misses the pack and raises `OBJECT_NOT_FOUND`.
Adopting the short-circuit would silently change that refusal to `UNEXPECTED_OBJECT_TYPE`.

`streamBlob(ctx, id, options?)` becomes `openBlobSource(ctx, id, 0, options)` plus a
"wrap a `bytes` arm as a one-chunk iterable" tail — with the cache probe gated off at
`0`, the only `bytes` arm it can reach is the pack-delta one, which is exactly where it
reports `materialised: true` today. Its observable contract is byte-for-byte unchanged,
and `test/unit/application/primitives/stream-blob.test.ts` must pass **unmodified**.

**Note on partial clones.** `readRawObject`/`readObject` carry a promisor lazy-fetch retry;
`streamBlob` does not. `openBlobSource` deliberately does **not** acquire one — adding it
would change refusal behaviour on the streamed arm too, and asymmetric lazy-fetch (small
blobs fetched, large ones not) would be worse than either. Reviewers should check this
(§Blind-spot 6).

### D3 — the predicate's two arms

```
isWhitespaceOnlyModify(ctx, change, lineKey, ignoreBlankLines):
  [oldSrc, newSrc] = await Promise.all([openBlobSource(ctx, change.oldId, T),
                                        openBlobSource(ctx, change.newId, T)])
  if both are 'bytes':  return compareBuffered(oldSrc.content, newSrc.content, …)  // 0 awaits
  else:                 return await compareStreamed(oldSrc, newSrc, …)           // today's loop
```

`compareBuffered` is fully synchronous: push each content slice into its scanner, `end()`,
then drain both with the existing verdict ladder (binary → both exhausted → one exhausted →
digest mismatch). Zero promises, zero microtasks, zero stream objects — which is what
removes the 16.4 % + 6.2 % + 4.4 % + 3.7 % of Pin A. `isWhitespaceOnlyModify` stays
`async` (the seam is async), so this arm is `return compareBuffered(…)` returning a plain
boolean; the streamed arm is `return await compareStreamed(…)` — never a bare
`return <promise>`, which is this repo's recurring workerd unhandled-rejection class.

`compareStreamed` keeps today's structure and its **concurrency**: both sides still advance
under one `Promise.all` per step, so a two-large-blob diff keeps overlapping its I/O.
What changes is that "advance one side to its next significant digest" now consults the
sync scanner first and only awaits when it answers `needs-input` — so the mixed case (one
sub-threshold buffered side, one huge streamed side) stops allocating and awaiting a
resolved promise for the buffered side on every line.

**Early-exit hygiene (brief item 2, demoted to non-perf).** `compareStreamed` calls
`iterator.return?.()` on both sides before returning early. `readableStreamToAsyncIterable`
already implements `return` as `reader.cancel()`, so this releases the reader and lets the
`createInflate` instance be collected instead of leaking until GC. Pin D-2 shows this is
worth **0 ms**; it is landed as resource hygiene and is *not* the fix.

### D4 — what happens to each hand-proven equivalent-mutant NOTE

| # | today's location | the proof's load-bearing premise | disposition |
|---|---|---|---|
| M1 | `concatBytes` — `if (a.length === 0) return b` (ConditionalExpression `false` variant) | `out.set(a, 0)` is a no-op when `a` is empty | **holds verbatim** under both drivers; the note moves with the function. The `true` variant stays a real killed mutant — the multi-push scanner tests keep killing it. |
| M2 | `scanForNul` — `nulScanOffset < BINARY_DETECTION_BYTES` (`true` variant, `<=` variant) | once `nulScanOffset ≥ 8 000`, `end ≤ 0` so the loop never runs | **holds verbatim**; independent of chunking. |
| M3 | `trackLineCaps` — `if (terminated) currentLineBytes = 0` (`true` variant) | this is the last `trackLineCaps` call for the line; the unterminated tail is the last line ever returned | **holds**, but the premise now cites the scanner's `exhausted` branch rather than `nextLine`'s. Note text updated to name the new structure. |
| M4 | `nextLine` — the pending-bytes cap, `Stryker disable next-line ArithmeticOperator,BlockStatement` | `buffer.length` only grows until the line completes | **holds, and is the one to re-verify by hand** against a *single whole-blob push* (see D1: the check is only reached when the buffer contains no LF). The plan must reproduce the proof against the buffered driver explicitly, not carry it. |
| M5 | `nextLine` exhausted branch — `terminated: false`, `Stryker disable next-line BooleanLiteral` | that call is always the last line returned; `currentLineBytes` is never read again | **holds verbatim**. |

The repo's known past defect is a proof silently falsified by a structure change
(sorted-array → heap). Every row above is re-derived against the sync scanner in the plan,
and each surviving `Stryker disable` keeps its `(mutator, line)` anchoring on the
**expression** line. DC-5 offers the alternative of deleting the constructs instead.

### D5 — layering

```
application/primitives/stream-blob.ts          application/primitives/internal/
  (public primitive, contract unchanged)         whitespace-drop-predicate.ts
                 │                                    │            │
                 └──────────────┬─────────────────────┘            │
                                ▼                                  ▼
        application/primitives/internal/          domain/diff/line-digest-scanner.ts
                  blob-source.ts                        (pure; no ports)
                                │                                  │
                                ▼                                  ▼
   object-resolver.ts · pack-registry.ts · ports/compressor   domain/diff/whitespace.ts
                                                              domain/diff/line-diff.ts
```

No new port, no new adapter method, no new public export, no `reports/api.json` churn. The
dependency rule (`repository → commands → primitives → domain`) is respected; the change
*removes* a domain-shaped state machine from the application layer.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Where the buffered/streamed choice is made, and what happens to ADR-385 | **A** shared internal `openBlobSource` seam below `streamBlob`; `streamBlob`'s public contract unchanged · **B** put the gate inside `streamBlob` itself (supersedes ADR-385; every caller inherits it) · **C** no seam — the predicate calls `readRawObject(…, { maxBytes: T })` and falls back to `streamBlob` on `OBJECT_TOO_LARGE` | **A** | ADR-385's decision text is explicit ("`streamBlob` always streams"); A keeps it literally true while its Neutral note ("escalation lives inside `streamBlob`") is honoured by the shared implementation. **C is unsound**: `enforceLooseCap` fires *after* the full inflate, so an oversized **loose** blob — exactly the 674 MB case streaming exists for — is materialised before the cap can refuse it. B is defensible but changes behaviour for `apply-changeset`, `apply-merge-to-worktree`, `merge`, `stash` and the public `repo.primitives.streamBlob`, none of which asked for it. **USER DECISION** — B needs an ADR superseding 385. |
| DC-2 | The threshold's unit and value | **A** compressed/on-disk bytes, uniform (loose file length; pack entry slice length), **64 KiB** · **B** inflated bytes where free (pack base `header.size`) + compressed for loose — mixed units · **C** no numeric threshold: buffer only what is *already* a buffer (delta-cache hit, pack delta) | **A** | A is one constant, free on every arm, and bounds the quantity actually read. B's mixed units are a review hazard; and A does not *lose* the inflated size — on the pack-base arm `header.size` is free too, so A's implementation may cheaply assert it as a second condition (an implementation detail of A, not a separate option; the loose arm has no such number). **C does not solve the problem** — the megarepo case is loose/pack-base small blobs, which C leaves streaming. A's known weakness: compressed size is not a bound on inflated size (a 64 KiB zlib bomb). Accepted because **every other tsgit read already has exactly this property** — `readBlob`/`readObject`/`readRawObject` inflate loose objects whole under only the adapter's 2 GiB `MAX_INFLATED_OBJECT_BYTES` cap. The fast path stops the predicate being uniquely stricter; it opens no new class of exposure. Peak bound under load: 32 concurrent pairs × 2 sides × 64 KiB compressed (§Blind-spot 1 attacks the *inflated* side of that product). **USER DECISION** (the value, and whether the amplification argument is accepted). |
| DC-3 | Does the streaming arm survive inside the predicate? | **A** yes, gated — blobs above the threshold still stream · **B** no — the predicate always buffers; `streamBlob` keeps its other callers · **C** yes, but only for pack-base entries (loose always buffered, since ADR-388 reads the whole compressed file anyway) | **A** | B regresses the memory posture ADR-513/ADR-383 built the streaming predicate for (a 674 MB file diffed with `-w` would materialise twice). C is *tempting* — the loose arm never bounds the compressed read, only the inflated output — but it makes a large **loose** blob unbounded on the inflated side, which is the one thing ADR-388 deliberately still bounds. A costs one branch. **USER DECISION** — B would let §D1's `needs-input` state and half the scanner tests be deleted, a real simplification if the large-blob case is judged out of scope; but B materialises **both** sides of a 674 MB `-w` diff in full, which is exactly the case ADR-513's streaming predicate was built for. |
| DC-4 | The shared scanner's home and shape | **A** new pure `src/domain/diff/line-digest-scanner.ts`, sync `push`/`end`/`next` · **B** keep it in `whitespace-drop-predicate.ts` and write a second buffered code path beside the streaming one · **C** keep the async-iterator core; the buffered arm is just a single-chunk `AsyncIterable` | **A** | A gives §Requirements 5 (identity by construction) and puts a pure state machine next to `line-diff.ts`, whose caps it mirrors. B duplicates the semantics that must never drift — the precise failure mode §Requirements 1 is guarding. **C is the honest minimal-diff alternative, not a straw man**: fed from the same `openBlobSource`, it *does* remove the WHATWG streams and `createInflate` (16.4 % + 6.2 % + 4.4 % of Pin A) and it keeps one state machine, so §Requirements 5 still holds. What it keeps is the per-line `Promise.all`, the async-generator frames and `runMicrotasks` (3.7 %) — call it most of the win for a much smaller blast radius. A is preferred because the sync scanner additionally unlocks synchronous, mutation-friendly chunk-boundary tests (DC-9) and returns a domain state machine to the domain layer; if blast radius is the overriding concern, C is defensible. |
| DC-5 | Disposition of the five hand-proven equivalent-mutant NOTEs (§D4) | **A** move verbatim, re-prove each against the sync driver, update the note text where the premise cites a moved symbol · **B** delete the constructs that needed them (e.g. drop `concatBytes`'s empty-`a` shortcut) so the mutants die naturally · **C** carry the notes forward unchanged | **A** | C is forbidden by the repo's own history (a structure migration silently falsified a carried-forward proof). B is cleaner where it applies but M1's shortcut is a real allocation saving on the hot buffered arm (`concatBytes(EMPTY, wholeBlob)` — B would copy the whole blob on every buffered read), and M2/M4/M5 have no construct to delete. |
| DC-6 | Drop-pass concurrency (brief item 4) | **A** unchanged — `boundedMap(changes, MAX_CONCURRENT_OBJECT_LOADS = 32)` · **B** raise the bound for the drop pass now that each unit is a buffered read · **C** split bounds: buffered arm higher, streaming arm 32 | **A** | The premise that this is sequential is false (Pin D-1). 32 is also what bounds peak memory (DC-2). Raising it is a *measurement*, not a design decision — and the buffered arm's cost is syscalls + `inflateSync`, both of which stop scaling past core count. Re-measure after the fast path lands; only then consider B. |
| DC-7 | The two divergences Pin C uncovered (C4 trailing-LF gain, C5 `MAX_LINE_BYTES`) | **A** land the perf slice first (reproducing today's verdicts exactly), then fix both as separate commits **in this PR**, each with its own ADR + interop case · **B** fix them first, build the fast path on the corrected verdicts · **C** pure perf only; the divergences are filed and fixed elsewhere | **A** | The standing preference is "everything in this PR, no follow-ups". But mixing a verdict change into the perf change destroys the invariant that makes the perf change cheap to review ("the verdict must not move") and poisons the differential oracle (§Test strategy) — so they must be *ordered*, not merged. C4 also touches the `withStat` path (`normalizeLine` keeps the LF, `bytesEqual` sees it), and C5 is a deliberate DoS cap whose removal needs its own threat argument — each is genuinely an ADR. **USER DECISION.** |
| DC-8 | Browser/memory adapters get no win (Pin D-5) | **A** accept — Node-only win; the gate stays adapter-blind · **B** reimplement `BrowserCompressor.inflate` / `MemoryCompressor.inflate` over the existing synchronous zero-dependency `inflateZlibMember` (already their `streamInflate` engine), so buffered inflate is genuinely cheap everywhere · **C** add a `Compressor` capability flag so the gate is skipped where buffered inflate is not cheaper | **B, gated on a browser bench** | B is a small, already-tested code path and would make the fast path pay off on OPFS/e2e too; it must be benched against native `DecompressionStream` on large inputs before landing, because it would also change every *other* `inflate` caller on those adapters (`tryLoose`, `collectDeltaChain`) — a much wider blast radius than this design. If the bench is not clearly better, take A. **C is rejected**: a perf-detail capability verb on a port is exactly the surface ADR-387 refused to add. **USER DECISION.** |
| DC-9 | The predicate's unit-test seam | **A** retarget today's `vi.spyOn(streamBlobMod, 'streamBlob')` to `openBlobSource`, keep the chunk-boundary cases there · **B** delete the module spy: drive the scanner directly and synchronously for every chunk-boundary case, and exercise the predicate's two arms against real `createMemoryContext` blobs | **B** | The chunk-boundary cases are the scanner's contract, not the predicate's; testing them synchronously against a `push` API is faster, mutation-friendlier (no async timing), and removes module-level mocking. The predicate then only needs arm-selection tests. Costs: the fixtures move file, and "which arm ran" must be observable — assert it via the scanner/source seam, not by timing. |

## Test strategy

- **P1 scanner (unit, `test/unit/domain/diff/line-digest-scanner.test.ts`).** Every case
  today's `whitespace-drop-predicate.test.ts` drives through `chunkedStream` moves here and
  becomes synchronous: LF at a chunk boundary; a line split across three pushes; NUL in the
  first 8 000 bytes vs at byte 8 001 vs straddling a push boundary; `MAX_LINE_BYTES`
  reached by one long line, by a pending unterminated tail, and *not* reached by many short
  lines in one whole-blob push (the M4 re-proof, as an executable test); `MAX_LINES`;
  unterminated final line; `ignoreBlankLines` skipping a spaces-only line under a whitespace
  mode but not under `'none'`; empty blob; blob that is a single LF. Guard clauses get
  **isolated** tests per operand (`currentLineBytes >= MAX` and `lineCount >= MAX`
  separately). Error data asserted via try/catch on `.data`, never bare `toThrow(Class)`.
- **Differential oracle (unit, `line-digest-scanner.properties.test.ts`).** CLAUDE.md lens
  **2** (compositional matcher/aggregator) and lens **4** (idempotence/counting invariant)
  both fit; lens 1 (round-trip) and lens 3 (totality over a grammar) fit the scanner too.
  Properties, `numRuns: 100` (the chunk-split one at 200):
  1. *chunk-split invariance* — for an arbitrary byte string `b` and an arbitrary partition
     of `b` into chunks, the digest sequence and final `binary` flag are identical to
     pushing `b` whole. **This is the requirement-1 guarantee expressed as a property**, and
     it is not a tautology: the oracle is the same scanner fed differently, which is exactly
     the invariant that matters.
  2. *agreement with the allocating reference* — for arbitrary lines and an arbitrary
     `LineKey`, `digestsEqual(scan(a), scan(b))` agrees with
     `linesEqualUnder(a, b, key)` (the independently-tested `normalizeLine` + `bytesEqual`
     pair — a genuinely separate implementation, not a copy of the SUT).
  3. *totality* — over the safe subset (bytes without NUL, under the caps) the scanner
     never throws and always terminates.
  Generators live in a shared `test/unit/domain/diff/arbitraries.ts`; no seed committed.
- **P3 predicate (unit).** Arm selection: a sub-threshold pair takes the buffered arm and
  builds **no** stream; an over-threshold side takes the streamed arm; a mixed pair takes
  the streamed arm. Content edges on both arms: one side empty, both sides empty, a side
  that is a single LF, a side with no trailing LF. Error identity: missing oid, tree oid,
  the empty-tree oid, corrupted loose object, aborted signal — asserted on **both** arms
  with the same `.data` (§Requirements 2). Verdict identity: the whole of today's predicate
  suite re-run once per arm by varying only the threshold constant — a sub-threshold blob
  forced onto the streaming arm must return the identical boolean.
- **P2 seam (unit).** `openBlobSource` on: delta-cache hit **with the gate open and with it
  at 0** (the probe must be skipped at 0 — §D2 step 0, the property that keeps
  `streamBlob` unchanged), loose under/over the gate, pack base under/over the gate, pack
  delta (always `bytes`), missing oid, non-blob oid, empty-tree oid, `verifyHash` on/off,
  aborted signal. Header framing per arm: the pack-base arm's `bytes` must be raw content
  with the synthetic `blob <size>\0` used only for hashing; the other three split with
  `splitObject`. `streamBlob`'s existing suite
  (`test/unit/application/primitives/stream-blob.test.ts`, 40+ cases) is the regression net
  proving the public contract did not move — **it must pass unchanged**.
- **Faithfulness (integration).** The two existing interop suites are the authority and
  must stay byte-identical: `test/integration/diff-whitespace-interop.test.ts` (the full
  W/B/EOL/CR/BL/M/D/C matrix, name-status + numstat + quiet + reconstructed patch bytes vs
  live `git diff --no-ext-diff --no-color <mode>` and frozen goldens) and
  `test/integration/diff-whitespace-modes-interop.test.ts` (predicate path *and*
  `withStat` path agreeing with each other and with git across all five flags). **They
  cover the fast path automatically** — their blobs are all far under any sensible
  threshold, so today they exercise the streaming arm and after this change they exercise
  the buffered arm. To keep *both* arms pinned against git, the suites gain a
  threshold-forced second pass (same fixtures, gate set to 0) — otherwise the streaming arm
  loses its only cross-tool coverage. Add Pin C's five fixtures as explicit rows, with
  C4/C5 asserted at whatever DC-7 settles.
- **Cross-adapter (parity).** No `test/parity` scenario touches `ignoreWhitespace` today
  (§Requirements 8). Extend `test/parity/scenarios/diff-pipeline.scenario.ts` with a
  whitespace-only modified pair and assert the surviving paths — this is what catches an
  adapter whose `Compressor.inflate` behaves differently (and it is the suite that catches
  the workerd `return`-without-`await` class of failure; `test:parity:workers|deno|bun` are
  **not** in `npm run validate` and must be run explicitly, since P4/DC-8 touch adapters).
- **Mutation.** The gate comparison (`<=` vs `<`), the arm-selection branch, and the
  scanner's index arithmetic are mutation-dense; each boundary gets an explicit test rather
  than a documented equivalence. §D4's five proofs are re-derived, not carried.

### Measurement protocol (requirement 7)

1. **New bench** — `test/bench/diff-whitespace.bench.ts` gains a
   *many-small-modified-pairs* scenario, because the existing one never reaches the
   predicate (Pin D-3). Shape: a **scratch** repo built through the library's own API in
   `test/bench/support/write-scratch.ts` style — N files × ~56 bytes across N/50
   directories, committed, then rewritten whitespace-only and committed — **not** a
   mutation of the shared `~/.cache/tsgit-bench` fixture (`buildWideModifyTreeId`'s
   deterministic-write trick would add 20 000 loose objects to a cache every other bench
   shares). Two variants: loose (as committed) and packed (`git repack -ad`), because Pin B
   shows they exercise different resolution arms and the packed one is the realistic
   megarepo. Built **once** at module scope and reused across iterations (the 2 500-file
   build measured a few seconds); torn down in `afterAll`. Keep the existing add-shaped
   scenario as a non-regression watch, relabelled so its "measures the whitespace path"
   claim is no longer implied (Pin D-3).
2. **Go/no-go, in-PR** — before(`main`) vs after(branch), same host, ≥2 runs, absolute
   wall-clock, both variants, recorded in the PR body. Target: loose ≤ 130 ms, packed
   ≤ 100 ms cold (from 258 / 165 ms), no regression on `diff.bench.ts`,
   `diff-recursive.bench.ts`, `pack-read.bench.ts`, `loose-read.bench.ts`.
3. **Re-profile** — `npm run profile` after landing; the `NodeError` /
   `NodeError` and the three web-streams-module frames should leave the digest
   entirely for this workload. Published numbers come from the **nightly `bench.yml`
   artifact**, never a loaded local session.
4. **Non-goal** — beating native git. On the packed variant native is 77 ms and the
   projection is ~91 ms cold; the residual is the loose/pack read itself plus the
   containment gate (Pin A, ~4.9 %), not this design's business.

## Blind-spot checklist — what a reviewer should attack

1. **Zip-bomb amplification through the gate (DC-2).** A 64 KiB compressed loose object can
   inflate to gigabytes; the fast path materialises it where the streaming path would not.
   Attack: is the "every other read path already does this" argument actually true for the
   *concurrent* case (32 pairs × 2 sides in flight)? Peak is now 64 × inflated-size, not
   1 × inflated-size.
2. **Hash verification silently weakened.** Confirm the buffered arm verifies with the same
   default (`verifyHash` true) and raises `OBJECT_HASH_MISMATCH` with the same `.data`.
   A buffered read that skips verification "because it's small" is a supply-chain hole.
3. **Type-confusion parity.** `streamBlob` refuses a non-blob oid in *three* different
   places (loose `stripHeader`, pack `isBase` + `PACK_ENTRY_TYPE.BLOB`, delta
   `streamFromBuffer`/`parseHeader`). Check every arm of `openBlobSource` refuses
   identically — a tree oid reaching the scanner as "content" would be a silent wrong answer,
   not a crash. Specifically check the **empty-tree oid**: `resolveObjectBytes` answers it
   virtually from `EMPTY_TREE_BYTES`; the seam must not inherit that, or today's
   `OBJECT_NOT_FOUND` silently becomes `UNEXPECTED_OBJECT_TYPE` (§D2).
4. **Loose-first precedence.** `streamBlob` probes loose *first*; `openBlobSource` probes
   the delta cache first (mirroring `resolveObjectBytes`). Confirm that cannot serve a
   stale object after an external `git gc` + rewrite — and that the fanout-cache
   invalidation caveat (a `Context` built before a foreign `git` write sees a stale loose
   set) is unchanged.
5. **Chunk-count invariance.** The two proofs in §D1 (`scanForNul`, the pending-bytes cap)
   are the load-bearing correctness claims. Attack them with a file whose total length
   exceeds `MAX_LINE_BYTES` but whose every line is short, and with a NUL at byte 8 000 vs
   8 001, on both arms.
6. **Partial clones.** The buffered arm is one call away from `readRawObject`'s promisor
   lazy-fetch retry; if it acquires one, small blobs get lazy-fetched and large ones do not.
   Confirm the seam does *not* retry (§D2).
7. **Abort responsiveness.** Today a long blob is abandoned mid-stream on
   `ctx.signal.aborted`; the buffered arm checks only at the resolution boundary. Confirm
   the gate keeps abort granularity acceptable — the sub-threshold case is bounded by the
   threshold, so this is only a question above it.
8. **Workerd / Deno / Bun.** P4 and DC-8 touch adapters, and the parity suites are **not**
   in `npm run validate`. The recurring failure class on this repo is `return <promise>`
   without `await` in an `async` function → a workerd unhandled rejection while every test
   passes. Concrete site here: `isWhitespaceOnlyModify`'s streamed arm
   (`return await compareStreamed(…)`, §D3) and every arm of `openBlobSource` that tails
   into an inner async call.
9. **DC-7 ordering.** If the C4/C5 fixes land in the same PR, verify the perf commit's
   diff shows *zero* verdict change on its own — the whole safety argument for the perf
   slice is "the oracle did not move".

## Out of scope

- **The loose-read containment gate** (`realpath` + `isContainedInAnyRoot`, ~4.9 % of Pin A).
  Paid identically by both designs, already investigated and partly reverted in 26.4, and
  absent entirely on packed repos.
- **The `.gitattributes` per-path resolution in `changeShouldDrop`.** `loadDir` caches per
  directory, so it is O(distinct directories), not O(changes); it did not surface in Pin A.
- **`core.bigFileThreshold`.** ADR-385 established tsgit does not honour it anywhere; this
  design's threshold is an internal memory bound, deliberately not that knob, and not
  user-configurable (adding an option would be a public-surface change — §Requirements 4).
- **The `withStat` / `materialisePatchFiles` path.** Untouched: it already materialises both
  sides by construction and intern-Myers is a different cost profile (ADR-513).
- **`streamInflate` and `fetch-pack`.** Different verb, different contract
  (`bytesConsumed`), untouched.
- **Raising `MAX_CONCURRENT_OBJECT_LOADS`** (DC-6) — a measurement to run *after* the arm
  cost changes, not a design decision to take now.
