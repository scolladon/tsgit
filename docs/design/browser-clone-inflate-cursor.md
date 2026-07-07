# Design — Faithful `bytesConsumed` for browser/memory `streamInflate` (clone path)

> Brief: make the browser and memory `Compressor.streamInflate` report a byte-exact `bytesConsumed` for one zlib member inside a concatenated in-memory pack, so `clone`/`fetch` works on those adapters for packs whose *compressed* entries exceed 64 KiB (backlog 26.10).
> Status: draft → self-reviewed ×3 → accepted

## Context

### The port and its three adapters

`src/ports/compressor.ts` defines `streamInflate(bytes, offset) => Promise<{ output, bytesConsumed }>` (`InflateStreamResult`). Its contract: inflate exactly one zlib member starting at `offset`, return the inflated `output` and `bytesConsumed` — the compressed length of that single member, measured from `offset`. The pack walker relies on `bytesConsumed` to find where the next entry begins; it does not know a member's compressed length a priori.

Three adapters implement the port:

- **`src/adapters/node/node-compressor.ts` — the faithful reference.** `streamInflate` drives `node:zlib` `createInflate()`, and on `'end'` reads `inflate.bytesWritten` — the exact count of compressed bytes zlib accepted as the member (2-byte zlib header + DEFLATE blocks + 4-byte adler32 trailer). Node clone works unbounded.
- **`src/adapters/memory/memory-compressor.ts`** and **`src/adapters/browser/browser-compressor.ts`** — both implement `streamInflate` with the **same progressive-prefix scan** (duplicated, not shared): try `end = 1, 2, 3, …`, feed `slice[0..end)` to a fresh `DecompressionStream('deflate')`, and accept `end` when it decodes *and* the trailing 4 bytes equal `adler32(output)`. `DecompressionStream` exposes no consumed-byte cursor, so the boundary is brute-forced. Each attempt re-inflates the whole prefix → **O(n²)** in compressed length, hard-capped at `MEMORY_/BROWSER_STREAM_INFLATE_MAX_INPUT = 64 * 1024`; over the cap it throws `DECOMPRESS_FAILED`.

`src/adapters/adler32.ts` is a shared, platform-free pure module already imported by both the browser and memory compressors (and `src/domain/archive/zip.ts`). It is the house precedent for a pure helper shared across adapters.

### Where the gap bites

`src/application/primitives/fetch-pack.ts` → `inflateAllEntries` walks pack entries sequentially:

```
const inflate = await ctx.compressor.streamInflate(packBytes, entryHeader.dataOffset);
const entryEnd = entryHeader.dataOffset + inflate.bytesConsumed;   // advance to next entry
```

This is the *only* caller of `streamInflate`. A pack entry whose compressed form exceeds 64 KiB (a large, poorly-compressible blob) trips the cap → the whole clone/fetch throws on browser and memory. Node is unaffected.

### Why 24.10's read-path fix does not cover this

The object **read** path (`src/application/primitives/object-resolver.ts` → `collectDeltaChain`) never calls `streamInflate`. It reads an *index-bounded* slice — the `.idx` offset table gives the exact next-entry offset, so it slices `chunk.subarray(headerEndInChunk)` up to a known boundary and calls the whole-buffer `ctx.compressor.inflate(...)`. No boundary search, no cap. Reads therefore already work at any size on all three adapters. **The gap is exclusively the clone/index-build path**, where no `.idx` exists yet, so member boundaries must be discovered by inflating.

### Governing invariants

- **Git-faithfulness prime directive (ADR-226):** the three adapters must be observationally identical. `bytesConsumed` from browser/memory must equal Node's `bytesWritten` byte-for-byte for every member.
- **Structured output (ADR-249):** the port returns data (`{ output, bytesConsumed }`), never rendered text. Unaffected here — this is already structured — but noted so the fix stays data-only.
- **Zero runtime dependencies** — README flagship pitch ("Zero runtime dependencies — no transitive surface"); `package.json` keyword `zero-dependency`, empty `dependencies`. Any option adding a runtime dep trades away a documented north-star.
- **Hexagonal layering:** ports → adapters; domain stays platform-free. A shared decompression helper is an *adapter* concern (like `adler32.ts`), not a domain concern.
- **Size budgets** (`.size-limit.json`, gzip): Browser adapter 10 kB, Memory adapter 10 kB, Full library 335 kB.

## Requirements

