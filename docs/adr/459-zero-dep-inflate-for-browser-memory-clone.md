# ADR-459: zero-dependency pure-JS inflate for browser/memory streamInflate bytesConsumed

## Status

Accepted (at `f73f9a10`)

## Context

`Compressor.streamInflate(bytes, offset)` returns `{ output, bytesConsumed }` — the
inflated member plus the exact compressed length it spanned. The **clone/index-build**
path (`fetch-pack.inflateAllEntries`, the sole `streamInflate` caller) walks a received
in-memory pack sequentially, advancing by `bytesConsumed` to find each next member.

- **Node** gets `bytesConsumed` for free from `node:zlib` `createInflate().bytesWritten`.
  It stops at the first member and reports the exact compressed length; clone is unbounded.
- **Browser / memory** use the Web `DecompressionStream`, which exposes **no consumed-byte
  cursor**. Today they brute-force the boundary with a progressive-prefix scan (`end = 1,2,3…`,
  each re-inflating the whole prefix, accepting when the trailing 4 bytes equal
  `adler32(output)`) — **O(n²)**, hard-capped at `64 KiB`. Any pack entry whose *compressed*
  form exceeds that cap fails to clone on these adapters.

24.10's exact-slice fix removed the **read**-path ceiling (`object-resolver` reads
index-bounded member slices and inflates via the whole-buffer `inflate`, never
`streamInflate`), so the gap is exclusively the clone path.

Empirically pinned (design doc `docs/design/browser-clone-inflate-cursor.md`, Node v22.22.3):

- **M1** — `createInflate().bytesWritten` is byte-exact at every offset of a concatenated
  buffer: `2` (zlib header) + DEFLATE blocks to the byte boundary after `BFINAL` + `4`
  (adler32). This is the oracle all adapters must reproduce.
- **M2** — `DecompressionStream('deflate')` acceptance is a **single non-monotone spike**:
  only the exact boundary decodes; a longer prefix throws *"Trailing junk found after the end
  of the compressed stream"* with no partial output; a shorter one throws incomplete. There is
  no signal to binary-search, and the API only finalizes on `close()`, so no incremental
  boundary detection either. A sub-linear zero-dep scan is **impossible** on this API.
- **M3** — `pako.Inflate().push()` exposes `strm.total_in` = exact member length (stops at the
  first member, leftover in `avail_in`). A direct pako dependency is technically viable.
- **M4** — pako costs ~7.6 kB gzip inflate-only (14.7 kB full) **per adapter**, ~76% of the
  10 kB/adapter budget; a hand-written decoder is ~330–430 LOC / ~2–3 kB gzip.
- **Bundler-polyfill probe** — the `zlib` polyfill a bundler injects for `require('zlib')` is
  `browserify-zlib`, which is itself pako-based (pinned old `pako ~1.0.5`) **and exposes no
  `bytesWritten`** (`hasBytesWritten:false` at every offset). It decodes but hides the cursor,
  so the bundler route yields nothing free — to get the boundary you fall through to its bundled
  pako's `total_in`, i.e. option (b) with a heavier, staler wrapper and a fragile
  consumer-bundler-config dependency.

"Zero dependencies" is a documented project north-star (README pitch); trading it away needs
its own justifying decision.

## Decision

1. **Hand-write a zero-dependency pure-JS DEFLATE/zlib decoder** rather than depend on pako
   or rely on a bundler polyfill (**ratified user judgment**, chosen with the M1–M4 +
   bundler-probe evidence in hand). It is the only approach that preserves the zero-dep
   north-star, reports `bytesConsumed` natively like Node, and stays inside the size budgets;
   the `DecompressionStream` binary-search alternative is empirically impossible (M2) and pako
   trades away the pitch for ~3× the bytes (M4) while the bundler form is strictly worse.

2. **Replace the O(n² progressive-prefix scan entirely** on both the browser and memory
   adapters (**adopted as recommended (no user judgment)**). A real streaming decoder reports
   the boundary natively, so the scan — and its 64 KiB safety cap and adler32-guessing — become
   dead code; no dual small-input/large-input path is kept.

3. **The decoder lives in a shared pure `src/adapters/inflate.ts`**, sibling to
   `src/adapters/adler32.ts` (which it reuses for the zlib trailer), consumed identically by
   both the browser and memory compressors (**adopted as recommended**). It carries no platform
   dependency.

4. **The Node adapter keeps native `createInflate().bytesWritten`** (**adopted as recommended**).
   Native `node:zlib` is faithful, fast, and battle-tested, and gives an **independent oracle**
   for the cross-adapter parity tests — unifying all three on the pure-JS path would forfeit that.

5. **Decode granularity is whole-member with an internal 32 KiB LZ77 window**, returning
   `{ output, bytesConsumed }` for one member (**adopted as recommended**); `bytesConsumed` =
   zlib header + DEFLATE blocks (to the post-`BFINAL` byte boundary) + 4-byte adler32. The
   separate `createInflateStream` transform (whole-object streaming for large blobs) is
   unchanged — it needs no boundary cursor.

`bytesConsumed` and `output` MUST be byte-identical to Node's `bytesWritten`/output (M1) across
node/browser/memory. Each pinned behaviour becomes a cross-adapter parity assertion; the
round-trip against Node's `zlib` and real pack fixtures pins faithfulness.

## Consequences

### Positive

- Browser/memory clone works for arbitrarily large compressed entries; the 64 KiB cap and the
  O(n²) scan are removed. Zero-dependency north-star preserved; no consumer bundler config, no
  bundle-size regression.
- A native, non-guessing boundary cursor on all three adapters, with Node's `node:zlib` retained
  as an independent parity oracle.

### Negative

- tsgit now owns ~330–430 LOC of RFC-1951 DEFLATE (bit-reader, fixed + dynamic Huffman, stored
  blocks, 32 KiB window, zlib framing). Mitigated by 100% coverage, property tests, round-trip vs
  Node `zlib`, and real-pack interop.

### Neutral

- `pako`/`browserify-zlib` (option b and the bundler route) are rejected on the north-star and
  size axes, not on capability — `strm.total_in` would have worked (M3). `DecompressionStream`
  stays in use only for `inflate`/`createInflateStream`, where no boundary cursor is needed.
