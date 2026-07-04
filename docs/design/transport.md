# Design: Transport

**Status: Draft** — Phase 8 of the [backlog](../BACKLOG.md).

### Review Notes

Changes applied across five self-review passes (architecture → security → performance → API/types → testability):

- **§3 / §6.4 `ZERO_OID` gap closed.** Receive-pack create/delete encodes `0000…` (40 ASCII zeros). The constant did not exist in `domain/objects/`; design now adds `ZERO_OID: ObjectId` to `object-id.ts` (one-liner, 40-byte string) rather than re-deriving it inside `domain/protocol/`. Single source of truth.
- **§5.2 Basic-auth UTF-8 bug fixed.** Round-1 draft used `btoa(user + ':' + pwd)`, which corrupts non-ASCII (RFC 7617 mandates UTF-8). New spec routes through `TextEncoder` then byte-level base64 (`String.fromCharCode(...bytes)` → `btoa`), matching browser-side and Node `Buffer.from(str, 'utf8').toString('base64')` outputs.
- **§6.3 progress double-spec resolved.** Round-1 declared both `progressEvents: ReadonlyArray<string>` and an `onProgress` callback. Removed the array (callback-only); `UploadPackResponse` no longer materializes progress, matching the §4.4 callback contract.
- **§7 added `parseCapabilities` + `formatCapabilities` specs.** Listed in §2 module table but had no signatures in earlier draft.
- **§7 agent string versioning made concrete.** Round-1 said "rewritten at build time" without naming a mechanism. Now specified: `agent` is built from `process.env.npm_package_version` at module load, falling back to a baked literal for browsers — no rollup plugin needed.
- **§5.1 `delay` primitive contract pinned.** Default implementation uses `setTimeout` + an `AbortController` listener that rejects with the signal's `reason`. Specifies `delay(0, signal)` resolves on the next microtask (not `setTimeout(0)` which is ~4 ms minimum) so zero-jitter / `baseMs: 0` doesn't accidentally pay a 4 ms tax.
- **§5.3 `Logger.log` synchronous-only contract recorded.** Async logging would force `withLogging` to `await` every event, serializing the request hot path on the user's logger latency. Sync-only is the contract; users wanting async writes must enqueue internally.
- **§6.1 `buildDiscoveryUrl` `.git` suffix policy clarified.** The function does not append/strip — caller-supplied URL is appended with `/info/refs?service=...` verbatim. Avoids surprising mutations of user URLs.
- **§4.3 final-newline policy pinned.** Pkt-line payloads include the trailing `\n` if the producer wrote one. The decoder does NOT strip; the parser tier (e.g. `parseAdvertisedRefs`) trims `\n` from line-oriented commands. Keeps the wire format pristine.
- **§5.2 case-insensitive header lookup specified.** `withAuth` iterates `Object.keys(req.headers)` and skips when any key lowercases to `authorization`. Avoids overwriting a per-call override that used a different case (`Authorization` vs `authorization`).
- **§11 added `package.json` export entry to deliverables.** New `./transport` export under `exports`, matching the pattern for `./primitives` and `./operators`. Without it, `import { withRetry } from 'tsgit/transport'` resolves to nothing.
- **§1 budget table now references the new size-limit entry explicitly.** Step 11 in §12 adds a `Transport` entry to `.size-limit.json` (2 kB gzipped). The protocol code lives under domain — the existing 50 kB Core cap absorbs it; design notes the residual budget so we don't blow Core when domain bundles include `domain/protocol/*`.
- **§5.1.2 retry idempotency caveat added.** `withRetry` retries POST requests, which is **not** idempotent in HTTP terms. For smart-HTTP this is safe because: (a) discovery is GET; (b) `git-upload-pack` is read-only on the server (negotiation produces a pack but does not mutate state); (c) `git-receive-pack` updates are gated by `oldId` ref check on the server, so a retried push either no-ops (already applied) or fails with a stale-ref error which is itself non-retryable. Documented so future custom-retry users don't break the invariant.
- **§9.1 `INVALID_PKT_LENGTH.value` typed correctly.** Round-1 draft used `string` for the offending bytes, which loses information when the bytes contain non-printable chars. Switched to a hex-encoded 4-char preview (already a string, but documented as ASCII-hex of the raw bytes).
- **§10.5 isolated tests for every guard clause** per CLAUDE.md mutation rule. Validation table broken out into one test per condition, not a single combined "throws on bad input" test.

**Pass 2 — security & error edge cases:**