Self-supplied (no separate requirements artifact this run). When this ships:

1. `MemoryCompressor.streamInflate` and `BrowserCompressor.streamInflate` return `bytesConsumed` equal to Node's `createInflate().bytesWritten` for the same member, for members of any compressed size (no 64 KiB cap).
2. The three adapters are byte-identical on `{ output, bytesConsumed }` for every member, proven by the shared `compressorContractTests` parity harness extended with a >64 KiB-compressed member.
3. `clone`/`fetch` of a pack containing an entry whose compressed form exceeds 64 KiB succeeds on browser and memory, producing object SHAs identical to Node and to real `git` (interop pin).
4. Corrupt / non-zlib input at `offset` still throws `DECOMPRESS_FAILED` (unchanged contract). Existing contract tests keep passing on all adapters.
5. No new runtime dependency unless an ADR explicitly authorises the zero-dep exception.
6. Domain stays platform-free; the fix lives in the adapter tier; no DOM/Node globals leak into shared code.
7. 100% line/branch/function coverage and the mutation budget hold on the new code; a parser/round-trip touch ships a `*.properties.test.ts` sibling.

## Design

### Pinned faithfulness matrix

All probes are read-only zlib experiments (no git state written); Node v22.22.3, `DecompressionStream`/`node:zlib` as shipped. Reproduction scripts in scratchpad (`probe.mjs`, `pako-test.mjs`).

**M1 — Node `createInflate().bytesWritten` is the reference `bytesConsumed`.**
A buffer of 4 concatenated `zlib.deflateSync` members (mixed compressible/random payloads). At every member offset, `streamInflate` returned `bytesConsumed` **exactly equal to that member's compressed length** (`match=true` for all 4), decoding only that member. This is the value the browser/memory path must reproduce. Structurally, `bytesWritten` = `2` (zlib CMF+FLG header) + DEFLATE blocks rounded up to the next byte boundary after `BFINAL` + `4` (big-endian adler32 trailer).

**M2 — `DecompressionStream('deflate')` acceptance is a SINGLE SPIKE, not monotone.** (Decides option c.)
Feeding prefixes of member 0 (true boundary `L = 55`) and asking "does it decode without throwing?":

| prefix length `L` | `L − boundary` | decodes cleanly? | note |
|---|---|---|---|
| 51–54 | −4 … −1 | **no** (throws) | incomplete member |
| **55** | **0** | **yes** (`outLen=132`) | exact member boundary |
| 56 | +1 | **no** (throws) | "Trailing junk found after the end of the compressed stream" |
| 57–58 | +2 … +3 | **no** (throws) | trailing junk |

The predicate `decodes(L)` is `false … false · TRUE · false … false` — true at exactly one `L`. It is **not** a step function. On a longer-than-member prefix the stream **errors on the trailing bytes** (it does not decode the member and ignore the rest), and yields **no partial output** to binary-search on. There is no monotone signal over `L`.

**M3 — pako `Inflate` exposes the consumed count natively.** (Feasibility of option b.)
3-member concat `[31, 12, 13]` bytes. `pako.Inflate().push(tail, false)` at each offset: `strm.total_in` = `[31, 12, 13]` (= member length, `match=true`), `ended=true`, `err=0`, `avail_in` = the untouched leftover. pako stops at the first member end and does not choke on trailing junk — so it can report `bytesConsumed = strm.total_in` for a member inside a concatenated buffer.

**M4 — pako bundle cost** (`pako@2.2.0`, gzip -9): full `pako.min.js` 47 016 B raw / **14 733 B gzip**; inflate-only `pako_inflate.min.js` 21 676 B raw / **7 648 B gzip**. Against the 10 kB per-adapter gzip budget, inflate-only alone is ~76% of budget for *each* of browser and memory, plus ~7.6 kB on the full-library budget.

**Consequence of M1–M4:** reporting `bytesConsumed` from a streaming inflate without a native cursor requires actually parsing the DEFLATE bitstream to the member boundary. `DecompressionStream` cannot be coaxed into it (M2). The only zero-dep way to do that is our own decoder (option a); the only off-the-shelf way is a JS inflate library (option b, M3) at a documented zero-dep and size cost (M4). Option (c) is empirically dead.

### Chosen shape (pending the ADR fork below)

Add one **shared, pure, platform-free** module — proposed `src/adapters/inflate.ts`, sibling to `adler32.ts` — exporting a single function:

