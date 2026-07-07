# Plan — Faithful `bytesConsumed` for browser/memory `streamInflate` (zero-dep inflate)

> Source: design doc `docs/design/browser-clone-inflate-cursor.md` · ADRs `459`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Decisions already settled (do NOT re-open)

Every load-bearing choice is pre-decided by **ADR-459** (accepted): hand-write a
zero-dep pure-JS DEFLATE/zlib decoder (DC-1=a); **replace** the O(n²) scan entirely
(DC-2); decoder lives at `src/adapters/inflate.ts` sibling to `adler32.ts` (DC-3);
Node keeps native `createInflate().bytesWritten` — untouched (DC-4); whole-member
decode with an internal 32 KiB window (DC-5). No open decision candidates remain.

**Planner surface decision (up front):** the new export `inflateZlibMember` is
**INTERNAL**. Precedent: `src/adapters/adler32.ts` → `adler32` is imported directly
by sibling adapters (`../adler32.js`) and appears in **no** barrel — verified: not in
`src/index.ts`, `src/index.browser.ts`, `src/adapters/index.ts`, or any adapter
`index.ts`. `inflateZlibMember` mirrors that exactly (imported as `../inflate.js`
by the memory + browser compressors only). It therefore trips **none** of the
public-surface gates in `.claude/workflow/surface-gates.md` — no barrel, no
`Repository` facade, no `reports/api.json` regen, no `docs/use/commands` page, no
error-union / exhaustiveness switch, no `README` count. No surface pre-payment is
owed by any part below.

**Coverage vs mutation note (load-bearing):** `vitest.config.ts` `coverage.include`
lists only `src/{domain,ports,operators}/**` + `src/adapters/{node,memory}/**` — so
`src/adapters/inflate.ts` (like `adler32.ts`) is **NOT** under the 100%-line validate
gate. Its real gate is **Stryker mutation**: `stryker.config.mjs` `mutate` =
`['src/**/*.ts','!src/**/index.ts','!src/**/*.d.ts','!src/adapters/browser/**/*.ts']`
→ `inflate.ts` and `memory-compressor.ts` ARE mutated; `browser-compressor.ts` is
**excluded**. Consequence, applied throughout: (1) the decoder needs an exhaustive
`test/unit` example + property suite that kills every guard/table/branch mutant
(integration tests are skipped under Stryker); (2) memory-compressor wiring mutants
are killed by its unit + contract tests; (3) browser-compressor carries no mutation
burden and is proven only by the e2e/parity harness.

---

## Part 1 — Decoder: bit-reader + zlib framing + stored blocks

### Context

Create the shared pure decoder module and land the framing skeleton that fully
round-trips **stored (BTYPE=00) zlib members** with a byte-exact `bytesConsumed`,
plus all malformed-input guards.

**Create** `src/adapters/inflate.ts` (pure, platform-free; imports only
`./adler32.js` and `../domain/index.js`):

- Export `inflateZlibMember(bytes: Uint8Array, offset: number): { output: Uint8Array; bytesConsumed: number }` — **synchronous**.
- Imports: `import { adler32 } from './adler32.js';` and
  `import { decompressFailed } from '../domain/index.js';`
  (`decompressFailed(reason: string)` is defined at `src/domain/error.ts:134` →
  `TsgitError` with `{ code: 'DECOMPRESS_FAILED', reason }`; error union member at
  `src/domain/error.ts:28`).
- Internal LSB-first **bit reader** over `bytes` starting at `offset`: `readBits(n)`,
  `alignToByte()`, a `bytePos` cursor, and a `readBytes(n)` for stored payload. It
  MUST guard end-of-buffer on every read and throw `decompressFailed('unexpected end of deflate stream')` — no raw `RangeError` may escape (the adapter delegates without re-wrap, so the decoder owns ALL error mapping).
