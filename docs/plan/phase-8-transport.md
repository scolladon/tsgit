# Plan: Phase 8 — Transport

Implements [design/transport.md](../design/transport.md).
Covers [backlog](../BACKLOG.md) items 8.1–8.4.

### Review Notes

Five self-review passes (architecture/sequencing → spec correctness → impl feasibility → cross-refs/consistency → mutation resistance):

**Pass 1 — Sequencing, factual correctness, script names:**

- **`ObjectId.parse` does not exist.** Step 0(a) red test #2 used `ObjectId.parse(ZERO_OID)`. Actual API is `ObjectId.from(hex)`. Fixed.
- **Tautological test removed.** Step 0(a) red test #3 (`expect(ZERO_OID).toBe(ZERO_OID)`) was a string-literal self-equality — passes regardless of impl. Removed; replaced with a "byte-equivalent to a fresh hand-built 40-zero string" test that actually verifies the constant's value.
- **Backlog mapping fixed.** Row labeled `0(a–c)` but only 0(a) + 0(b) exist; 0(c) is a deferral note. Renamed to `0(a–b)`.
- **Wireit script names corrected.** Plan referenced `check:knip` (no such script — actual: `check:dead-code`), `check:attw` (actual: `check:exports`), `check:spell` (actual: `check:spelling`). Fixed in steps 0(b), 7, 11, 14.
- **Stray cspell entry `vfx`** (left in from an instruction-style comment) removed. Final lexicon list curated to actually-needed terms.
- **Forward reference removed (5.4 → step 1).** The "add EMPTY_WANTS to step 1 retroactively" anti-pattern eliminated by adding the variant upfront in §1.1's union.

**Pass 2 — Test specifications:**