```
inflateZlibMember(bytes: Uint8Array, offset: number): { output: Uint8Array; bytesConsumed: number }
```

It is a real streaming DEFLATE/zlib decoder that decodes exactly one member and returns the byte-exact consumed length, mirroring Node's `bytesWritten` (M1). Both `MemoryCompressor.streamInflate` and `BrowserCompressor.streamInflate` **replace** their O(n²) scan with a call to it, wrapping non-zlib/corrupt input as `decompressFailed(...)` (unchanged error contract). The 64 KiB caps and their constants are deleted. `NodeCompressor` keeps its native `createInflate` path (faithful reference, faster, and the byte-oracle the other two are tested against). `createInflateStream` (the separate TransformStream port method) is untouched — it needs no `bytesConsumed`.

**Decoder internal structure (LOC estimate ~330–430 production):**

| Component | Responsibility | ~LOC |
|---|---|---|
| Bit reader | LSB-first bit accumulator over `Uint8Array`; tracks byte position for `bytesConsumed`; byte-align before trailer | 40–60 |
| zlib wrapper | parse 2-byte header (CM=8, CINFO≤7, `(CMF*256+FLG)%31===0`); reject FDICT; read 4-byte adler32 trailer; `bytesConsumed` = final byte position | 40 |
| Fixed Huffman | static literal/length + distance tables (built once) | 20 |
| Dynamic Huffman | decode HLIT/HDIST/HCLEN, code-length code, build canonical tables | 60–90 |
| Canonical table build | code lengths → decode table (shared by fixed/dynamic) | 40–60 |
| Length/distance base+extra tables | RFC 1951 constants | 20 |
| Block loop | stored / fixed / dynamic blocks until `BFINAL` | 80–120 |
| 32 KiB LZ77 window + output growth | back-reference copy into a growable output | 40 |
| adler32 verify + error mapping | reuse `src/adapters/adler32.ts`; compare trailer; throw on mismatch | 20 |

gzip footprint estimate **~2–3 kB** (reference: fflate inflate-only ≈ 1.6 kB gzip; our idiomatic small-function style runs a little larger) — well inside the 10 kB per-adapter and 335 kB full-library budgets, and **removes** the O(n²) scan (a perf win: O(n) single pass).

**Edge behaviour the decoder must pin (all covered by contract tests today):**
- Empty payload member (`deflate('')`) round-trips with correct `bytesConsumed`.
- Corrupt/non-zlib bytes at `offset` → `decompressFailed` (contract: junk → `DECOMPRESS_FAILED`).
- FDICT set → reject (git/zlib packs never set it; Node errors likewise).
- Concatenated members: decode member at `offset`, stop at its adler32, leave the rest untouched (contract test at `compressor.contract.ts:42`).
- Trailer adler32 mismatch → `decompressFailed` (catches a truncated/garbled member instead of silently accepting).

### Faithfulness & parity wiring

- **Adapter parity** (`test/unit/ports/compressor.contract.ts`, run by `memory-compressor.test.ts` + `node-compressor.test.ts`, and the browser adapter via the parity/e2e harness): extend the existing `streamInflate` contract case with a member whose *compressed* size exceeds 64 KiB (a large random payload), asserting identical `{ output, bytesConsumed }` across adapters. This proves browser ≡ node ≡ memory (parity only — not faithfulness).
- **Faithfulness interop** (`test/integration/*-interop.test.ts`): clone/index a pack that contains a >64 KiB-compressed blob and assert object SHAs match real `git` on the browser/memory adapters. This is the byte-for-byte pin against the external tool (parity tests do not prove faithfulness).

## Decision candidates