- **zlib header parse** (2 bytes at `offset`): CMF/FLG. Validate `CM = CMF & 0x0f === 8`
  (else `decompressFailed('unsupported compression method')`), `CINFO = CMF >> 4 <= 7`
  (else `decompressFailed('invalid window size')`), `(CMF*256 + FLG) % 31 === 0` (FCHECK;
  else `decompressFailed('invalid zlib header checksum')`), and reject `FDICT = (FLG >> 5) & 1`
  (else `decompressFailed('preset dictionary not supported')`).
- **Block loop**: read `BFINAL` (1 bit) + `BTYPE` (2 bits); `switch (BTYPE)`:
  `case 0` = stored (implemented here); `default` = `decompressFailed('reserved block type')`.
  Repeat until a block with `BFINAL === 1`. (Parts 2/3 add `case 1`/`case 2`; the
  `default` line stays and permanently covers reserved BTYPE=3.)
- **Stored block**: `alignToByte()`, read `LEN` (2 bytes LE) + `NLEN` (2 bytes LE);
  verify `NLEN === (~LEN & 0xffff)` (else `decompressFailed('stored block length mismatch')`);
  copy `LEN` raw bytes into a growable output. Level-0 payloads > 65535 bytes span
  **multiple** stored blocks — the loop must handle that.
- **Output growth**: accumulate into a single growable `Uint8Array` (double on
  overflow, `subarray(0, len)` at the end). This same buffer is the LZ77 window in
  Part 2 (back-refs index into accumulated output → 32 KiB window is inherently
  satisfied, no ring buffer needed).
- **Trailer**: after `BFINAL`, `alignToByte()`, read the 4-byte big-endian adler32
  (`(b0<<24)|(b1<<16)|(b2<<8)|b3` as `>>> 0`); compare to `adler32(output)`; mismatch →
  `decompressFailed('adler32 checksum mismatch')`. `bytesConsumed = bytePos - offset`
  (final cursor minus start) = zlib header(2) + block bytes + trailer(4). This is the
  value M1 pins (`node:zlib createInflate().bytesWritten`).

**Create** `test/unit/adapters/inflate.test.ts` (sibling to the existing
`test/unit/adapters/adler32.test.ts`). Oracle for producing stored members:
`import { deflateSync } from 'node:zlib'` and `deflateSync(x, { level: 0 })` (forces
stored blocks). Conventions: `describe('Given …')` > `describe('When …')` > `it('Then …')`,
AAA body, `const sut = inflateZlibMember`. Error assertions on
`(err as TsgitError).data.code === 'DECOMPRESS_FAILED'` (per project mutation-resistance
rule — never bare `toThrow`); each guard tested in isolation.

### TDD steps

1. **RED** — `it` "Given a level-0 (stored) zlib member, Then round-trips with byte-exact bytesConsumed": `deflateSync(new Uint8Array([1,2,3,4,5]), { level: 0 })` → `sut(member, 0)` expects `output` equal to input and `bytesConsumed === member.length`. Fails: `inflate.ts` does not exist.
2. GREEN — create `inflate.ts` with bit reader, zlib framing, single stored block, trailer verify, `bytesConsumed`.
3. **RED** — "Given a stored member > 65535 bytes (multi stored block), Then round-trips": `deflateSync(randomBytes(70000), { level: 0 })`. Fails until the block loop iterates past one stored block. GREEN — loop until `BFINAL`.
4. **RED** — "Given two stored members concatenated, When decoding at member-1 offset, Then returns only member 1 and its exact length": deflate two payloads at level 0, concat, decode at `[0]` then at `bytesConsumed`. Fails until `bytesConsumed` stops exactly at the trailer. GREEN.
5. **RED** (guards, one test each) — bad `CM` (`member[0]` low nibble ≠ 8), `CINFO > 7`, bad FCHECK, `FDICT` set, `NLEN` mismatch, adler32-mismatch (flip a trailer byte), truncated member (`member.subarray(0, member.length-2)`), reserved BTYPE=3 (hand-set the block-header bits), non-zlib junk (`new Uint8Array([0xff,0xff,0xff,0xff])`). Each asserts `.data.code === 'DECOMPRESS_FAILED'`. GREEN — add each guard minimally.
6. REFACTOR — extract the bit reader / header parse / stored reader into small named functions (<20 lines each, early returns); confirm no magic numbers left unnamed (name RFC constants: `ZLIB_CM_DEFLATE`, `WINDOW_MAX_CINFO`, `FCHECK_MOD`, `ADLER_BYTES = 4`).