- **Step 2.2 "exactly ONE allocation" test** was unverifiable (V8 has no public allocation spy). Replaced with a deterministic byte-content test: `encodePktStream([a, b])` produces a buffer whose bytes equal `concat(encodePktLine(a), encodePktLine(b), FLUSH_PKT)` — proves the layout without needing allocation introspection.
- **Step 2.3 reassembly cap test reframed.** Original premise ("1-byte chunks summing past cap") cannot trigger overflow because each chunk's first 4 bytes parse to a length prefix > MAX_PKT_LINE_PAYLOAD which throws PKT_TOO_LARGE first. Realistic threat: a single chunk larger than the accumulator capacity. New test: `Given a single chunk of MAX_PKT_LINE_PAYLOAD + 100 bytes whose first 4 bytes are NOT a valid hex length, Then INVALID_PKT_LENGTH (not memory blowup)` proves the parser cannot be DoSed via giant chunks.
- **Step 3 flush handling clarified.** `parseSideBand` MAY receive a `flush` from upstream (the side-band stream typically ends with one). Decision: flush from upstream ends iteration naturally (no yield, no error). Documented in 3.1 + 3.2 fixture.
- **Step 4 AGENT regex relaxed.** Original `/^agent=tsgit\/\d+\.\d+$/` rejected the browser fallback `agent=tsgit/0.x`. New: `/^agent=tsgit\/(?:\d+\.\d+|0\.x)$/`. Test must run identically in Node + browser environments.
- **Step 5.5 packBody laziness test rewritten.** Original premise that "parseUploadPackResponse returns synchronously without reading the source" was wrong — meta packets MUST be consumed before the structure is known. Corrected to: "no channel-1 packet is consumed until packBody is iterated" (assert via marker packet that the source records when reached).
- **Step 6.2 empty updates is now an error, not a wire-shape test.** Original said "support for symmetry" — there is no use case for receive-pack with zero updates. Now: empty updates throws (added EMPTY_RECEIVE_UPDATES to §1.1's union).

**Pass 3 — Implementation feasibility:**

- **Step 8.8 timer-leak test made concrete.** Original "no leaked handle" was unverifiable. Replaced with: spy `globalThis.clearTimeout`, abort the signal, assert `clearTimeout` was called once with the timer's handle.
- **Step 13 captured-fixture scope reduced.** Real `git-http-backend` capture requires a working git CLI, child-process orchestration, and fragile binary capture. Replaced with **hand-crafted fixtures** built via `encodePktStream(...)` calls in a fixture-builder module (`test/fixtures/transport/builders.ts`). Real-server interop testing is deferred to Phase 11 per `docs/design/transport.md` §10.7. Saves ~3 days of script work and removes a flaky CI dependency.
- **Step 14 trim-budget candidates cleaned up.** "Move `defaultIsRetryable` inline" was misleading — it's already inline (only referenced as the default of `RetryConfig.isRetryable`, never exported). Removed; replaced with realistic candidates (drop ASCII-format-cluttered RangeError messages, share regex constants).

**Pass 4 — Cross-refs and consistency:**

- **Step 0 commit-count statement.** "Land as two separate commits" matches the two amendments listed (0(a) + 0(b)). Confirmed; reworded for clarity.
- **Step 5.4 forward-reference removed** (covered by pass 1 fix).
- **Step 9.3 case-sensitivity wording.** "Case-sensitive key preserved" was ambiguous. New phrasing: "the existing key (whatever its casing) is preserved unchanged; the middleware does not rewrite or duplicate it."
- **Dependency Graph ASCII art** rebuilt with correct character alignment (the previous mangled `└─ │` cluster lost its connection lines).
- **Step 11 type re-exports.** `RetryPredicate` is exported from `types.ts` (it's a public type users build custom predicates against) — confirmed in barrel.

**Pass 5 — Mutation resistance:**

- **Validation regex tightened.** Tests using `/attempts/` matched too broadly — any error containing the word "attempts" passes. Tightened to exact substrings of the documented error messages: `/attempts must be 1\.\.10/`, `/baseMs must be ≥ 0/`, `/maxDelayMs must be ≥ baseMs/`, `/jitter must be in \[0, 1\]/`. The factory error messages in §5.1's design are the source of truth.
- **Step 8.4 default-value verification added.** Three tests pin that omitted config fields take their documented defaults: `withRetry({ attempts: 3 })` calls `delay` with `250 * 2^(attempt-1)` (base 250, default exponential), default jitter is 0.2 (verified by deterministic Math.random spy), default `maxDelayMs` clamps at 30 000.
- **Step 8.5 boundary test added.** `attempts: 1, inner rejects → rejection propagates` was missing; now explicit (pins `attempt < attempts` vs `attempt <= attempts` mutant for the trivial case).
- **Step 9.5 inner-not-called assertion added.** Custom-auth callback throwing must propagate AND prove `inner.request` was never called (otherwise the inner adapter could send a request without auth). Spy-based assertion added.
- **Step 1.4 detail-format tests use exact-match assertions** (not regex) — string literals match exactly. Anything fuzzy here lets StringLiteral mutants survive.

---

## Backlog → Step Mapping

| Backlog | Description | Step |
|---|---|---|
| — | Prerequisite amendments (Phase 1 `ZERO_OID` constant + cspell lexicon entries) | 0(a–b) |
| — | Error scaffold: `ProtocolError` union + factories + `TsgitErrorData` widening + `extractDetail` arms | 1 |
| **8.1a** | `pkt-line.ts` — encoder, decoder, `MAX_PKT_LINE_PAYLOAD`, `FLUSH_PKT`, `DELIM_PKT` | 2 |
| **8.1b** | `side-band.ts` — sideband-64k demuxer with `onProgress` / `onError` callbacks | 3 |
| **8.1c** | `capabilities.ts` — `parseCapabilities`, `formatCapabilities`, `negotiateCapabilities`, `AGENT`, client-cap constants | 4 |
| **8.1d** | `upload-pack.ts` — `buildDiscoveryUrl`, `parseAdvertisedRefs`, `buildUploadPackRequest`, `parseUploadPackResponse` | 5 |
| **8.1e** | `receive-pack.ts` — `buildReceivePackRequest`, `parseReceivePackResponse` | 6 |
| — | `domain/protocol/index.ts` barrel + dep-cruiser pass | 7 |
| **8.2** | `with-retry.ts` — predicate, jitter, body re-emission, signal cooperation, default `delay` | 8 |
| **8.3** | `with-auth.ts` — bearer / basic (UTF-8) / custom; case-insensitive override detection | 9 |
| **8.4** | `with-logging.ts` — events, header + URL redaction, timing, logger-throw swallow | 10 |
| — | `transport/types.ts` + `transport/index.ts` barrel | 11 |
| — | Pkt-line round-trip property test (`pkt-line.laws.test.ts`) | 12 |
| — | Hand-built fixtures + integration test (`upload-pack-integration.test.ts`, `receive-pack-integration.test.ts`) | 13 |
| — | `package.json` `./transport` export + `.size-limit.json` entry + size verification | 14 |
| — | Mutation testing + 4× parallel reviews + merge | 15 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step, run: `npm run check:types && npm run test:unit && npm run check:architecture`.

**Commit strategy.** One commit per completed step. Message format: scope matches the file tree being modified.

- Step 0(a) modifies `src/domain/objects/object-id.ts` → `feat(domain):`.
- Step 0(b) modifies `package.json` → `chore:`.
- Step 0(c) modifies `.size-limit.json` placeholder → deferred to step 14 (no separate commit).
- Step 1 modifies `src/domain/protocol/error.ts` (new) + `src/domain/error.ts` + `src/domain/index.ts` → `feat(domain): add Phase 8 protocol error codes`.
- Steps 2–7 add files under `src/domain/protocol/` → `feat(domain):` (protocol is intra-domain).
- Steps 8–11 add files under `src/transport/` → `feat(transport):`.
- Steps 12–13 add tests only → `test(domain):` / `test(transport):`.
- Step 14 modifies build config → `chore: wire Phase 8 transport export`.
- Step 15 squash-merge message: `feat(transport): add phase 8 — smart HTTP and middleware`.

**Size gate.** The 2 kB gzipped cap on `dist/esm/transport/index.js` lands at step 14 only. `domain/protocol/*` rolls into the existing 50 kB Core cap; verified at the same step.

**Branch strategy.** Implement on `feat/phase-8-transport` (or worktree under `.claude/worktrees/phase-8-transport`). Plan + design land directly on main per the Phase 6/7 precedent; implementation goes on a branch and squash-merges.

---

## Prerequisites (before Step 0)

1. **Design doc merged.** `docs/design/transport.md` is on main (commit `<TBD>`). ✓ this commit.
2. **Phases 1–7 complete.** Phase 8 introduces `domain/protocol/` (new sibling under `domain/`) and `src/transport/` (currently empty). Both depend only on Phases 1 + 4.
3. **`size-limit` entry for Transport.** Add to `.size-limit.json` at step 14 with cap `2 kB` gzipped.
4. **`package.json exports`.** New `./transport` entry added at step 14 alongside the existing `./primitives` / `./operators`.
5. **`.dependency-cruiser.cjs` rules.** No new rule needed — existing `transport-only-depends-on-ports` and `domain-cannot-import-outward` cover the new directories. Verified at step 7 + step 11.
6. **`knip.json` entries.** Add `src/transport/index.ts` and `src/domain/protocol/index.ts` to the `entry` array at step 7 / step 11.
7. **`cspell` lexicon.** Add new domain terms surfacing in this plan: `pktline`, `sideband`, `multiack`, `nak`, `symref`, `subprotocol`, `OAuth`, `SigV4`. Land at step 0(b). Verify with `npm run check:spelling` after each docs/plan edit.
8. **No new ADR required.** Every choice with multiple alternatives is documented inline in `docs/design/transport.md`'s Review Notes; none cross the ADR-worthy threshold (no decision overrides a prior phase's stance).

---

## File Conventions

- Source files under `src/domain/protocol/` (parser/serializer code) and `src/transport/` (middleware).
- Test files mirror under `test/unit/domain/protocol/` and `test/unit/transport/`.
- File names: kebab-case (enforced by ls-lint). `pkt-line.ts`, `side-band.ts`, `with-retry.ts`.
- Test file names: `<module>.test.ts`. Shared fixtures in `fixtures.ts`. Property tests in `<module>.laws.test.ts`.
- **Test format:** Given/When/Then titles, AAA bodies with `// Arrange` / `// Act` / `// Assert` comments, `sut` variable.
- **Inline test specifications in this plan use one of two styles.** (a) Full `Given … When … Then …` prose in the plan → copy verbatim as the test title. (b) Shorthand `<scenario>: <outcome>` → rewrite to full `Given … When … Then …` form when authoring the test file.
- **Import extensions:** all imports MUST use the `.js` extension (ESM / verbatimModuleSyntax).
- **Type-only imports:** middleware files use `import type { HttpTransport, HttpRequest, HttpResponse } from '../ports/http-transport.js'`. Runtime imports of port symbols are forbidden — there are none.
- **Error types:** `TsgitError` via named factories from `domain/protocol/error.ts`. Never construct `new TsgitError({...})` in protocol bodies. Middleware throws plain `RangeError` / `TypeError` for misconfiguration (cannot import domain).
- **Iterator protocol:** decoders return `AsyncIterable<T>` (NOT `AsyncGenerator<T, void, unknown>`). Consumers iterate via `for await … of` only.
- **Defensive zero-copy on payload exposure:** `PktLine.payload` is a slice view of the decoder's internal buffer. The `payload === bytesOf(...)` test fixtures explicitly call `.slice()` before retention — documented per design §4.1 and §10.

---

## Design Decisions (applied in this plan)

- **Step 1 (error scaffold) lands BEFORE every other step.** All steps 2–10 throw `protocolError*(...)` factories from their first red test. Without step 1 the test files would not type-check.
- **Steps 2–7 sequence by dependency.** `pkt-line` is foundational; `side-band` consumes `PktLine`; `capabilities` is independent (lands in parallel possible, but kept sequential for review simplicity); `upload-pack` and `receive-pack` consume all of the above.
- **Steps 8–10 (middleware) are independent of 2–7.** The dep-cruiser rule prohibits transport from importing protocol code, so these steps could land in parallel. Kept sequential to keep the implementation branch linear.
- **Step 12 (pkt-line round-trip property test)** uses `fast-check` (already in devDeps — verified). Lands AFTER `pkt-line.ts` (step 2) and AFTER step 1's error scaffold so the property assertions can match `.data.code` / `.data.value`.
- **Step 13 (integration tests with hand-built fixtures)** lands as the last test step before size + merge. Fixture builders live in `test/fixtures/transport/builders.ts` and compose realistic wire bodies via the new `encodePktStream` API — no captured `.bin` files, no `git-http-backend` dependency. Real-server interop is deferred to Phase 11 (per design §10.7).
- **Every boundary cap gets just-under / at / just-over triple tests** per CLAUDE.md: `MAX_PKT_LINE_PAYLOAD` (65516), retry `attempts` (1, 10), retry status code carve-outs (429 / 500 / 501 / 599 / 600), reassembly buffer cap. Listed at the consuming step.
- **All validation tests are isolated** (one guard per test), per CLAUDE.md guard-isolation rule. Combined "throws on bad input" tests don't kill `&&`-vs-`||` mutants.
- **Middleware tests use a `fakeTransport` array-driven mock**, not a hand-written class per test. Defined once in `test/unit/transport/fixtures.ts` (step 8) and reused.
- **Required reading before Step 1:** `docs/design/transport.md` Review Notes (passes 1–5) — enumerates non-obvious decisions (basic-auth UTF-8 routing, `delay(0)` shortcut, URL query redaction, retry idempotency caveat, error swallow contracts). Every step below assumes the reader has internalized these.

---

## Step 0: Prerequisite amendments

Land as two separate commits on the implementation branch, in order. Each is verified by running its originating phase's existing test suite green before the next amendment begins.

### Step 0(a) — Phase 1 `ZERO_OID` constant

**Design:** §6.6.

**Modify:** `src/domain/objects/object-id.ts`.

Add: `export const ZERO_OID: ObjectId = '0000000000000000000000000000000000000000' as ObjectId;`

**Red.** Add tests to `test/unit/domain/objects/object-id.test.ts`:

```
Given ZERO_OID, When inspected, Then ZERO_OID === '0000000000000000000000000000000000000000' (exact-match string equality — pins value against typo mutants).
Given ZERO_OID, When ZERO_OID.length is read, Then it equals 40 (sha1 width).
Given ZERO_OID, When passed to ObjectId.from, Then the call succeeds AND the result equals ZERO_OID (proves ZERO_OID satisfies the existing 40-hex validator — guards against a future change to ObjectId.from that would reject the all-zero form).
```

Three isolated tests. Test 1 pins the literal against character-level mutants. Test 2 pins length independent of the literal (kills mutants that change one character but preserve length, like `'1' + '0'.repeat(39)`). Test 3 pins compatibility with the existing `ObjectId.from(hex)` validator (`SHA1_HEX_RE = /^[0-9a-f]{40}$/`).

**Green.** One-line export. No other changes.

**Verify.** `npm run test:unit -- test/unit/domain/objects/`.

**Commit.** `feat(domain): add ZERO_OID constant for receive-pack create/delete`

### Step 0(b) — `cspell` lexicon entries

**Modify:** `cspell.json` (verified to exist at repo root).

Add to the `words` array: `pktline`, `sideband`, `multiack`, `nak`, `symref`, `subprotocol`, `OAuth`, `SigV4`. (Other terms — `pkt`, `oid` — are already present from earlier phases; verify before adding to avoid duplicates.)

**Red.** None — config change only.

**Verify.** `npm run check:spelling` against the design + plan docs (`docs/design/transport.md` and `docs/plan/phase-8-transport.md`).

**Commit.** `chore: add Phase 8 transport terms to cspell lexicon`

> Step 0(c) — `.size-limit.json` and `package.json` `./transport` export — deferred to Step 14 so it lands together with the actual barrel file. Without `dist/esm/transport/index.js` existing, the size-limit entry has nothing to measure.

---

## Step 1: Error scaffold

**Design:** §9.1.

**Create:** `src/domain/protocol/error.ts`.

**Modify:** `src/domain/error.ts`, `src/domain/index.ts`.

### 1.1 Define `ProtocolError` and factories

`src/domain/protocol/error.ts` (new):

```typescript
import { TsgitError } from '../error.js';

export type ProtocolError =
  | { readonly code: 'INVALID_PKT_LENGTH'; readonly value: string }
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
  | { readonly code: 'INVALID_REPORT_STATUS'; readonly line: string }
  | { readonly code: 'EMPTY_WANTS' }                  // raised by buildUploadPackRequest with no wants
  | { readonly code: 'EMPTY_RECEIVE_UPDATES' };       // raised by buildReceivePackRequest with no updates

export const invalidPktLength = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_PKT_LENGTH', value });
// ... 14 more factories, one per variant (15 total)
```

### 1.2 Wire into `TsgitErrorData`

`src/domain/error.ts`:

- Add `import type { ProtocolError } from './protocol/error.js';`
- Add `| ProtocolError` to the `TsgitErrorData` union.
- Add 15 cases to the `extractDetail()` switch — each formats `data` to a human-readable string (mirror `RefsError` arms for tone). The `default: never` exhaustiveness check will fail-fast at `npm run check:types` if any variant is missed.

Detail format suggestions (exact strings — assertions in §1.4 use exact-match equality, NOT regex):

| code                       | detail format                                         |
| -------------------------- | ----------------------------------------------------- |
| `INVALID_PKT_LENGTH`       | `invalid pkt-line length: ${value}`                   |
| `PKT_LENGTH_RESERVED`      | `reserved pkt-line length: ${value}`                  |
| `PKT_TOO_LARGE`            | `pkt-line too large: ${value} bytes (max 65520)`      |
| `PKT_TRUNCATED`            | `pkt-line truncated: ${remaining} bytes remaining`    |
| `INVALID_BASE_URL`         | `invalid base URL: ${reason}`                         |
| `MISSING_SERVICE_HEADER`   | `missing service header: expected=${expected} actual=${actual}` |
| `MISSING_CAPABILITIES`     | `missing capabilities in advertisement`               |
| `INVALID_REF_LINE`         | `invalid ref line: ${line}`                           |
| `DUPLICATE_REF`            | `duplicate ref: ${name}`                              |
| `INVALID_SIDEBAND_CHANNEL` | `invalid sideband channel: ${channel}`                |
| `SIDEBAND_FATAL`           | `sideband fatal: ${message}`                          |
| `UNKNOWN_ACK_STATUS`       | `unknown ack status: ${value}`                        |
| `INVALID_REPORT_STATUS`    | `invalid report-status line: ${line}`                 |
| `EMPTY_WANTS`              | `upload-pack request has no wants`                    |
| `EMPTY_RECEIVE_UPDATES`    | `receive-pack request has no updates`                 |

### 1.3 Re-export from `domain/index.ts`

Add: `export * from './protocol/error.js';`

### 1.4 Tests

`test/unit/domain/error.test.ts` (or wherever existing extractDetail tests live):

```
For each of the 15 ProtocolError variants:
  Given a TsgitError constructed with that variant's data,
   When .message is read,
   Then it equals (exact match) `${code}: ${detail}` per the table above.
   (NOT regex — use toBe / strictEqual. Regex permits "matches anything containing X" mutants.)
```

15 tests; each pins the detail format against StringLiteral mutations.

```
For each of the 15 ProtocolError variants:
  Given a TsgitError constructed with that variant's data,
   When .data.code is read,
   Then it === '<the variant string literal>' (one test per code — pins string literals against mutation).
```

15 more tests (table-driven via `it.each` if the existing `error.test.ts` already uses that pattern — otherwise spell out). Both batches together = 30 tests; each kills one StringLiteral mutant in either the type union or the format table.

**Verify.** `npm run check:types` (must catch any missed `extractDetail` arm) + `npm run test:unit -- test/unit/domain/error.test.ts`.

**Commit.** `feat(domain): add Phase 8 protocol error codes and factories`

---

## Step 2: `pkt-line.ts`

**Design:** §4.

**Create:** `src/domain/protocol/pkt-line.ts`, `test/unit/domain/protocol/pkt-line.test.ts`.

### 2.1 Public surface

```typescript
export type PktLine =
  | { readonly kind: 'data'; readonly payload: Uint8Array }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

export const MAX_PKT_LINE_PAYLOAD = 65516;
export const FLUSH_PKT: Readonly<Uint8Array>;        // bytes for "0000"
export const DELIM_PKT: Readonly<Uint8Array>;        // bytes for "0001"

export function encodePktLine(payload: Uint8Array): Uint8Array;
export function encodePktStream(payloads: ReadonlyArray<Uint8Array>): Uint8Array;
export function decodePktStream(
  source: AsyncIterable<Uint8Array>,
  options?: { readonly v2?: boolean },
): AsyncIterable<PktLine>;
```

### 2.2 Tests — encoder

**Boundary table** (§10.2):

```
Given an empty payload, When encodePktLine, Then result === bytesOf("0004").
Given a 1-byte payload [0x41], When encodePktLine, Then result === bytesOf("0005A").
Given a payload of MAX_PKT_LINE_PAYLOAD bytes, When encodePktLine, Then result.byteLength === MAX_PKT_LINE_PAYLOAD + 4.
Given a payload of MAX_PKT_LINE_PAYLOAD bytes, When encodePktLine, Then the first 4 bytes equal bytesOf("fff0").
Given a payload of MAX_PKT_LINE_PAYLOAD - 1 bytes, When encodePktLine, Then the first 4 bytes equal bytesOf("ffef").
Given a payload of MAX_PKT_LINE_PAYLOAD + 1 bytes, When encodePktLine, Then it throws RangeError matching /payload too large/.

Given encodePktStream([]), Then result === bytesOf("0000") (just the trailing flush).
Given encodePktStream([bytesOf("foo")]), Then result === bytesOf("0007foo0000").
Given encodePktStream([a, b, c]), Then result === concat(encodePktLine(a), encodePktLine(b), encodePktLine(c), bytesOf("0000")) (byte-equivalent layout — proves sequential packets + trailing flush).
Given encodePktStream with two 1-KB payloads p1, p2, Then result.byteLength === (p1.byteLength + 4) + (p2.byteLength + 4) + 4 (no padding bytes between packets — pins §4.2 single-pass allocation indirectly).
```

The last test verifies the layout has no padding/overhead bytes — the only way to satisfy it is to write each packet contiguously, which is what single-pass allocation produces. (V8 has no public allocation introspection, so direct allocation-count assertions are not feasible.)

### 2.3 Tests — decoder

Per design §10.2 boundary table + reassembly cap:

```
Given the chunk bytesOf("0000"), When decoded, Then yields one { kind: 'flush' }.
Given the chunk bytesOf("0001") with v2: false (default), When decoded, Then throws TsgitError with .data.code === 'PKT_LENGTH_RESERVED' and .data.value === 1.
Given the chunk bytesOf("0001") with v2: true, When decoded, Then yields one { kind: 'delim' }.
Given the chunk bytesOf("0002") with v2: false, Then throws PKT_LENGTH_RESERVED with .data.value === 2.
Given the chunk bytesOf("0002") with v2: true, Then yields one { kind: 'response-end' }.
Given the chunks bytesOf("0003"), Then throws PKT_LENGTH_RESERVED with .data.value === 3 (regardless of v2).
Given the chunk bytesOf("00040000"), When decoded, Then yields { kind: 'data', payload: Uint8Array(0) } then { kind: 'flush' }.
Given the chunk bytesOf("0009done\n"), When decoded, Then yields one data with payload === bytesOf("done\n").

# Reassembly across chunk boundaries
Given chunks bytesOf("00"), bytesOf("09do"), bytesOf("ne\n"), When decoded, Then yields one data with payload === bytesOf("done\n").
Given chunks bytesOf("00090123456"), bytesOf("789\n"), Then yields one data with payload === bytesOf("0123456789\n").

# Multiple packets in one chunk
Given chunks bytesOf("0006A\n0006B\n"), Then yields two data packets in order: payload === bytesOf("A\n") then payload === bytesOf("B\n").

# Boundary triple for length cap
Given a chunk encoding length === 0xfff0 (max), Then yields one data with payload.byteLength === MAX_PKT_LINE_PAYLOAD.
Given a chunk encoding length === 0xfff1 (just over), Then throws PKT_TOO_LARGE with .data.value === 0xfff1.
Given a chunk encoding length === 0xffef (just under max), Then yields one data with payload.byteLength === MAX_PKT_LINE_PAYLOAD - 1.

# Truncation
Given the chunk bytesOf("00") and stream end, Then throws PKT_TRUNCATED with .data.remaining === 2.
Given the chunk bytesOf("0009do") and stream end, Then throws PKT_TRUNCATED with .data.remaining === 6 (4 length + 2 partial payload received; spec value pins partial-payload accounting).

# Invalid length
Given the chunk bytesOf("xxxx"), Then throws INVALID_PKT_LENGTH with .data.value matching /xxxx/i.
Given the chunk bytesOf("0g00"), Then throws INVALID_PKT_LENGTH with .data.value === '0g00'.

# Reassembly buffer cap (DoS resistance — single huge chunk)
Given a single chunk of (MAX_PKT_LINE_PAYLOAD + 100) bytes whose first 4 bytes are "gggg" (NOT valid hex),
 When decoded, Then throws INVALID_PKT_LENGTH (parse runs first, before any oversize accumulator condition can be reached).

Given a single chunk of (MAX_PKT_LINE_PAYLOAD + 100) bytes whose first 4 bytes are "fff5" (length 65525, exceeds max 65520),
 When decoded, Then throws PKT_TOO_LARGE with .data.value === 0xfff5
 (the length-prefix validation catches oversize requests at parse time — the implementation never has to handle accumulator overflow because no valid prefix can demand more than 65520 bytes).
```

> **Implementation note.** The accumulator's natural upper bound is `MAX_PKT_LINE_PAYLOAD + 4 = 65520` bytes (one max-size packet). Because every parseable length prefix above this threshold throws `PKT_TOO_LARGE`, the accumulator can never grow beyond one packet's worth without a parse error firing first. The above tests pin this property; they replace the original "1-byte chunks summing past cap" scenario, which was unreachable (1-byte chunks form parseable prefixes after 4 chunks, triggering errors before any cap-relevant accumulation).

Each guard is its own isolated test (per CLAUDE.md). The "two packets in one chunk" test pins the offset-advance loop. The truncation `remaining` value is a single integer assertion that kills off-by-one mutants.

### 2.4 Tests — case-insensitive length parse

```
Given the chunk bytesOf("000A") (uppercase hex), When decoded with a 6-byte payload that follows, Then yields data of length 6 (parseInt is case-insensitive — spec mandates accept; we emit lowercase).
```

One test pins the spec's "accept either case" requirement.

### 2.5 Implementation notes

- `encodePktLine`: `(len + 0x10000).toString(16).slice(-4)` → ASCII bytes via `TextEncoder` (one shared encoder at module scope).
- `encodePktStream`: pre-compute total size, allocate one `Uint8Array`, `.set()` payloads at known offsets. Trailing `FLUSH_PKT` slice at the end.
- `decodePktStream`: maintain `acc: Uint8Array` (capacity `MAX_PKT_LINE_PAYLOAD + 4`) + `usedLen: number`. On each chunk, copy into `acc` at `usedLen`. Loop: while `usedLen >= 4`, parse 4-byte length; if `usedLen >= length`, yield + slide remaining bytes leftward.
- The slide-left can be a `acc.copyWithin(0, length, usedLen)` + `usedLen -= length`. Avoids per-iteration allocation.
- Use ONE shared `TextDecoder` at module scope for length-prefix parsing (ASCII subset; safe to reuse).

**Verify.** `npm run test:unit -- test/unit/domain/protocol/pkt-line.test.ts && npm run check:architecture`.

**Commit.** `feat(domain): add pkt-line encoder and decoder`

---

## Step 3: `side-band.ts`

**Design:** §4.4.

**Create:** `src/domain/protocol/side-band.ts`, `test/unit/domain/protocol/side-band.test.ts`.

### 3.1 Public surface

```typescript
/**
 * Demux a sideband-64k pkt-line stream into pack bytes (channel 1) plus
 * progress / error callbacks (channels 2 / 3).
 *
 * Termination: iteration ends naturally when the source yields a `flush`
 * packet OR exhausts. Channel-3 packets throw SIDEBAND_FATAL.
 * Unknown channels throw INVALID_SIDEBAND_CHANNEL.
 */
export function parseSideBand(
  source: AsyncIterable<PktLine>,
  options: {
    readonly onProgress?: (text: string) => void;
    readonly onError?:    (text: string) => void;
  },
): AsyncIterable<Uint8Array>;
```

### 3.2 Tests

```
Given a stream of two channel-1 packets [bytesOf([0x01, ...A]), bytesOf([0x01, ...B])],
 When parseSideBand is iterated to exhaustion,
 Then yields exactly two Uint8Arrays containing A then B (no concatenation; one per packet).

Given a channel-2 packet bytesOf([0x02, ...utf8("Counting...")]),
 When parseSideBand is iterated with onProgress callback,
 Then onProgress is called once with "Counting...", and no Uint8Array is yielded for that packet.

Given a channel-3 packet bytesOf([0x03, ...utf8("repository not found")]),
 When parseSideBand is iterated with onError callback,
 Then onError is called once with "repository not found",
 AND iteration throws TsgitError with .data.code === 'SIDEBAND_FATAL' and .data.message === "repository not found".

Given a channel-3 packet WITHOUT an onError callback,
 When parseSideBand is iterated,
 Then iteration still throws SIDEBAND_FATAL (callback is optional — error is non-suppressible).

Given a channel-4 packet,
 When parseSideBand is iterated,
 Then throws INVALID_SIDEBAND_CHANNEL with .data.channel === 4.

Given a channel-0 packet (unused per spec),
 When iterated,
 Then throws INVALID_SIDEBAND_CHANNEL with .data.channel === 0.

Given an empty channel-1 packet bytesOf([0x01]),
 When iterated,
 Then yields one Uint8Array of byteLength 0; iteration continues to the next packet.

Given a source whose only packet is { kind: 'flush' },
 When parseSideBand is iterated,
 Then iteration ends naturally with zero yields and no error
 (pin: flush from upstream signals end-of-sideband-stream — typical for
  upload-pack responses where the trailing flush follows the pack).

Given a stream of [channel-1 packet A, flush, channel-1 packet B],
 When iterated,
 Then yields A only; iteration ends at the flush; B is never reached
 (pins that flush is a hard terminator, not a no-op).

# Callback safety
Given an onProgress callback that throws Error("boom"),
 When a channel-2 packet is processed,
 Then iteration continues normally (the error is swallowed); no yield for that packet; downstream packets are still yielded.

Given an onError callback that throws Error("boom"),
 When a channel-3 packet is processed,
 Then the SIDEBAND_FATAL TsgitError still propagates (NOT the callback's "boom" error).
```

### 3.3 Implementation notes

- Single `TextDecoder('utf-8', { fatal: false })` at module scope.
- Loop body is a small switch on `payload[0]`; default arm raises `INVALID_SIDEBAND_CHANNEL`.
- Channel-1 yields `payload.subarray(1)` — zero-copy view (per design §4.3 and §6.3).
- Callbacks wrapped in `try { … } catch { /* swallow */ }`. No console noise; no rethrow.

**Verify.** `npm run test:unit -- test/unit/domain/protocol/side-band.test.ts`.

**Commit.** `feat(domain): add sideband-64k stream demuxer`

---

## Step 4: `capabilities.ts`

**Design:** §7.

**Create:** `src/domain/protocol/capabilities.ts`, `test/unit/domain/protocol/capabilities.test.ts`.

### 4.1 Public surface

```typescript
export const AGENT: string;                                // 'agent=tsgit/<MAJ.MIN>'
export const CLIENT_CAPABILITIES_FETCH: ReadonlyArray<string>;
export const CLIENT_CAPABILITIES_PUSH: ReadonlyArray<string>;

export function parseCapabilities(tail: string): ReadonlyArray<string>;
export function formatCapabilities(caps: ReadonlyArray<string>): string;
export function negotiateCapabilities(
  serverCaps: ReadonlyArray<string>,
  clientCaps: ReadonlyArray<string>,
): ReadonlyArray<string>;
```

### 4.2 Tests

```
# parseCapabilities
Given "multi_ack_detailed side-band-64k ofs-delta", When parseCapabilities, Then ['multi_ack_detailed', 'side-band-64k', 'ofs-delta'].
Given "agent=git/2.43 thin-pack", When parseCapabilities, Then ['agent=git/2.43', 'thin-pack'].
Given "" (empty tail), When parseCapabilities, Then [] (no capabilities).
Given "  side-band-64k  ofs-delta  " (extra whitespace), When parseCapabilities, Then ['side-band-64k', 'ofs-delta'] (no empty entries).
Given "side-band-64k side-band-64k", When parseCapabilities, Then ['side-band-64k'] (deduplication).
Given "agent=git/2.40 agent=git/2.43" (key= variants), When parseCapabilities, Then ['agent=git/2.43'] (last write wins for key=value shapes — per design §7).

# formatCapabilities
Given ['side-band-64k', 'ofs-delta'], When formatCapabilities, Then 'side-band-64k ofs-delta'.
Given [], When formatCapabilities, Then '' (empty string, not "undefined").
Given ['side-band-64k'], When formatCapabilities, Then 'side-band-64k' (no trailing space).

# negotiateCapabilities
Given server=['side-band-64k', 'ofs-delta', 'extra-cap'], client=['side-band-64k', 'thin-pack'], When negotiated, Then ['side-band-64k'].
Given server=['agent=git/2.43'], client=['agent=tsgit/0.x'], When negotiated, Then ['agent=git/2.43'] (server's value wins on key= shapes).
Given server=[], client=['side-band-64k'], When negotiated, Then [].
Given server=['side-band-64k'], client=[], When negotiated, Then [].

# AGENT constant shape
Given AGENT, When inspected, Then it matches /^agent=tsgit\/(?:\d+\.\d+|0\.x)$/
 (major.minor in Node builds; literal "0.x" fallback in browser builds — both must pass).
Given AGENT, When inspected, Then it does NOT include a patch version segment
 (regex above already enforces this; pinned in a separate test for clarity).
Given AGENT, When inspected, Then it does NOT include a SHA, "+build", or "-rc" suffix
 (fingerprinting reduction — design §7).

# CLIENT_CAPABILITIES_FETCH / _PUSH shape
Given CLIENT_CAPABILITIES_FETCH, Then it includes 'multi_ack_detailed', 'side-band-64k', 'ofs-delta', AGENT, 'thin-pack', 'no-progress', 'include-tag' (one assertion per cap — kills mutation on individual entries).
Given CLIENT_CAPABILITIES_PUSH, Then it includes 'report-status', 'side-band-64k', 'ofs-delta', AGENT, 'atomic', 'delete-refs' (one assertion per cap).
```

Each cap assertion is its own test (per CLAUDE.md isolated-guard rule applied to constant lists).

### 4.3 Implementation notes

- `parseCapabilities`: `tail.split(' ').filter(s => s.length > 0)` then dedupe via `Map<key, value>` where `key` is the substring before `=` (or the whole token if no `=`). Materialize as `Array.from(map.values())`.
- `formatCapabilities`: `caps.join(' ')`.
- `negotiateCapabilities`: build a `Map<key, serverValue>` from server caps; iterate client caps; emit `serverValue` (not client value) if the key is present.
- `AGENT`: IIFE at module scope that reads `process.env.npm_package_version`, splits on `.`, takes first two segments. Falls back to `'0.x'` (literal) for browser builds. Per design §7.

**Verify.** `npm run test:unit -- test/unit/domain/protocol/capabilities.test.ts`.

**Commit.** `feat(domain): add capability parsing and negotiation`

---

## Step 5: `upload-pack.ts`

**Design:** §6.1, §6.2, §6.3.

**Create:** `src/domain/protocol/upload-pack.ts`, `test/unit/domain/protocol/upload-pack.test.ts`.

### 5.1 Public surface

```typescript
export interface AdvertisedRef { readonly name: string; readonly id: ObjectId; readonly peeled?: ObjectId; }
export interface Advertisement {
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<AdvertisedRef>;
  readonly head?: AdvertisedRef;
}
export interface WantHaveRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly haves: ReadonlyArray<ObjectId>;
  readonly capabilities: ReadonlyArray<string>;
  readonly depth?: number;
  readonly done?: boolean;
}
export interface UploadPackResponse {
  readonly acks: ReadonlyArray<{ readonly id: ObjectId; readonly status: 'ack' | 'continue' | 'common' | 'ready' }>;
  readonly nak: boolean;
  readonly packBody: AsyncIterable<Uint8Array>;
}

export function buildDiscoveryUrl(baseUrl: string, service: 'git-upload-pack' | 'git-receive-pack'): string;
export function parseAdvertisedRefs(source: AsyncIterable<PktLine>, expectedService: 'git-upload-pack' | 'git-receive-pack'): Promise<Advertisement>;
export function buildUploadPackRequest(req: WantHaveRequest): Uint8Array;
export function parseUploadPackResponse(
  source: AsyncIterable<PktLine>,
  options: { readonly sideBand: boolean; readonly onProgress?: (text: string) => void },
): UploadPackResponse;
```

### 5.2 Tests — `buildDiscoveryUrl`

```
Given "https://example.com/repo.git" + "git-upload-pack",
 When buildDiscoveryUrl,
 Then "https://example.com/repo.git/info/refs?service=git-upload-pack".

Given "https://example.com/repo.git/" (trailing slash) + "git-upload-pack",
 Then "https://example.com/repo.git/info/refs?service=git-upload-pack" (no double slash).

Given "https://example.com/repo.git?token=xyz" (pre-existing query param) + "git-upload-pack",
 Then "https://example.com/repo.git/info/refs?token=xyz&service=git-upload-pack".

Given "https://example.com/repo.git#frag" (fragment present),
 Then throws TsgitError with .data.code === 'INVALID_BASE_URL' and .data.reason matching /fragment/.

Given "not-a-url",
 Then throws INVALID_BASE_URL with .data.reason matching /invalid URL/.

Given "ftp://example.com/repo" (non-HTTP scheme),
 Then result is "ftp://example.com/repo/info/refs?service=git-upload-pack" (function does NOT validate scheme — that is HTTPS-only check at adapter layer per Phase 4).

Given "https://example.com/repo" (no .git suffix),
 Then "https://example.com/repo/info/refs?service=git-upload-pack" (no .git auto-append).
```

### 5.3 Tests — `parseAdvertisedRefs`

```
# Happy path (full interop test deferred to Step 13 with hand-built fixtures;
# this in-step test uses the SAME builder helpers from Step 13 — declare them
# as a forward dependency or stub locally for Step 5)
Given a discovery body built via buildDiscoveryBody({
  service: 'git-upload-pack',
  capabilities: ['multi_ack_detailed', 'side-band-64k'],
  refs: [{name: 'HEAD', id: OID1}, {name: 'refs/heads/main', id: OID1}],
}) parsed via decodePktStream → parseAdvertisedRefs,
 When result is read,
 Then capabilities deep-equals ['multi_ack_detailed', 'side-band-64k']
 AND refs.length === 2
 AND head?.name === 'HEAD' AND head?.id === OID1.

# Service header validation
Given a stream starting with "# service=git-receive-pack\n" + flush,
 When parseAdvertisedRefs(source, 'git-upload-pack'),
 Then throws MISSING_SERVICE_HEADER with .data.expected === 'git-upload-pack' and .data.actual === 'git-receive-pack'.

Given a stream WITHOUT a "# service=" header,
 Then throws MISSING_SERVICE_HEADER.

# Capability extraction
Given the first ref payload "<sha40> refs/heads/main\0multi_ack_detailed side-band-64k\n",
 When parsed,
 Then capabilities === ['multi_ack_detailed', 'side-band-64k'] and refs[0] === { name: 'refs/heads/main', id: <sha40> }.

Given the first ref payload "<sha40> refs/heads/main\n" (no NUL — no capabilities),
 Then throws MISSING_CAPABILITIES.

# Ref validation
Given a ref line "<sha40>" with no name,
 Then throws INVALID_REF_LINE with .data.line matching the offending line.

Given a ref line "not-a-sha refs/heads/main",
 Then throws INVALID_REF_LINE.

Given two ref lines with the same name,
 Then throws DUPLICATE_REF with .data.name === 'refs/heads/main'.

# Peeled tags
Given lines "<tagSha> refs/tags/v1\n" then "<commitSha> refs/tags/v1^{}\n",
 Then refs has one entry { name: 'refs/tags/v1', id: <tagSha>, peeled: <commitSha> }.

# Symref HEAD resolution
Given capabilities containing "symref=HEAD:refs/heads/main" and a ref line "<sha40> HEAD",
 Then head?.name === 'HEAD' and the underlying refs include 'refs/heads/main' (via symref capability — head is exposed as the HEAD ref, not the target ref).
```

### 5.4 Tests — `buildUploadPackRequest`

```
Given { wants: [oid1], haves: [], capabilities: ['multi_ack_detailed', 'side-band-64k'], done: true },
 When buildUploadPackRequest,
 Then result decodes to:
  - one data pkt-line "want <oid1> multi_ack_detailed side-band-64k\n"
  - flush
  - one data pkt-line "0009done\n" (literal — "done\n" is 5 bytes, length prefix "0009")

Given { wants: [oid1, oid2], haves: [], capabilities: ['side-band-64k'] },
 Then result has two want lines: capabilities only on the first.

Given { wants: [oid1], haves: [oid2, oid3], capabilities: ['side-band-64k'] },
 Then result has want then flush then "have <oid2>\n" then "have <oid3>\n" then a trailing flush (multi-round; no done).

Given { wants: [oid1], haves: [], capabilities: [], depth: 5 },
 Then result includes "deepen 5\n" line before the flush.

Given { wants: [], haves: [], capabilities: [] },
 Then throws TsgitError with .data.code === 'EMPTY_WANTS'
 (the variant is defined in §1.1's ProtocolError union — buildUploadPackRequest
  validates wants.length > 0 at function entry per spec — no want-line means
  no negotiation can occur).
```

### 5.5 Tests — `parseUploadPackResponse`

```
# NAK + pack (sideBand: true)
Given a stream of:
  - data pkt "NAK\n"
  - channel-1 sideband packet of N bytes (pack data)
  - flush
 When parseUploadPackResponse(source, { sideBand: true }),
 Then result.nak === true, result.acks === [], packBody iterated yields N bytes total.

# ACK / continue
Given a stream of:
  - data pkt "ACK <oid> continue\n"
  - data pkt "ACK <oid2>\n"
  - data pkt "NAK\n"
  - channel-1 packet
  - flush
 When parsed (sideBand: true),
 Then acks === [{ id: oid, status: 'continue' }, { id: oid2, status: 'ack' }], nak === true.

# Unknown ACK status
Given "ACK <oid> bogus\n",
 Then throws UNKNOWN_ACK_STATUS with .data.value === 'bogus'.

# sideBand: false
Given a stream of "NAK\n" then raw pack data packets (NOT sidebanded),
 When parsed (sideBand: false),
 Then packBody yields the raw payloads unchanged.

# Progress flow-through
Given a channel-2 packet "Counting objects: 5\n",
 When parsed (sideBand: true) with onProgress spy,
 Then onProgress called once with "Counting objects: 5\n".

# packBody laziness (perf)
Given a source that records every PktLine yielded (a "trackedSource"),
  the source contains: ACK lines, NAK, sentinel "MARKER" pkt-line that flips a
  flag when read, then channel-1 pack packets,
 When parseUploadPackResponse(trackedSource, { sideBand: true }) returns,
 Then trackedSource.read.includes('NAK') === true (meta consumed)
  AND trackedSource.read.includes('MARKER') === false (NOT yet — pack reads are deferred)
  AND markerFlag === false.
 When the consumer iterates packBody (e.g. for await),
 Then markerFlag becomes true (proving pack-channel reads happen lazily on iteration).
```

### 5.6 Implementation notes

- `parseAdvertisedRefs`: consume the first data packet; assert it starts with `# service=`; verify it matches `expectedService`; consume the flush; then consume ref lines until next flush. First ref line carries capabilities (split on `\0`); subsequent lines do not.
- HEAD symref: scan capabilities for `symref=HEAD:<target>` and synthesize the `head` field from the ref whose name === 'HEAD'.
- `buildUploadPackRequest`: build an array of payload `Uint8Array`s, then `encodePktStream(payloads)`. Capabilities emitted only on the first want line.
- `parseUploadPackResponse`: explicit state machine — call `source[Symbol.asyncIterator]()` once; read meta packets (NAK / ACK lines) by inspecting payload prefix; the FIRST packet that does NOT start with `'NAK'` / `'ACK '` belongs to the pack stream. Push that packet back into a one-element pre-buffer that `packBody`'s generator drains before continuing the iterator.
- The shared iterator is the ONLY source — both meta + pack reads come from it. Document that consuming `packBody` advances the underlying source. Calling `packBody` twice yields the same iterator (NOT a multi-shot iterable).
- For `sideBand: false`: the pack-stream packets are raw pkt-line payloads (no channel byte); for `sideBand: true`: the packets are channel-1-prefixed and need `parseSideBand` demultiplexing. The structural meta packets (NAK/ACK) always use raw payloads regardless of sideBand setting.

**Verify.** `npm run test:unit -- test/unit/domain/protocol/upload-pack.test.ts`.

**Commit.** `feat(domain): add smart-HTTP upload-pack message construction`

---

## Step 6: `receive-pack.ts`

**Design:** §6.4, §6.5, §6.6.

**Create:** `src/domain/protocol/receive-pack.ts`, `test/unit/domain/protocol/receive-pack.test.ts`.

### 6.1 Public surface

```typescript
export interface RefUpdate {
  readonly name: string;
  readonly oldId: ObjectId;     // ZERO_OID for create
  readonly newId: ObjectId;     // ZERO_OID for delete
}
export interface ReceivePackRequest {
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly capabilities: ReadonlyArray<string>;
  readonly packfile: Uint8Array;
}
export interface ReceivePackResponse {
  readonly unpackOk: boolean;
  readonly unpackError?: string;
  readonly refUpdates: ReadonlyArray<{ readonly name: string; readonly accepted: boolean; readonly reason?: string }>;
}

export function buildReceivePackRequest(req: ReceivePackRequest): Uint8Array;
export function parseReceivePackResponse(source: AsyncIterable<PktLine>): Promise<ReceivePackResponse>;
```

### 6.2 Tests — `buildReceivePackRequest`

```
# Update (oldId != ZERO, newId != ZERO)
Given { updates: [{ name: 'refs/heads/main', oldId: oid1, newId: oid2 }],
        capabilities: ['report-status', 'side-band-64k'],
        packfile: bytesOf("PACK...") },
 When buildReceivePackRequest,
 Then result starts with the pkt-line "<oid1> <oid2> refs/heads/main\0report-status side-band-64k\n",
 followed by flush, followed by the raw packfile bytes appended (no pkt-line wrapping for the pack itself).

# Create
Given an update with oldId === ZERO_OID and newId !== ZERO_OID,
 Then the line is "0000000000000000000000000000000000000000 <newId> refs/heads/feature\n" (with caps on first if multiple updates).

# Delete
Given an update with oldId !== ZERO_OID and newId === ZERO_OID,
 Then the line is "<oldId> 0000000000000000000000000000000000000000 refs/heads/old\n".

# Multiple updates — caps on first only
Given two updates,
 Then capabilities appear on the first line only; subsequent lines have no NUL/caps.

# Empty updates — error
Given { updates: [], capabilities: [...], packfile: ... },
 Then throws TsgitError with .data.code === 'EMPTY_RECEIVE_UPDATES'
 (push without ref updates is a server-side no-op the spec discourages; we
  reject at the construction boundary. Variant defined in §1.1.)

# Pack appended after flush
Given updates and a 100-byte packfile,
 Then the byte at offset (sum of pkt-line bytes + 4) is the first byte of the packfile; total result.byteLength === sum(pkt-lines) + 4 (flush) + 100.
```

### 6.3 Tests — `parseReceivePackResponse`

```
# Happy path — unpack ok + all refs accepted
Given pkt-lines:
  "unpack ok\n"
  "ok refs/heads/main\n"
  "ok refs/heads/feature\n"
 then flush,
 When parseReceivePackResponse,
 Then unpackOk === true, refUpdates === [
   { name: 'refs/heads/main', accepted: true },
   { name: 'refs/heads/feature', accepted: true },
 ].

# Unpack failed
Given pkt-lines "unpack index-pack failed\n" + flush,
 Then unpackOk === false, unpackError === 'index-pack failed', refUpdates === [].

# Per-ref rejection
Given pkt-lines "unpack ok\n" + "ng refs/heads/main pre-receive hook declined\n" + flush,
 Then refUpdates === [{ name: 'refs/heads/main', accepted: false, reason: 'pre-receive hook declined' }].

# Mixed
Given "unpack ok\n" + "ok refs/heads/main\n" + "ng refs/heads/feature stale ref\n" + flush,
 Then refUpdates has two entries with the documented accepted/reason values.

# Invalid line
Given "unpack ok\n" + "weird line\n" + flush,
 Then throws INVALID_REPORT_STATUS with .data.line matching /weird line/.

# Missing unpack header
Given "ok refs/heads/main\n" + flush (no unpack line first),
 Then throws INVALID_REPORT_STATUS (the first line MUST be unpack).
```

### 6.4 Implementation notes

- `buildReceivePackRequest`: array of payload `Uint8Array`s for the command lines (capabilities NUL-suffixed on the first). Use `encodePktStream(commands)` to get the framed prefix; concatenate with `req.packfile` (single allocation; pre-compute total size).
- `parseReceivePackResponse`: collect pkt-lines until flush; first line must start with `unpack `; subsequent lines are `ok <ref>` or `ng <ref> <reason>`.

**Verify.** `npm run test:unit -- test/unit/domain/protocol/receive-pack.test.ts`.

**Commit.** `feat(domain): add smart-HTTP receive-pack message construction`

---

## Step 7: `domain/protocol/index.ts` barrel + dep-cruiser pass

**Create:** `src/domain/protocol/index.ts`.

Re-export everything from pkt-line, side-band, capabilities, upload-pack, receive-pack, error.

**Modify:** `src/domain/index.ts` — add `export * from './protocol/index.js';`.

**Modify:** `knip.json` — add `src/domain/protocol/index.ts` to `entry`.

**Verify.**

```bash
npm run check:architecture     # dep-cruiser must pass — protocol stays intra-domain
npm run check:types
npm run test:unit
npm run check:dead-code        # knip — no orphan files
```

**Commit.** `feat(domain): export protocol module barrel`

---

## Step 8: `with-retry.ts` + middleware test fixtures

**Design:** §5.1.

**Create:**
- `src/transport/with-retry.ts`
- `src/transport/types.ts` (shared between middleware files)
- `test/unit/transport/with-retry.test.ts`
- `test/unit/transport/fixtures.ts`

### 8.1 `transport/types.ts`

```typescript
import type { HttpResponse } from '../ports/http-transport.js';

export type RetryPredicate = (info: {
  readonly error?: unknown;
  readonly response?: HttpResponse;
  readonly attempt: number;
}) => boolean;

export interface RetryConfig {
  readonly attempts: number;
  readonly backoff?: 'fixed' | 'exponential';
  readonly baseMs?: number;
  readonly maxDelayMs?: number;
  readonly jitter?: number;
  readonly isRetryable?: RetryPredicate;
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export type AuthConfig =
  | { readonly type: 'bearer'; readonly token: string }
  | { readonly type: 'basic';  readonly username: string; readonly password: string }
  | { readonly type: 'custom'; readonly header: (req: HttpRequest) => string | Promise<string> };
// (HttpRequest type-only import added in actual file.)

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
  readonly now?: () => number;
  readonly redactHeaders?: ReadonlyArray<string>;
}
```

### 8.2 `transport/fixtures.ts`

```typescript
export function recordingLogger(): { logger: Logger; events: LogEvent[] } { … }
export function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } { … }
export function fakeTransport(seq: ReadonlyArray<HttpResponse | Error>): HttpTransport { … }
export function controllableDelay(): {
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  pending: ReadonlyArray<{ ms: number; resolve: () => void; reject: (e: unknown) => void }>;
  resolveNext: () => void;
} { … }
export function makeRequest(overrides?: Partial<HttpRequest>): HttpRequest { … }
export function makeResponse(overrides?: Partial<HttpResponse>): HttpResponse { … }
```

### 8.3 `with-retry.ts` public surface

```typescript
export function withRetry(config: RetryConfig): (inner: HttpTransport) => HttpTransport;
```

### 8.4 Tests — validation (one test per guard)

Per CLAUDE.md guard-isolation. **Each assertion uses an EXACT message
match** (not a broad regex) to kill StringLiteral mutants on the message
literals. Documented messages live in `with-retry.ts`'s validation block.

```
withRetry({ attempts: 0 }) throws RangeError with message === 'withRetry: attempts must be 1..10'.
withRetry({ attempts: -1 }) throws RangeError 'withRetry: attempts must be 1..10'.
withRetry({ attempts: 11 }) throws RangeError 'withRetry: attempts must be 1..10'.
withRetry({ attempts: 1.5 }) throws RangeError 'withRetry: attempts must be 1..10'.
withRetry({ attempts: NaN }) throws RangeError 'withRetry: attempts must be 1..10'.
withRetry({ attempts: Infinity }) throws RangeError 'withRetry: attempts must be 1..10'.
withRetry({ attempts: 1 }) returns a function (boundary at 1 — no throw).
withRetry({ attempts: 10 }) returns a function (boundary at 10 — no throw).
withRetry({ attempts: 3, baseMs: -1 }) throws RangeError 'withRetry: baseMs must be ≥ 0'.
withRetry({ attempts: 3, baseMs: Infinity }) throws RangeError 'withRetry: baseMs must be ≥ 0' (Infinity is non-finite).
withRetry({ attempts: 3, baseMs: NaN }) throws RangeError 'withRetry: baseMs must be ≥ 0'.
withRetry({ attempts: 3, baseMs: 0 }) returns a function.
withRetry({ attempts: 3, baseMs: 200, maxDelayMs: 100 }) throws RangeError 'withRetry: maxDelayMs must be ≥ baseMs'.
withRetry({ attempts: 3, baseMs: 100, maxDelayMs: 100 }) returns a function (equal — boundary inclusive).
withRetry({ attempts: 3, jitter: -0.01 }) throws RangeError 'withRetry: jitter must be in [0, 1]'.
withRetry({ attempts: 3, jitter: 1.01 }) throws RangeError 'withRetry: jitter must be in [0, 1]'.
withRetry({ attempts: 3, jitter: 0 }) returns a function.
withRetry({ attempts: 3, jitter: 1 }) returns a function.
```

### 8.4.1 Tests — defaults applied

```
Given withRetry({ attempts: 3 }) with all other fields omitted, AND inner that always returns 500,
  AND a deterministic delay spy + Math.random spy returning 0.5,
 When request is awaited,
 Then the delay spy was called with [250, 500] (default baseMs=250 × default backoff='fixed' would be [250,250];
  default backoff is actually 'fixed' per design §5.1 — the docs default needs to match. If backoff defaults to 'exponential', the values become [250, 500]).
 (This test pins the documented defaults: pick the documented value and assert it.
  If implementation drifts, this test fails — exactly the mutation-resistance behavior we want.)

Given withRetry({ attempts: 3 }) and Math.random returning 0.5,
 When backoff is computed,
 Then default jitter applied is 0.2 → effective multiplier === 1.0 (since 1 - 0.2 + 2*0.2*0.5 === 1.0 — pin against jitter:0 mutant which would also produce 1.0; use Math.random=1.0 instead → multiplier === 1.2, kills the mutant).

Given withRetry({ attempts: 3, baseMs: 100_000 }), inner returns 500 always,
 When delay computed,
 Then delay spy receives values clamped at default maxDelayMs=30_000 (not 100_000).
```

> **Default backoff resolution:** the design §5.1 declares `backoff?: 'fixed' | 'exponential'` without naming a default. The plan resolves this here: **default backoff is `'fixed'`**. Rationale: predictable delays are the safer default; users opt into exponential explicitly. This decision is recorded in design Review Notes when the implementation ships (Step 15.3 doc update).

### 8.5 Tests — retry behavior

```
attempts: 1, inner resolves → inner called once; result === inner's response (no retry path entered).
attempts: 1, inner rejects → inner called EXACTLY once; rejection propagated unchanged.
  (Pins `attempt < attempts` vs `attempt <= attempts` mutant: `<` would call once, `<=` would call twice.)
attempts: 2, inner rejects then resolves → inner called twice; second response returned.
attempts: 2, inner rejects twice → inner called twice; final rejection propagated (off-by-one mutant kill at the boundary).
attempts: 3, inner rejects three times → inner called three times; third rejection propagated.
attempts: 10 with all rejects → inner called 10 times (no off-by-one at upper bound; `<= 10` would call 11).

# Body cancel on 5xx retry
attempts: 2, inner returns 500 then 200 → 200 response returned;
  the 500 response's body.cancel() was called once (spy).

# body.cancel() throws — swallowed
attempts: 2, inner returns 500 with body.cancel() throwing then 200 → 200 returned (cancel error swallowed).

# Custom predicate
attempts: 3, predicate always returns false → inner called once even on rejection.
attempts: 3, predicate returns true on first failure but false on second → inner called twice.
```

### 8.6 Tests — `defaultIsRetryable` table

Table-driven (or `it.each`):

| input                           | expected | mutant killed                  |
| ------------------------------- | -------- | ------------------------------ |
| `error: new Error()`, no resp   | `true`   | error-without-response branch  |
| `response: { statusCode: 200 }` | `false`  | success                        |
| `response: { statusCode: 429 }` | `true`   | 429 carve-in                   |
| `response: { statusCode: 499 }` | `false`  | <500 lower bound               |
| `response: { statusCode: 500 }` | `true`   | =500 lower bound               |
| `response: { statusCode: 501 }` | `false`  | 501 carve-out                  |
| `response: { statusCode: 502 }` | `true`   | post-501 continuity            |
| `response: { statusCode: 599 }` | `true`   | <600 upper bound               |
| `response: { statusCode: 600 }` | `false`  | =600 upper bound               |

### 8.7 Tests — cancellation

```
req.signal.aborted === true at call time → rejects with signal.reason; inner NOT called.

req.signal.abort() during backoff (using controllableDelay) → rejects with signal.reason within one microtask;
  inner called only once (not the would-be retry).

inner rejects with DOMException('AbortError', 'AbortError') → no retry; rejection propagated.
```

### 8.8 Tests — default `delay` primitive

Tested in isolation (not via `withRetry`). Use `vi.useFakeTimers()` for
timer assertions to keep tests deterministic.

```
defaultDelay(0) resolves before any setTimeout fires.
  Setup: vi.useFakeTimers(); spy on globalThis.setTimeout.
  Assert: setTimeout was NOT called; await defaultDelay(0) completes.
  (Pins the §5.1.5 zero-shortcut — without it, setTimeout(fn, 0) would clamp to ~4 ms.)

defaultDelay(50) resolves after exactly 50 ms (fake-timer-advanced).
  Setup: vi.useFakeTimers(); call defaultDelay(50) but do NOT await.
  Action: vi.advanceTimersByTime(49) → promise still pending; vi.advanceTimersByTime(1) → resolves.

defaultDelay(1000, signal) with signal pre-aborted → rejects with signal.reason; setTimeout was NOT called.
  Setup: const controller = new AbortController(); controller.abort('reason');
  Assert: await defaultDelay(1000, controller.signal) rejects with 'reason';
   spy on setTimeout shows zero calls (early-return path).

defaultDelay(1000, signal) with mid-flight abort → rejects with signal.reason; clearTimeout called once.
  Setup: vi.useFakeTimers(); spy on globalThis.clearTimeout; const controller = new AbortController();
  Action: const promise = defaultDelay(1000, controller.signal); controller.abort('mid-abort');
  Assert: await expect(promise).rejects.toBe('mid-abort');
   AND clearTimeout spy called exactly once (no leaked handle — pins the cleanup path).

defaultDelay resolution does NOT depend on signal listener (no abort listener leaked after success).
  Setup: const controller = new AbortController(); spy on signal.addEventListener / removeEventListener.
  Action: vi.useFakeTimers(); const promise = defaultDelay(50, controller.signal); vi.advanceTimersByTime(50); await promise;
  Assert: addEventListener was called once with 'abort'; removeEventListener was called once with the same handler
   (proves the abort listener is unregistered on resolve — otherwise long-lived signals leak listeners).
```

### 8.9 Implementation notes

- Body re-emission: same `req.body` reference is passed into `inner.request` on each attempt. No buffering. (Per design §5.1.2.)
- Backoff: `delayMs = backoff === 'exponential' ? baseMs * 2 ** (attempt - 1) : baseMs`; clamp to `maxDelayMs`; apply jitter `* (1 - jitter + 2 * jitter * Math.random())`.
- Always wrap `body.cancel()` in `try/catch`.
- Pre-attempt: check `req.signal?.aborted` — if true, reject with `req.signal.reason`.
- Pass `req.signal` into `delay(...)` so `controllableDelay` and the default `setTimeout` impl both honor cancellation.

**Verify.** `npm run test:unit -- test/unit/transport/with-retry.test.ts`.

**Commit.** `feat(transport): add withRetry middleware`

---

## Step 9: `with-auth.ts`

**Design:** §5.2.

**Create:** `src/transport/with-auth.ts`, `test/unit/transport/with-auth.test.ts`.

### 9.1 Public surface

```typescript
export function withAuth(config: AuthConfig): (inner: HttpTransport) => HttpTransport;
```

### 9.2 Tests — validation (one test per guard, exact-match messages)

```
withAuth({ type: 'bearer', token: '' }) throws TypeError with message === 'withAuth: token is empty'.
withAuth({ type: 'basic', username: 'a:b', password: 'x' }) throws TypeError with message === 'withAuth: basic username must not contain ":"'.
withAuth({ type: 'basic', username: 'a:', password: 'x' }) throws TypeError 'withAuth: basic username must not contain ":"' (boundary: colon at end).
withAuth({ type: 'basic', username: ':a', password: 'x' }) throws TypeError 'withAuth: basic username must not contain ":"' (boundary: colon at start).
withAuth({ type: 'basic', username: '', password: 'x' }) returns a function (empty username allowed).
withAuth({ type: 'basic', username: 'u', password: '' }) returns a function (empty password allowed).
withAuth({ type: 'custom', header: () => '...' }) returns a function.
```

### 9.3 Tests — bearer

```
Given a request with no Authorization header,
 When withAuth({type:'bearer',token:'xyz'})(inner).request(req),
 Then inner.request was called with headers including 'authorization': 'Bearer xyz'.

Given a request with existing header 'Authorization': 'Bearer override' (capital A),
 When withAuth(...)(inner).request(req),
 Then the headers object inner.request received contains key 'Authorization' with value 'Bearer override',
  AND the headers object does NOT contain a separate 'authorization' key
  (the existing header wins; the middleware does not rewrite the key's casing nor add a duplicate).

Given a request with existing header 'authorization': 'Bearer override' (lowercase),
 When withAuth(...)(inner).request(req),
 Then the headers object inner.request received contains key 'authorization' with value 'Bearer override',
  AND does NOT contain 'Authorization' (case-insensitive override detection — the lowercase key wins, not duplicated under different casing).
```

### 9.4 Tests — basic (UTF-8 critical)

```
Given username='alice', password='wonderland',
 When request is sent,
 Then header value === 'Basic YWxpY2U6d29uZGVybGFuZA==' (Bun/Node btoa-equivalent).

Given username='münchen', password='paßwort' (non-ASCII — RFC 7617 UTF-8 mandate),
 When request is sent,
 Then header value === 'Basic ' + Buffer.from('münchen:paßwort', 'utf8').toString('base64')
 (regression test for the §5.2 Latin-1 btoa bug — value MUST NOT match `'Basic ' + btoa('münchen:paßwort')`, which throws or produces mojibake).

Given username='', password='secret',
 Then header value === 'Basic ' + base64Utf8(':secret').

Given username='user', password='' (empty password),
 Then header value === 'Basic ' + base64Utf8('user:').
```

### 9.5 Tests — custom

```
Given header callback returning 'CustomScheme abc',
 When request is sent,
 Then inner received 'authorization': 'CustomScheme abc'.

Given header callback returning a Promise that resolves to 'token',
 When request is sent,
 Then inner received 'authorization': 'token' (function awaited).

Given header callback receiving the request,
 When called,
 Then it was passed the inbound HttpRequest unchanged (assert via spy: req.url, req.method match).

Given header callback returning '',
 Then withAuth(...)(inner).request(req) rejects with TypeError matching message exactly === 'withAuth: custom returned empty value'
  AND inner.request was NOT called (spy assertion — proves no auth-less request leaked through).

Given header callback returning undefined,
 Then rejects with TypeError 'withAuth: custom returned empty value'
  AND inner.request was NOT called.

Given header callback returning null,
 Then rejects with TypeError 'withAuth: custom returned empty value'
  AND inner.request was NOT called.

Given header callback throwing Error('boom'),
 Then withAuth(...)(inner).request(req) rejects with the original Error('boom') (referential equality)
  AND inner.request was NOT called.
```

### 9.6 Implementation notes

- Helper `base64Utf8(str)`: `const bytes = new TextEncoder().encode(str); return btoa(String.fromCharCode(...bytes));`. Or `Buffer.from(str, 'utf8').toString('base64')` on Node only — but project ships browser, so use the `TextEncoder` form.
  - Note: `String.fromCharCode(...bytes)` spreads up to ~64K args (basic auth credentials are tiny — fine). For long values, fall back to a chunked loop. Document; not relevant here.
- Case-insensitive header lookup: `Object.keys(req.headers).some(k => k.toLowerCase() === 'authorization')`.
- If the inbound has the header (any case), spread into `inner.request(req)` unchanged.

**Verify.** `npm run test:unit -- test/unit/transport/with-auth.test.ts`.

**Commit.** `feat(transport): add withAuth middleware (bearer, basic, custom)`

---

## Step 10: `with-logging.ts`

**Design:** §5.3.

**Create:** `src/transport/with-logging.ts`, `test/unit/transport/with-logging.test.ts`.

### 10.1 Public surface

```typescript
export function withLogging(config: LoggingConfig): (inner: HttpTransport) => HttpTransport;
```

### 10.2 Tests — events on success

```
Given inner resolves with statusCode 200,
 When withLogging(recordingLogger)(inner).request(req),
 Then events.length === 2,
 events[0].kind === 'request' with method, url, headers, bodyBytes set,
 events[1].kind === 'response' with statusCode === 200, elapsedMs >= 0.

Given fakeClock starting at 1000, advanced by 250 between request and response,
 Then events[1].elapsedMs === 250.
```

### 10.3 Tests — events on failure

```
Given inner rejects with originalError,
 When wrapped request is awaited,
 Then events.length === 2,
 events[0].kind === 'request',
 events[1].kind === 'error' with errorMessage === String(originalError.message),
 AND the rejected promise's value === originalError (same reference — NOT a wrapper).
```

### 10.4 Tests — header redaction

```
Given req.headers === { 'authorization': 'Bearer xyz', 'x-trace-id': 'abc' },
 When wrapped request is sent,
 Then events[0].headers.authorization === undefined,
 events[0].headers['x-trace-id'] === 'abc'.

Given headers === { 'Authorization': 'Bearer xyz' } (capital A) AND no custom redactHeaders,
 Then events[0].headers does NOT contain a key whose lowercase form === 'authorization' (case-insensitive scrub).

Given config.redactHeaders === [] (empty),
 Then 'authorization' is STILL stripped (forced; non-opt-out).

Given config.redactHeaders === ['x-trace-id'],
 Then both 'authorization' AND 'x-trace-id' are stripped (additive).

Given headers includes 'cookie', 'set-cookie', 'proxy-authorization',
 Then all four (incl. 'authorization') are stripped by default.
```

### 10.5 Tests — URL redaction

```
url='https://example.com/r?access_token=xyz&page=2' → events[0].url === 'https://example.com/r?page=2'.
url='https://example.com/r?api_key=abc' → events[0].url === 'https://example.com/r' (last param stripped — empty query string elided, NOT '?').
url='https://example.com/r?api-key=abc' → events[0].url === 'https://example.com/r' (matches /api[_-]?key/).
url='https://example.com/r?Token=foo' → stripped (case-insensitive match).
url='https://example.com/r?normal=value' → unchanged.
url='https://example.com/r?password=hunter2' → stripped.
url='https://example.com/r?secret=foo&token=bar&page=2' → events[0].url === 'https://example.com/r?page=2' (multi-strip).
```

### 10.6 Tests — logger throw safety

```
Given a logger whose log() throws Error('boom'),
 When wrapped request is sent and inner resolves with 200,
 Then the wrapped request resolves with 200 (logger's throw swallowed).

Given a logger whose log() throws on the request event but succeeds on response,
 When wrapped request is sent,
 Then the request still emits the response event AND resolves successfully.
```

### 10.7 Implementation notes

- Single regex constant for query-key redaction at module scope: `const REDACT_QUERY_KEYS = /^(access[_-]?token|api[_-]?key|password|secret|token|sig|signature)$/i;`
- URL rebuild via `URL` constructor: parse, iterate `searchParams`, delete matching keys, then `url.toString()`. If `searchParams` becomes empty, the resulting URL has no `?` (URL constructor handles this).
- Header redaction: build a new object excluding the union of default redaction list + user `redactHeaders`. Case-insensitive matching.
- Logger calls always wrapped `try { logger.log(event); } catch { /* swallow */ }`.
- Time measurement: `start = (config.now ?? performance.now)()` once at request entry; `elapsed = (config.now ?? performance.now)() - start` once at completion. No mid-flight measurements.

**Verify.** `npm run test:unit -- test/unit/transport/with-logging.test.ts`.

**Commit.** `feat(transport): add withLogging middleware with redaction`

---

## Step 11: `transport/index.ts` barrel

**Create:** `src/transport/index.ts`.

```typescript
export { withRetry } from './with-retry.js';
export { withAuth } from './with-auth.js';
export { withLogging } from './with-logging.js';
export type { RetryConfig, RetryPredicate, AuthConfig, Logger, LogEvent, LoggingConfig } from './types.js';
```

**Modify:** `knip.json` — add `src/transport/index.ts` to `entry`.

**Verify.**

```bash
npm run check:architecture     # transport-only-depends-on-ports must pass
npm run check:types
npm run check:dead-code        # knip
```

**Commit.** `feat(transport): export barrel`

---

## Step 12: Pkt-line property test

**Create:** `test/unit/domain/protocol/pkt-line.laws.test.ts`.

**Tooling.** Uses `fast-check` (verify it's already in devDeps; if not, install at this step — cspell + dep-cruiser updates not needed since it's a test-only dep).

```
Property: encode-then-decode round-trips.

  fc.property(
    fc.uint8Array({ maxLength: MAX_PKT_LINE_PAYLOAD }),
    async (payload) => {
      const encoded = encodePktLine(payload);
      const decoded: PktLine[] = [];
      for await (const pkt of decodePktStream(asyncOf([encoded]))) decoded.push(pkt);
      expect(decoded).toEqual([{ kind: 'data', payload }]);
    }
  )

Property: encodePktStream-then-decode round-trips for arbitrary payload arrays.

  fc.property(
    fc.array(fc.uint8Array({ maxLength: 1024 }), { maxLength: 50 }),
    async (payloads) => {
      const encoded = encodePktStream(payloads);
      const decoded: PktLine[] = [];
      for await (const pkt of decodePktStream(asyncOf([encoded]))) decoded.push(pkt);
      // First N entries are data with the original payloads; last entry is flush.
      expect(decoded.length).toBe(payloads.length + 1);
      payloads.forEach((p, i) => {
        expect(decoded[i]).toEqual({ kind: 'data', payload: p });
      });
      expect(decoded[payloads.length]).toEqual({ kind: 'flush' });
    }
  )

Property: chunk re-arrangement is invariant.

  fc.property(
    fc.uint8Array({ minLength: 8, maxLength: 4096 }),  // any encoded stream
    fc.array(fc.integer({ min: 1, max: 1024 }), { maxLength: 20 }),  // chunk sizes
    async (encoded, sizes) => {
      const oneChunk = await collect(decodePktStream(asyncOf([encoded])));
      const splitChunks = await collect(decodePktStream(asyncOf(splitBytes(encoded, sizes))));
      expect(splitChunks).toEqual(oneChunk);
    }
  )
  // Predicate: encoded must be a valid pkt-line stream — pre-filter via the encoder, OR accept that the property only asserts equivalence regardless of validity (both throw the same error or both succeed with the same output).
```

Run with `numRuns: 200` minimum; raise to 1000 if test time permits (under 5 s for the property suite).

**Verify.** `npm run test:unit -- test/unit/domain/protocol/pkt-line.laws.test.ts`.

**Commit.** `test(domain): add pkt-line round-trip property tests`

---

## Step 13: Hand-built fixtures + integration test

> **Scope decision.** Real `git-http-backend` capture (with binary fixtures
> committed to the repo) was descoped after pass 3 review — it requires git
> CLI, child-process orchestration, and gives flaky CI. Replaced with
> **hand-built fixtures** that compose the wire format via the new
> `encodePktStream` API. Real-server interop testing is deferred to Phase 11
> per `docs/design/transport.md` §10.7.

**Create:**

- `test/fixtures/transport/builders.ts` — fixture builder helpers that
  compose realistic discovery / upload-pack / receive-pack streams from
  structural inputs.
- `test/unit/domain/protocol/upload-pack-integration.test.ts` — end-to-end
  pipeline test: `builder → bytes → decodePktStream → parseAdvertisedRefs / parseUploadPackResponse`.
- `test/unit/domain/protocol/receive-pack-integration.test.ts` — same shape
  for receive-pack.

### 13.1 `builders.ts`

```typescript
export interface BuiltDiscovery {
  readonly service: 'git-upload-pack' | 'git-receive-pack';
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<{ name: string; id: string; peeled?: string }>;
}

/**
 * Build a discovery response body matching real git-http-backend output.
 * Format: pkt-line "# service=<service>\n", flush, first ref with NUL-suffix
 * capabilities, subsequent refs, peeled tags as "<oid> <name>^{}\n", flush.
 */
export function buildDiscoveryBody(d: BuiltDiscovery): Uint8Array;

/**
 * Build a single-round clone upload-pack response: optional ACK lines,
 * NAK, then a sideband-1 wrapper around `packBytes`, then flush.
 */
export function buildUploadPackResponseBody(opts: {
  readonly acks?: ReadonlyArray<{ id: string; status: 'ack' | 'continue' | 'common' | 'ready' }>;
  readonly packBytes: Uint8Array;
  readonly sideBand: boolean;
  readonly progressLines?: ReadonlyArray<string>;
}): Uint8Array;

/**
 * Build a receive-pack report-status body.
 */
export function buildReceivePackResponseBody(opts: {
  readonly unpackResult: 'ok' | string;            // 'ok' or error message
  readonly refResults: ReadonlyArray<{ name: string; result: 'ok' | string }>;  // 'ok' or ng-reason
  readonly sideBand?: boolean;
}): Uint8Array;
```

The builders use `encodePktStream` from step 2 — they are NOT separate
binary file fixtures; they are pure code. This means every fixture is
self-documenting (read the build call to see the structure) and trivially
updatable (change a field, rerun the test).

### 13.2 Integration tests

```
# upload-pack — discovery
Given a discovery body built with capabilities ['multi_ack_detailed', 'side-band-64k', 'symref=HEAD:refs/heads/main']
  and refs [{name:'HEAD', id:OID1}, {name:'refs/heads/main', id:OID1}, {name:'refs/tags/v1', id:OID2, peeled: OID3}],
 When parsed via decodePktStream → parseAdvertisedRefs(_, 'git-upload-pack'),
 Then capabilities deep-equals the input capabilities (order preserved by parser),
  AND refs has exactly 3 entries with the specified names + ids,
  AND refs.find(r => r.name === 'refs/tags/v1').peeled === OID3,
  AND head?.name === 'HEAD' AND head?.id === OID1.

# upload-pack — clone response
Given an upload-pack response built with no acks (single-round clone), packBytes = bytesOf('PACK\0\0\0\x02...'),
  sideBand: true,
 When parsed via decodePktStream → parseUploadPackResponse(_, { sideBand: true }),
 Then nak === true, acks === [],
  AND collect(packBody) === packBytes (byte-for-byte equality — proves zero-copy + correct sideband demultiplexing).

# upload-pack — multi-round
Given an upload-pack response built with acks=[{id:OID1, status:'continue'}, {id:OID2, status:'ack'}],
 Then result.acks deep-equals the input.

# receive-pack — success
Given a receive-pack response with unpackResult='ok' and refResults=[{name:'refs/heads/main', result:'ok'}],
 When parsed,
 Then unpackOk === true AND refUpdates === [{name:'refs/heads/main', accepted:true}].

# receive-pack — partial rejection
Given unpackResult='ok' and refResults=[{name:'refs/heads/main', result:'ok'}, {name:'refs/heads/feature', result:'pre-receive hook declined'}],
 Then unpackOk === true AND refUpdates has both entries with the documented accepted/reason fields.
```

### 13.3 Real-server interop disclaimer

Add to `docs/design/transport.md` Review Notes (Phase 11 obligation table
already has this — verify): "Phase 8 ships zero tests against a real git
server. Phase 11 adds Playwright + a local `git-http-backend` for
true protocol interop. The hand-built fixtures here pin the parser
against the wire format as specified, NOT against any specific server's
implementation."

**Verify.** `npm run test:unit -- test/unit/domain/protocol/`.

**Commit.** `test(domain): add upload-pack and receive-pack integration tests`

---

## Step 14: `package.json` export + `.size-limit.json` entry + size verification

**Modify:** `package.json`.

Add to `exports`:

```json
"./transport": {
  "import": { "types": "./dist/types/transport/index.d.ts", "default": "./dist/esm/transport/index.js" },
  "require": { "types": "./dist/types/transport/index.d.cts", "default": "./dist/cjs/transport/index.cjs" }
}
```

**Modify:** `.size-limit.json`.

Add (positioned between `Operators` and `Node adapter` for visual order):

```json
{ "name": "Transport", "path": "dist/esm/transport/index.js", "limit": "2 kB", "gzip": true }
```

**Modify:** rollup config — verify `src/transport/index.ts` is picked up as an entry (the existing `src/<bundle>/index.ts` pattern should auto-discover, but verify). If not, add explicitly.

**Verify.**

```bash
npm run build                  # builds dist/esm/transport/index.js
npm run check:size             # all caps respected — Transport ≤ 2 kB, Core ≤ 50 kB
npm run check:exports          # arethetypeswrong — passes for the new ./transport entry
node --input-type=module -e "import('./dist/esm/transport/index.js').then(m => console.log(Object.keys(m)));"
# Expect output: [ 'withRetry', 'withAuth', 'withLogging' ]
```

If `Transport` cap is overshot, candidates for trimming (apply in order):

1. **Shorten `RangeError` messages** — `'attempts must be 1..10'` → `'bad attempts'`. ~30 B per message × 5 guards ≈ 150 B.
2. **Share regex constants between middleware files.** If `with-logging.ts`'s URL-redaction regex appears anywhere else (it doesn't currently), hoist to `transport/types.ts`. Marginal.
3. **Inline shared body closures.** If `with-retry.ts` factors a `delayWithJitter()` helper that's only called once, inline it. ~50–100 B.
4. **As a last resort: relax the cap to 2.5 kB and document why.** The 2 kB cap is an estimate, not a hard requirement; an ADR-style justification in `docs/design/transport.md` Review Notes is acceptable if 2.5 kB is the realistic floor with all features intact.