- **§4.3 chunk-reassembly buffer cap.** Decoder buffer is bounded by `MAX_PKT_LINE_PAYLOAD + 4` (~65 KB). If a chunk arrives that pushes the buffer beyond this without yielding a complete packet, `PKT_TOO_LARGE` is raised. Prevents a malicious server from blowing memory by streaming bytes that never form a valid length prefix.
- **§4.4 / §6.3 callback safety.** `onProgress` and `onError` callbacks are invoked inside `try/catch`; thrown errors are swallowed (with no console noise — the iterator continues). Rationale: a misbehaving progress reporter must not crash the protocol parser. Documented as part of the contract so users don't expect rethrow.
- **§5.3 `Logger.log` thrown error policy.** Same — `withLogging` wraps `logger.log(event)` in `try/catch` and swallows. A logger crash must never break the HTTP request. (Strictly, the user's request is now both succeeded *and* unlogged — preferable to silently dropping the request.)
- **§5.3 URL query-string redaction.** Some auth flows pass tokens via `?access_token=...` (OAuth implicit flow, GitHub's PAT-as-query). `withLogging` rebuilds the logged URL with the query string stripped if any param key matches `/access_token|api[_-]?key|password|secret|token/i`. Path is preserved. Documented in §8.1.
- **§6.1 `buildDiscoveryUrl` query-string handling.** If `baseUrl` already contains `?`, the function uses `&service=…` instead of `?service=…`. URLs containing fragments (`#`) trigger `INVALID_BASE_URL`. Spec uses `URL` constructor for parsing — no string concat shortcuts.
- **§5.2 custom-auth empty value.** If the `custom` async function returns `''`, `null`, or `undefined`, the middleware throws `TypeError('withAuth: custom returned empty value')` — failing loud at the call site rather than sending a malformed `Authorization: ` header.
- **§5.1.3 `body.cancel()` failure tolerance.** When draining a failed retry's response body, `withRetry` calls `response.body.cancel()` inside `try/catch`; cancellation failures are swallowed (the underlying socket cleanup happens at the adapter layer regardless).
- **§8.1 body-immutability contract recorded.** Adapters MUST treat `req.body` as immutable. `NodeHttpTransport` already does (`Buffer.from(req.body)` copies). Documented as a port contract obligation so future adapters don't break retries.
- **§4.4 channel-3 size cap derives from packet cap.** A pathological server pushing a massive channel-3 message is naturally bounded by `MAX_PKT_LINE_PAYLOAD` per packet; `parseSideBand` accumulates at most one packet's worth of channel-3 payload before raising `SIDEBAND_FATAL` (no concatenation across packets — first channel-3 packet ends the stream).

**Pass 3 — performance & streaming hot paths:**

- **§4.2 encoder length-prefix is branchless.** Length prefix uses `(len + 0x10000).toString(16).slice(-4)` — one bit-or, one toString, one slice. Avoids `padStart` (which allocates an intermediate `String` and walks character-by-character). Discovery has typically 1–10 pkt-lines, but pack request can have 1000s of want/have lines; this matters at scale.
- **§4.2 single-pass write into pre-sized Uint8Array.** `encodePktStream(payloads)` computes total size first (`sum(p.byteLength + 4) + 4` for the trailing flush), allocates one buffer, then `set()`s payloads at known offsets. No intermediate concat, no `Buffer.concat`-style reallocations. Hot path for push (10K+ ref updates).
- **§4.3 decoder allocates one `TextDecoder` per stream, not per packet.** Reused across all data packets. Same instance handles UTF-8 progress text in `parseSideBand` (fed only complete packet payloads — stream-decoder reset between channels not needed).
- **§4.3 chunk reassembly uses `Uint8Array.set` not `Buffer.concat`.** Buffer is a `Uint8Array` of capped capacity (§4.3 reassembly cap). When a new chunk arrives, copy directly into the buffer at `usedLen`; do not allocate a new buffer per chunk. Adapter chunks can arrive at 16 KB granularity — a clone-per-arrival is `O(n²)`.
- **§6.3 `packBody` lazy with no copy.** `parseUploadPackResponse` returns `packBody` as a generator that yields the raw `payload` slice from each channel-1 pkt-line — no concatenation. The Phase 2 `parsePackfile` consumer accepts an `AsyncIterable<Uint8Array>` directly. Memory ceiling for clone is one packet (~64 KB) at any given time, regardless of pack size.
- **§5.1 jitter computed without `Math.random()` allocations.** Single `Math.random()` call per attempt, multiplied into the delay value: `delayMs = base * (1 - jitter + 2 * jitter * Math.random())`. No `Array.from`, no spread. Negligible per-call but documented to prevent regressions.
- **§5.3 `now` calls are amortized.** `withLogging` records `start = now()` once per request, computes `elapsedMs = now() - start` once at completion. No mid-flight measurements. `performance.now()` is fast (~30 ns) but two calls per request × 1000 fetches = 60 µs that we don't have to spend.
- **§7 `parseCapabilities` uses `string.split(' ')`, not regex.** Capability tail is small (typically <300 bytes) and space-separated. `split(' ')` is O(n) and avoids RegExp engine warmup (~10 µs first-call cost).

**Pass 4 — API surface & TypeScript correctness:**

- **§5.1 `RetryConfig.attempts` named clearly.** "Attempts" includes the first request — `attempts: 1` means "no retries". Documented in the JSDoc to avoid the off-by-one trap from "retries: 3" semantics. Validation message reflects the meaning.
- **`HttpTransport.request` is a property, not a method.** Tests of middleware must spread the inner transport (`{ ...inner, request: wrappedRequest }`) — not `Object.create`-and-overwrite, which breaks structural typing for `readonly` properties. Documented in §5 prelude.
- **§5.1 `RetryPredicate` `info` shape uses optional `error`/`response` instead of a discriminated union.** The exclusivity ("error XOR response") is true at runtime but encoding it as a DU forces every consumer through a switch. Two optional fields with the documented contract is friendlier and matches RxJS `RetryConfig`'s shape.
- **§6.1 `Advertisement.head` typed as `AdvertisedRef | undefined`** rather than `null`. Project convention is to use `undefined` for absence (matches `domain/git-index/index-entry.ts`, `WantHaveRequest.depth`, etc.).
- **§5 type-only imports note.** Middleware files use `import type { HttpTransport, HttpRequest, HttpResponse } from '../ports/http-transport.js'` — runtime imports would create a value dep and the dep-cruiser rule would still pass, but type-only is leaner and signals intent.
- **§9.1 `ProtocolError` integration with `TsgitErrorData`.** Concrete patch: `domain/error.ts` `TsgitErrorData = ... | ProtocolError`. `extractDetail()` gains 12 new switch arms (one per ProtocolError variant). Pattern is mechanical — matches existing `RefsError` / `IndexError` integration. Listed in §12 step 6 as a single atomic edit.
- **`encodePktStream` parameter order: `(payloads)` not `(payloads, options)`.** The trailing flush is part of the contract — there is no opt-out. If a future caller needs "pkt-lines with no trailing flush", expose `encodePktLine` per-payload + manual concat instead of bloating the API.
- **§5.2 `AuthConfig.custom`'s `header` callback parameter is the `HttpRequest`.** Originally underspecified — the function may need the URL or method to compute signed headers (e.g. AWS SigV4-style). The signature `(req: HttpRequest) => string | Promise<string>` already covers this; documented in §5.2.
- **§4.1 `PktLine` `kind: 'data'` carries `Uint8Array` view, not copy.** Mentioned in §4.3 perf notes but worth surfacing here: the `payload` field is a slice of the decoder's internal buffer. Consumers that retain payloads beyond the iteration must `.slice()` themselves. This matches the project's stat cache pattern (Phase 3 `index-parser.ts`).
- **§6.2 `WantHaveRequest.capabilities` empty array allowed.** Some servers tolerate "no capabilities" on the first want; advertised v0 protocol behavior. Validated at the parser tier (server's discovery would have signaled the empty cap set), not at `buildUploadPackRequest`.

**Pass 5 — testability, mutation resistance, impl ordering:**

- **§10 mutation-resistant assertions everywhere.** Per CLAUDE.md, pkt-line tests use `try/catch` + direct `.data.code` and `.data.value` assertions, NOT `toThrow(TsgitError)`. Updated §10.2 fixture table to show what each test asserts (not just the input shape).
- **§10.5 `withRetry` validation — one test per guard.** CLAUDE.md "guard clauses need isolated tests": the 5 `RangeError` guards become 5 separate tests. A single combined test would not kill `&&`-vs-`||` mutants.
- **§12 impl ordering corrected.** Step 6 (error wiring) was scheduled AFTER pkt-line and side-band — but those need `protocolError(...)` factories at red-step. Moved §12 step 6 (error scaffold) BEFORE step 1; the actual variant additions stay distributed (each step adds the cases it raises).
- **§10.2 boundary tests for `MAX_PKT_LINE_PAYLOAD ± 1`.** Three explicit tests pin the boundary: `len = MAX_PKT_LINE_PAYLOAD` succeeds, `MAX_PKT_LINE_PAYLOAD + 1` throws `PKT_TOO_LARGE`, `MAX_PKT_LINE_PAYLOAD - 1` succeeds. Together kills `<`-vs-`<=` and `>`-vs-`>=` mutants.
- **§10.5 `withRetry` retry-count boundary.** Three tests: `attempts: 1` (no retry — boundary against `> 1`), `attempts: 2` (one retry on first failure), `attempts: 10` (max — boundary against `< 10` vs `<= 10`).
- **§10.5 `defaultIsRetryable` table-driven.** Each status-code branch tested in isolation: `429`, `500`, `501` (NOT retryable per spec carve-out), `599`, `600`, `200`, `404`. Plus error-without-response. Table format mirrors the predicate's branch structure to guarantee 1:1 coverage.
- **§10.6 mutation targets revised** to require 100% on `pkt-line.ts`, `with-retry.ts`, and `capabilities.ts` (densest control-flow per byte). 95% on `with-auth.ts`, `with-logging.ts`, `side-band.ts`. Larger parsers (`upload-pack.ts`, `receive-pack.ts`) target ≥ 90% with the rest documented as equivalent (e.g. ack-status string-position tweaks where any non-zero index produces the same parse failure).
- **§10.7 fixture regeneration script.** `scripts/regenerate-transport-fixtures.ts` documented to require a working `git` CLI + a small init script that creates `test/fixtures/transport/repo/` with one commit. Reproducibility matters for fixture refresh on protocol changes.
- **`tests/unit/transport/fixtures.ts`** — gains a `recordingLogger()` returning `{ logger, events }` so tests assert on `events[i]` not on call counts; a `fakeClock()` returning `{ now, advance }` for `withLogging` deterministic timing; a `fakeTransport({ responses, errors })` array-driven mock for `withRetry` sequence tests.
- **§10.5 cancellation test wires through `delay`.** Test passes a custom `delay` returning a `Promise` that never resolves, then aborts the signal — asserts the rejected promise reaches the caller within one microtask (no leaked timer). Pinning the cancellation contract is critical because the default `delay`'s `setTimeout` is hard to assert under fake timers without test pollution.
- **§12 size-limit gate is a separate step, not bundled with impl.** Step 11 (size check) explicitly comes after all impl steps so a regression isolates clearly. Bundling size-limit checks per-step would mask incremental drift.

---

## 1. Overview

Phase 8 ships two distinct deliverables that share a layer name but live in different folders:

1. **Smart HTTP protocol v1** — pkt-line framing + discovery / negotiation
   message construction. Pure parsers and serializers. Lives in
   `src/domain/protocol/`. Consumed by Phase 9 commands (`clone`, `fetch`,
   `push`).

2. **Transport middleware** — three composable wrappers around
   `HttpTransport`: `withRetry`, `withAuth`, `withLogging`. Each is a unary
   function `(HttpTransport) => HttpTransport`. Lives in `src/transport/`.
   Composed by users (or the Phase 10 facade) via `pipe` from
   `src/operators/`.

The split is forced by `.dependency-cruiser.cjs` rule
`transport-only-depends-on-ports`: `src/transport/` imports from `src/ports/`
**only**. It cannot import `domain/` (so it cannot construct `TsgitError`),
`application/` (so it cannot use primitives), or `operators/` (so it cannot
self-compose). Pkt-line and message construction therefore land in
`domain/protocol/` — they manipulate `Uint8Array`s and structural records,
which is well-trodden domain ground (cf. `domain/storage/` for pack
parsing).

**Scope boundary.**

- Smart HTTP negotiates protocol **v2** as the primary path (`Git-Protocol:
  version=2` opt-in header, `ls-refs` discovery, the `fetch` command's
  `acknowledgments`/`packfile` sections), falling back to the v1 wire
  described below when the server doesn't advertise `version 2` — shipped in
  a later backlog slice ([ADR-450](../adr/450-fetch-protocol-v2-with-v1-fallback.md),
  superseding this section's original v1-only stance; see §6.8 for the v2
  summary and §11 for phase ownership).
- HTTPS only at the adapter layer (already enforced by `NodeHttpTransport`'s
  `allowInsecureHttp` default-`false`).
- No SSH transport (PRD §3 non-goal).
- No `git://` daemon protocol.
- No reference advertisement caching (each operation re-discovers).
- No HTTP/2 multiplexing (handled by `node:https` / `fetch` opaquely).
- No streaming **request** body (push uploads the whole pack as one
  `Uint8Array` in v1; the response body is streamed). See §6.7.

**Binary-size budget.** `.size-limit.json` gains one new entry; the
protocol code lives under `domain/` and is absorbed by existing caps:

| Entry                        | Cap (gzipped) | Estimated emission | Where it lands               |
| ---------------------------- | ------------- | ------------------ | ---------------------------- |
| `tsgit/transport`            | **2 kB**      | ~1.4 kB            | new `dist/esm/transport/index.js` size-limit entry |
| `domain/protocol/*`          | absorbed      | ~3.0 kB            | counted against the existing 50 kB Core cap (currently has ~30 kB headroom — checked by `npm run check:size`) |

Real-size sanity: `isomorphic-git`'s pkt-line + smart-HTTP code is ~5 kB
gzipped after tree-shaking, including v2 support and SSH plumbing we
explicitly skip; ~3 kB for the v1-only subset is realistic.

**Package export.** A new `./transport` entry must be added to
`package.json` `exports`, mirroring the existing `./primitives` / `./operators`
entries:

```json
"./transport": {
  "import": { "types": "./dist/types/transport/index.d.ts", "default": "./dist/esm/transport/index.js" },
  "require": { "types": "./dist/types/transport/index.d.cts", "default": "./dist/cjs/transport/index.cjs" }
}
```

Without it `import { withRetry } from 'tsgit/transport'` resolves to nothing.

---

## 2. Module Structure

```
src/
├── domain/
│   └── protocol/
│       ├── pkt-line.ts          # encodePktLine, decodePktLine, FLUSH_PKT, DELIM_PKT
│       ├── side-band.ts         # parseSideBand (sideband-64k demuxer)
│       ├── capabilities.ts      # parseCapabilities, formatCapabilities, KNOWN_CAPABILITIES
│       ├── upload-pack.ts       # buildDiscoveryRequest, parseAdvertisedRefs, buildUploadPackRequest, parseUploadPackResponse
│       ├── receive-pack.ts      # buildReceivePackRequest, parseReceivePackResponse
│       ├── index.ts             # Barrel
│       └── error.ts             # ProtocolError discriminated union
└── transport/
    ├── with-retry.ts            # (config) => (inner: HttpTransport) => HttpTransport
    ├── with-auth.ts
    ├── with-logging.ts
    ├── types.ts                 # RetryConfig, AuthConfig, LoggingConfig, RetryPredicate, Logger
    └── index.ts                 # Barrel
```

**Test layout:**

```
test/unit/
├── domain/protocol/
│   ├── pkt-line.test.ts
│   ├── side-band.test.ts
│   ├── capabilities.test.ts
│   ├── upload-pack.test.ts
│   └── receive-pack.test.ts
└── transport/
    ├── with-retry.test.ts
    ├── with-auth.test.ts
    ├── with-logging.test.ts
    └── fixtures.ts              # fakeTransport, fixed clock, recording logger
```

All files kebab-case (ls-lint). All internal imports use the `.js`
extension (ESM).

---

## 3. Dependency Boundaries

```
domain/protocol/  → domain/objects/ (ObjectId only)        # type-only
domain/protocol/ ✗→ ports/, application/, transport/, ...  # domain rule

transport/        → ports/http-transport.ts               # request/response types
transport/       ✗→ domain/, application/, adapters/, operators/
transport/       ✗→ transport/* (siblings — no cross-imports)
```

The transport rule's "no domain" stance has one consequence: middleware
**cannot inspect `TsgitError` structurally**. It must operate on the
generic `unknown` thrown by `inner.request(...)`, plus the
`HttpResponse.statusCode`. Concrete tactics in §5.1 (`isRetryable` default).

| Property                       | Guarantee                                                      |
| ------------------------------ | -------------------------------------------------------------- |
| Zero outward deps (transport)  | Only `ports/http-transport.ts`                                 |
| Zero outward deps (protocol)   | Only `domain/objects/object-id.ts` (type-only)                 |
| Standard JS errors only        | `TypeError` for misconfig; `unknown` rethrown unchanged        |
| Pure functions                 | Middleware factories return new `HttpTransport`; no shared state except per-request |
| Tree-shakeable                 | Each middleware in its own file with one named export          |

**No new dep-cruiser rules needed.** The existing
`transport-only-depends-on-ports` and `domain-cannot-import-outward`
already cover the boundaries above. `domain/protocol/` slots into the
existing domain rule with no special-casing.

---

## 4. Pkt-Line Wire Format

Source of truth: [Documentation/technical/protocol-common.txt](https://git-scm.com/docs/protocol-common)
in upstream git.

```
pkt-line     = data-pkt | flush-pkt | delim-pkt | response-end-pkt
data-pkt     = pkt-len pkt-payload
pkt-len      = 4*(HEXDIG)          ; ASCII hex, lowercase, length INCLUDES the 4 length bytes
pkt-payload  = (pkt-len - 4) BYTES ; max payload = 65520 bytes (0xfff0 - 4)
flush-pkt    = "0000"
delim-pkt    = "0001"              ; v2-only; rejected in v1 parse path
response-end = "0002"              ; v2-only; rejected in v1 parse path
```

**Length bounds.**

- Minimum data length: `0004` (empty payload — legal but unused; we
  preserve it on parse for round-trip fidelity).
- Maximum: `fff0` (65520) total → 65516 bytes payload.
- Lengths `0001`, `0002`, `0003` are reserved control packets.
- Any other length `< 0004` is malformed.

**Encoding (little design choice).** Lengths are emitted **lowercase** to
match canonical git output. Receivers MUST accept either case (per spec);
the parser uses `parseInt(slice, 16)` which is case-insensitive.

### 4.1 Public types

```typescript
/** A single decoded pkt-line. */
export type PktLine =
  | { readonly kind: 'data';         readonly payload: Uint8Array }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }              // v2 only
  | { readonly kind: 'response-end' };      // v2 only

export const FLUSH_PKT: Readonly<Uint8Array>;        // bytes for "0000"
export const DELIM_PKT: Readonly<Uint8Array>;        // bytes for "0001"

export const MAX_PKT_LINE_PAYLOAD = 65516; // 65520 - 4
```

### 4.2 Encoder

```typescript
/**
 * Encode a payload as a single pkt-line. Throws RangeError if
 * payload.byteLength > MAX_PKT_LINE_PAYLOAD. Empty payload is allowed
 * and emits "0004".
 */
export function encodePktLine(payload: Uint8Array): Uint8Array;

/**
 * Concatenate multiple pkt-lines + a trailing flush packet.
 * Convenience for building request bodies.
 */
export function encodePktStream(payloads: ReadonlyArray<Uint8Array>): Uint8Array;
```

**Implementation notes.**

- The 4-byte length prefix is built with a fixed-width hex helper:
  `(n + 0x10000).toString(16).slice(-4)`. Branchless; avoids `padStart`'s
  per-call intermediate `String` allocation. Matters for push request
  bodies that may emit thousands of pkt-lines.
- `encodePktStream(payloads)` allocates **one** `Uint8Array` of computed
  total size, then writes each payload at its known offset via `.set(...)`.
  No intermediate concat, no Buffer.concat-style reallocations. Total
  size = `sum(payload.byteLength + 4) + 4` (the trailing flush).

### 4.3 Decoder

```typescript
/**
 * Decode a pkt-line stream from an AsyncIterable<Uint8Array>. Yields PktLine
 * records. Buffers across chunk boundaries — the source need not align
 * chunks to packet boundaries (HTTP chunked transfer doesn't).
 *
 * Throws ProtocolError on:
 *   - INVALID_PKT_LENGTH: non-hex length bytes
 *   - PKT_LENGTH_RESERVED: lengths 0001/0002/0003 in a v1 stream
 *   - PKT_TOO_LARGE: pkt-len > 0xfff0
 *   - PKT_TRUNCATED: stream ends mid-packet
 */
export function decodePktStream(
  source: AsyncIterable<Uint8Array>,
  options?: { readonly v2?: boolean },
): AsyncIterable<PktLine>;
```

**v1 vs v2 distinction.** Default `v2: false` means delim/response-end
packets surface as `PROTOCOL_ERROR` with code `PKT_LENGTH_RESERVED`. The HTTP
session now always decodes with `{ v2: true }` (sub-decision D2 in
`design/incremental-fetch-negotiation.md`) — safe on a v1 response too,
because v1 upload-pack never emits length-`0001`/`0002` frames, so decoding
is byte-identical either way. SSH sessions still decode `v2: false`; SSH
stays on the v1 wire (§6.8).

**Backpressure.** The decoder is an `async function*` — consumers naturally
backpressure via `for await … of`. No explicit pull-mode API.

**Reassembly buffer cap.** The decoder maintains a single internal
`Uint8Array` accumulator for cross-chunk packet reassembly. The cap is
`MAX_PKT_LINE_PAYLOAD + 4` bytes (~65 KB). If a chunk arrives that pushes
the accumulator beyond this without yielding a complete packet, the
decoder raises `PKT_TOO_LARGE`. A malicious server cannot blow memory by
streaming bytes that never form a valid length prefix.

**Trailing-newline policy.** Pkt-line payloads include a trailing `\n` if
the producer wrote one. The decoder does **not** strip it — that is a
parser-tier concern. `parseAdvertisedRefs`, `parseUploadPackResponse`, and
`parseReceivePackResponse` strip the terminating `\n` from each line they
process; raw payloads (e.g. side-band data on channel 1) pass through
untouched.

### 4.4 Side-band-64k demuxer

When the server advertises `side-band-64k`, every data packet in the
upload-pack response begins with a single byte channel marker:

| Byte | Channel | Meaning                                            |
| ---- | ------- | -------------------------------------------------- |
| `0x01` | data    | Packfile bytes — concatenate to form the pack    |
| `0x02` | progress | Human-readable progress text (route to ProgressReporter) |
| `0x03` | error   | Fatal error text — abort the operation           |

```typescript
/**
 * Split a sideband-64k pkt-line stream into three separate AsyncIterables.
 * The pack channel is the primary output; progress + error are emitted
 * via callbacks so callers don't have to fan out the stream.
 *
 * Callbacks are invoked inside try/catch — a thrown error from
 * onProgress / onError is swallowed and the iterator continues. Rationale:
 * a misbehaving progress reporter must not crash the protocol parser.
 *
 * Throws ProtocolError(SIDEBAND_FATAL) when the error channel produces text;
 * the message is the channel-3 payload decoded as UTF-8. The first channel-3
 * packet ends the stream — channel-3 payload is NOT accumulated across packets,
 * so the message size is naturally bounded by MAX_PKT_LINE_PAYLOAD.
 */
export function parseSideBand(
  source: AsyncIterable<PktLine>,
  options: {
    readonly onProgress?: (text: string) => void;
    readonly onError?:    (text: string) => void; // before the throw
  },
): AsyncIterable<Uint8Array>;
```

**Why callbacks for non-pack channels.** Splitting one source into three
AsyncIterables would require either buffering or a fan-out queue — both
add bundle bytes. Progress is fire-and-forget; routing it through a
callback into `ctx.progress` keeps the surface tiny.

---

## 5. Transport Middleware

**Wrapping shape.** Each middleware returns a new `HttpTransport` by
spreading the inner transport and overriding `request`:

```typescript
return { ...inner, request: wrappedRequest };
```

**Not** `Object.create`-and-overwrite, which breaks structural typing for
`readonly` properties and prevents future port additions (e.g. a hypothetical
`upload` for streaming push) from being inherited.

**Type-only port import.** Middleware files use
`import type { HttpTransport, HttpRequest, HttpResponse } from '../ports/http-transport.js'`.
The runtime never references the port — it just constructs / passes records
that structurally satisfy it. Type-only imports keep emitted JS lean.

### 5.1 `withRetry`

```typescript
export interface RetryConfig {
  /**
   * Total request attempts INCLUDING the first. `attempts: 1` means "no retries".
   * `attempts: 3` = up to 2 retries after the initial call. Must be a positive
   * integer ≤ 10. (Hard cap prevents pathological configurations from blocking
   * an operation for hours on persistent 5xx.)
   */
  readonly attempts: number;
  /** 'fixed' = baseMs every attempt; 'exponential' = baseMs * 2^(attempt-1). */
  readonly backoff?: 'fixed' | 'exponential';
  /** Initial delay in ms. Must be a non-negative finite number. Default 250. */
  readonly baseMs?: number;
  /** Cap per-attempt delay. Default 30_000. */
  readonly maxDelayMs?: number;
  /** Multiplicative jitter factor in [0, 1]. Default 0.2 (±20% of computed delay). */
  readonly jitter?: number;
  /** Custom retryability predicate. Default: §5.1.1. */
  readonly isRetryable?: RetryPredicate;
  /** Test seam: deterministic delay primitive. Default: §5.1.5. */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Decides whether to retry. EXACTLY ONE of `error` / `response` is defined per call:
 *  - `error` defined, `response` undefined: inner.request rejected
 *  - `response` defined, `error` undefined: inner.request resolved with this response
 * `attempt` is the 1-based index of the attempt that just failed (1 = first call).
 */
export type RetryPredicate = (info: {
  readonly error?: unknown;
  readonly response?: HttpResponse;
  readonly attempt: number;
}) => boolean;

export function withRetry(config: RetryConfig): (inner: HttpTransport) => HttpTransport;
```

**Validation (synchronous, at factory call time).**

- `attempts` not in `[1, 10]` → `RangeError('withRetry: attempts must be 1..10')`.
- `baseMs` < 0 or non-finite → `RangeError('withRetry: baseMs must be ≥ 0')`.
- `maxDelayMs` < `baseMs` → `RangeError`.
- `jitter` outside `[0, 1]` → `RangeError`.

#### 5.1.1 Default `isRetryable`

Without importing domain, the predicate must rely on duck-typing and
status codes:

```typescript
const defaultIsRetryable: RetryPredicate = ({ error, response }) => {
  // Network failures: any thrown error WITHOUT a response is treated as transient.
  if (error !== undefined && response === undefined) return true;

  // 5xx and 429 — server-side transient. Excludes 501 Not Implemented.
  if (response !== undefined) {
    const s = response.statusCode;
    return s === 429 || (s >= 500 && s < 600 && s !== 501);
  }

  return false;
};
```

**Why duck-typing of errors is acceptable here.** `withRetry` doesn't need
to *understand* the error — it only needs to decide "retry or not". The
only signal it has is "did inner throw?" plus status code on success.
Pulling `TsgitError.data.code` would buy nothing the boolean doesn't
already give us.

#### 5.1.2 Body re-emission

Retry on `POST` requests requires re-sending `req.body`. The body is a
`Uint8Array` — immutable from `withRetry`'s perspective — so re-emission
is just re-passing the same reference. No buffering, no rewinding.

> **Constraint.** This is one reason §1's scope boundary forbids streaming
> request bodies in v1. A streamed body could not be retried without a
> tee buffer of unbounded size.

#### 5.1.3 Response body and retries

If `inner.request(...)` *resolves* with a 5xx, the previous response's
`body` stream is **draining-required** before the retry. `withRetry` calls
`response.body.cancel()` to release the underlying socket / fetch stream
before sleeping. Skipping this leaks a connection per retry.

The `cancel()` call is wrapped in `try/catch`; cancellation failures are
swallowed (the underlying socket cleanup happens at the adapter layer
regardless, and the alternative — propagating a cleanup error past a
retry decision — is worse than the leak it would prevent).

#### 5.1.4 Cancellation cooperation

The middleware honors `req.signal`:

- Inflight `inner.request(...)` rejection due to `AbortError` → no retry.
- Pre-attempt: if `req.signal?.aborted`, throw `AbortError` immediately.
- During backoff sleep, the `delay` primitive accepts the same signal so
  cancellation interrupts the wait.

#### 5.1.5 Default `delay` primitive

```typescript
const defaultDelay = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (ms === 0) return Promise.resolve();                           // skip the ~4 ms setTimeout-0 floor
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const handle = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(handle);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};
```

**Why `ms === 0` shortcut.** Browser/Node both clamp `setTimeout(fn, 0)`
to ~4 ms (HTML spec §8.6.1 "minimum nesting level"). For `baseMs: 0` (or
the user passing `delay: defaultDelay` with a custom `baseMs`) we want
microtask-fast resumption, not 4 ms × `attempts`.

#### 5.1.6 Retry idempotency caveat

`withRetry` retries POST requests, which is **not** idempotent in HTTP
generally. For smart-HTTP this is safe because:

- **Discovery is GET** — naturally idempotent.
- **`git-upload-pack` is read-only on the server** — negotiation produces
  a pack but does not mutate state; retrying yields the same pack.
- **`git-receive-pack` is gated by per-ref `oldId` checks** — a retried
  push either no-ops (already applied; server reports `ok` for refs whose
  current head matches `newId`) or fails with a stale-ref error
  (`old hash check failed`), which the default predicate does NOT mark
  retryable (it's a 200 response with `report-status: ng`, not a 5xx).

Custom predicates that mark non-network failures retryable break this
invariant — flagged in `withRetry`'s docstring.

### 5.2 `withAuth`

```typescript
export type AuthConfig =
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic';  readonly username: string; readonly password: string }
  | { readonly type: 'custom'; readonly header: (req: HttpRequest) => string | Promise<string> };

export function withAuth(config: AuthConfig): (inner: HttpTransport) => HttpTransport;
```

**Behavior.**

- Adds (does not replace) the `Authorization` header to every request.
- **Case-insensitive override detection.** The middleware iterates
  `Object.keys(req.headers)`; if any key lowercases to `'authorization'`,
  the inbound header **wins** — the middleware does not overwrite. Lets
  per-call overrides through regardless of header-name casing.
- `basic`: header value is `'Basic ' + base64(utf8(username + ':' + password))`.
  Uses `TextEncoder().encode(...)` then `btoa(String.fromCharCode(...bytes))`
  (or `Buffer.from(bytes).toString('base64')` on Node — equivalent output).
  This matches RFC 7617 §2 (UTF-8 charset). Naive `btoa(user + ':' + pwd)`
  would corrupt non-ASCII because `btoa` only accepts Latin-1.
- `bearer`: header value is `'Bearer ' + token`.
- `custom`: caller-provided function returns the full header value
  (e.g. for OAuth dance, signed requests). The function may be async to
  permit token refresh. If it returns `''`, `null`, or `undefined`, the
  middleware throws `TypeError('withAuth: custom returned empty value')` —
  preferable to sending `Authorization: ` with an empty value.

**Validation (synchronous).**

- Empty `token` → `TypeError('withAuth: token is empty')`.
- `username` containing `:` → `TypeError('withAuth: basic username must not contain ":"')`
  (RFC 7617 §2 — basic auth uses `:` as the credential separator).

**Header redaction in errors / logs.** `withAuth` writes the `Authorization`
header but does not log it. `withLogging` (§5.3) MUST drop it from every
event. See §8.

### 5.3 `withLogging`

```typescript
/**
 * Logger contract: log() is SYNCHRONOUS. Async logging would force
 * withLogging to await every event, serializing the request hot path on
 * the user's logger latency. Users wanting async writes must enqueue
 * internally (e.g. push to a buffer that a background flusher drains).
 */
export interface Logger {
  readonly log: (event: LogEvent) => void;
}

export type LogEvent =
  | { readonly kind: 'request';   readonly method: 'GET'|'POST'; readonly url: string;
      readonly headers: Readonly<Record<string,string>>; readonly bodyBytes: number }
  | { readonly kind: 'response';  readonly statusCode: number; readonly url: string;
      readonly elapsedMs: number; readonly headers: Readonly<Record<string,string>> }
  | { readonly kind: 'error';     readonly url: string; readonly elapsedMs: number;
      readonly errorMessage: string };

export interface LoggingConfig {
  readonly logger: Logger;
  /** ms-precision timer. Default `() => performance.now()`. Test seam. */
  readonly now?: () => number;
  /**
   * Header keys (lowercased) to drop before passing the headers map to logger.
   * Default: ['authorization', 'cookie', 'set-cookie', 'proxy-authorization'].
   * 'authorization' MUST always be redacted — see §8.
   */
  readonly redactHeaders?: ReadonlyArray<string>;
}

export function withLogging(config: LoggingConfig): (inner: HttpTransport) => HttpTransport;
```

**Behavior.**

- Synchronously emits a `request` event with redacted headers + body byte
  count (NOT body content — bodies may contain credentials in custom-auth
  flows).
- On success: emits `response` with elapsed ms.
- On rejection: emits `error` with `String((err as Error)?.message ?? err)`,
  then rethrows the original error unchanged.
- **Header redaction is always applied** — even if the user supplies an empty
  `redactHeaders` array, `'authorization'`, `'cookie'`, `'set-cookie'`, and
  `'proxy-authorization'` are forced in. Non-negotiable: a logging
  middleware that leaks creds is a security regression. See §8.
- **URL query-string redaction.** The logged `url` strips query parameters
  whose key matches `/^(access[_-]?token|api[_-]?key|password|secret|token|sig|signature)$/i`.
  Path is preserved. Other params pass through. Some auth flows (OAuth
  implicit, GitHub PAT-as-query) put credentials in the URL — without this,
  `withLogging` would defeat `withAuth`'s redaction.
- **Logger thrown errors are swallowed.** `logger.log(event)` is wrapped in
  `try/catch`; a thrown error is discarded silently. A logger crash must
  never break an HTTP request. (The caller's request still succeeds; it
  is simply unlogged for that event.)

**Validation.** None at factory time (logger interface is structurally
typed; bad callers crash at first event).

---

## 6. Smart HTTP v1 Message Construction

These are pure builders — they take structural inputs and return
`Uint8Array` (request body) or parsed records (response). They do not
issue HTTP requests. Phase 9 commands compose them with
`ctx.transport.request(...)`.

### 6.1 Discovery (`GET .../info/refs?service=...`)

```typescript
/**
 * Build the discovery URL given a remote base URL and the desired service.
 *
 * Behavior:
 * - Parses baseUrl with the URL constructor. Throws ProtocolError(INVALID_BASE_URL)
 *   on malformed URLs or URLs containing a fragment ('#').
 * - Appends '/info/refs' to the path (with a single '/' join — no double slash).
 * - Adds 'service' to the search params, preserving any pre-existing params.
 * - Does NOT add or strip a '.git' suffix — the caller decides whether the
 *   remote URL needs one (most servers accept both forms).
 */
export function buildDiscoveryUrl(
  baseUrl: string,
  service: 'git-upload-pack' | 'git-receive-pack',
): string;

export interface AdvertisedRef {
  readonly name: string;          // e.g. "refs/heads/main"
  readonly id: ObjectId;          // 40-char SHA-1 (sha256 if server advertises)
  readonly peeled?: ObjectId;     // for annotated tags: the `^{}` line
}

export interface Advertisement {
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<AdvertisedRef>;
  /** undefined when the server advertises no HEAD (rare; permitted by spec). */
  readonly head?: AdvertisedRef;  // resolved from `symref=HEAD:refs/heads/X` capability if present
}

/**
 * Parse a discovery response body. Validates the `# service=...\n0000`
 * prologue, splits capabilities off the first ref's NUL-suffix, and
 * collects subsequent refs.
 *
 * Throws ProtocolError on:
 *   - MISSING_SERVICE_HEADER: prologue missing or for the wrong service
 *   - INVALID_REF_LINE: malformed `<id> <name>` line
 *   - DUPLICATE_REF: same ref name appears twice
 */
export function parseAdvertisedRefs(
  source: AsyncIterable<PktLine>,
  expectedService: 'git-upload-pack' | 'git-receive-pack',
): Promise<Advertisement>;
```

**Capability parsing.** First-ref payload format: `<id> <name>\0<cap1> <cap2> ...`.
The NUL-split is mandatory (per spec); absence is `MISSING_CAPABILITIES`.

### 6.2 Upload-pack request (fetch / clone)

```typescript
export interface WantHaveRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly haves: ReadonlyArray<ObjectId>;
  readonly capabilities: ReadonlyArray<string>;     // negotiated subset
  readonly depth?: number;                          // shallow clone
  readonly done?: boolean;                          // single-round (clone w/ no haves)
}

/** Build the body of POST /git-upload-pack. */
export function buildUploadPackRequest(req: WantHaveRequest): Uint8Array;
```

**Wire layout** (per `protocol-pack.txt`):

```
want <oid> [cap1 cap2 ...]\n      ; capabilities only on the first want line
want <oid>\n
...
[shallow <oid>\n]*
[deepen <depth>\n]
0000                               ; flush
have <oid>\n
have <oid>\n
...
0009done\n                         ; or 0000 if multiple rounds
```

### 6.3 Upload-pack response

```typescript
export interface UploadPackResponse {
  readonly acks: ReadonlyArray<{ readonly id: ObjectId; readonly status: 'ack' | 'continue' | 'common' | 'ready' }>;
  readonly nak: boolean;
  /** Pack bytes — pre-demuxed if side-band-64k was negotiated. Lazy. */
  readonly packBody: AsyncIterable<Uint8Array>;
}

export function parseUploadPackResponse(
  source: AsyncIterable<PktLine>,
  options: {
    readonly sideBand: boolean;
    /** Progress callback for side-band channel 2. Fire-and-forget; sync only. */
    readonly onProgress?: (text: string) => void;
  },
): UploadPackResponse;
```

**Why progress is callback-only.** Materializing progress as an array
forces the parser to buffer until the response completes — losing the
real-time streaming intent. A callback gives the consumer a hook into
`ctx.progress.emit(...)` (Phase 4 port) without coupling the parser to
`Context`.

**Streaming contract.** `packBody` is lazily produced. The caller passes
it to `parsePackfile` (Phase 2 already done) directly — no intermediate
buffering of the full pack. This is critical: clones of multi-GB
repositories must not require multi-GB of RAM.

### 6.4 Receive-pack request (push)

```typescript
export interface RefUpdate {
  readonly name: string;       // "refs/heads/main"
  readonly oldId: ObjectId;    // ZERO_OID (40 hex zeros) for create
  readonly newId: ObjectId;    // ZERO_OID (40 hex zeros) for delete
}

export interface ReceivePackRequest {
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly capabilities: ReadonlyArray<string>;   // e.g. ['report-status', 'side-band-64k']
  readonly packfile: Uint8Array;                  // built by Phase 2's serializePackfile
}

export function buildReceivePackRequest(req: ReceivePackRequest): Uint8Array;
```

**Wire layout** (per `protocol-pack.txt`):

```
<oldId> <newId> <name>\0<cap1> <cap2> ...\n    ; first command carries capabilities
<oldId> <newId> <name>\n
...
0000
<packfile bytes ...>
```

### 6.5 Receive-pack response

```typescript
export interface ReceivePackResponse {
  readonly unpackOk: boolean;
  readonly unpackError?: string;                 // present iff !unpackOk
  readonly refUpdates: ReadonlyArray<{
    readonly name: string;
    readonly accepted: boolean;
    readonly reason?: string;                    // present iff !accepted
  }>;
}

export function parseReceivePackResponse(
  source: AsyncIterable<PktLine>,
): Promise<ReceivePackResponse>;
```

### 6.6 `ZERO_OID` constant

The receive-pack create/delete encoding uses 40 ASCII zeros (or 64 for
SHA-256) as the placeholder OID. The constant must come from somewhere;
adding it once in `domain/objects/object-id.ts` keeps a single source of
truth:

```typescript
// in domain/objects/object-id.ts (Phase 1 module — small additive change)
export const ZERO_OID: ObjectId = '0000000000000000000000000000000000000000' as ObjectId;
// SHA-256: a separate constant if we add sha256 support — out of scope for v1.
```

`domain/protocol/receive-pack.ts` imports it; the existing `domain/objects/`
boundary is intra-domain, no dep-cruiser change needed.

### 6.7 Why the request body is `Uint8Array`, not a stream

Two reasons:

1. **Retry-safe.** A `Uint8Array` body re-emits across attempts with no
   buffering. A `ReadableStream` body would force `withRetry` to maintain
   a tee buffer of unbounded size.

2. **Pack assembly is finite.** `serializePackfile` (Phase 2) emits the
   full pack as a `Uint8Array`. Streaming the request body would require
   a streaming pack writer — a V2 enhancement. For v1, push of repos with
   working sets above ~1 GB is out of scope.

The **response** body is streamed (HTTP responses always are in our
`HttpTransport` port; `body` is a `ReadableStream<Uint8Array>`).

### 6.8 Smart HTTP v2 (primary negotiation, v1 retained as fallback)

Superseding this section's original v1-only stance (ADR-005), tsgit opts
into protocol v2 on every HTTP discovery GET and exchange POST via a
`Git-Protocol: version=2` request header (SSH sessions never set it, so SSH
stays on the v1 wire above — ADR-450). Version detection is response-driven,
not request-driven: the authoritative signal is the advertisement's first
data pkt-line (`version 2` vs. a v1 ref line), so a server that ignores the
header still gets a correct v1 fallback.

- **Discovery** — the v2 **`ls-refs`** command (not the v1 ref-advertisement
  GET) lists refs.
- **Fetch** — the v2 **`fetch`** command replaces the v1 upload-pack
  request/response pair; its section-framed response carries an
  `acknowledgments` section (`ack`/`ready`/`done`) and a `packfile` section
  (side-band, reusing the same `parseSideBand` as v1).
- **Fallback** — a server that does not advertise `version 2` gets the
  corrected v1 wire above (ADR-451's no-flush-before-`done` fix +
  `multi_ack_detailed`), and so does every SSH remote (v2 is HTTP-only).

**Deliberate minimal v2 request arg set.** tsgit's v2 requests carry a
narrower argument set than git's own client sends: `ls-refs` sends only
`symrefs`, and `fetch` sends only `deepen`/`filter` when set — never
`ofs-delta`, `include-tag`, `thin-pack`, or `no-progress`. Every omitted arg
only steers *how* the server searches, filters, or packs bytes on the wire,
never *what* tsgit ends up with on disk, so the resulting objects are
identical to what git's fuller arg list would produce — a deliberate, pinned
wire divergence rather than an oversight. See "Deliberate minimalism in the
v2 request arg set" in `design/incremental-fetch-negotiation.md` for the
per-argument rationale, and that same doc for the pinned request/response
wire matrices (not duplicated here). Cross-linked ADRs:
[450](../adr/450-fetch-protocol-v2-with-v1-fallback.md) (v2 primary + v1
fallback), [451](../adr/451-fetch-v1-fallback-framing-and-multi-ack.md) (v1
framing fix), [452](../adr/452-empty-pack-suppression-and-everything-local.md)
(empty-pack suppression + the `everything_local` no-op short-circuit,
protocol-agnostic across v1 and v2).

---

## 7. Capability Handling

```typescript
/**
 * Parse the capability tail of a discovery first-ref line. Input is the
 * substring AFTER the NUL byte: "multi_ack_detailed side-band-64k ofs-delta agent=git/2.43".
 * Splits on space, preserves order, deduplicates (last write wins for `key=value` shapes).
 */
export function parseCapabilities(tail: string): ReadonlyArray<string>;

/**
 * Format a capability list back into the wire form: space-separated,
 * preserves caller order. Used by want/have request builders.
 */
export function formatCapabilities(caps: ReadonlyArray<string>): string;

/**
 * Intersect server capabilities with client-supported set. Never returns
 * a cap the server didn't advertise. `key=value` capabilities (like `agent=...`)
 * match by KEY only — server's value wins.
 */
export function negotiateCapabilities(
  serverCaps: ReadonlyArray<string>,
  clientCaps: ReadonlyArray<string>,
): ReadonlyArray<string>;

/** Capabilities tsgit advertises in v1. AGENT is computed at module load — see below. */
export const CLIENT_CAPABILITIES_FETCH: readonly string[] = [
  'multi_ack_detailed',
  'side-band-64k',
  'ofs-delta',
  AGENT,
  'thin-pack',
  'no-progress',                  // request: caller can downgrade if no terminal
  'include-tag',
];

export const CLIENT_CAPABILITIES_PUSH: readonly string[] = [
  'report-status',
  'side-band-64k',
  'ofs-delta',
  AGENT,
  'atomic',
  'delete-refs',
];
```

**Why a fixed list, not configurable.** Each capability is wired to a
specific code path (`thin-pack` requires `applyDelta` to handle `OBJ_REF_DELTA`
to objects already in the local store; `side-band-64k` requires the demuxer
in §4.4). Configurability without backing implementations is a footgun.
A future ADR can extend the list when a new code path lands.

**Agent string — concrete derivation.** `AGENT` is computed once at
module load:

```typescript
// In domain/protocol/capabilities.ts
const VERSION = (() => {
  // Node: process.env.npm_package_version is set by `npm run …` and by `node` when
  // launched via package scripts; empty in browser builds.
  const v = (typeof process !== 'undefined' && process.env?.npm_package_version) || '0.x';
  // Strip patch + prerelease — fingerprinting reduction. "1.2.3-rc.4" → "1.2".
  return v.split('.').slice(0, 2).join('.');
})();

export const AGENT = `agent=tsgit/${VERSION}`;
```

For browser bundles, the `0.x` literal is the fallback. A rollup
`@rollup/plugin-replace` step (already in the build for `process.env.NODE_ENV`)
substitutes `process.env.npm_package_version` with the package-time value
during bundling. No new build plugin is required.

**Why major.minor only.** Full version strings (especially with patch +
SHA suffixes) are a fingerprinting vector. Major.minor balances
diagnostic value against fingerprinting surface — matches `git`'s upstream
behavior pre-2.0.

---

## 8. Security

### 8.1 Credential handling

| Surface                       | Rule                                                                  |
| ----------------------------- | --------------------------------------------------------------------- |
| `withAuth`                    | Token / password held in closure; never logged, never serialized      |
| `withLogging` header redactions | `authorization`, `cookie`, `set-cookie`, `proxy-authorization` always dropped (cannot be opted out) |
| `withLogging` URL redactions  | Query params matching `/^(access[_-]?token|api[_-]?key|password|secret|token|sig|signature)$/i` stripped before logging |
| Error messages                | Never include header values; pre-existing `NodeHttpTransport` already sanitizes |
| Discovery / negotiation logs  | Same redactions applied (events flow through `withLogging` regardless of payload) |
| Body bytes contract           | Adapters MUST treat `req.body` as immutable. `NodeHttpTransport` honors this (uses `Buffer.from(...)` which copies). Required for `withRetry` to safely re-emit the same body across attempts. |

### 8.2 SSRF (Server-Side Request Forgery)

**Out of scope at the transport layer.** Per `ports-and-adapters.md` §35 and
§32, SSRF mitigation is the application layer's job: Phase 9 `clone` /
`fetch` validate the remote URL (block private IP ranges,
`localhost`/`127.0.0.0/8`/`169.254.0.0/16`/`fc00::/7`, file:// schemes,
custom non-http(s) protocols) **before** calling `ctx.transport.request(...)`.

Adding URL validation in `withAuth` or `withRetry` would duplicate the
check and risk drift. The HTTPS-only stance from Phase 4 (`allowInsecureHttp`
default-false) is the only network-policy enforcement at this layer.

### 8.3 Redirect handling

`HttpTransport` (Phase 4) does **not** follow redirects automatically —
`NodeHttpTransport` just resolves the response and `fetch` requires opt-in.
Smart HTTP servers may redirect `/info/refs?service=...` to a canonical URL.

**Decision (Phase 9 Phase-ownership table entry).** Phase 9 commands
implement bounded redirect following: max 5 hops, only same-origin or
explicitly-trusted hosts, and **strip `Authorization` on cross-origin
hops**. Transport middleware is unaware of redirects (it sees one
request → one response).

### 8.4 Pkt-line parser hardening

| Threat                                  | Mitigation                                     |
| --------------------------------------- | ---------------------------------------------- |
| Length > 0xfff0 (slow loris via giant packets) | `PKT_TOO_LARGE` error                  |
| Truncation mid-packet                   | `PKT_TRUNCATED` on stream end with partial buffer |
| Unbounded ref enumeration               | Application layer (Phase 9) caps refs at a configurable max (default 10 000) |
| Side-band channel 3 (error)             | Raises `SIDEBAND_FATAL`; abort the operation  |
| Side-band channel ≥ 4                   | `INVALID_SIDEBAND_CHANNEL`                    |

### 8.5 Custom auth callback safety

`AuthConfig['type'] = 'custom'` accepts a user function returning the
header value. If the function throws, the error propagates to the caller
unchanged. The middleware does **not** retry custom-auth failures — that's
a `withRetry` concern, and `withRetry` will only retry if the predicate
matches (default: no, since the function throws synchronously without a
`response`).

---

## 9. Error Model

### 9.1 `ProtocolError` (lives in `domain/protocol/error.ts`)

```typescript
export type ProtocolError =
  | { readonly code: 'INVALID_PKT_LENGTH'; readonly value: string }   // hex preview of bad bytes
  | { readonly code: 'PKT_LENGTH_RESERVED'; readonly value: number }
  | { readonly code: 'PKT_TOO_LARGE'; readonly value: number }
  | { readonly code: 'PKT_TRUNCATED'; readonly remaining: number }
  | { readonly code: 'INVALID_BASE_URL'; readonly reason: string }
  | { readonly code: 'MISSING_SERVICE_HEADER'; readonly expected: string; readonly actual: string }
  | { readonly code: 'MISSING_CAPABILITIES' }
  | { readonly code: 'INVALID_REF_LINE'; readonly line: string }
  | { readonly code: 'DUPLICATE_REF'; readonly name: string }
  | { readonly code: 'INVALID_SIDEBAND_CHANNEL'; readonly channel: number }
  | { readonly code: 'SIDEBAND_FATAL'; readonly message: string }
  | { readonly code: 'UNKNOWN_ACK_STATUS'; readonly value: string }
  | { readonly code: 'INVALID_REPORT_STATUS'; readonly line: string };
```

These extend `TsgitErrorData` (the union in `domain/error.ts`) and gain
factory helpers in `domain/protocol/error.ts`. Existing pattern (matches
`StorageError`, `RefsError`, etc.).

**Integration patch (concrete, single atomic edit per §12 step 6):**

1. `domain/protocol/error.ts` — define `ProtocolError` + 13 factory helpers
   (one per variant), matching the shape of `domain/storage/error.ts`.
2. `domain/error.ts`:
   - Add `ProtocolError` import + union into `TsgitErrorData`.
   - Add 13 cases to `extractDetail()` switch — `default: never` exhaustiveness
     check guarantees the compiler flags any miss.
3. `domain/index.ts` — re-export `protocolError*` factories alongside existing
   `storageError*`, `refsError*`, etc.

### 9.2 Transport middleware errors

Middleware **does not construct `TsgitError`** (can't import domain). It
uses standard JS errors:

| Site                        | Thrown                                                               |
| --------------------------- | -------------------------------------------------------------------- |
| Misconfiguration            | `TypeError` / `RangeError` synchronously at factory call              |
| Inflight cancellation       | The `inner.request` rejection (typically a `DOMException` of name `AbortError` or `TsgitError(NETWORK_ERROR)`) is rethrown unchanged |
| Retry exhaustion            | The **last** error / response from `inner` propagates — the middleware does not wrap |

**Why no wrapping.** The caller already gets `TsgitError(NETWORK_ERROR/HTTP_ERROR)`
from the `NodeHttpTransport` adapter. Wrapping in a `RETRY_EXHAUSTED`
sentinel would obscure the underlying cause. If a future Phase 9 command
needs "did we exhaust retries?" telemetry, `withLogging` events provide
enough signal.

---

## 10. Testing Strategy

### 10.1 Pkt-line round-trip property test

```typescript
// Given any payload up to 65516 bytes
// When encoded then decoded
// Then we recover the original bytes exactly
```

Run with at least: empty, 1 byte, `MAX_PKT_LINE_PAYLOAD`, `MAX_PKT_LINE_PAYLOAD - 1`,
`MAX_PKT_LINE_PAYLOAD + 1` (must throw), and a fast-check generator over
random sizes in `[0, 65520]`.

### 10.2 Pkt-line decoder fixtures

Boundary cases that pin mutations. All assertions use `try/catch` +
direct `.data.code` / `.data.value` checks (per CLAUDE.md mutation rule —
`toThrow(TsgitError)` alone misses StringLiteral mutations on `.code`).

| Fixture                                             | Expected                                     | Mutant killed                  |
| --------------------------------------------------- | -------------------------------------------- | ------------------------------ |
| `0000`                                              | one `flush`                                  | length-eq-0 baseline           |
| `0001` (v1 mode)                                    | throws `PKT_LENGTH_RESERVED`, `value === 1`  | reserved-range lower bound     |
| `0001` (v2 mode)                                    | one `delim`                                  | v2 flag check                  |
| `00040000`                                          | `data{ Uint8Array(0) }` then `flush`         | empty-payload allowed          |
| `0009` + `done\n`                                   | `data{ payload === bytesOf("done\n") }`      | length parse + payload slice   |
| Length = `fff0` payload of 65516 bytes              | `data{ payload.byteLength === 65516 }`       | upper boundary inclusive       |
| Length = `fff1`                                     | throws `PKT_TOO_LARGE`, `value === 0xfff1`   | upper boundary exclusive       |
| Chunk split mid-length: `[00]`, `[09do]`, `[ne\n]`  | reassembles to one `data`                    | accumulator correctness        |
| Chunk split mid-payload                              | reassembles                                  | accumulator correctness        |
| Two payloads in one chunk                           | yields both data packets in order            | offset advance                 |
| Stream ends after `00`                              | throws `PKT_TRUNCATED`, `remaining === 2`    | truncation detection           |
| Stream ends after `0009do`                          | throws `PKT_TRUNCATED`, `remaining === 4`    | mid-payload truncation         |
| Length `xxxx` (non-hex)                             | throws `INVALID_PKT_LENGTH`, `value === "xxxx"` | hex parse                  |
| Length `0000` then a stray byte after flush         | yields flush, then throws `INVALID_PKT_LENGTH` | post-flush continuation     |
| Reassembly cap exceeded (chunk push past `0xfff4`)  | throws `PKT_TOO_LARGE`                       | accumulator cap                |

### 10.3 Side-band tests

| Fixture                                                         | Expected                            |
| --------------------------------------------------------------- | ----------------------------------- |
| Channel 1 only, two pkt-lines                                   | concatenated pack bytes; no progress |
| Channel 2 mid-stream                                            | `onProgress` called with text       |
| Channel 3 mid-stream                                            | `onError` called, then `SIDEBAND_FATAL` thrown |
| Channel 4                                                       | `INVALID_SIDEBAND_CHANNEL`          |
| Empty data packet on channel 1                                  | yields zero bytes; consumer continues |

### 10.4 Smart HTTP fixtures

Captured from a real `git-upload-pack` against a small fixture repo. Two
fixtures committed to `test/fixtures/transport/`:

- `info-refs-upload-pack.bin` — discovery response for fetch
- `upload-pack-response-clone.bin` — single-round full clone (NAK + pack)

Tests parse them and assert structural equivalence. A regenerator script
under `scripts/regenerate-transport-fixtures.ts` documents how to update.

### 10.5 Middleware tests

All validation tests are **isolated** (one guard per test) per CLAUDE.md.
Combined "throws on bad input" tests don't kill `&&`-vs-`||` mutants.

**`withRetry` retry behavior:**

- `attempts: 1` → calls inner once, no retry (boundary; pins `>` vs `>=`).
- `attempts: 2`, inner throws once → succeeds on second call.
- `attempts: 3`, inner throws twice then succeeds → succeeds on third call.
- `attempts: 3`, inner throws three times → final error propagates.
- `attempts: 10` → max attempts honored (boundary).
- `attempts: 3`, inner returns `500` then `200` → success; first response's
  `body.cancel()` was called once (spy).
- `body.cancel()` throws → swallowed; retry still proceeds.

**`withRetry` `defaultIsRetryable` table-driven:**

| input                          | expected      | mutant killed                       |
| ------------------------------ | ------------- | ----------------------------------- |
| `error: <any>` no response     | `true`        | error-without-response branch       |
| `response.statusCode: 200`     | `false`       | success path                        |
| `response.statusCode: 429`     | `true`        | 429 carve-in                        |
| `response.statusCode: 499`     | `false`       | <500 boundary                       |
| `response.statusCode: 500`     | `true`        | =500 boundary                       |
| `response.statusCode: 501`     | `false`       | 501 carve-out                       |
| `response.statusCode: 599`     | `true`        | <600 boundary                       |
| `response.statusCode: 600`     | `false`       | =600 boundary                       |

**`withRetry` validation (one test per guard):**

- `attempts: 0` → `RangeError`.
- `attempts: 11` → `RangeError`.
- `attempts: 1.5` → `RangeError`.
- `attempts: NaN` → `RangeError`.
- `baseMs: -1` → `RangeError`.
- `baseMs: Infinity` → `RangeError`.
- `maxDelayMs: 100` with `baseMs: 200` → `RangeError`.
- `jitter: -0.01` → `RangeError`.
- `jitter: 1.01` → `RangeError`.

**`withRetry` cancellation:**

- `req.signal.aborted = true` before call → rejects without calling inner.
- Custom `delay` returns a never-resolving promise; abort the signal
  during backoff → `inner.request` not called a second time; rejection
  observed within one microtask.
- Inner rejects with `DOMException(AbortError)` → no retry attempt.

**`withAuth`:**

- Bearer: header `'Bearer xyz'` set when no auth was present.
- Bearer: existing `Authorization` header preserved verbatim.
- Bearer: existing `authorization` (lowercase) header preserved verbatim
  (case-insensitive override detection).
- Basic ASCII: `username='alice'`, `password='wonderland'` →
  `'Basic YWxpY2U6d29uZGVybGFuZA=='`.
- Basic UTF-8: `username='münchen'`, `password='paßwort'` → matches
  `'Basic ' + Buffer.from('münchen:paßwort', 'utf8').toString('base64')`
  (regression for the §5.2 Latin-1-only `btoa` bug).
- Custom async: function awaited; returned value used.
- Custom returns `''` → `TypeError`.
- Custom returns `undefined` → `TypeError`.
- Validation: empty token (bearer), basic username with `:`.

**`withLogging`:**

- Success → events `[request, response]` in order; `elapsedMs ≥ 0`.
- Failure → events `[request, error]`; original error rethrown by reference
  (`error === originalError`).
- `Authorization` redacted with default config.
- `Authorization` STILL redacted when `redactHeaders: []` (forced).
- Custom additive: `redactHeaders: ['x-trace-id']` drops trace AND
  authorization.
- URL `?access_token=xyz&page=2` logged as `?page=2` (token stripped).
- URL `?api-key=xxx` stripped (case-insensitive key + `[_-]?` matched).
- URL `?normal=value` passes through.
- Logger throws → discarded; downstream request still resolves with
  inner's response.

### 10.6 Mutation testing targets

- **100%** on `pkt-line.ts`, `with-retry.ts`, `capabilities.ts` (densest
  control-flow per byte; isolated boundary tests must kill every
  comparison-operator mutant).
- **≥ 95%** on `with-auth.ts`, `with-logging.ts`, `side-band.ts`.
- **≥ 90%** on `upload-pack.ts`, `receive-pack.ts` (parser arms with
  string-position tweaks where any non-zero offset produces the same
  parse failure are accepted as equivalent — documented in line per
  CLAUDE.md guidance).
- All `withRetry` boundary mutations (`> 0` vs `>= 0`, `< 600` vs `<= 599`,
  `=== 429` vs `!== 429`, `=== 501` vs `!== 501`) killed by §10.5's
  table-driven predicate tests.

### 10.7 No live network tests

Phase 8 ships zero tests that hit a real git server. All transport tests
use `MemoryHttpTransport` (Phase 4) or hand-rolled fakes (`fixtures.ts`).
Phase 11 adds contract tests against a local `git-http-backend` in CI —
that's where real-server compatibility is proven, not here.

**Fixture regeneration.** `scripts/regenerate-transport-fixtures.ts`
(committed) requires a working `git` CLI and an init script that builds
`test/fixtures/transport/repo/` with one commit, then captures the
discovery + clone responses by running the local `git-http-backend` over
a unix socket. Reproducible from a clean checkout.

### 10.8 Test fixtures (`test/unit/transport/fixtures.ts`)

Helpers shared across middleware tests:

- `recordingLogger() => { logger: Logger; events: LogEvent[] }` — assert on
  `events[0].kind === 'request'`, `events[1].headers.authorization === undefined`.
  Avoids brittle call-count assertions.
- `fakeClock(start = 0) => { now: () => number; advance: (ms) => void }` —
  injected as `LoggingConfig.now`. `withLogging` uses `now()` exactly twice
  per request (start + complete), so `elapsedMs` is `advance` total.
- `fakeTransport({ responses, errors }) => HttpTransport` — accepts an
  array of `Response | Error`; each `request(...)` shifts one. Used by
  `withRetry` for sequence-driven scenarios. Throws if drained.
- `controllableDelay() => { delay, resolveAll, advance }` — a `delay`
  primitive whose pending sleeps the test can resolve manually. Required
  for cancellation tests (the default `setTimeout`-based delay would
  pollute timer state across tests).

---

## 11. Phase Ownership

| Obligation                                              | Owner phase | Verification                                |
| ------------------------------------------------------- | ----------- | ------------------------------------------- |
| HTTPS-only (HTTP rejected unless `allowInsecureHttp`)   | 4 (existing) | adapter contract test                      |
| Sanitized network error messages                        | 4 (existing) | Node adapter unit tests                    |
| URL validation (SSRF mitigation) before transport call  | 9           | clone/fetch unit tests with malicious URLs |
| Bounded redirect following + cross-origin auth strip    | 9           | clone/fetch redirect tests                 |
| Reference cap on advertisement parsing                  | 9           | fetch/clone unit tests                     |
| Streaming pack consumption (no full-pack buffering)     | 9 (consumer of §6.3) | integration test with fixture pack |
| Cancellation propagation through middleware             | 8           | `withRetry` cancellation tests             |
| `Authorization` header redaction in all logs            | 8           | `withLogging` test asserts default + custom |
| Smart HTTP v2 support (primary, v1 fallback retained)   | delivered   | `design/incremental-fetch-negotiation.md`, ADRs 450–452 |
| SSH transport                                           | V2 (post-1.0) | non-goal in PRD §3                         |
| Streaming **request** bodies (push of huge repos)       | V2          | requires streaming pack writer              |

---

## 12. Implementation Order

**Pre-step 0 — error scaffold (must be first).** `domain/protocol/error.ts`
ships with the `ProtocolError` union and one factory per variant; `domain/error.ts`
gains the `ProtocolError` member of `TsgitErrorData` and the 13 `extractDetail`
arms. Without this, every subsequent red step has no error helpers to throw.

1. **`pkt-line.ts`** — encoder, decoder, `MAX_PKT_LINE_PAYLOAD`,
   `FLUSH_PKT`/`DELIM_PKT`. Round-trip property test + boundary table (§10.2).
2. **`side-band.ts`** — demuxer + `parseSideBand` callbacks. Tests §10.3.
3. **`capabilities.ts`** — `parseCapabilities`, `formatCapabilities`,
   `negotiateCapabilities`, `AGENT`, `CLIENT_CAPABILITIES_FETCH`,
   `CLIENT_CAPABILITIES_PUSH`.
4. **`upload-pack.ts`** — `buildDiscoveryUrl`, `parseAdvertisedRefs`,
   `buildUploadPackRequest`, `parseUploadPackResponse`. Wire to fixtures §10.4.
5. **`receive-pack.ts`** — `buildReceivePackRequest`, `parseReceivePackResponse`.
   Adds `ZERO_OID` to `domain/objects/object-id.ts` (one-line export).
6. **`domain/protocol/index.ts`** — barrel export; verify dep-cruiser passes
   for the new directory.
7. **`with-retry.ts`** — predicate, jitter, body re-emission, signal
   cooperation, default `delay` primitive. Tests §10.5.
8. **`with-auth.ts`** — bearer/basic/custom; UTF-8 base64; case-insensitive
   override detection. Tests §10.5.
9. **`with-logging.ts`** — events, header + URL redaction, timing,
   logger-throw swallow. Tests §10.5.
10. **`transport/types.ts` + `transport/index.ts`** — barrel.
11. **`package.json`** — add `./transport` exports entry.
    **`.size-limit.json`** — add 2 kB `tsgit/transport` entry; re-run
    `npm run check:size` to verify Core stays under 50 kB after `domain/protocol/*`.
12. **Stryker run** — full mutation pass per §10.6 targets. Fix
    non-equivalent survivors. Document any equivalent mutants inline
    (per CLAUDE.md guidance) before merging to main.

Each step follows red→green→refactor; `npm run validate` after every step.

---

## 13. Open Questions

- **Q1: Should `withLogging` log the request body byte count or skip it?**
  Decision in §5.3 is to log `bodyBytes`. Length is non-sensitive and useful
  for diagnosing "why is push slow" without leaking pack contents. Revisit
  if a use case for omitting it emerges.

- **Q2: Should `withRetry` honor `Retry-After` response headers (429/503)?**
  Not in v1. Adds 50–80 bytes for header parsing + value clamping. Logging
  shows the `Retry-After` value via the response headers; user can build
  a custom predicate that overrides backoff if they want. Re-open if a
  Phase 9 integration uncovers servers that mandate it (GitHub does).

- **Q3: Should `parseAdvertisedRefs` enforce a per-stream ref cap?**
  No — the cap is a Phase 9 concern (different commands want different
  ceilings). Pkt-line decoder rejects oversized packets; ref count is an
  application-level policy. (See §11.)