### Gate

`npx vitest run test/unit/adapters/inflate.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/inflate.ts test/unit/adapters/inflate.test.ts`

### Commit

`feat: zero-dep inflate decoder — bit reader, zlib framing, stored blocks`

---

## Part 2 — Decoder: fixed-Huffman blocks + Huffman machinery + back-reference copy

### Context

Extend `src/adapters/inflate.ts` (from Part 1) to decode **fixed-Huffman blocks
(BTYPE=01)**, adding the reusable Huffman machinery that Part 3 also consumes.

**Edit** `src/adapters/inflate.ts`:

- **Canonical table builder** `buildHuffmanTable(codeLengths: ReadonlyArray<number>)`
  → a decode structure usable by `decodeSymbol(reader, table)`. Standard canonical
  Huffman: count lengths, compute first-code per length, assign codes, build a lookup
  (a `{ counts, symbols }` pair with a bit-at-a-time walk is simplest and mutation-clean;
  avoid a fast-table if it multiplies magic constants). Malformed/over-subscribed
  lengths → `decompressFailed('invalid huffman code lengths')`.
- **RFC 1951 constant tables** (name them): `LENGTH_BASE[29]`, `LENGTH_EXTRA[29]`,
  `DIST_BASE[30]`, `DIST_EXTRA[30]`, code-length symbol order (used in Part 3).
- **Fixed literal/length + distance code lengths** (lit/len: 8 bits for 0–143, 9 for
  144–255, 7 for 256–279, 8 for 280–287; dist: 5 bits × 30). Build the two fixed tables
  **once at module scope** via `buildHuffmanTable` (built once, reused per call).
- **Block-body loop** (shared by fixed + dynamic): given a lit/len table and a dist
  table, `decodeSymbol` until end-of-block (256): `< 256` → append literal to output;
  `256` → end block; `257–285` → read `LENGTH_EXTRA` extra bits over `LENGTH_BASE`,
  decode a distance symbol, read `DIST_EXTRA` over `DIST_BASE`, then **back-reference
  copy** `length` bytes from `outputLen - distance` (byte-by-byte so overlapping
  copies — `distance < length` — replicate correctly). Guard `distance > outputLen` →
  `decompressFailed('distance exceeds output')`.
- Wire the block `switch`: add `case 1` → run the block-body loop with the fixed tables.
  `case 0` (Part 1) and `default` unchanged.

**Edit** `test/unit/adapters/inflate.test.ts`: add fixed-block cases. Producing a
**fixed** block deterministically: tiny inputs (empty, 1–4 bytes) make zlib choose
fixed Huffman. To avoid silent block-type drift across zlib versions, the test's
Arrange MUST assert the member actually uses BTYPE=01 (read `BFINAL/BTYPE` from the
first byte after the 2-byte header: `(member[2] >> 1) & 0b11 === 1`) before asserting
the round-trip — a drift then fails loudly instead of skipping the path. For
back-reference coverage, a short repetitive payload (`'abc'` repeated, ~40 B)
that stays a single fixed block exercises length/distance copy including an
overlapping copy.

### TDD steps