If `Core` overshoots after `domain/protocol/*` lands, candidates:

1. Split `parseAdvertisedRefs` + smart-HTTP message construction into a separate sub-entry (`tsgit/protocol`) by adding a new export to `package.json` and a new size-limit entry. The `tsgit` Core bundle then only carries pkt-line + capabilities + side-band (the truly common pieces).
2. Trim `extractDetail` arms that share format strings (e.g. consolidate the two EMPTY_* arms via a shared template).

**Commit.** `chore: wire Phase 8 transport export and size-limit entry`

---

## Step 15: Mutation testing + 4× parallel reviews + merge

### 15.1 Mutation testing

Run `npx stryker run` against the new files only (use a focused `mutate` glob in `stryker.conf.json` for this run — full project mutation is too slow for an iteration loop):

```
mutate: [
  "src/domain/protocol/**/*.ts",
  "src/transport/**/*.ts",
  // Keep error.ts, object-id.ts changes via the existing per-domain stryker config — they're already covered.
]
```

Targets per design §10.6:

- 100% mutation score on `pkt-line.ts`, `with-retry.ts`, `capabilities.ts`.
- ≥ 95% on `with-auth.ts`, `with-logging.ts`, `side-band.ts`.
- ≥ 90% on `upload-pack.ts`, `receive-pack.ts`.