The user decides each in the ADR phase. **DC-1 is the primary fork; DC-2…DC-5 are sub-choices that only apply if DC-1 = (a).**

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | How to obtain byte-exact `bytesConsumed` without a native cursor | **(a)** hand-write a zero-dep pure-JS DEFLATE/zlib decoder in a shared adapter module; **(b)** add a runtime dep on a pure-JS inflate (e.g. `pako`), reading `strm.total_in` — **requires its own ADR justifying the zero-dep exception**; **(c)** doubling + binary-search boundary probe over `DecompressionStream` | **(a)** | (c) is empirically invalid: M2 shows the accept predicate is a single spike with no monotone signal and no partial output — binary search cannot find it. (b) works (M3) but trades away the documented zero-dep north-star and costs ~7.6 kB gzip per adapter (M4). (a) preserves zero-dep, is ~2–3 kB, removes the O(n²) cap, and gives a native cursor like Node. |
| DC-2 | Replace vs augment the O(n²) scan | **replace** the scan entirely with the decoder; **keep** the scan for small inputs and use the decoder only over the cap | **replace** | One code path, no dead complexity, no arbitrary threshold; the decoder is strictly better (correct + O(n)) at all sizes, so the scan has no remaining reason to exist. |
| DC-3 | Where the shared decoder lives | **`src/adapters/inflate.ts`** (pure module, sibling to `adler32.ts`, imported by both browser + memory); a `src/adapters/inflate/` folder if split; under `src/domain/` | **`src/adapters/inflate.ts`** | Matches the existing `adler32.ts` shared-adapter-helper precedent; decompression is an adapter concern, not a git-domain concern, so it must not sit in `domain/`. Split to a folder only if the single file nears the 800-line ceiling. |
| DC-4 | Does Node also switch to the pure-JS decoder | **keep** Node on native `createInflate`; **unify** all three adapters on the pure-JS decoder | **keep native** | Node's `bytesWritten` is the faithful byte-oracle the other two are validated against, and native zlib is faster; unifying would forfeit both the speed and the independent reference. Parity is still proven by the shared contract test. |
| DC-5 | Decode granularity | **whole-member decode** with an internal 32 KiB window (return full `output` + `bytesConsumed`); **true incremental** chunk-streaming | **whole-member decode** | `streamInflate` returns the entire `output` anyway, so incremental streaming adds machinery with no caller benefit; the separate `createInflateStream` already covers true streaming and is out of scope. |

If DC-1 = (b): a dedicated ADR must (i) justify overturning the zero-dep pitch (README + `package.json` keyword), (ii) pick full pako vs inflate-only import and record the size-budget impact (M4), and (iii) confirm the API contract (`strm.total_in`, `ended`, `err`, `avail_in` leftover — M3) across all target runtimes (Node, browser, workerd, Deno, Bun), since the parity suite runs on all of them.

## Test strategy

- **Unit — decoder (`src/adapters/inflate.ts`):** example tests for each block type (stored, fixed Huffman, dynamic Huffman), empty payload, back-references spanning the 32 KiB window, multi-member concat boundary, corrupt header (bad FCHECK), FDICT rejection, adler32-mismatch rejection. Error assertions on `.data.code === 'DECOMPRESS_FAILED'` (specific, mutation-resistant), guard clauses tested in isolation.
- **Property (`inflate.properties.test.ts` + shared `arbitraries.ts`):** round-trip lens (ADR-134…136 case 1) — `inflateZlibMember(deflate(x)) ≡ { output: x, bytesConsumed: deflate(x).length }` over arbitrary byte payloads, with `deflate` produced by Node/`DecompressionStream` as the independent oracle. `numRuns` 200 (cheap round-trip). Also a concat invariant: decoding member *i* of `concat(deflate(x₀..xₙ))` at its offset yields `xᵢ` and advances by exactly `deflate(xᵢ).length`.
- **Adapter parity (`compressor.contract.ts`):** extend the existing `streamInflate` case with a >64 KiB-compressed member; assert identical `{ output, bytesConsumed }` across memory/node (unit) and browser (parity/e2e). Add a memory/browser case proving the old cap is gone (large member no longer throws).
- **Faithfulness interop (`test/integration/*-interop.test.ts`):** clone/index a pack carrying a >64 KiB-compressed blob; assert resulting object SHAs equal real `git`'s on the browser and memory adapters. Fixture must include a large, poorly-compressible blob so its *compressed* form clears 64 KiB.
- **Regression:** all existing `compressor.contract.ts` cases stay green unchanged on every adapter.

## Out of scope

- `NodeCompressor` — already faithful and unbounded (keeps native `createInflate`).
- The object **read** path (`object-resolver.ts`) — uses index-bounded whole-buffer `inflate`, never `streamInflate`; already works at any size.
- `createInflateStream` (TransformStream port method) — no `bytesConsumed` need; large loose-object streaming already works via `DecompressionStream`.
- `deflate` / `deflateRaw` (compression direction) — unaffected; loose disk bytes are equivalence-under-readback, outside the byte-faithfulness contract.
- Structured-output rendering (ADR-249) — the port is already data-only; nothing to sweep.