1. **RED** — "Given the empty payload (`deflateSync(new Uint8Array())`), Then round-trips to empty with exact bytesConsumed" (zlib emits a fixed empty block: end-of-block code only). Fails: `case 1` unimplemented → hits `default` → throws. GREEN — add `buildHuffmanTable`, fixed tables, block-body loop, `case 1`.
2. **RED** — "Given a fixed-Huffman member with a back-reference (repetitive payload), Then round-trips": assert BTYPE=01 in Arrange, then decode. Fails until length/distance + back-ref copy work. GREEN.
3. **RED** — "Given a back-reference with distance < length (overlapping run), Then bytes replicate": a run-length payload (e.g. `'aaaaaaaaaaaa'`). Fails if the copy reads a snapshot instead of byte-by-byte. GREEN — byte-by-byte copy.
4. **RED** — guard tests: `distance > outputLen` and over-subscribed code lengths → `.data.code === 'DECOMPRESS_FAILED'` (hand-craft minimal bad blocks). GREEN.
5. REFACTOR — factor `decodeSymbol`, the block-body loop, and the constant tables into named units; verify every `LENGTH_*`/`DIST_*` entry is reachable via the tests added here + the Part 3 property suite (note the residual gaps for Part 3’s property net to close).

### Gate

`npx vitest run test/unit/adapters/inflate.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/inflate.ts test/unit/adapters/inflate.test.ts`

### Commit

`feat: zero-dep inflate decoder — fixed-Huffman blocks and back-references`

---

## Part 3 — Decoder: dynamic-Huffman blocks + property/round-trip suite

### Context

Complete the decoder with **dynamic-Huffman blocks (BTYPE=10)** and ship the required
round-trip **property** sibling that proves the whole DEFLATE grammar (ADR-134…136
case 1). After this part `inflateZlibMember` decodes every block type and is fully
mutation-covered.

**Edit** `src/adapters/inflate.ts`:

- **Dynamic header decode**: read `HLIT = readBits(5)+257`, `HDIST = readBits(5)+1`,
  `HCLEN = readBits(4)+4`; read `HCLEN` 3-bit code-length-code lengths in the RFC order
  (`[16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]` — name it `CL_ORDER`); build the
  code-length table via `buildHuffmanTable`. Then decode `HLIT + HDIST` code lengths
  using it, honouring the RLE symbols: `16` (copy previous length, `readBits(2)+3`
  times — guard "no previous length"), `17` (repeat zero `readBits(3)+3`), `18`
  (repeat zero `readBits(7)+11`). Split into the lit/len (`HLIT`) and distance
  (`HDIST`) length arrays, build both tables via `buildHuffmanTable`, run the **shared
  block-body loop** from Part 2. Wire `case 2` into the block `switch`. Guard a length
  run that overflows the declared count → `decompressFailed('invalid code-length run')`.

**Edit** `test/unit/adapters/inflate.test.ts`: add dynamic-block example cases —
a larger structured payload (~1–2 KB of mixed text, e.g. repeated varied lines) that
zlib encodes as a dynamic block (assert BTYPE=10 in Arrange, same drift-guard as
Part 2); a payload exercising a back-reference whose distance spans **> 32 KiB**
(e.g. `randomBytes` prefix + a repeat of an early 4 KB slice at offset > 32768, so the
distance reaches back across the window); and RLE-guard cases (bad code-length run).

**Create** `test/unit/adapters/arbitraries.ts` — shared generators (house layout:
per-family `arbitraries.ts` beside the property file, cf. `test/unit/domain/*/arbitraries.ts`).
Export `arbBytes()` = `fc.uint8Array({ minLength: 0, maxLength: 4096 })` and a
`arbBytesList()` = `fc.array(arbBytes(), { minLength: 1, maxLength: 5 })` for the
concat invariant.

**Create** `test/unit/adapters/inflate.properties.test.ts` — model on
`test/unit/application/primitives/enumerate-objects.properties.test.ts`
(`import fc from 'fast-check'`; `fast-check` is a devDependency — confirmed in
`package.json`). Oracle = `deflateSync` from `node:zlib` (independent of the SUT).
`const sut = inflateZlibMember`.

- **Round-trip lens** (`numRuns: 200`, cheap): `Given arbitrary bytes x`, let
  `m = deflateSync(x)` (default level → dynamic/fixed mix), assert `sut(m, 0)` equals
  `{ output: x, bytesConsumed: m.length }`.