For every survivor:

1. Determine if it is **provably equivalent** (e.g. ack-status string-position offset where any non-zero index produces the same parse failure) — document inline with a one-line comment per CLAUDE.md §"Accept provably equivalent mutants".
2. Otherwise, add an isolated test that kills it.

### 15.2 Parallel reviews

Run four agents in parallel (single message, multiple Agent calls), per CLAUDE.md "Parallel Task Execution":

1. **`code-reviewer`** — quality, idiomatic TypeScript, project conventions.
2. **`security-reviewer`** — credential handling, redaction, SSRF stance, parser hardening.
3. **`profiling-driven-optimization`** — hot-path allocations, microtask churn, unnecessary copies.
4. **`test-review`** — coverage holes, mutation-resistant assertions, test isolation.

Address all CRITICAL + HIGH findings before merge. MEDIUM findings either fixed or recorded in `docs/design/transport.md` Review Notes.

### 15.3 Documentation updates

- `README.md` — add a one-line entry under "Transport middleware" showing `import { pipe } from 'tsgit/operators'; import { withRetry, withAuth, withLogging } from 'tsgit/transport';`.
- `docs/design/transport.md` — promote Status from `Draft` to `Implemented (<date>)`. Add post-implementation notes section per Phase 6 / 7 precedent (mutation score, bundle size, surprises).

### 15.4 Merge

- Squash-merge the implementation branch into main.
- Squash commit message: `feat(transport): add phase 8 — smart HTTP and middleware`.
- Delete the implementation branch.
- Update `docs/BACKLOG.md`: items 8.1–8.4 from `[~]` → `[x]`. Bump the Progress line: `Phases 0–8 complete. Phase 9 (Commands) is next.`

**Verify.**

```bash
npm run validate               # full quality gate
git log --oneline -5           # confirm squash landed cleanly
```

**Final commit (on main, post-merge).** Squash message above.

---

## Dependency Graph

Each row lists a step and its hard prerequisites. Sequential implementation
on a single branch keeps the picture linear; the "could parallel" notes
document where a future split-branch workflow could shave wall time.

| Step | Prerequisites | Could parallel with |
| ---- | ------------- | ------------------- |
| 0(a) ZERO_OID                   | none                          | 0(b)                          |
| 0(b) cspell lexicon             | none                          | 0(a)                          |
| 1 protocol error scaffold       | 0(a), 0(b)                    | —                             |
| 2 pkt-line                      | 1                             | 4 (no shared symbols)         |
| 3 side-band                     | 2 (PktLine type)              | 4                             |
| 4 capabilities                  | 1                             | 2, 3, 8, 9, 10                |
| 5 upload-pack                   | 2, 3, 4                       | 6 (no shared symbols)         |
| 6 receive-pack                  | 2, 4, 0(a) (ZERO_OID)         | 5                             |
| 7 protocol barrel + dep-cruiser | 2, 3, 4, 5, 6                 | 8, 9, 10, 11                  |
| 8 with-retry + fixtures.ts      | 1 (only for type-only domain refs in fixtures? no — fixtures don't use domain) | 9, 10, 2–7 |
| 9 with-auth                     | 8 (shares types.ts)           | 10                            |
| 10 with-logging                 | 8 (shares types.ts)           | 9                             |
| 11 transport barrel             | 8, 9, 10                      | 7                             |
| 12 pkt-line laws                | 2, 1                          | 13                            |
| 13 integration fixtures + tests | 5, 6, 7                       | 12                            |
| 14 build + size                 | 7, 11                         | —                             |
| 15 mutation + reviews + merge   | all prior                     | —                             |

**Critical path** (longest chain of dependencies):
`0(a) → 1 → 2 → 5 → 7 → 14 → 15` — 7 hops. (Step 0(b) and Step 4 are off the critical path.)

**Sequential implementation order** (single branch — what the implementer actually executes):
`0(a) → 0(b) → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15`.

**Maximum parallelism** (future optimization — multi-branch workflow):
After Step 1, three branches can land in parallel: {2, 3, 4 → 5 → 6 → 7}, {8 → 9 → 10 → 11}, and (after Step 7) {12, 13}. Step 14 still serializes the merge.

---

## Post-Plan — next branch

Merge of `feat/phase-8-transport` to main starts the Phase 9 (Commands) work:

- Phase 9 design doc (`docs/design/commands.md`) is the next deliverable.
- Phase 9 will consume both the protocol layer (`tsgit/domain/protocol`) and `ctx.transport.request(...)` (with whatever middleware the `openRepository` facade composes).
- Phase 9 owns SSRF mitigation, redirect following, ref count caps — see `docs/design/transport.md` §11 Phase Ownership.

The plan doc itself lands on main as a separate commit BEFORE the implementation branch is opened (matches Phase 6 / 7 precedent).