- **Concat-boundary invariant** (`numRuns: 200`): `Given a list [x₀…xₙ]`, deflate each
  (`deflateSync(xᵢ)`), concat; walk offsets: decoding at the running offset yields `xᵢ`
  and advances by exactly `deflateSync(xᵢ).length`. Mirrors the real pack-walk
  (`fetch-pack.inflateAllEntries`) advancing by `bytesConsumed`.

### TDD steps

1. **RED** — dynamic-block example "Given a dynamic-Huffman member, Then round-trips" (assert BTYPE=10 in Arrange). Fails: `case 2` unimplemented → `default` throws. GREEN — add dynamic header decode + `case 2`.
2. **RED** — ">32 KiB distance back-reference round-trips". GREEN (Part 2's back-ref already indexes full output; this confirms the window depth). 
3. **RED** — RLE guard tests (`16` with no previous, run overflow) → `.data.code === 'DECOMPRESS_FAILED'`. GREEN.
4. **RED** — property suite (`inflate.properties.test.ts` + `arbitraries.ts`): round-trip + concat invariant, both `numRuns: 200`. Run — must pass over arbitrary payloads (this is the mutation net for the Huffman tables/constants). If it shrinks to a counterexample, fix the decoder (never pin a seed). GREEN.
5. REFACTOR — dedupe dynamic/fixed table construction through the shared builder + block-body loop; re-run the property suite to confirm still green.

### Gate

`npx vitest run test/unit/adapters/inflate.test.ts test/unit/adapters/inflate.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/inflate.ts test/unit/adapters/inflate.test.ts test/unit/adapters/inflate.properties.test.ts test/unit/adapters/arbitraries.ts`

### Commit

`feat: zero-dep inflate decoder — dynamic-Huffman blocks and round-trip properties`

---

## Part 4 — Wire MemoryCompressor + parity contract + faithfulness interop

### Context

Replace the memory adapter's O(n²) scan with the Part 3 decoder, extend the shared
parity contract with a > 64 KiB-compressed member, and pin git-faithfulness with a
real-pack interop test on the memory adapter. Memory-compressor is Stryker-mutated →
its wiring mutants are killed here by the unit + contract tests (integration is skipped
under Stryker, so the interop test is a faithfulness pin only, not mutation coverage).

**Edit** `src/adapters/memory/memory-compressor.ts`:

- Replace the whole `streamInflate` body (currently `src/adapters/memory/memory-compressor.ts:49-80`, the progressive-prefix loop) with a thin delegate:
  `streamInflate = async (bytes, offset) => inflateZlibMember(bytes, offset);`
  (the decoder throws `decompressFailed` itself, so no re-wrap is needed — a rejected
  promise carries the typed error).
- Delete the `MEMORY_STREAM_INFLATE_MAX_INPUT` constant (`:5-10`) and its doc comment.
- Replace `import { adler32 } from '../adler32.js';` (`:3`) with
  `import { inflateZlibMember } from '../inflate.js';` — `adler32` is now unused in this
  file (biome `noUnusedImports` will fail otherwise). `runTransform` and `describeError`
  stay (still used by `deflate`/`deflateRaw`/`inflate`).
- Leave `createInflateStream`, `deflate`, `deflateRaw`, `inflate` untouched.

**Edit** `test/unit/ports/compressor.contract.ts` (runs for **memory** via
`test/unit/adapters/memory/memory-compressor.test.ts:14` and **node** via
`test/unit/adapters/node/node-compressor.test.ts:7`): extend the streamInflate coverage
with a **> 64 KiB-compressed** member. Add an `it` "Given a member whose compressed
form exceeds 64 KiB, When streamInflate, Then returns exact output and bytesConsumed":
build `data = crypto.getRandomValues(new Uint8Array(100 * 1024))` (random ⇒ poorly
compressible ⇒ deflated length > 64 KiB), `deflated = await sut.deflate(data)`,
concat with a second member, assert `streamInflate` at `[0]` returns `{ output: data,
bytesConsumed: deflated.length }` and advances to the second. This proves the old cap
is gone AND that memory ≡ node byte-for-byte on `{ output, bytesConsumed }`. Keep every
existing contract case unchanged (regression).

**Edit** `test/unit/adapters/memory/memory-compressor.test.ts` — the scan-specific
tests are now obsolete:
- **Delete** "Given streamInflate input above the safety cap" (`:106-128`) — cap removed.
- **Delete** "Given streamInflate input exactly at the safety cap …" (`:130-149`) — cap removed (large-member success now lives in the contract extension above).
- **Delete** "Given a buffer where DecompressionStream succeeds on a truncated prefix (Deno/Workers)" (`:178-226`) and "Given a DecompressionStream whose writable.close() rejects (workerd)" (`:228-301`) — both mock the scan's `DecompressionStream` use; `streamInflate` no longer touches it.
- **Update** "Given bytes that never form a valid zlib stream within the cap" (`:151-176`): keep a corrupt-`streamInflate` → `DECOMPRESS_FAILED` case, but assert only `data.code === 'DECOMPRESS_FAILED'` (the old exact reason `'no valid zlib stream at offset'` is gone; the decoder now emits its own reasons — do not pin a specific decoder reason string here).
- The `deflate`/`deflateRaw`/`inflate`/constructor tests are untouched.
- After deletion, run `npm run test:coverage` and confirm `memory-compressor.ts` stays 100% (the corrupt-`inflate` contract case still drives `runTransform`'s error path incl. the `.catch(() => {})` writable-rejection arm; if a line shows uncovered, add a minimal corrupt-input `inflate` test — do NOT add a `v8 ignore`).

**Create** `test/integration/memory-large-compressed-pack-interop.test.ts` —
faithfulness pin. Model on `test/integration/large-object-pack-interop.test.ts` and use
`test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `makePeerPair`, `initBothRepos`,
`git`, `runGitEnv`). `describe.skipIf(!GIT_AVAILABLE)`. Steps: create a peer repo, set
`commit.gpgsign false` + user identity; write `big.bin = randomBytes(100_000)` (random
⇒ compressed entry > 64 KiB); `git add` + `git commit`; capture the blob OID via
`git rev-parse HEAD:big.bin`; `git gc --quiet`; read the packed `.pack` bytes from
`objects/pack/*.pack`; build `const ctx = createMemoryContext()`
(`import { createMemoryContext } from '../../src/adapters/memory/memory-adapter.js'`);
call `const walked = await walkPackEntries(ctx, packBytes)`
(`import { walkPackEntries } from '../../src/application/primitives/fetch-pack.js'`);
assert `walked.map(w => w.id)` **contains the git blob OID** (and the commit + tree OIDs
from `git rev-parse HEAD` / `HEAD^{tree}`). Because each `WalkedEntry.id` is
`sha1(header+inflated)`, a wrong inflation or wrong `bytesConsumed` on the preceding
entry would desync the walk and the OID would not match git — so OID-set containment is
a strict byte-for-byte faithfulness proof across the > 64 KiB-compressed boundary on the
memory adapter. Add a `@proves` header block mirroring the large-object interop file.
Use `{ timeout: 60_000 }` on the `it` (real git + gc).

### TDD steps

1. **RED** — the contract `> 64 KiB-compressed member` case, run against memory: `npx vitest run test/unit/adapters/memory/memory-compressor.test.ts`. Fails today with `DECOMPRESS_FAILED … 64 * 1024 byte safety cap` (the old scan cap). 
2. **RED** — the memory interop test: fails today (memory `streamInflate` throws the cap error inside `inflateAllEntries`).
3. GREEN — apply the `memory-compressor.ts` edit (delegate to `inflateZlibMember`, drop the cap + `adler32` import). Both the contract case and the interop pass; node keeps passing (unchanged path).
4. GREEN — delete/update the obsolete scan tests in `memory-compressor.test.ts`; run the memory unit file + `npm run test:coverage`; confirm green and 100%.
5. REFACTOR — none expected (the delegate is already minimal); confirm `biome check` clean (no unused `adler32`).

### Gate

`npx vitest run test/unit/adapters/memory/memory-compressor.test.ts test/unit/adapters/node/node-compressor.test.ts test/integration/memory-large-compressed-pack-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/adapters/memory/memory-compressor.ts test/unit/ports/compressor.contract.ts test/unit/adapters/memory/memory-compressor.test.ts test/integration/memory-large-compressed-pack-interop.test.ts`

### Commit

`feat: memory streamInflate uses zero-dep decoder — removes 64 KiB clone cap`

---

## Part 5 — Wire BrowserCompressor + browser streamInflate e2e parity

### Context

Mirror the memory wiring on the browser adapter and prove it in-browser via the
Playwright e2e harness. `browser-compressor.ts` is **excluded** from Stryker mutation
AND from `vitest.config.ts` `coverage.include`, and it is not exercised by the Node
unit runner (`Blob`/`Response`/`DecompressionStream` DOM path) — so its proof is the
e2e/parity harness, not `test/unit`. Byte-for-byte faithfulness for browser is covered
transitively: browser ≡ memory via the shared decoder + the streamInflate byte-parity
e2e below, and memory ≡ real git via Part 4's interop pin.

**Edit** `src/adapters/browser/browser-compressor.ts`:

- Replace the whole `streamInflate` body (`src/adapters/browser/browser-compressor.ts:63-97`, the progressive-prefix loop) with a thin delegate:
  `async streamInflate(bytes, offset): Promise<InflateStreamResult> { return inflateZlibMember(bytes, offset); }`.
- Delete `BROWSER_STREAM_INFLATE_MAX_INPUT` (`:5-11`).
- Replace `import { adler32 } from '../adler32.js';` (`:4`) with
  `import { inflateZlibMember } from '../inflate.js';` (`adler32` now unused → biome
  fails otherwise). Keep the `/// <reference lib="dom" />` pragma and the
  `import type { Compressor, InflateStreamResult }` line. `deflate`/`deflateRaw`/
  `inflate`/`createInflateStream` untouched.

**Edit** `test/browser/decompression-stream.spec.ts` — add a browser streamInflate
case. The bundle exposes `window.__tsgit.adapters.BrowserCompressor` (cf. the existing
`readyPage.evaluate` blocks in this file at `:20-39` and `:51-74`). Add a `test`
"Given a > 64 KiB-compressed member concatenated with a second, When streamInflate,
Then returns exact output and bytesConsumed for each and no longer throws a cap error":
inside `readyPage.evaluate`, construct `new tsgit.adapters.BrowserCompressor()`, build
`data = crypto.getRandomValues(new Uint8Array(100 * 1024))`, `deflated = await c.deflate(data)`,
concat with a second member, call `streamInflate` at `0` then at `bytesConsumed`, and
return sizes + a byte-equality flag; assert member-0 `bytesConsumed === deflated.length`
and both outputs match. This proves the browser adapter now uses the zero-dep decoder
(the old code would throw the `64 * 1024 byte safety cap` error at this size).

### TDD steps

1. **RED** — add the browser streamInflate e2e case; run `npm run test:e2e` (Playwright). Fails today: the browser adapter throws the 64 KiB cap error for a 100 KiB-compressed member.
2. GREEN — apply the `browser-compressor.ts` edit (delegate to `inflateZlibMember`, drop the cap + `adler32` import). The e2e case passes; the existing deflate/inflate round-trip + DECOMPRESS_FAILED cases stay green.
3. REFACTOR — none expected; confirm `biome check` clean (no unused `adler32`) and `npm run build` / `npm run check:size` still within the 10 kB per-adapter + 335 kB full-library budgets (`inflate.ts` adds ~2–3 kB gzip to both adapter bundles; well inside).

### Gate

`npm run test:e2e && npm run check:types && ./node_modules/.bin/biome check src/adapters/browser/browser-compressor.ts test/browser/decompression-stream.spec.ts`

(Phase-boundary gate for the whole change is `npm run validate`; the browser e2e is not
part of the Node vitest run, so it is invoked explicitly here.)

### Commit

`feat: browser streamInflate uses zero-dep decoder — removes 64 KiB clone cap`
