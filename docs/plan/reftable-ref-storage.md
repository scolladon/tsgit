# Plan — reftable ref storage

> Source: design doc `docs/design/reftable-ref-storage.md` · ADRs 680, 686, 687, 688, 689, 690,
> 691, 692, 704, 705, 706, 707
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Reading order and shared conventions

**18 parts, strictly sequential, one working tree.** Parts 1–7 are additive (no existing
behaviour changes). Parts 8–11 reshape `RefStore` and are the review-heavy middle. Parts 12–16
land the reftable backend. Part 17 adds one Tier-1 command. Part 18 closes the coordination
point with the sibling plans.

`plan-lint` emits three cognitive-locality warnings. **All three overlaps are deliberate and must
not be merged away:**

- `src/application/primitives/ref-store.ts` (Parts 8 and 13, and touched without being cited by
  Parts 9–11) — Parts 8–11 are the caller-cluster split the `RefStore` reshape requires, one
  part per verb family, because a single part touching all ~40 call sites is unreviewable;
  Part 13 only adds the backend branch to `createRefStore`.
- `src/domain/refs/error.ts` (Parts 2 and 15) — two different error codes added at the two
  different moments each first acquires a throw site. A code with no throw site is dead code,
  which this repo refuses.
- `docs/use/errors.md` (Parts 2, 15 and 18) — the same rule applied to its rows: each row lands
  with its code, and Part 18 only revisits an existing row if the sibling acceptance-gate plan
  wrote it as an enumeration rather than generically.

**House facts every part depends on (do not re-derive):**

- Domain tests mirror `src/` at `test/unit/domain/<subdomain>/…`; application tests at
  `test/unit/application/…`. Tests are never colocated with source.
- Test titles: `describe('Given …')` > `describe('When …')` > `it('Then …')`; body carries
  `// Arrange` / `// Act` / `// Assert` markers; the function under test is aliased
  `const sut = …` (never the result).
- Binary-parser house style (`src/domain/storage/rev-index.ts`, `midx.ts`, `pack-index.ts`):
  module JSDoc first, `SCREAMING_SNAKE` format-prefixed consts, magic as a hex `number`
  compared against `view.getUint32(0)`, size gate FIRST, then
  `new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)` (always all three args —
  subarray safety), all-`readonly` handle interface ending `_bytes: bytes, _view: view`,
  free lookup functions taking the handle first, no classes.
- Error factories are arrow consts: `export const invalidX = (check: XCheck, reason: string):
  TsgitError => new TsgitError({ code: 'INVALID_X', check, reason });` — **check first, reason
  second**. `Check` union members are **kebab-case** (`'hash-version'`, `'chunk-table'`), never
  camelCase; the design doc's `footerCrc`/`blockType` spellings are prose, not the house form.
- Adding one error code touches five places: the union arm + factory in the subdomain
  `error.ts`; a `case` arm in `extractDetail`'s switch in `src/domain/error.ts` (~line 178–563,
  terminated by `const _exhaustive: never = data;` — **compile-blocking**); a `case` arm in
  `test/unit/domain/exhaustiveness.ts` (~line 14–214, same `never` guard — **compile-blocking**);
  a table row in `docs/use/errors.md` (**not** machine-checked — do not skip); and the barrel
  re-export in `src/domain/refs/index.ts`.
- `reports/api.json` is a **pre-push** gate (`.husky/pre-push` → `npm run prepush` →
  `validate` + `check:doc-typedoc`, which runs `npm run docs:json` then
  `git diff --exit-code -- reports/api.json`). A local green `validate` does not clear it.
  Every part that widens a public type or adds a public export regenerates and commits it.
- `mutation-budgets.json` puts `src/domain/**` at break 99 / high 100. The codec parts must be
  mutation-tight: never `toThrow(TsgitError)` alone — always assert `.data.check` and
  `.data.reason`; give each guard clause its own isolated test.
- Equivalent mutants are suppressed only as
  `// Stryker disable next-line <Mutators>: equivalent — <proof>` with a real proof. No other
  ignore directive of any kind.
- `exactOptionalPropertyTypes` is on: build optional fields by conditional spread
  (`...(x !== undefined ? { x } : {})`), never `key: undefined`.
- Interop tests live at `test/integration/*-interop.test.ts`, open with
  `describe.skipIf(!GIT_AVAILABLE)`, and import from `test/integration/interop-helpers.ts`:
  `GIT_AVAILABLE`, `runGit`, `runGitEnv` (scrubs every `GIT_*`, isolates `HOME`, sets
  `GIT_CONFIG_NOSYSTEM=1`), `git(dir, …)`, `gitAsync`, `makePeerPair`, `PeerPair`,
  `initBothRepos`, `disableAutoMaintenance`, `tryRunGitWithExit`
  (`{ stdout, stderr, exitCode }`, never throws), `tryRunGit`. `-C` does **not** override
  `GIT_DIR` — always go through these helpers.
- Every interop file's first JSDoc carries a `@proves` header:
  `surface:` / `bucket: cross-tool-interop` / `unique:` (12–200 chars) / `interopSurface:`
  (comma-separated). `interopSurface` is required iff the bucket is `cross-tool-interop`.
- The reftable format spec that ships with the pinned git build is readable at
  `/opt/homebrew/Cellar/git/2.55.0/share/doc/git-doc/technical/reftable.adoc`. **Where the
  spec and the bytes disagree, the bytes win** — the design records three such divergences
  (S1 `tz_offset`, S2 first restart offset, S3 log-index threshold) and each is pinned below.
- No provenance references (phase / ADR / backlog numbers) in source or test code.

## Part 1 — Close the `updateRef` write-then-throw ordering bug

### Context

A files-backend defect, reachable today and independent of reftable — landed first so it is
reviewable on its own and so the regression pin exists before the seam moves under it.

`src/application/primitives/update-ref.ts` (91 lines, verbatim shape):

```ts
await atomicWriteRef(ctx, name, refPath, content);          // line 46 — COMMITS
if (oldId !== newId) {
  await recordRefUpdate(ctx, name, oldId, newId, options.reflogMessage);   // line 51
}
await logCoupledHead(ctx, store, name, oldId, newId, options.reflogMessage);  // line 53
```

`logCoupledHead` (module-private, lines 80–91) opens with
`const head = await store.resolveDirect(HEAD);` (line 87). **The only read that can refuse runs
after the only write that commits.** A corrupt `HEAD`, a symref cycle or an I/O error therefore
leaves a committed ref, a written reflog, and a thrown call.

Symbols and paths:

- `updateRef(ctx, name, newId, options)` — the only export of
  `src/application/primitives/update-ref.ts`, re-exported at
  `src/application/primitives/index.ts:101`.
- Module-private `deleteRef(store, name)` (lines 56–70) and
  `logCoupledHead(ctx, store, name, oldId, newId, reflogMessage)` (lines 80–91).
- `atomicWriteRef(ctx, refName, refPath, content)` lives in
  `src/application/primitives/atomic-write.ts` (47 lines) — lock via `fs.writeExclusive` on
  `${refPath}.lock`, then `fs.rename`; maps `FILE_EXISTS` to `refLocked(refName)`.
- `getRefStore(ctx)` / `RefStore` from `src/application/primitives/ref-store.ts`;
  `resolveDirect(name)` returns
  `{ kind: 'direct'; id } | { kind: 'symbolic'; target } | { kind: 'missing' }`.
- `recordRefUpdate(ctx, ref, oldId, newId, message)` —
  `src/application/primitives/record-ref-update.ts`, self-gated by private `isLoggable` which
  calls `reflogExists(ctx, ref)` first and the autocreate config second.
- Existing tests to extend: `test/unit/application/primitives/update-ref.test.ts` and
  `test/unit/application/primitives/ref-store.test.ts`. Memory contexts come from
  `createMemoryContext` in `src/adapters/memory/memory-adapter.js`.

The fix is a **reordering only** — the `applyRefUpdates` seam that eventually absorbs it arrives
in Part 10, and this part's test is what proves that later change preserves the property.
Required new order:

```
1  validateRefName(name)
2  current = store.resolveDirect(name)
3  head    = store.resolveDirect(HEAD)     <- MOVED ABOVE every write
4  check   options.expected against current
5  write   atomicWriteRef(…)
6  reflogs recordRefUpdate(name, …) and, when head is symbolic at `name`,
           recordRefUpdate(HEAD, …)
```

`logCoupledHead` therefore splits: the *decision* (`head.kind === 'symbolic' && head.target ===
name`) moves above the write; only the `recordRefUpdate(HEAD, …)` call stays after it. Keep the
existing no-op rule intact — a `oldId === newId` update records no entry on the direct ref, while
the coupled `HEAD` entry is written unconditionally.

Behaviour that must NOT change: every existing `update-ref` test stays green untouched. The
observable difference is confined to the failure path.

### TDD steps

1. **RED** — `test/unit/application/primitives/update-ref.test.ts`, new
   `describe('Given a repository whose HEAD cannot be resolved')` >
   `describe('When updateRef writes a branch')`: seed a memory repo with a valid branch, then
   plant a `HEAD` whose content makes `resolveDirect` throw (write
   `ref: refs/heads/.invalid\n`, which `validateRefName` rejects inside `parseLooseRef`'s
   consumer chain — confirm the exact throwing shape against the current code before asserting).
   `it('Then it throws and leaves the ref and its reflog byte-unchanged')`: capture
   `fs` snapshots of `<gitDir>/refs` and `<gitDir>/logs` before, assert the throw's
   `.data.code`, assert both snapshots are byte-identical after.
   **Expected failure:** the ref file and reflog exist after the throw — the snapshots differ.
2. **RED** — sibling `it('Then the coupled HEAD reflog is not written')` asserting
   `<gitDir>/logs/HEAD` is absent. **Expected failure:** it is present when the branch write
   succeeded before the `HEAD` read failed.
3. **GREEN** — reorder `updateRef` per the sequence above; inline the coupled-`HEAD` decision
   before `atomicWriteRef` and keep only the `recordRefUpdate(ctx, HEAD, …)` call after it.
4. **REFACTOR** — extract the decision as a private
   `coupledHeadTarget(head: ResolveDirectResult, name: RefName): boolean` pure predicate so it
   is independently mutation-testable; keep `updateRef` under 20 lines with early returns.
   Delete `logCoupledHead` if nothing remains of it.

### Gate

```
npx vitest run test/unit/application/primitives/update-ref.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/update-ref.ts test/unit/application/primitives/update-ref.test.ts
```

### Commit

`fix(refs): resolve HEAD before updateRef commits so a refusal leaves no state`

## Part 2 — Reftable codec: header, footer, varint and the refusal code

### Context

First module of the new codec directory `src/domain/refs/reftable/` — the first subdirectory
under `src/domain/refs/`. Pure, zero-copy, no I/O, no `Context`. Tests at
`test/unit/domain/refs/reftable/`.

New files:

- `src/domain/refs/reftable/reftable-format.ts` — header, footer, varint, block framing.
- `test/unit/domain/refs/reftable/reftable-format.test.ts`
- `test/fixtures/refs/reftable-writers.ts` — **fast-check-free** byte writers, per the house
  rule that parity suites on Deno/Bun/workerd must reach fixtures without the dev dependency
  (precedent: `test/fixtures/storage/bitmap-writers.ts`, re-exported through
  `test/unit/domain/storage/arbitraries.ts`).
- `test/unit/domain/refs/reftable/arbitraries.ts` — re-exports the writers; generators arrive
  in Part 5.

Edited: `src/domain/refs/error.ts`, `src/domain/refs/index.ts`, `src/domain/error.ts`,
`test/unit/domain/exhaustiveness.ts`, `test/unit/domain/refs/error.test.ts`,
`docs/use/errors.md`.

**Pinned bytes (measured against git 2.55.0; the spec is secondary):**

- Header v1, 24 bytes: `'REFT' | uint8(version=1) | uint24(block_size) | uint64(min_update_index)
  | uint64(max_update_index)`. Header v2, 28 bytes: identical plus `uint32(hash_id)`, `"sha1"`
  or `"s256"`.
- Footer: the header bytes repeated, then `uint64(ref_index_position)`,
  `uint64((obj_position << 5) | obj_id_len)`, `uint64(obj_index_position)`,
  `uint64(log_position)`, `uint64(log_index_position)`, `uint32(CRC-32 over all preceding
  footer bytes)`. **68 bytes at v1, 72 at v2** — CRC over the first 64 / 68 footer bytes.
- A zero position means the section is absent. The reader stats for the length, seeks to
  `fileLength - footerLength`, and verifies magic, version and CRC-32.
- Measured empty tables: **v1 = 124 bytes, footer at 56; v2 = 132 bytes, footer at 60.** Both
  are literal fixtures.
- Version and hash are coupled by git's writer but **must not be assumed by the reader**:
  `hash_id` is `"sha1"` or `"s256"` and v2 may carry either. `digestLength` (20 / 32) derives
  from `hashId`, is threaded through every record read, and is never a module constant.
- Varint (the pack ofs-delta encoding, confirmed against every fixture):
  `val = buf[p] & 0x7f; while (buf[p] & 0x80) { p++; val = ((val + 1) << 7) | (buf[p] & 0x7f) }`.
  Measured multi-byte cases to pin: `0x8011` = 145, `0x8010` = 144, `0x8001` = 129,
  `0x9f00` = 4096. Needs an overflow guard in the shape of `delta.ts`'s
  `MAX_VARINT_BYTES = 5` — return the house cursor idiom `{ readonly value, readonly nextOffset }`.
- Block framing (non-log): `type | uint24(block_len) | record+ | uint24(restart_offset)+ |
  uint16(restart_count) | padding?`. `block_len` **excludes** padding and, **for the first
  block, includes the 24/28-byte file header**. `restart_count` must not be zero. Block types
  are `'r'` ref, `'i'` index, `'o'` obj, `'g'` log.
- There is no `readUint24` helper anywhere in `src/domain` — this module writes the first one:
  `(view.getUint8(o) << 16) | view.getUint16(o + 1)`.
- 64-bit reads follow the house idiom `high * 0x100000000 + low` with a safe-integer guard
  (`pack-index.ts:104` guards `high > 0x1fffff`).
- **Reuse `crc32` from `src/domain/storage/crc32.ts`** (IEEE poly `0xedb88320`, returns
  unsigned). Do not write a second one.

Public shape (from the design, adjusted to house style):

```ts
export interface ReftableHeader {
  readonly version: 1 | 2;
  readonly blockSize: number;
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
  readonly hashId: 'sha1' | 's256';
  readonly headerLength: 24 | 28;
  readonly digestLength: 20 | 32;
}
export interface ReftableFooter {
  readonly refIndexPosition: number;
  readonly objPosition: number;
  readonly objIdLength: number;
  readonly objIndexPosition: number;
  readonly logPosition: number;
  readonly logIndexPosition: number;
}
export interface Reftable {
  readonly header: ReftableHeader;
  readonly footer: ReftableFooter;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}
export function parseReftable(bytes: Uint8Array): Reftable;
```

The refusal code, added to `src/domain/refs/error.ts` beside `INVALID_PACKED_REFS`:

```ts
export type ReftableCheck =
  | 'magic' | 'version' | 'footer-crc' | 'truncated'
  | 'block-type' | 'restart-count' | 'record-overrun' | 'varint-overflow'
  | 'tables-list';

| { readonly code: 'INVALID_REFTABLE'; readonly check: ReftableCheck; readonly reason: string }

export const invalidReftable = (check: ReftableCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_REFTABLE', check, reason });
```

Only `magic`, `version`, `footer-crc`, `truncated` and `varint-overflow` acquire throw sites in
this part; the remaining members arrive in Parts 3, 4 and 13, and their JSDoc says so (precedent:
`BitmapCheck`'s comment, `src/domain/storage/error.ts:27-33`). `case 'INVALID_REFTABLE':` joins
the grouped `reason` fallthrough in `extractDetail` and the arm in
`test/unit/domain/exhaustiveness.ts`. Echoed input is **truncated to 80 chars** in every reason
(precedent: `packed-refs.ts` `line.slice(0, 80)`). `docs/use/errors.md` gains a row in
`### Refs, reflog, revparse`, between `INVALID_REFLOG_ENTRY` and `REF_CHAIN_TOO_DEEP`:
`| `INVALID_REFTABLE` | `check, reason` | A reftable stack file failed a structural parse gate. |`.

No `@writes` block yet — this module only reads. The writer's block lands in Part 5.

### TDD steps

1. **RED** — `reftable-format.test.ts`, `describe('Given the measured 124-byte empty v1 table')`
   > `describe('When parsing it')` > `it('Then version, blockSize and both update indexes match
   the bytes')`. Fixture built by `buildReftable({version: 1, …})` in
   `test/fixtures/refs/reftable-writers.ts`. **Expected failure:** `parseReftable` does not exist.
2. **RED** — the v2 twin (132 bytes, `hashId: 's256'`, `headerLength: 28`, `digestLength: 32`),
   plus a v2 table carrying `"sha1"` to prove version and hash are decoupled on read.
3. **RED** — footer: all five positions, `objPosition`/`objIdLength` unpacked from the packed
   `uint64`, footer length 68 at v1 and 72 at v2, and a zero position read as absent.
4. **RED** — four isolated refusal tests, each asserting `.data.check` AND `.data.reason` via
   try/catch (never `toThrow(TsgitError)`): bad magic (`'XXXX'`) → `'magic'`; version 9 →
   `'version'`; truncated below the header → `'truncated'`; a poked footer CRC → `'footer-crc'`.
   Poke helpers follow `rev-index.test.ts`'s `pokeSignature`/`pokeVersion`/`truncate` shape.
5. **RED** — varint: the four measured multi-byte values, a single-byte value, and a 6-byte
   sequence → `'varint-overflow'` as its own test.
6. **RED** — block framing: `blockLengthAt` reads `uint24`; `firstBlockLengthIncludesHeader` is
   proved by a two-block fixture where the first block's declared length equals
   `headerLength + bodyLength`; `restart_count === 0` refuses with `'restart-count'`.
7. **RED** — `test/unit/domain/refs/error.test.ts` gains a factory test asserting
   `invalidReftable('magic', 'bad').data` equals `{ code: 'INVALID_REFTABLE', check: 'magic',
   reason: 'bad' }`. **Expected failure:** the export does not exist, and
   `assertExhaustiveSwitch` fails to compile once the union arm lands.
8. **GREEN** — implement `reftable-format.ts`, the error arms and the barrel re-exports
   (`export type { ReftableCheck, ReftableFooter, ReftableHeader, Reftable }` and
   `export { invalidReftable, parseReftable }` in `src/domain/refs/index.ts`, in the existing
   grouped-comment style).
9. **REFACTOR** — hoist every literal into a named const (`REFT_MAGIC = 0x52454654`,
   `HEADER_LENGTH_V1 = 24`, `FOOTER_LENGTH_V1 = 68`, `DIGEST_LENGTH_SHA1 = 20`, …); express
   the v1/v2 pair as a `ReadonlyMap` from version to its lengths, mirroring midx's
   `HASH_VERSION_WIDTH`. Every function under 20 lines with early returns.

### Gate

```
npx vitest run test/unit/domain/refs/reftable test/unit/domain/refs/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/refs src/domain/error.ts test/unit/domain/refs test/unit/domain/exhaustiveness.ts
```

### Commit

`feat(refs): parse reftable headers and footers in both hash widths`

## Part 3 — Reftable codec: ref, index and obj blocks

### Context

Builds directly on Part 2's framing. New file
`src/domain/refs/reftable/reftable-block.ts`, test
`test/unit/domain/refs/reftable/reftable-block.test.ts`; extends
`test/fixtures/refs/reftable-writers.ts` with record-level writers.

**Ref record grammar:**

```
varint(prefix_length) | varint((suffix_length << 3) | value_type) | suffix
  | varint(update_index_delta) | value?
```

`update_index = header.minUpdateIndex + update_index_delta`. `prefix_length` **must be 0** for
the first record in a block and for every record named by a `restart_offset`.

| `value_type` | meaning | value bytes |
|---|---|---|
| `0x0` | deletion / tombstone | none |
| `0x1` | one object name | one digest |
| `0x2` | two object names | ref digest then peeled digest |
| `0x3` | symbolic reference | `varint(target_len) target`, uncompressed |
| `0x4`–`0x7` | reserved → refuse `'record-overrun'` | — |

**The reference fixture is the design's five-ref repository, decoded byte-by-byte — use it
verbatim as the example table.** First ref block at file offset 24, `block_len = 0x00010e` (270):

```
offset  bytes                                       decoded
    28  00 23 "HEAD" 00 0f "refs/heads/main"        prefix 0, type 3 symref, upd_delta 0
    51  00 8011 "refs/heads/deleted" 06 <20B oid>   varint 0x8011 = 145 -> suffix 18, type 1
    93  0b 39 "feature" 04 <20B oid>                prefix 11 = "refs/heads/", type 1
   123  0b 21 "main" 01 <20B oid>                   suffix 4, type 1
   150  0b 43 "symbolic" 05 0f "refs/heads/main"    varint 0x43 = 67 -> suffix 8, type 3
   177  05 8001 "tags/lightweight" 03 <20B oid>     prefix 5 = "refs/", suffix 16, type 1
   217  0a 12 "v1" 02 <20B tag oid> <20B peeled>    prefix 10, type 2 peeled annotated tag
        00001c 000033 0002                          restart_offset[2] = {28, 51}, count 2
```

Two structural facts fall out and each needs its own test. **`HEAD` is an ordinary ref record
inside the stack** (type `0x3` → `refs/heads/main`) — the `.git/HEAD` stub is never consulted.
And **records are sorted by name, not by creation order** (`deleted` precedes `feature`), so a
reader may binary-search but must never assume `update_index` order.

**Restart offsets are relative to the block start, except in the first block where they are
relative to the FILE and therefore include the header — 28 at v1 and 32 at v2.** The spec says
"28" flatly; that sentence is v1-only. The rule is `headerLength + 4`. Derive it; a literal `28`
produces a v2 file no reader can walk.

**Index records** (block type `'i'`):
`varint(prefix_length) | varint((suffix_length << 3) | 0) | suffix | varint(block_position)`.
`block_position` is **absolute from the start of the file**. Measured head:
`69 0000d0` (`'i'`, len 208), then `00 8038 "refs/heads/wide/br00154" 00`, then
`14 18 "312" 9f00` — prefix 20, suffix `"312"`, position varint `9f 00` = 4096.

**Obj records** (block type `'o'`):
`varint(prefix_length) | varint((suffix_length << 3) | cnt_3) | suffix | varint(cnt_large)? |
varint(position_delta)*`. `cnt_3` holds counts 1–7; `cnt_3 === 0` means a `cnt_large` varint
follows; `cnt_3 === 0 && cnt_large === 0` is the "scan all refs" case. The **first
`position_delta` is absolute, the rest relative.** Measured head: `6f 000035` (`'o'`, len 53),
then `00 10 6dc9 14 00 9f00 9f00 …` — a 2-byte abbreviation mapping to 20 ref-block positions,
first absolute (0) then deltas of 4096, with `obj_id_len = 2` from the footer.

**Parser obligations the spec permits and git 2.55.0 never emitted (R12) — all three get tests
built with the fixture writers, because no real-git fixture can produce them:**

| variation | obligation |
|---|---|
| `block_size = 0` | unaligned: never derive the next block position from `block_size`; walk by `block_len`. A ref index is then mandatory when there is more than one ref block. |
| log-only file (`.log` extension) | dispatch on **content** (`footer.logPosition`, absent ref section), never on the filename extension — the `${min}-${max}-${random}` naming is only "suggested" by the spec. |
| multi-level index | read the block type at each `block_position` and **recurse while it is `'i'`**, rather than assuming the target is a leaf. |

Public shape:

```ts
export type ReftableRefValue =
  | { readonly kind: 'deletion' }
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'peeled'; readonly id: ObjectId; readonly peeled: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName };
export interface ReftableRefRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly value: ReftableRefValue;
}
export function lookupReftableRef(table: Reftable, name: RefName): ReftableRefRecord | undefined;
export function iterateReftableRefs(table: Reftable): Iterable<ReftableRefRecord>;
```

`ObjectId` / `RefName` are branded — construct through the factories in
`src/domain/objects/index.js` (`ObjectId.from`, `RefName.from`), and render digests with
`bytesToHex` from `src/domain/objects/encoding.ts`. Also available there: `hexToBytes`,
`compareBytes`, `bytesEqual`, `indexOf`, `encode`, `decode`.

`lookupReftableRef` uses the restart points for a binary search then a forward prefix-decompressed
scan, and consults the ref index when `footer.refIndexPosition !== 0`.

New `ReftableCheck` members acquiring throw sites here: `'block-type'`, `'record-overrun'`.

### TDD steps

1. **RED** — decode the seven-record reference block above and assert each record's `name`,
   `updateIndex` and `value` discriminant, one `it` per `value_type` (0/1/2/3).
   **Expected failure:** `iterateReftableRefs` does not exist.
2. **RED** — `it('Then both restart points carry prefix_length 0')` and a negative test where a
   restart-named record carries a non-zero prefix → `'record-overrun'`.
3. **RED** — prefix compression across a restart boundary: a record whose prefix refers to the
   predecessor *within* its restart run decodes; the first record of the next run does not
   inherit across the boundary.
4. **RED** — first-restart-offset: **two isolated tests**, v1 asserting 28 and v2 asserting 32,
   so a hard-coded `28` dies.
5. **RED** — `lookupReftableRef` finds `refs/heads/main` and returns `undefined` for an absent
   name; a name whose tombstone is present returns the `'deletion'` record (the merge join in
   Part 6 interprets it — the block layer reports it faithfully).
6. **RED** — `value_type` `0x4` refuses with `'record-overrun'`.
7. **RED** — index records: the measured `'i'` block head, `block_position` absolute; and a
   two-level index whose first-level position targets another `'i'` block, proving the recursion.
8. **RED** — obj records: `cnt_3` 1–7, `cnt_3 === 0` → `cnt_large`, the
   `cnt_3 === 0 && cnt_large === 0` scan-all case, and `position_delta` accumulation
   (first absolute, rest relative).
9. **RED** — `block_size = 0` unaligned file with two ref blocks and a mandatory ref index:
   walking by `block_len` yields every record.
10. **RED** — a log-only file (footer has `logPosition !== 0`, no ref section) is dispatched by
    content, not by name.
11. **GREEN** — implement `reftable-block.ts`; extend the fixture writers with
    `buildRefBlock`, `buildIndexBlock`, `buildObjBlock`.
12. **REFACTOR** — factor the shared `varint`-cursor record walk so ref, index and obj decoders
    do not each re-implement it; keep decoders under 20 lines; export the record grammar
    constants by name (`VALUE_TYPE_DELETION = 0x0`, …, `VALUE_TYPE_MASK = 0x7`,
    `SUFFIX_SHIFT = 3`).

### Gate

```
npx vitest run test/unit/domain/refs/reftable && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/reftable test/unit/domain/refs/reftable test/fixtures/refs
```

### Commit

`feat(refs): decode reftable ref, index and obj blocks`

## Part 4 — Reftable codec: log blocks, reflog records and the tz-offset divergence

### Context

New file `src/domain/refs/reftable/reftable-log.ts`, test
`test/unit/domain/refs/reftable/reftable-log.test.ts`.

**Log block framing:**

```
'g' | uint24(block_len) | zlib_deflate { log_record+ | uint24(restart_offset)+ | uint16(restart_count) }
```

`block_len` is the **inflated** size *including* the 4-byte block header — measured 820 against
816 inflated bytes and 102 against 98. Offsets inside the block include the header, so the first
restart offset is 4. **Log blocks are never padded and never aligned; they are written
back-to-back**, so a reader must track bytes consumed by the inflater to find the next block —
the compressed length is not knowable a priori.

**Log key:** `refname '\0' reverse_int64(update_index)` where
`reverse_int64(t) = 0xffffffffffffffff - t`, so newer entries sort first.

```
log_record: varint(prefix_length) | varint((suffix_length << 3) | log_type) | suffix | log_data?
log_data:   old_id | new_id | varint(name_len) name | varint(email_len) email
            | varint(time_seconds) | sint16(tz_offset) | varint(message_len) message
```

`log_type` `0x0` is a reflog tombstone; `0x1` carries `log_data`. A rename is a zero-`new_id`
deletion plus a zero-`old_id` creation.

**S1 — `tz_offset` is the raw `±HHMM` integer, not minutes.** The shipped spec says "the absolute
number of minutes from GMT … `GMT-0800` is encoded as `sint16(-480)`". Six repositories were
built at distinct offsets and the `sint16` read back:

| `GIT_*_DATE` offset | stored `sint16` | spec (minutes) | raw `±HHMM` |
|---|---|---|---|
| `+0230` | **230** | 150 | 230 |
| `+0100` | **100** | 60 | 100 |
| `-0800` | **-800** | -480 | -800 |
| `+0000` | **0** | 0 | 0 |
| `-0530` | **-530** | -330 | -530 |
| `+1345` | **1345** | 825 | 1345 |

Six for six on raw `±HHMM`, zero for six on minutes. **Follow the binary in both directions.**
This lands as one named function pair, `decodeTzOffset` / `encodeTzOffset`, with the six rows as
an `it.each` table exercised in both directions — the single most important unit table in the
suite, because it is the one place the shipped spec would mislead an implementer.

The conversion is cheap because `AuthorIdentity.timezoneOffset`
(`src/domain/objects/author-identity.ts:3-8`) is already a `'+HHMM'` **string** validated by
`/^[+-]\d{4}$/`: `230 → '+0230'`, `-800 → '-0800'`, `0 → '+0000'`, `1345 → '+1345'`. Sign from
the integer's sign, magnitude zero-padded to four digits.

`ReflogEntry` (`src/domain/reflog/reflog-entry.ts`) is
`{ oldId, newId, identity: AuthorIdentity, message }` — the reftable record maps onto it directly.

**The compressor seam.** `src/domain/**` has zero platform dependencies and the `Compressor`
port is async, so the codec cannot import it. The port's
`streamInflate(bytes, offset): Promise<{ output, bytesConsumed }>`
(`src/ports/compressor.ts:36`) is exactly the primitive the unaligned log walk needs.
**Resolution — structural callback, no port import:**

```ts
export type InflateAt = (
  bytes: Uint8Array,
  offset: number,
) => Promise<{ readonly output: Uint8Array; readonly bytesConsumed: number }>;

export interface LoadedReftable extends Reftable {
  /** Inflated log-block payloads in file order. Empty when footer.logPosition === 0. */
  readonly logBlocks: readonly Uint8Array[];
}
export async function loadReftable(bytes: Uint8Array, inflateAt: InflateAt): Promise<LoadedReftable>;
export function iterateReftableLogs(table: LoadedReftable, name?: RefName): Iterable<ReftableLogRecord>;
```

`loadReftable` calls the sync `parseReftable` then walks the log section, inflating block by
block. `iterateReftableLogs` stays synchronous over the pre-inflated payloads, which is what
eager whole-stack loading makes affordable. The `InflateAt` shape matches
`Compressor['streamInflate']` structurally so the application tier passes
`ctx.compressor.streamInflate` with no adapter.

**S3 — the log index threshold.** The spec says a log index **must** be written at 2 or more log
blocks; git writes one only at **4 or more** (measured 2 → none, 3 → none, 4 → present at 5297).
Consequence for the reader: it must brute-force-scan the log section whenever
`log_index_position === 0`, regardless of block count. **Simplification pinned here:** because
the whole table is already in memory, the read path **always** walks the log section linearly and
never consults the log index; the index is parsed into the footer (Part 2) and emitted by the
writer (Part 5) purely for git's benefit. A unit test asserts the walk yields identical records
for a 3-block table with no index and a 4-block table with one.

Record shape:

```ts
export interface ReftableLogRecord {
  readonly name: RefName;
  readonly updateIndex: bigint;
  readonly entry:
    | { readonly kind: 'deletion' }
    | { readonly kind: 'entry'; readonly oldId: ObjectId; readonly newId: ObjectId;
        readonly identity: AuthorIdentity; readonly message: string };
}
```

The decoded reference log block (nine records over three ref names) confirms grouping and
ordering: `HEAD` entries first at update_index 7, 6, 5, 3, 2 descending, then `refs/heads/main`
at 3, 2, then `refs/heads/other` at 4, then `refs/stash` at 8. **`HEAD` carries its own reflog
inside the stack**, including `checkout: moving from …` entries.

Tests inflate with `MemoryCompressor` from `src/adapters/memory/memory-compressor.js` — real
zlib under Node, and the only inflate available to a domain test.

### TDD steps

1. **RED** — `describe('Given an arbitrary reflog timezone offset')` >
   `describe('When decoding the stored sint16')` with the six measured rows as `it.each`
   (`label` field, not `then`). **Expected failure:** `decodeTzOffset` does not exist.
2. **RED** — the same six rows through `encodeTzOffset`, plus
   `it('Then decodeTzOffset(encodeTzOffset(x)) is x')` over the six.
3. **RED** — `loadReftable` over the measured single-log-block fixture: `block_len` is the
   inflated size **including** the 4-byte header (assert 820 against 816 and 102 against 98 as
   two rows), and the first restart offset is 4.
4. **RED** — two consecutive unaligned log blocks: the second is found from the first's
   `bytesConsumed`, not from `block_size`. **Expected failure:** the walk misses it.
5. **RED** — `log_type` 0 (tombstone) and 1 (full entry) as separate tests; the full entry
   asserts `oldId`, `newId`, `identity` (all four fields) and `message`.
6. **RED** — `reverse_int64` key ordering: nine records over three names decode in the measured
   descending-`update_index`, grouped-by-name order; `iterateReftableLogs(table, 'HEAD')`
   returns only the `HEAD` group.
7. **RED** — a 3-log-block table with `log_index_position === 0` and a 4-block table with an
   index yield the same records under the same walk.
8. **GREEN** — implement `reftable-log.ts` and the log writers in
   `test/fixtures/refs/reftable-writers.ts`.
9. **REFACTOR** — extract `decodeLogData` and the `sint16` read into named helpers; name every
   constant (`LOG_TYPE_DELETION = 0x0`, `LOG_BLOCK_HEADER_LENGTH = 4`, `REVERSE_INT64_MAX =
   0xffffffffffffffffn`). Re-export the log types and `loadReftable` from
   `src/domain/refs/index.ts`.

### Gate

```
npx vitest run test/unit/domain/refs/reftable && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/reftable test/unit/domain/refs/reftable test/fixtures/refs
```

### Commit

`feat(refs): decode reftable log blocks with git's raw HHMM timezone encoding`

## Part 5 — The reftable writer

### Context

New file `src/domain/refs/reftable/reftable-writer.ts`; tests
`test/unit/domain/refs/reftable/reftable-writer.test.ts` and the first property file
`test/unit/domain/refs/reftable/reftable-writer.properties.test.ts`; generators added to
`test/unit/domain/refs/reftable/arbitraries.ts`.

**Entry point.** DEFLATE is async through the port, so the top-level writer is async and takes a
structural callback (same discipline as Part 4's `InflateAt`), while the deterministic majority
stays sync and pure:

```ts
export type DeflateBlock = (data: Uint8Array) => Promise<Uint8Array>;

export interface ReftableWriteOptions {
  readonly hashId: 'sha1' | 's256';   // fixes version: sha1 -> 1, s256 -> 2
  readonly blockSize: number;         // default 4096
  readonly restartInterval: number;   // default 16
  readonly indexObjects: boolean;     // default true
  readonly minUpdateIndex: bigint;
  readonly maxUpdateIndex: bigint;
}

/** Header + ref blocks + ref index + obj blocks + padding. Pure, sync, deterministic. */
export function buildReftableRefSection(
  refs: readonly ReftableRefRecord[],
  options: ReftableWriteOptions,
): Uint8Array;

export async function serializeReftable(
  refs: readonly ReftableRefRecord[],   // caller-sorted by name
  logs: readonly ReftableLogRecord[],   // caller-sorted by (name, reverse update_index)
  options: ReftableWriteOptions,
  deflate: DeflateBlock,
): Promise<Uint8Array>;
```

`buildReftableRefSection` is exported deliberately: everything before `log_position` is
byte-reproducible, and it is the single function the byte-identity interop assertion targets.
The log section is not reproducible and never will be (see below).

**Every writer choice is a measured row — each becomes a named const, never a literal at its use
site:**

| choice | git 2.55.0 |
|---|---|
| `block_size` | **4096** (`DEFAULT_BLOCK_SIZE`), written into the header |
| `restart_interval` | **16** records (measured by ratio: `reftable.restartInterval` 8 → `restart_count` 17 in a full 4096-byte block, 64 → 3–4, unset → 10) |
| ref/obj/index padding | zero bytes to the next `block_size` boundary |
| log blocks | never padded, never aligned, back-to-back |
| **ref index emitted** | only at **≥ 4 ref blocks** (3 blocks/400 refs → position 0; 4/450 → index at 16384; 5/600 → 20480) |
| **log index emitted** | only at **≥ 4 log blocks** — contradicting the spec's MUST at 2 (2 → 0, 3 → 0, 4 → 5297) |
| multi-level index | when the index level itself needs > 3 blocks |
| **obj section emitted** | only when the ref section got an index **and** `indexObjects` |
| `obj_id_len` | longest common prefix among adjacent sorted oids **+ 1**, minimum 2 (measured 2) |
| log message | trailing `\n`s stripped, an embedded `\n` is an error, then exactly **one `\n` appended**; an absent message becomes `'\n'`, **not** an absent record |
| log compression | zlib `deflateInit(level 9)`, default `windowBits`/`memLevel`/strategy |
| fresh table's `min`/`max_update_index` | both = `stack.maxUpdateIndex + 1` |
| compacted table's indexes | min of the oldest merged table, max of the newest |

Structural obligations:

1. **Header** — `'REFT'`, version from `hashId` (1 for `sha1`, 2 for `s256`), `uint24` block
   size, both update indexes; 24 bytes at v1, 28 at v2, `hash_id` written only at v2.
2. **Blocks** — records appended until the next would overflow `block_size`; a restart point
   every `restart_interval` records **and always at the first record of a block**, with
   `prefix_length = 0` at every restart. `block_len` as `uint24`, **including the file header
   for the first block**. Trailer: `uint24 restart_offset[]`, `uint16 restart_count`.
3. **The first restart offset is `headerLength + 4`** — 28 at v1, **32 at v2**. Derived, never
   a literal.
4. **Footer** — header bytes, the five positions, `obj_position << 5 | obj_id_len`, then CRC-32
   over the preceding 64 (v1) / 68 (v2) bytes. 68 / 72 bytes total.
5. **Width genericity** — header length, footer length, first restart offset, digest length and
   every `0x1`/`0x2` value and `log_data` oid pair derive from `hashId`. **No literal `20`,
   `40`, `24`, `28`, `68` or `72` outside the header/footer codec.**

**What the writer must NOT chase.** The log section's DEFLATE stream is implementation-defined:
git (Apple libz 1.2.12, level 9) produces 145 bytes where Node zlib 1.3.1 produces 147 and
`CompressionStream('deflate')` produces 147 different bytes again; a sweep of 2835 Node parameter
combinations reproduced none. All four inflate to identical content. Ask the port for level 9
because that is git's choice and it minimises size, and accept that the bytes differ. The footer
CRC covers only the footer, so a differing log section invalidates nothing.

**`@writes` block** — required by `tooling/audit-write-surfaces.ts`, first JSDoc in the file,
exactly three keys, `surface` matching `/^[a-z][a-zA-Z0-9.-]{1,40}$/`, `format` matching
`/^[a-z][a-z0-9-]+$/` at 4–40 chars:

```
 * @writes
 *   surface: reftable
 *   kind:    equivalent-under-readback
 *   format:  git-reftable-v1
```

`kind` is the weaker of the two because the audit permits one kind per surface and the log section
is not byte-reproducible; the byte-identical prefix is pinned by the interop assertion in
Part 15 instead. The audit pairs `surface: reftable` to a `test/integration/*.test.ts` whose
`@proves` header carries `bucket: cross-tool-interop` and `interopSurface: reftable` — that test
arrives in Part 13, so **this part will show one `gaps` finding until then**. The audit ships
warn-only, so it does not block; do **not** add an allowlist entry
(`tooling/audit-write-surfaces.allowlist.json` is `{ "surfaces": [] }` and must stay empty).

**Property tests (the first two of four lenses).** Generators live in
`test/unit/domain/refs/reftable/arbitraries.ts`:

- `arbRefName()` — valid grammar, ASCII, no NUL, bounded depth. `test/unit/domain/refs/
  arbitraries.ts` already exports an `arbRefName`; reuse or extend it rather than forking.
- `arbRefRecord()` — over all four value types.
- `arbLogRecord()` — both log types, `tz_offset` in ±1400.
- `arbWriteOptions()` — `{ hashId, blockSize ∈ {0, 512, 4096}, restartInterval ∈ 1..64,
  indexObjects }`.

**Lens 1 (round-trip), `numRuns: 200`**, `fc.asyncProperty` because `serializeReftable` and
`loadReftable` are async: `loadReftable(await serializeReftable(refs, logs, opts, deflate),
inflateAt)` yields exactly `refs` and `logs`. **The canonicalisation the round-trip is modulo,
stated in the test so it is not a tautology:** (i) refs compared as a **set keyed by name**,
because the writer sorts by name and the caller's order is not preserved; (ii) logs compared
sorted by `(name, reverse update_index)`; (iii) log **messages** round-trip through the
canonicalisation above, so the generator emits messages without embedded `\n` and the oracle is
`canonicaliseLogMessage(m)`, not `m`; (iv) `update_index` compared as the absolute value, not
the delta encoding.

**Lens 3 (total function over a grammar), `numRuns: 50`** — the flagship robustness property
every binary parser in this repo carries: `parseReftable` over a declared safe subset
(well-formed header + footer + arbitrary block payload) must never throw anything other than
`INVALID_REFTABLE`, never hang, and never read out of bounds. Copy the generation trick from
`test/unit/domain/storage/rev-index.properties.test.ts`: half the runs start from a **valid**
built table and corrupt a window of it, because raw bytes almost never survive the magic gate.

Never commit a seed.

### TDD steps

1. **RED** — one test per writer-choice row above, with the measured value as the oracle:
   `block_size` 4096 in the header; `restart_interval` 16; zero padding to the boundary; log
   blocks unpadded; `block_len` including the file header on the first block.
   **Expected failure:** `serializeReftable` does not exist.
2. **RED** — first restart offset: **isolated tests per version**, 28 at v1 and 32 at v2, so a
   hard-coded 28 dies.
3. **RED** — threshold pairs, both sides of each boundary (these are the rows a mutant most
   easily survives, so each is a pair, never a single case): **3 ref blocks → no index, 4 →
   index**; **3 log blocks → no log index, 4 → log index**; **obj section absent at 3 ref
   blocks, present at 4**.
4. **RED** — `obj_id_len` is the longest adjacent common prefix + 1 with a floor of 2, including
   an oid set that forces 3.
5. **RED** — log message canonicalisation: trailing `\n`s stripped; an embedded `\n` rejected
   with its own `check`; absent message → `'\n'`.
6. **RED** — round-trip through `parseReftable` for a v1 and a v2 table, asserting the parsed
   header/footer equal the options that produced them.
7. **RED** — `reftable-writer.properties.test.ts` lens 1 and lens 3 as above.
8. **GREEN** — implement `reftable-writer.ts` and the generators.
9. **REFACTOR** — split block assembly, index construction and footer emission into named
   private functions each under 20 lines; hoist `DEFAULT_BLOCK_SIZE = 4096`,
   `DEFAULT_RESTART_INTERVAL = 16`, `INDEX_EMIT_THRESHOLD_BLOCKS = 4`, `MIN_OBJ_ID_LENGTH = 2`,
   `MULTI_LEVEL_INDEX_THRESHOLD_BLOCKS = 3`. Add the `@writes` block. Re-export
   `serializeReftable`, `buildReftableRefSection` and `ReftableWriteOptions` from
   `src/domain/refs/index.ts`, then regenerate and commit `reports/api.json`
   (`npm run docs:json`) — this is the pre-push gate, not the validate gate.

### Gate

```
npx vitest run test/unit/domain/refs/reftable && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/reftable src/domain/refs/index.ts test/unit/domain/refs/reftable test/fixtures/refs
```

### Commit

`feat(refs): serialize reftable tables in both hash widths`

## Part 6 — The pure stack: merge view and compaction policy

### Context

Two pure domain modules, no I/O, both consumed by every later part. Merged into one part because
each is a handful of total functions over already-decoded data.

New files:

- `src/domain/refs/reftable/reftable-stack.ts` — the merge view.
- `src/domain/refs/reftable/reftable-compaction.ts` — the compaction policy.
- `test/unit/domain/refs/reftable/reftable-stack.test.ts`,
  `reftable-compaction.test.ts`, `reftable-stack.properties.test.ts`.

**The merge view.** A stack is an ordered list of loaded tables, **oldest → newest** (the order
`tables.list` records). Decoding a name is a **merge join, not a concatenation** — the newest
occurrence wins, and a `deletion` in the newest wins over a live record below it. Getting this
backwards resurrects deleted refs.

```ts
export interface ReftableStack {
  lookup(name: RefName): ReftableRefRecord | undefined;   // newest first, tombstone wins
  names(): Iterable<RefName>;                             // merge join, tombstones removed
  logs(name: RefName): Iterable<ReftableLogRecord>;       // newest update_index first
  readonly tables: readonly LoadedReftable[];             // oldest -> newest, for the writer
  readonly maxUpdateIndex: bigint;
}
export function createReftableStack(tables: readonly LoadedReftable[]): ReftableStack;
```

The canonical fixture is the design's measured two-table stack: table 1 (`min=1, max=7`) carries
the seven-record block from Part 3 including a live `refs/heads/deleted`; table 2 (`min=8,
max=8`) carries one tombstone:

```
header(min=8,max=8) | 'r' 000037 | 00 8010 "refs/heads/deleted" 00 | 00001c 0001 | log block | footer
```

`varint 0x8010 = 144`; `144 >> 3 = 18` (the name length), `144 & 7 = 0` → value_type 0, no value.
**A reader that concatenates instead of merge-joining resurrects `refs/heads/deleted`** — this
exact shape is the interop pin in Part 13, so it must be a unit fixture first.

**The compaction policy.** Auto-compaction runs after every append and maintains a **geometric
sequence with factor 2** (`reftable.geometricFactor`, default 2).

```ts
export interface CompactionSegment { readonly start: number; readonly end: number } // end exclusive
export function compactionMetric(fileSize: number, version: 1 | 2): number;
export function suggestCompactionSegment(
  sizes: readonly number[],   // metric(table), oldest -> newest
  factor: number,             // default 2
): CompactionSegment;
```

**The size metric is not the file size.** It is
`fileSize − footerSize(version) − (headerSize(version) − 1)` = `fileSize − 91` at v1,
`fileSize − 99` at v2. A 60-transition replay discriminated 91 from 0 (46/60), 24 (50/60) and
68 (55/60); **91 scored 60/60**. It does not discriminate 91 from 92 or 99 on that data — the
last two bytes come from git's `stack_table_sizes_for_compaction`. An independent v2/SHA-256 run
of 8 transitions with the −99 metric scored 8/8. Express both as
`compactionMetric(fileSize, version)` over named `FOOTER_LENGTH_*` / `HEADER_LENGTH_*` consts
already exported from Part 2 — never as the literal 91 or 99.

**The segment rule, verbatim:**

```
seg = { start: 0, end: 0 }
if n <= 1: no compaction
# 1. walk back from the newest table; the first table whose PREDECESSOR is
#    smaller than factor x itself ends the segment (exclusive).
for i = n-1 down to 1:
    if size[i-1] < size[i] * factor: end = i+1; bytes = size[i]; break
else: no compaction
# 2. continue from the SAME i, accumulating; keep the OLDEST qualifying start.
for ; i > 0; i--:
    curr = bytes; bytes += size[i-1]
    if size[i-1] < curr * factor: start = i-1
compact tables [start, end)
```

**Two details cost the most if missed, and each needs its own test.** The second loop **continues
from the index the first loop broke at, not one below it**. And — *once the first loop has found
an end* — **`start` remaining 0 because nothing qualified means the whole stack compacts**, which
is the only path by which a full merge ever happens. If the *first* loop finds no end, `start`
and `end` are both 0 and the segment is empty. **The two zero cases mean opposite things**; a
single `if (!end)` guard is what keeps them apart, and inverting it silently disables full
compaction.

Excerpt of the replayed sequence, base table `B = 1 867 775` (use the full 60 rows as `it.each`):

| n | depth | table sizes after | what the rule says |
|---|---|---|---|
| 6 | 2 | `B 393` | merge tables 1–2 (`272 < 2 × 146`) |
| 7 | 3 | `B 393 237` | no segment (`302 ≥ 2 × 146`) — the razor-thin row |
| 8 | 2 | `B 455` | merge 1–3 |
| 9 | 3 | `B 455 237` | no segment (`364 ≥ 2 × 146`) |
| 18 | 3 | `B 699 272` | merge **2–3 only** — table 1 survives (`608 ≥ 2 × 294`) |
| 24 | 2 | `B 960` | merge 1–3 |

Two merge rules a naive implementation gets wrong, encoded here as pure predicates consumed by
Part 16: **tombstones (ref and log alike) are dropped only when the segment starts at table 0**
(git's merge skips a deletion record only `if (first == 0 && …is_deletion)`); and the merged
table's `min_update_index` is the **oldest merged table's min**, its `max_update_index` the
**newest's max** (measured `0x…01-0x…05` + `0x…06-0x…06` → `0x…01-0x…06`).

**Property tests.** Lens 2 (compositional aggregator), `numRuns: 100`, in
`reftable-stack.properties.test.ts` — **without re-implementing the merge loop as its own
oracle**: an empty stack yields no names; appending a table with a live record for `X` makes
`lookup(X)` defined; appending a tombstone for `X` makes it `undefined`; appending the live
record again flips it back. A second lens-2 property covers `suggestCompactionSegment`: for any
size vector, applying the suggested merge and re-running the function **converges** — the
post-compaction stack is geometric. That property is the invariant the interop suite asserts in
Part 16, so it must exist as a pure property first.

### TDD steps

1. **RED** — `describe('Given a two-table stack whose newest table tombstones a ref')` >
   `describe('When looking the ref up')` > `it('Then it is absent')`, over the measured fixture.
   **Expected failure:** `createReftableStack` does not exist.
2. **RED** — `it('Then names() omits the deleted ref and yields the other six')`.
3. **RED** — newest-table-wins for a *live* record present in both tables (different oids).
4. **RED** — `logs(name)` merges across tables newest-`update_index` first.
5. **RED** — `maxUpdateIndex` is the newest table's `max`, and `tables` is oldest → newest.
6. **RED** — `compactionMetric` for v1 and v2 as two isolated tests.
7. **RED** — the 60 measured transitions as `it.each` rows on `suggestCompactionSegment`, plus
   the v2 8-row set.
8. **RED** — the two structural edge cases as their own tests: nothing qualifies in loop 2 →
   `start = 0` → whole-stack compaction; `n <= 1` → empty segment. Add a third asserting the
   second loop resumes at the break index (a size vector where resuming one lower changes the
   answer).
9. **RED** — `reftable-stack.properties.test.ts` with both lens-2 properties.
10. **GREEN** — implement both modules.
11. **REFACTOR** — express the merge join as a k-way walk over per-table iterators rather than a
    materialised map, so `names()` stays lazy; keep both loops of `suggestCompactionSegment`
    literally in the shape above with a comment naming which zero case each guard protects.
    Re-export the stack and compaction types from `src/domain/refs/index.ts`; regenerate
    `reports/api.json`.

### Gate

```
npx vitest run test/unit/domain/refs/reftable && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/reftable src/domain/refs/index.ts test/unit/domain/refs/reftable
```

### Commit

`feat(refs): merge reftable stacks by tombstone precedence and suggest geometric compaction`

## Part 7 — `atomicRename` as an optional `FileSystem` capability

### Context

A port widening, three adapters, no reftable code. Standalone because it is a public-type change
with a wide adapter surface, and because the capability is deliberately general — the files
backend's `atomicWriteRef` and every future lock-file protocol can consult it.

`src/ports/file-system.ts` (180 lines) has **no optional member today** — every member is
required, and the browser's answer to a capability it lacks has always been a **throwing stub**
(`readlink`, `symlink`, `openWithNoFollow`, `homedir`, `xdgConfigHome`, `systemConfigPath` all
`throw unsupportedOperation(...)` in `BrowserFileSystem`). `atomicRename` is the first optional
member on this port, and the throwing-stub pattern is explicitly the wrong shape for it: a
caller must be able to branch *before* attempting the operation.

**The shape to copy** is `LayoutProbe.readLink` (`src/ports/layout-probe.ts:29-39`) — an optional
method whose JSDoc states what **omission means** and which adapters omit it:

```ts
  /**
   * Rename `src` over `dst` as a single atomic replace. OPTIONAL: present only
   * where the platform can guarantee that no observer ever sees an intermediate
   * state. Node (`rename(2)`) and memory (synchronous map surgery inside one
   * event-loop turn) provide it; OPFS has no rename and no atomic replace, so the
   * browser adapter omits it. Omission is a documented answer, not an oversight:
   * a lock-file protocol that finds this absent must take its own degraded path
   * rather than assuming `rename` is safe to commit through.
   */
  readonly atomicRename?: (src: string, dst: string) => Promise<void>;
```

Required `rename` stays exactly as it is, JSDoc included — the two coexist, and the existing
`rename` doc already says OPFS emulates it as read + write + rm.

**Caller feature detection** — the house idioms, all three already present in the tree:
`await fs.atomicRename?.(src, dst)` (`find-layout.ts:305`), `x ?? fallback`
(`worktree-context.ts:14`), and an explicit `if (fs.atomicRename === undefined) { … }` guard
before a fallback (`resolve-layout.ts:137-139`). The transaction in Part 15 uses the explicit
guard because the two paths differ structurally, not by one value.

Adapter work — **match each file's local style**: node and memory declare members as class-field
arrows (`name = async (…) => {}`, required by the `readonly (…) => Promise<…>` port shape);
browser uses prototype methods (`async name(…) {}`).

- `src/adapters/node/node-file-system.ts` — `rename` at line 717 is already atomic
  (`this.fsOps.rename` after two `resolveWrite`s, then `this.parentRealpathCache.clear()`).
  `atomicRename` delegates to it. **Do not skip the cache clear** — the field doc at lines
  431-434 explains why a `dirname`-scoped invalidation is unsound for renames.
- `src/adapters/memory/memory-file-system.ts` — `rename` at line 246 is synchronous `Map`
  surgery with no `await` between the deletes and the sets, so it is atomic with respect to the
  event loop. `atomicRename` delegates to it.
- `src/adapters/browser/browser-file-system.ts` — **omits the member entirely.** Update the
  comment at line 153-157 to point at the capability rather than at prose: the sentence
  "Callers depending on atomicity (e.g., lock-file protocols) MUST use the Node or Memory
  adapter" becomes a statement that this adapter does not expose `atomicRename`, so callers
  branch on its absence.

Public-surface consequences: `FileSystem` **is** in `src/ports/index.ts`, so this is a public
type widening — regenerate and commit `reports/api.json`. `tooling/audit-browser-surface.ts`
audits `Repository` members, not port members, so it does not fire here.

Tests: `test/unit/adapters/node/…` and `test/unit/adapters/memory/…` for the two providers;
`test/unit/adapters/browser/…` (or the existing browser file-system test) asserts the member is
**structurally absent**, not merely undefined-returning. `src/adapters` gates at 100 % coverage.

### TDD steps

1. **RED** — node adapter test: `describe('Given a node file system')` >
   `describe('When atomicRename is invoked')` > `it('Then the destination holds the source bytes
   and the source is gone')`. **Expected failure:** `atomicRename` is not a function.
2. **RED** — node: `it('Then the parent-realpath cache is cleared')` — assert via the same
   observable the existing `rename` test uses.
3. **RED** — memory adapter twin.
4. **RED** — browser: `it('Then the adapter does not expose atomicRename')` asserting
   `'atomicRename' in sut === false`. **Expected failure:** nothing asserts it yet, and the
   assertion must survive an implementer's reflex to add a throwing stub.
5. **RED** — a port-contract test asserting a `FileSystem` value without `atomicRename`
   type-checks (a compile-time obligation exercised by constructing one in a test double).
6. **GREEN** — add the optional member and the two implementations; leave the browser untouched
   apart from the comment.
7. **REFACTOR** — none expected beyond deduplicating the node/memory delegation comment. Run
   `npm run docs:json` and commit `reports/api.json`.

### Gate

```
npx vitest run test/unit/adapters test/unit/ports && npm run check:types && ./node_modules/.bin/biome check src/ports/file-system.ts src/adapters test/unit/adapters
```

### Commit

`feat(ports): declare atomic rename as an optional file-system capability`

## Part 8 — `RefStore` narrowing I: `listRefs`, `verifyIntegrity`, and the six enumerators

### Context

**The first of four caller-cluster parts.** Read verbs only; writes and reflogs follow in
Parts 10 and 11. No reftable code — the files backend is still the only backend, and every
existing test must stay green except where the pre-existing bugs below are deliberately fixed.

`src/application/primitives/ref-store.ts` (117 lines) today:

```ts
export interface RefStore {
  resolveDirect(name: RefName): Promise<ResolveDirectResult>;
  writeLoose(name: RefName, id: ObjectId): Promise<void>;
  removeLoose(name: RefName): Promise<void>;
  isLoose(name: RefName): Promise<boolean>;
  readLooseRaw(name: RefName): Promise<string | undefined>;
  getPackedRefs(): Promise<PackedRefs>;
}
export type ResolveDirectResult =
  | { readonly kind: 'direct'; readonly id: ObjectId }
  | { readonly kind: 'symbolic'; readonly target: RefName }
  | { readonly kind: 'missing' };
const storeCache = new WeakMap<Context, RefStore>();
export function getRefStore(ctx: Context): RefStore;   // memoises createRefStore(ctx)
export function createRefStore(ctx: Context): RefStore;
```

`getRefStore` and its per-`Context` `WeakMap` keep their shape exactly. **`ref-store.ts` is not
exported from `src/application/primitives/index.ts`** — every consumer deep-imports it, so this
reshape has no public-API surface and `reports/api.json` is untouched by this part.
`getRefStore` is called with a **derived child `Context`** at `submodule.ts:660` and `:749`, so
the backend must key off `Context` and never a module global.

**This part adds two read verbs and deletes two files-shaped ones:**

```ts
  listRefs(prefix?: RefName): Promise<readonly RefEntry[]>;   // replaces getPackedRefs' 3 callers
  verifyIntegrity(): Promise<readonly RefIntegrityFinding[]>; // replaces readLooseRaw's 1 caller
```

`RefEntry` is `{ readonly name: RefName; readonly value: ResolveDirectResult }` — it must carry
symbolic refs, because `enumerateRefs` yields `HEAD` and a reftable stack stores `HEAD` as a
`0x3` record. `listRefs()` with no prefix returns **every** ref the backend knows, merged across
the per-worktree and common scopes, deduplicated, sorted by name.

`verifyIntegrity` exists because `readLooseRaw`'s single consumer needs something no
backend-neutral read can give it. `src/application/commands/internal/fsck/refs-verify.ts`
(145 lines) uses `readLooseRaw(ref) !== undefined` as its loose/packed discriminator at line 111
and hands the **unparsed** string to private `checkLooseRef` (lines 41-83), which tests
`raw.replace(/[\r\n]+$/,'')`, `content.startsWith('ref: ')` and `OID_RE` to classify
`badRefContent` versus `badRefOid`. `resolveDirect` cannot serve that — it parses. So the
per-backend integrity notion moves **behind** the seam: the files backend re-implements today's
loose-grammar check as its own private pass and returns findings; the reftable backend (Part 14)
returns its per-table `ReftableCheck` findings and reports `badRefContent` as structurally
unreachable. `RefIntegrityFinding` mirrors the existing `BadRefFinding` shape in
`refs-verify.ts` — read it and reuse the field names rather than inventing parallel ones.

**Callers to re-express. Each is checked for a files assumption, not merely recompiled:**

| site | today | after |
|---|---|---|
| `src/application/primitives/enumerate-refs.ts` `collectLooseRefs`/`walkLooseRefs` (lines 37-68) | recursive `readdir` of `<gitDir>/refs` and `<commonDir>/refs`, ref name = path; `fs.exists(<gitDir>/HEAD)` at line 18 | `store.listRefs()` |
| `src/application/commands/branch.ts` `branchList` (lines 64-81) | **single-level** `readdir` of `<commonDir>/refs/heads`, `if (!entry.isFile) continue` | `store.listRefs('refs/heads/')` |
| `src/application/commands/tag.ts` `tagList` (lines 69-75) | single-level `readdir` of `<commonDir>/refs/tags` | `store.listRefs('refs/tags/')` |
| `src/application/commands/branch.ts:132`, `tag.ts:214`, `checkout.ts:94`, `fetch.ts:389` | four hand-inlined copies of `fs.exists(\`${perWorktreeRefDir(ctx,name)}/${name}\`)` | `(await store.resolveDirect(name)).kind !== 'missing'` |
| `src/application/commands/fetch.ts` `collectRefTips` (285-314) + `collectFromDir` (316-327) | own recursive walk of `refs/remotes/<r>` and `refs/tags` unioned with `getPackedRefs()` | two `store.listRefs(prefix)` calls |
| `src/application/commands/fetch.ts` `readExistingRef` (379-393) | `fs.exists` + `readUtf8`, loose-only | `store.resolveDirect(name)` |
| `src/application/commands/fetch.ts` `prune` (400-415) + `deleteUnadvertised` (417-465) | `readdir` recursion reconstructing names from the directory tree | `store.listRefs('refs/remotes/<remote>/')` |
| `src/application/commands/internal/fsck/refs-verify.ts` `runRefsVerifyPass` (98-145) | `enumerateRefs` + `readLooseRaw` per ref + `getPackedRefs()` **re-fetched inside the loop** (line 127, O(n·m)) | `store.listRefs()` + `store.verifyIntegrity()` |

**Three pre-existing bugs this part fixes as a deliberate, tested consequence — call each out in
the commit's tests so the behaviour change is intentional and not an accident that trips an
acceptance test later:**

1. `branchList` / `tagList` skip **nested** refs (`refs/heads/feat/x` fails `isFile`) and
   **packed** refs entirely. `listRefs(prefix)` returns both.
2. `fetch.readExistingRef` reads a packed tracking ref as absent, so fetch rewrites it as new.
3. `refs-verify` re-scans `packed-refs` linearly per ref.

**Not touched by this part:** `resolveDirect` keeps its signature and its 14 call sites
(`resolve-ref.ts:45`, `update-ref.ts:29/62/87`, `stash-ref.ts:44`, `list-worktrees.ts:50`,
`remote.ts:217/338`, `name-rev.ts:102`, `worktree.ts:125`, `submodule.ts:660/749`,
`rev-parse.ts:93`, `describe.ts:217`). `writeLoose`, `removeLoose` and `isLoose` survive
untouched into Part 10.

`perWorktreeRefDir(ctx, name)` (`src/application/primitives/path-layout.ts:48-49`) already
encodes the split correctly — `isPerWorktreeRef(name) ? ctx.layout.gitDir : commonGitDir(ctx)` —
and stays the single source of the per-worktree rule for both backends. The *policy* is
backend-neutral and already right; only the path it produces will change in Part 13.

Tests to extend: `test/unit/application/primitives/ref-store.test.ts` (the only consumer of
`createRefStore`), `enumerate-refs`'s test, `branch.test.ts`, `tag.test.ts`, `fetch`'s tests,
and the fsck refs-verify test. `test/unit/application/primitives/commondir-refs.test.ts`
asserts the per-worktree split and must keep passing.

### TDD steps

1. **RED** — `ref-store.test.ts`: `describe('Given a repository with a loose ref, a packed ref
   and a nested loose ref')` > `describe('When listing refs with no prefix')` > `it('Then all
   three are returned sorted by name')`. **Expected failure:** `listRefs` does not exist.
2. **RED** — `it('Then a prefix restricts the result')` for `'refs/heads/'`, including the
   nested `refs/heads/feat/x`.
3. **RED** — `it('Then a symbolic ref is returned with its target')` for `HEAD`.
4. **RED** — `it('Then a per-worktree ref resolves against the worktree gitdir and a shared ref
   against the common dir')`, extending `commondir-refs.test.ts`'s fixture.
5. **RED** — `verifyIntegrity` returns a `badRefContent` finding for a loose ref whose body is
   neither an oid nor `ref: …`, and a `badRefOid` finding for a well-formed line naming an
   unknown oid. Assert the finding fields, not just the count.
6. **RED** — `branch.test.ts`: nested branch `refs/heads/feat/x` and a packed-only branch both
   appear in `branchList`. **Expected failure:** the flat `readdir` misses both.
7. **RED** — `tag.test.ts`: the packed-tag twin.
8. **RED** — `fetch`: a packed tracking ref is seen as existing by `readExistingRef`.
9. **GREEN** — add `listRefs` and `verifyIntegrity` to the interface and the files
   implementation; move the loose-grammar classification out of `refs-verify.ts` and into the
   files backend; rewrite each caller in the table.
10. **GREEN** — delete `getPackedRefs` and `readLooseRaw` from the interface once no caller
    remains; keep `parsePackedRefs` usage private to the files implementation.
11. **REFACTOR** — collapse the four hand-inlined existence probes onto one named helper;
    delete `walkLooseRefs`/`collectLooseRefs` from `enumerate-refs.ts` and `collectFromDir` /
    the `deleteUnadvertised` walk from `fetch.ts` now that nothing calls them (no dead code);
    keep the mtime-keyed `packed-refs` memo inside the files closure exactly as it is.

### Gate

```
npx vitest run test/unit/application/primitives test/unit/application/commands/branch.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/fetch.test.ts test/unit/application/commands/internal/fsck && npm run check:types && ./node_modules/.bin/biome check src/application/primitives src/application/commands/branch.ts src/application/commands/tag.ts src/application/commands/fetch.ts src/application/commands/internal/fsck test/unit/application
```

### Commit

`refactor(refs): enumerate refs through one backend-neutral listRefs verb`

## Part 9 — `RefStore` narrowing II: `HEAD` converges on the seam

### Context

**The largest single caller cluster, and the one the design under-counts.** `HEAD` has three
independent read paths today; on a reftable repository the file path returns the literal stub
`ref: refs/heads/.invalid\n`, which is what makes `branchList` throw `INVALID_REF` on a
repository git reads fine. Still files-only — no reftable code — but every site must go through
the seam before Part 13 can make the seam answer differently.

`readHeadRaw` lives at `src/application/primitives/internal/repo-state.ts:247-263` (there is a
`@deprecated` re-export shim at `src/application/commands/internal/repo-state.ts:13` that most
commands import through):

```ts
export const readHeadRaw = async (ctx: Context): Promise<HeadState> => {
  const path = `${ctx.layout.gitDir}/HEAD`;      // hardcoded — never perWorktreeRefDir/looseRefPath
  …catch FILE_NOT_FOUND -> refNotFound(HEAD_REF)…
  return parseLooseRef(content);
};
```

`HeadState` (lines 44-46) is `{kind:'symbolic'; target: RefName} | {kind:'direct'; id: ObjectId}`
— structurally `ResolveDirectResult` minus `'missing'`.

**The 20 production call sites of `readHeadRaw`** (plus `currentBranchRef`, which wraps it):

`push.ts:151` · `tag.ts:222` · `status.ts:133` · `abort-merge.ts:47` · `checkout.ts:86` ·
`cherry-pick.ts:433` · `cherry-pick.ts:542` · `internal/history-rewrite.ts:20` ·
`revert.ts:417` · `revert.ts:500` · `stash.ts:204` · `branch.ts:68` · `branch.ts:128` ·
`branch.ts:170` · `commit.ts:137` · `reset.ts:81` · `pull.ts:99` · `merge.ts:166` ·
`fetch.ts:93` · `rebase.ts:455`.

`currentBranchRef` (`repo-state.ts:270-271`) has one consumer, `submodule.ts:158`. A **shadowing
local redefinition** in `rev-parse.ts:92-95` already goes through
`getRefStore(ctx).resolveDirect('HEAD')` — that is the one site doing it right, and it is the
model. Test consumers: `test/unit/application/commands/push-refspecs.test.ts` (13 uses) and
`test/unit/application/commands/internal/repo-state.test.ts` (6 uses).

**The reshape:** `readHeadRaw` keeps its name, its `HeadState` return type and all 20 call sites,
and changes its **body** to `getRefStore(ctx).resolveDirect(HEAD)`, mapping `'missing'` to the
existing `refNotFound(HEAD_REF)` throw so the observable contract is unchanged. That is the
minimal diff with the maximal reach: one function body, twenty callers untouched. Do **not**
rewrite the twenty call sites — that would be churn with no behavioural content, and it would
make this part unreviewable.

**Three sites that cannot take that route and each need a decision recorded in code:**

1. **`hasUsableHead`** (`repo-state.ts:108-114`, private) does
   `ctx.fs.readlink(\`${ctx.layout.gitDir}/HEAD\`)` and judges a symlinked `HEAD` by its **link
   text**, then falls back to `readUtf8`. This is the only `readlink`-on-`HEAD` in the tree and
   it is not expressible through `RefStore`. **Keep it as a files-layout probe** and document
   why in place: it answers "is this directory a repository at all", which runs *before* a
   backend exists and is a discovery question, not a ref-read. A reftable repository satisfies
   it through the stub file exactly as git intends. Add the comment; change no behaviour.
2. **`list-worktrees.ts`** reads **other** worktrees' `HEAD` files directly — `mainEntry` at
   line 102 (`${commonGitDir(ctx)}/HEAD`) and `linkedEntry` at line 120 (`${adminDir}/HEAD`) —
   then hands the content string to `resolveHead(ctx, content)` (lines 45-56), which calls
   `getRefStore(ctx).resolveDirect(parsed.target)` on the **current** context. On reftable those
   files are `.invalid` stubs and each worktree has its own stack. **Route through a derived
   `Context` whose `layout.gitDir` is that worktree's admin dir**, then
   `getRefStore(derived).resolveDirect(HEAD)`. The pattern already exists: `submodule.ts:660`
   and `:749` call `getRefStore(child)` on a derived child context, and
   `src/application/primitives/internal/worktree-context.ts` already derives a worktree-scoped
   layout. Reuse that helper rather than building a second derivation.
3. **Raw `HEAD` writes** stay in Part 10 — this part is reads only.

**Also converging here:** `enumerate-refs.ts:18`'s `fs.exists(\`${ctx.layout.gitDir}/HEAD\`)`
probe was already replaced in Part 8 by `listRefs`; confirm nothing reintroduced it. Read-side
`HEAD`-file probes that remain and must be individually judged (each is either discovery-tier,
foreign-worktree, or a bug): `list-worktrees.ts:102`, `list-worktrees.ts:120`,
`internal/submodule-context.ts:59`, `clone.ts:82`, `init.ts:29`, `submodule.ts:814`,
`repo-state.ts:109`, `repo-state.ts:248`. Record the verdict for each as a one-line comment at
the site — a site left without a verdict is the defect class this part exists to close.

### TDD steps

1. **RED** — `test/unit/application/commands/internal/repo-state.test.ts`:
   `describe('Given a repository whose HEAD lives only in the backend, not on disk')` >
   `describe('When readHeadRaw is called')` > `it('Then it returns the backend answer')`.
   Simulate with a memory context whose `RefStore` is stubbed to return a symbolic `HEAD` while
   `<gitDir>/HEAD` is absent. **Expected failure:** it throws `REF_NOT_FOUND` from the file read.
2. **RED** — `it('Then a missing HEAD still throws REF_NOT_FOUND with the HEAD name')`, asserting
   `.data.code` and `.data.name` so the mapping from `'missing'` is pinned.
3. **RED** — `list-worktrees` test: a linked worktree whose admin-dir `HEAD` differs from the
   main one resolves against **its own** gitdir. **Expected failure:** it resolves against the
   current context.
4. **GREEN** — reroute `readHeadRaw` through `getRefStore(ctx).resolveDirect(HEAD)`; reroute
   `list-worktrees` through the derived worktree context.
5. **GREEN** — add the in-place verdict comments to `hasUsableHead` and the eight remaining
   `HEAD`-file read probes.
6. **REFACTOR** — collapse `HeadState` onto `ResolveDirectResult` if the mapping is a pure
   narrowing (`kind !== 'missing'`), so there is one shape rather than two structurally identical
   ones; keep the exported name `HeadState` as an alias so the 20 callers and both test files
   are untouched.

### Gate

```
npx vitest run test/unit/application/commands/internal/repo-state.test.ts test/unit/application/commands/push-refspecs.test.ts test/unit/application/primitives/list-worktrees.test.ts test/unit/application/commands && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts src/application/primitives/list-worktrees.ts test/unit/application
```

### Commit

`refactor(refs): read HEAD through the ref backend instead of the gitdir file`

## Part 10 — `RefStore` narrowing III: `applyRefUpdates` on the files backend

### Context

The write half of the seam. Files backend only — the observable result of every existing test is
unchanged, and Part 1's regression pin must stay green throughout.

**The verb** replaces `writeLoose`, `removeLoose` and `isLoose`:

```ts
  applyRefUpdates(updates: readonly RefUpdate[]): Promise<void>;

export type RefUpdate =
  | { readonly kind: 'set';         readonly name: RefName; readonly id: ObjectId;
      readonly expected?: ObjectId | 'absent'; readonly reflog?: ReflogAppend }
  | { readonly kind: 'setSymbolic'; readonly name: RefName; readonly target: RefName;
      readonly expected?: ObjectId | 'absent'; readonly reflog?: ReflogAppend }
  | { readonly kind: 'delete';      readonly name: RefName;
      readonly expected?: ObjectId | 'absent' }
  | { readonly kind: 'reflogOnly';  readonly name: RefName; readonly reflog: ReflogAppend };
```

Three shapes are load-bearing and each is forced by a measurement:

- **It takes a list, not one ref.** Committing on `main` writes the `HEAD` and
  `refs/heads/main` log records in **one** transaction at one `update_index`. A one-ref-at-a-time
  interface cannot express that, and expressing it as two calls is exactly Part 1's bug.
- **`expected` lives on the update, not on a separate pre-check.** The reftable backend must
  re-verify the old value *under the stack lock*; the files backend already gets this from its
  per-ref lock.
- **`reflogOnly`** is what `HEAD`-coupling and stash need; git treats it as an ordinary member
  of the same transaction.

`ReflogAppend` carries what `recordRefUpdate` needs — `{ oldId, newId, message }` plus a flag for
the two callers that bypass the autocreate gate (see stash, Part 11). Model it on the existing
`recordRefUpdate(ctx, ref, oldId, newId, message)` signature
(`src/application/primitives/record-ref-update.ts:19-34`) and its private `isLoggable` gate
(line 36-40: `reflogExists(ctx, ref)` first, `shouldAutocreateReflog` second).

**Files-backend semantics:** apply the list **in order**, each `set`/`setSymbolic` through the
existing `atomicWriteRef` lock-and-rename (`src/application/primitives/atomic-write.ts`), each
`delete` through the existing loose-removal path, each reflog through `appendReflog`. Note that
today's `writeLoose` is **plain `ctx.fs.writeUtf8`, not `atomicWriteRef`** — routing rebase's
five `HEAD` detaches through `applyRefUpdates` therefore makes them atomic, which is a
strictly-better change; assert the lock file's transient existence in one test so the change is
intentional.

**Call sites to absorb:**

| site | today | after |
|---|---|---|
| `update-ref.ts` `updateRef` | Part 1's reordered read-then-write-then-log | one `applyRefUpdates([set(name,…), reflogOnly(HEAD,…) if coupled])` |
| `update-ref.ts` private `deleteRef` (56-70) | `isLoose` → `removeLoose` → `deleteReflog`: three mutations, no rollback | one `delete` update; the reflog tombstones ride with it |
| `write-symbolic-ref.ts` (28-38) | `looseRefPath` + `atomicWriteRef` | one `setSymbolic` update |
| `rebase.ts:237, 607, 717, 726, 1219` | `getRefStore(ctx).writeLoose(HEAD, oid)` then `recordRefUpdate` | one `set` + `reflog` per site |
| `clone.ts:267-268` private `writeRef`, `:289`, `:297` | raw `fs.writeUtf8` to `${gitDir}/${name}` and `${gitDir}/HEAD` | `set` / `setSymbolic` updates |
| `checkout.ts:137` | raw `fs.writeUtf8` detached `HEAD` + `recordRefUpdate` at 138 | one `set` + `reflog` |
| `commit.ts:242` | raw `fs.writeUtf8` detached `HEAD` + `recordRefUpdate` at 243 | one `set` + `reflog` |
| `internal/bootstrap.ts:48` | `fs.writeUtf8(\`${gitDir}/HEAD\`, \`ref: refs/heads/${branch}\n\`)` | **stays a raw write** — see below |
| `worktree.ts:165-166` | `writeUtf8` into **another** worktree's admin dir | derived-context `applyRefUpdates`, same pattern as Part 9's `list-worktrees` fix |

**`bootstrap.ts` deliberately stays a raw file write.** It runs before any repository exists, so
there is no backend to route through; and it is what guarantees that `init` keeps emitting
`repositoryformatversion = 0` with no `[extensions]` — tsgit must never create a reftable
repository by accident and trip its own backend. Record that reasoning at the site.

**Two refusals move inside the files implementation, not a shared branch.**
`deleteRef`'s `unsupportedOperation('delete-packed-ref', 'deleting packed-only refs requires
packed-refs rewrite')` and `remote.moveTrackingRef`'s
`unsupportedOperation('rename-packed-tracking-ref', …)` (`remote.ts:222`, guarded by
`isLoose(source)`) are **files-backend limitations**, not seam-level facts — reftable has no
packed refs and deletes by tombstone. Both move into the files backend and are raised from there.
Those are the two `isLoose` call sites the narrowed interface drops.
`fetch.ts:449-456`'s `isPackedRefDeleteError` swallow keeps working because the code is unchanged.

`recordRefUpdate` has **16 production call sites** — `update-ref.ts:51/90`, `clone.ts:269/311`,
`worktree.ts:192/194`, `checkout.ts:138/147`, `submodule.ts:624`, `commit.ts:243`,
`rebase.ts:238/388/605/608/718/727`. Every one of them sits immediately after a ref write; that
write+log pair **is** `applyRefUpdates`. Fold the pairs; leave `recordRefUpdate` exported for
the sites that genuinely log without writing (they become `reflogOnly` updates in Part 11).

Tests: `test/unit/application/primitives/update-ref.test.ts`, `ref-store.test.ts`,
`commondir-refs.test.ts` (uses `writeLoose` at lines 71 and 86 to seed fixtures — port to
`applyRefUpdates`), `test/unit/application/commands/describe.test.ts:238` (same, fixture
seeding), plus rebase, clone, checkout, commit and worktree command tests.

### TDD steps

1. **RED** — `ref-store.test.ts`: `describe('Given two updates in one list')` >
   `describe('When applyRefUpdates is called')` > `it('Then both refs are written')`.
   **Expected failure:** `applyRefUpdates` does not exist.
2. **RED** — `it('Then an expected mismatch on the second update throws REF_UPDATE_CONFLICT')`,
   asserting `.data.name`, `.data.expected` and `.data.actual`.
3. **RED** — `it('Then a set update writes through the ref lock')` — assert the `.lock` path is
   created and removed, so rebase's newly-atomic detach is pinned.
4. **RED** — `it('Then a reflogOnly update appends without touching the ref')`.
5. **RED** — `it('Then a delete update removes the ref and its reflog')`.
6. **RED** — files-backend refusal: deleting a packed-only ref throws
   `UNSUPPORTED_OPERATION` with `operation: 'delete-packed-ref'`; renaming a packed tracking ref
   throws with `operation: 'rename-packed-tracking-ref'`. **Two isolated tests** — one guard each.
7. **RED** — `update-ref.test.ts`: Part 1's regression test must still pass **and** a new
   `it('Then the branch and the coupled HEAD reflog land in one call')` asserting a single
   `applyRefUpdates` invocation (spy on the store).
8. **GREEN** — add `applyRefUpdates` and the files implementation; rewrite each call site in the
   table; move the two refusals inside.
9. **GREEN** — delete `writeLoose`, `removeLoose` and `isLoose` from the interface.
10. **REFACTOR** — `atomicWriteRef` becomes private to the files backend (its three callers all
    route through `applyRefUpdates` now); keep it exported only if a test needs it directly.
    `write-symbolic-ref.ts` keeps its `@writes surface: symbolicRef / kind: byte-identical /
    format: git-symbolic-ref` block wherever the serialization ends up — do not orphan it.
    Add the `bootstrap.ts` comment. Keep `updateRef` under 20 lines.

### Gate

```
npx vitest run test/unit/application && npm run check:types && ./node_modules/.bin/biome check src/application test/unit/application
```

### Commit

`refactor(refs): commit ref writes through one transactional applyRefUpdates verb`

## Part 11 — `RefStore` narrowing IV: reflogs on the same seam

### Context

The last caller cluster. Reflog read and write verbs join the backend-neutral interface, because
a ref update and its reflog are **one transaction at one `update_index`** in git and two seams
could not express that.

```ts
  readReflog(name: RefName): Promise<readonly ReflogEntry[]>;
  listReflogs(): Promise<readonly RefName[]>;
```

Writes already ride on Part 10's `RefUpdate.reflog` / `reflogOnly`.

`src/application/primitives/reflog-store.ts` (91 lines) — **all six exports plus one private**,
every one files-shaped:

| symbol | lines | files assumption |
|---|---|---|
| `appendReflog(ctx, ref, entry)` | 15-17 | `ctx.fs.appendUtf8(reflogPath(perWorktreeRefDir(ctx, ref), ref), …)` — the only `appendUtf8` caller in the application tier |
| `readReflog(ctx, ref)` | 20-28 | `reflogPath`, `fs.exists` → `[]`, `fs.stat().size > MAX_REFLOG_BYTES` → throw, `readUtf8` → `parseReflog` |
| `reflogExists(ctx, ref)` | 31-33 | `ctx.fs.exists(reflogPath(...))` — a pure file probe |
| `writeReflog(ctx, ref, entries)` | 36-43 | whole-file `writeUtf8` overwrite, non-atomic |
| `deleteReflog(ctx, ref)` | 46-51 | `fs.exists` then `fs.rm` |
| `listReflogs(ctx)` | 61-73 | two roots — `logsDir(ctx.layout.gitDir)` and `logsDir(commonGitDir(ctx))` — string-compared, `Set<RefName>` dedupe |
| private `collectReflogs(ctx, dir, prefix)` | 75-91 | `readdir` recursion; name = path, with an empty-prefix special case because `HEAD`'s reflog lives at `logs/HEAD` |

**Eleven consumer modules:** `snapshot/snapshot-factory.ts:17,169` · `record-ref-update.ts:12,28,37`
· `update-ref.ts:11,40` · `stash-ref.ts:28,58,68,83,102,116,122` · `primitives/index.ts:70-77`
(barrel) · `internal/fsck/roots.ts:9,104,108` · `branch.ts:16,149,166` · `reflog.ts:16,77,90,98,99,
113,146,150,156` · `rev-parse.ts:21,85,108`. `listReflogs` has exactly two call sites,
`fsck/roots.ts:104` and `reflog.ts:146`.

**Reshape:** `readReflog(ctx, ref)` and `listReflogs(ctx)` keep their exported names, signatures
and every call site, and change their **bodies** to delegate to
`getRefStore(ctx).readReflog(ref)` / `.listReflogs()`. Same minimal-diff discipline as Part 9's
`readHeadRaw`. `reflogExists`, `appendReflog`, `writeReflog` and `deleteReflog` become **private
to the files backend**; their remaining external callers are converted:

- `record-ref-update.ts`'s `isLoggable` gate needs "does this ref have a reflog" as a
  backend question. Fold the gate into the backend: the files backend answers with the file
  probe; the reftable backend answers from the stack. Expose it as part of applying a
  `reflog` on a `RefUpdate` rather than as a public verb, so there is no `reflogExists` on the
  seam.
- `branch.ts:149,166` (`readReflog` then `writeReflog` around a rename) becomes a rename
  expressed as `RefUpdate`s: a zero-`new_id` deletion plus a zero-`old_id` creation is exactly
  how git encodes a reflog rename in reftable, so model the files path the same way.
- `reflog.ts`'s delete-by-index and expiry paths are whole-reflog rewrites. Keep them working by
  giving the files backend a private rewrite and expressing the reftable equivalent as **one log
  tombstone per cancelled entry** (Part 15) — git enumerates a ref's existing log entries and
  emits one tombstone per entry, each carrying **that entry's own `update_index`**, not the new
  one. A writer that emits a single tombstone at the new index leaves the old entries visible.

**`stash-ref.ts` is the hardest write to port** (124 lines):

- `writeStashRef` (48-54) hardcodes `looseRefPath(commonGitDir(ctx), STASH_REF)` where every
  sibling uses `perWorktreeRefDir`. **A pre-existing inconsistency this part surfaces** —
  `refs/stash` is not in the per-worktree set, so `perWorktreeRefDir` returns the common dir
  anyway and the two agree today. Switch to `perWorktreeRefDir` for uniformity and pin the
  equivalence with a test rather than leaving two definitions of the split.
- `pushStashRef` (79-89) calls `appendReflog` **directly, deliberately bypassing**
  `recordRefUpdate`'s autocreate gate (its own header comment, lines 5-9, says so). That is the
  flag on `ReflogAppend` from Part 10 — name it for what it is (the stash log is unconditional),
  not `force`.
- `dropStashEntry` (101-124) does a whole-reflog rewrite: `removeLoose` (115), `deleteReflog`
  (116), `writeStashRef` (121), `writeReflog` (122). Express as one `applyRefUpdates` list.

`reflog-identity.ts` (34 lines, single export `resolveReflogIdentity(ctx)`) has **no files
assumption at all** — config plus `Date.now()`. It is already backend-neutral; touch nothing and
say so in the commit body's absence (one line in the part, not the commit).

`resolve-notes-ref.ts` (58 lines) and `resolve-oid-prefix.ts` (60 lines) are listed in the design
as callers but are **not affected**: the first is pure name resolution over env and config, the
second touches only `objectsDir` and pack indexes. Confirm and move on.

### TDD steps

1. **RED** — `ref-store.test.ts`: `describe('Given a ref with two reflog entries')` >
   `describe('When readReflog is called on the store')` > `it('Then both entries are returned
   newest last')`. **Expected failure:** `readReflog` is not on the interface.
2. **RED** — `it('Then listReflogs returns per-worktree and shared reflogs merged and
   deduplicated')`, including `HEAD` (the empty-prefix special case).
3. **RED** — `reflog-store` test: `readReflog(ctx, ref)` still honours `MAX_REFLOG_BYTES` and
   still returns `[]` for a ref with no reflog, proving the delegation preserved both.
4. **RED** — `stash-ref` test: `dropStashEntry` at index 0 of a two-entry stack leaves one entry
   and the ref pointing at it, achieved through a single `applyRefUpdates` call (spy).
5. **RED** — `stash-ref` test: `pushStashRef` writes a reflog entry even when the autocreate
   config is off and no reflog file exists.
6. **RED** — `branch` test: renaming a branch moves its reflog, expressed as the
   deletion+creation pair.
7. **GREEN** — add both verbs; delegate `readReflog`/`listReflogs`; make the other four private;
   rewrite stash, branch-rename and `reflog.ts`'s rewrite paths.
8. **REFACTOR** — delete `collectReflogs` from `reflog-store.ts` once the backend owns the walk
   (no dead code); keep `MAX_REFLOG_BYTES` where the size guard now lives; keep the barrel
   exports at `primitives/index.ts:70-77` stable so no public surface moves.

### Gate

```
npx vitest run test/unit/application && npm run check:types && ./node_modules/.bin/biome check src/application test/unit/application
```

### Commit

`refactor(refs): route reflog reads and writes through the ref backend`

## Part 12 — `refStorage` reaches `Context` through the layout

### Context

Plumbing only — a `RepositoryLayout` field, resolved at open time, readable synchronously,
consumed by nobody until Part 13. Wide but shallow: **the compiler is the worklist.**

**Not a config re-read.** An untrusted repository has no readable config scope, so a
config-reading selector fails exactly where a layout must still resolve. The value is carried on
the layout, set once by the Stage-2 read, and is therefore resolved **before any tier assertion**
— which is why this design adds nothing to `assertRepository` /
`assertAcceptedRepository` / `assertOperationalRepository` and leaves the acceptance-gate
allowlist untouched.

**Where the Stage-2 read lives** (correcting the design's prose): not
`src/application/primitives/find-layout.ts` but **`src/repository/read-repository-format.ts`**.
It currently extracts exactly three keys:

```ts
export interface RepositoryFormat {
  readonly bare: boolean | undefined;
  readonly worktree: string | undefined;
  readonly worktreeConfig: boolean;
}
const CORE_SECTION = 'core';
const EXTENSIONS_SECTION = 'extensions';
const BARE_KEY = 'bare';
const WORKTREE_KEY = 'worktree';
const WORKTREE_CONFIG_KEY = 'worktreeconfig';
```

`lastTopLevelEntry(tokens, section, key)` (line 36) already implements git's last-wins scalar
resolution and skips subsections. **The sibling acceptance-gate plan lands before this one and
may already have added a `refStorage` read — check first, and extend rather than duplicate.**
If it has not, add `REFSTORAGE_KEY = 'refstorage'` (**lower-case**: `lastTopLevelEntry`
lower-cases both section and key, and `git init --ref-format=reftable` writes the key lower-case)
and read it from **`<commonDir>/config` only**, the same scoping `worktreeConfig` uses. Value
grammar is `files` / `reftable`; a bogus value is refused by the config tier, not here.

**Where the layout is built** — `src/repository/resolve-layout.ts`, the single funnel all three
shims route through:

- `finishLayout(probe, outcome, pathPolicy, cwd, overrides, caps)` at lines 190-220 returns the
  `RepositoryLayoutInput` literal — add `refStorage` from `fmt`.
- `syntheticFallbackLayout(gitDir, defaultWorkDir, cwd, overrides, pathPolicy)` at lines 160-178
  is the found-nothing bootstrap and deliberately reads nothing from disk — it sets
  `refStorage: 'files'`.

**Two type declarations change, both required-not-optional:**

- `RepositoryLayout` in `src/ports/context.ts:21-55` — add
  `readonly refStorage: 'files' | 'reftable';`
- `RepositoryLayoutInput` in `src/repository.ts:146-164` (`@internal`, the facade's input shape)
  — same field.

**Required, not optional, and the reason must go in the JSDoc:** an optional field whose absence
means `'files'` reintroduces the misread on every path that builds a `Context` without the
facade, which is precisely the class of bug this whole change exists to close. Making it required
turns each such path into a compile error the author must answer.

**Every construction site must answer.** `bare` is currently the only required field besides
`gitDir`, so this is the second — and it breaks roughly 34 files / 117 literal sites. Do not
enumerate them by hand: add the field, run `npm run check:types`, and fix exactly what it
reports. Production sites are `src/repository/resolve-layout.ts` (both builders),
`src/adapters/memory/memory-adapter.ts:55-63`, `src/adapters/browser/browser-adapter.ts:38-42`,
`src/adapters/node/node-adapter.ts:99-105` (`buildLayout`),
`src/application/primitives/list-worktrees.ts` (3 literals),
`src/application/primitives/internal/worktree-context.ts`,
`src/application/primitives/internal/submodule-context.ts` (**a submodule can declare its own
`refStorage` — derive it, do not inherit the parent's**), and `src/application/commands/init.ts`.

The three raw adapter entry points — `createNodeContext`, `createMemoryContext`,
`createBrowserContext` — **never run the Stage-2 scan**; they hardcode a structural layout. They
set `refStorage: 'files'` **by explicit assignment**, which is the whole point of the field being
required. The shims that do run Stage-2 are `src/index.node.ts`, `src/index.default.ts:63-79`
and `src/index.browser.ts:70`.

Two test factories absorb most of the test fallout and should be updated first:
`test/unit/application/primitives/run-hook.test.ts:14-19`'s
`layout = (over: Partial<RepositoryLayout> = {}) => ({ …, ...over })`, and
`test/unit/application/commands/fixtures.ts:248-257`'s spread-based bare-context derivation
(which passes a new field through automatically).

**`repo.layout` is public** (`src/repository.ts:342`, deep-frozen), so this is a public-type
widening: regenerate and commit `reports/api.json`. A consumer can now tell which storage a
repository uses.

**One measured rule the field must obey:** the *extension*, not the directory, is authoritative.
A repository declaring `refStorage = reftable` with no `.git/reftable/` is a **valid empty-stack**
reftable repository, and the first write creates the directory. Backend selection never sniffs
for the directory. Conversely, `extensions.refStorage = reftable` planted on a files layout is
not an error to git (`git status` reports `Not currently on any branch. / No commits yet`).
Pin both as tests here, before any backend exists to be confused by them.

Also add the path helpers next to their siblings in
`src/application/primitives/path-layout.ts` (which already owns every `<gitDir>/…` builder):

```ts
export const reftableDir = (gitDir: string): string => `${gitDir}/reftable`;
export const tablesListPath = (gitDir: string): string => `${gitDir}/reftable/tables.list`;
export const tablesListLockPath = (gitDir: string): string => `${gitDir}/reftable/tables.list.lock`;
```

`perWorktreeRefDir(ctx, name)` chooses between `<gitDir>/reftable/` and `<commonDir>/reftable/`
for reads and writes alike — git routes writes by the same rule — so no second definition of
"per-worktree" is introduced.

### TDD steps

1. **RED** — `test/unit/repository/read-repository-format.test.ts`:
   `describe('Given a config declaring extensions.refstorage = reftable')` >
   `describe('When the repository format is read')` > `it('Then refStorage is reftable')`.
   **Expected failure:** the field is not read.
2. **RED** — `it('Then a config with no extensions section yields files')`.
3. **RED** — `it('Then the key is read from the common dir, not the worktree config')` using a
   linked-worktree fixture.
4. **RED** — `test/unit/repository/resolve-layout.test.ts`: `finishLayout` carries the value
   through; `syntheticFallbackLayout` yields `'files'`.
5. **RED** — `it('Then a repository declaring reftable with no reftable directory still resolves
   as reftable')` — the extension, not the directory, decides.
6. **RED** — `test/unit/ports/context.test.ts`: each of the three raw adapter contexts reports
   `layout.refStorage === 'files'`.
7. **RED** — `submodule-context` test: a submodule declaring `reftable` resolves as reftable
   while its parent is files.
8. **GREEN** — add the field to both interfaces, thread it through `readRepositoryFormat` and
   both layout builders, and set it explicitly in every construction site the type-checker flags.
9. **GREEN** — add the three path helpers with unit tests in
   `test/unit/application/primitives/path-layout.test.ts`.
10. **REFACTOR** — none structural. Run `npm run docs:json` and commit `reports/api.json`; add
    the `docs/use/` note that `repo.layout.refStorage` now exists wherever `repo.layout` is
    documented.

### Gate

```
npx vitest run test/unit/repository test/unit/ports test/unit/adapters test/unit/application/primitives/path-layout.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/context.ts src/repository.ts src/repository src/adapters src/application/primitives/path-layout.ts test/unit
```

### Commit

`feat(repository): resolve the ref-storage backend on the repository layout`

## Part 13 — The reftable read backend

### Context

The parts above make this a wiring job: the codec exists (2–6), the seam is backend-neutral
(8–11), the layout says which backend to build (12). This part loads a stack and answers the
read verbs from it, and lands the first interop suite.

New files:

- `src/application/primitives/load-reftable-stack.ts` — I/O and memoisation.
- `src/application/primitives/reftable-ref-store.ts` — the backend's read half.
- `test/unit/application/primitives/load-reftable-stack.test.ts`,
  `reftable-ref-store.test.ts`
- `test/integration/reftable-ref-storage-interop.test.ts`

Edited: `src/application/primitives/ref-store.ts` — `createRefStore(ctx)` branches on
`ctx.layout.refStorage`. **`getRefStore` and the per-`Context` `WeakMap` are unchanged in shape**;
the memo already keys off `Context`, which is what makes `getRefStore(child)` at
`submodule.ts:660/749` correct for a submodule with its own backend.

**What a reftable repository is on disk** (measured, `git init --ref-format=reftable`):

| path | content |
|---|---|
| `.git/reftable/tables.list` | plain text, one filename per line, LF-terminated **including the last**, ordered **oldest → newest** |
| `.git/reftable/*.ref` | table files, named `0x%012x-0x%012x-%08x.ref` |
| `.git/packed-refs` | **absent** |
| `.git/logs/` | **absent** — reflogs live in the stack |
| `.git/HEAD` | a stub: `ref: refs/heads/.invalid<LF>` (25 bytes) |
| `.git/refs/` | a **directory** |
| `.git/refs/heads` | a **regular file**, 41 bytes: `this repository uses the reftable format<LF>` |

Those last two are the compatibility stubs the spec mandates, and they are exactly what produces
today's phantom `refs/heads` ref and the accidental `NOT_A_DIRECTORY`. The reftable backend must
never derive a ref name from anything under `.git/refs/`, and must never read `.git/HEAD`.
`find-layout.ts`'s `sharedDirsValid` requires `<commonDir>/refs` to be a directory — a reftable
repo satisfies that, so discovery already passes today and needs no change.

**The load protocol** (from the spec, and load-bearing because compaction unlinks merged tables):
read `tables.list`; open every file it names; **if any is missing, start over**; then read from
the open files as long as needed. Files not in `tables.list` are either about to be added or
ready to be pruned, and must be ignored. tsgit's `FileSystem` reads **by path**, not by a held
fd, so it has no POSIX unlink-survives-open protection — the restart is a specified hot-path
behaviour, not a defensive one. **One retry, then `INVALID_REFTABLE { check: 'tables-list' }`.**

```ts
export async function loadReftableStack(ctx: Context, reftableDir: string): Promise<ReftableStack>;
```

Memoised per `Context` with an **mtime+size key on `tables.list`**, exactly as `createRefStore`
memoises `packed-refs` today (`stat.mtimeMs`:`stat.size`, held in the closure). Both the update
and the compaction protocols rewrite `tables.list` as their final step, so the key catches every
*committed* change and a stack that was valid when loaded stays internally consistent. tsgit is
now also a writer, so its own writes invalidate the memo through the same key rather than through
a special case. Eager whole-table loading: the whole stack is parsed on load, log blocks
inflated via `ctx.compressor.streamInflate` passed as Part 4's `InflateAt`.

**`tables.list` entries are opaque filenames.** The `${min}-${max}-${random}` convention is only
"suggested" by the spec, so neither the `0x%012x` formatting nor the `.ref` extension is safe to
parse for meaning. Dispatch on each file's own header and footer — a `.log`-extension file
carrying only header + log blocks + footer is legal and must load.

**A backend instance is scoped to two stacks, not one.** A linked worktree has a full second
stack:

```
.git/reftable/{tables.list, *.ref}                    shared refs
.git/worktrees/<name>/reftable/{tables.list, *.ref}   per-worktree refs
```

Measured scoping: `refs/heads/*` and `refs/tags/*` visible from both; `refs/bisect/bad` created
in the linked worktree visible **only** there. `ORIG_HEAD` is a record in the stack — there is no
`.git/ORIG_HEAD` file. Route with `perWorktreeRefDir(ctx, name)` from Part 12, for reads and
writes alike.

**`resolve-ref.ts` is nearly backend-neutral already** — it owns the symref chain walk, cycle
detection and `MAX_SYMBOLIC_REF_DEPTH`, delegating each hop to `resolveDirect`. One caveat to
record in place: `validateRefName` is load-bearing there as a **path-escape** guard, because the
files `resolveDirect` builds a filesystem path from the name. Under reftable that justification
goes vacuous, but **the call must stay** — it is still the ref-name grammar gate, and removing it
would weaken the files backend that shares the code path.

**Interop suite.** `test/integration/reftable-ref-storage-interop.test.ts`, `@proves` header with
`surface: reftable`, `bucket: cross-tool-interop`,
`unique: reftable stack reads and writes agree with canonical git`,
`interopSurface: reftable` — this is what clears the Part 5 write-surface gap.
**One shared `beforeAll` fixture with a 60 000 ms timeout** (`beforeAll(fn, 60_000)`), per the
repo's git-spawning-suite convention; call `disableAutoMaintenance(dir)` on every fixture repo,
because `.git/reftable/` is exactly the kind of directory a detached `gc --auto` would rewrite
underneath the test. **Every read row builds its tsgit `Context` *after* the last `git`
subprocess has written**, so no memoised stack predates the mutation under test.

Read rows (git writes → tsgit reads):

| # | fixture | asserts |
|---|---|---|
| 1 | the five-ref fixture | tsgit's ref set ≡ `git show-ref`; and ≡ `git for-each-ref` including the `commit`/`tag` type column |
| 2 | annotated tag | peeled value ≡ `git for-each-ref '%(objectname) %(*objectname)'` |
| 3 | symbolic ref `refs/heads/symbolic` | resolves through the chain as `git rev-parse` does |
| 4 | `HEAD` | ≡ `git symbolic-ref HEAD`; the `.invalid` stub never surfaces |
| 5 | tombstone across two tables | the deleted ref is absent from both tools |
| 6 | reflog fixture | entries, order, oids, identity and message ≡ `git reflog show --date=raw`, **for each of the six tz offsets** |
| 7 | `--object-format=sha256` reftable | v2 header parsed; ref set ≡ git's |
| 8 | 3001-ref fixture (`git update-ref --stdin` then `git pack-refs --all`) | ref index + obj block exercised; ref set ≡ git's |
| 9 | linked worktree | shared vs per-worktree scoping ≡ git's, from both stacks |
| 10 | 100-ref fixture (3 log blocks) | log records read correctly with **no log index** |

Nothing here returns a rendered line: reconstruct git's output *in the test* from the structured
fields and compare. That is how faithfulness is pinned without the library emitting display text.

The 3001-ref fixture produced a single 97 803-byte table with **20 `'r'` blocks**, one `'i'` at
81920, one `'o'` at 86016 with `obj_id_len = 2`, `log_position = 86069`,
`log_index_position = 96750` — use those numbers as a sanity assertion on the parsed footer so a
regression in section placement fails loudly rather than through a ref-set mismatch.

**Read-path / read-path symmetry is the trap.** Converting `RefStore` and `enumerate-refs` while
leaving `branchList` and `tagList` on their own `readdir` produces a repository where
`resolveRef` and `enumerateRefs` are right and `branch.list()` / `tag.list()` are silently empty.
Part 8 converged all six enumerators; row 1 must assert through **`repo.branch.list()` and
`repo.tag.list()` as well as the primitive**, or the convergence is untested.

### TDD steps

1. **RED** — `load-reftable-stack.test.ts`: `describe('Given a two-table stack on disk')` >
   `describe('When the stack is loaded')` > `it('Then tables are ordered oldest to newest')`.
   Build the fixture with `test/fixtures/refs/reftable-writers.ts` into a memory context.
   **Expected failure:** `loadReftableStack` does not exist.
2. **RED** — `it('Then a table named by tables.list but missing on disk triggers exactly one
   reload')` (spy on `fs.read`), and `it('Then a second miss refuses with check tables-list')`
   asserting `.data.check` and `.data.reason`.
3. **RED** — `it('Then a malformed tables.list refuses with check tables-list')` for a body that
   is not LF-terminated filenames.
4. **RED** — `it('Then the stack is reloaded when tables.list mtime or size changes and reused
   otherwise')` — two isolated tests, one per key component.
5. **RED** — `it('Then a .log-extension entry carrying only log blocks loads')` — dispatch on
   content, not extension.
6. **RED** — `reftable-ref-store.test.ts`: `resolveDirect`, `listRefs`, `readReflog` and
   `listReflogs` all answer from the stack; `listRefs()` never yields `refs/heads` from the stub
   file and `resolveDirect('HEAD')` never returns `refs/heads/.invalid`.
7. **RED** — per-worktree routing: a `refs/bisect/*` ref resolves only from the worktree stack, a
   `refs/heads/*` ref only from the common stack.
8. **RED** — `ref-store.test.ts`: `createRefStore` on a `refStorage: 'reftable'` layout produces
   the reftable backend and on `'files'` the files backend. **Two isolated tests.**
9. **RED** — the interop suite's ten read rows.
10. **GREEN** — implement `loadReftableStack` and `reftableRefStore`, and branch `createRefStore`.
11. **REFACTOR** — hoist the two backends into sibling factory functions so `createRefStore` is a
    three-line dispatcher; keep the files closure's `packed-refs` memo untouched; add the
    `resolve-ref.ts` comment about `validateRefName`.

### Gate

```
npx vitest run test/unit/application/primitives test/integration/reftable-ref-storage-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives test/unit/application/primitives test/integration/reftable-ref-storage-interop.test.ts
```

### Commit

`feat(refs): read refs and reflogs from a reftable stack`

## Part 14 — Corrupt-stack tiering

### Context

A documented divergence, and the one place tsgit deliberately does not do what git does — because
on part of this input class git has no behaviour, it has a crash.

**Seven damaged fixtures, each a copy of the healthy five-ref repository** (a control copy was
verified to still report all five refs, so the copies are sound):

| damage | `for-each-ref` | `show-ref` | `rev-parse HEAD` | `log` | `fsck` |
|---|---|---|---|---|---|
| healthy control | rc 0, 5 refs | rc 0 | rc 0, oid | rc 0 | rc 0 |
| bad magic (`XXXX`) | **rc 0, empty** | rc 1 | rc 128 `ambiguous argument 'HEAD'` | rc 128 `fatal: your current branch appears to be broken` | **rc 8, `error: refs died of signal 11`** |
| truncated to 400 bytes | **rc 0, empty** | rc 1 | rc 128 | rc 128 | rc 8, signal 11 |
| footer CRC corrupted | **rc 0, empty** | rc 1 | rc 128 | rc 128 | rc 8, signal 11 |
| header version = 9 | **rc 0, empty** | rc 1 | rc 128 | rc 128 | rc 8, signal 11 |
| `tables.list` names a missing file | **rc 0, empty** | rc 1 | rc 128 | rc 128 | rc 8, signal 11 |
| `tables.list` removed | rc 0, empty | rc 1 | rc 128 | rc 128 | **rc 0**, `notice: No default references` |
| `.git/reftable/` removed | rc 0, empty | — | — | — | — |

Two findings pulling in opposite directions. **git does not `fatal` on a corrupt reftable stack —
it reports an empty ref space.** The contrast with the files backend is stark: a `packed-refs`
containing `GARBAGE NOT A REF` gives `fatal: unexpected line in .git/packed-refs: …`, rc 128, on
both `for-each-ref` and `show-ref`. Same class of damage; loud on files, silent on reftable. And
**`git fsck` dies on a signal** — `error: refs died of signal 11` is the child `git refs verify`
crashing. That is a genuine git bug, not a behaviour.

**The rule: tsgit refuses where git crashes, and degrades where git degrades coherently.** A
missing `tables.list` is rc 0 with no signal — a legitimately empty stack — so tsgit degrades to
an empty ref space there. Every structural fault on a *named* table is a refusal with a
structured code, because there is no coherent git behaviour to copy.

**The mechanism already exists in this repo and must be copied, not reinvented.**
`src/application/primitives/internal/midx-source.ts:68-108`:

```ts
type MidxTier = 'A' | 'B';

/** One total function from the closed `MidxCheck` union to a tier. No
 *  `default` arm: a future `MidxCheck` member is a compile error here, not a
 *  runtime surprise. */
function tierOf(check: MidxCheck): MidxTier {
  switch (check) {
    case 'size': …  return 'B';
    case 'signature': … return 'A';
  }
}
export function isTierBMidxFault(err: unknown): err is TsgitError { … }
```

Note the discipline in its comment at line 87: the predicate is a **positive test for the
degrade tier**; everything else falls through and is rethrown. *Never invert it into an
allow-list for the refuse tier* — that silently swallows a future `ReftableCheck` member the map
forgot.

New file `src/application/primitives/internal/reftable-source.ts` with
`tierOf(check: ReftableCheck)` (no `default` arm) and `isDegradableReftableFault(err)`. Mapping:

- **Degrade to an empty stack** — an absent `.git/reftable/` directory and an absent
  `tables.list`, i.e. `FILE_NOT_FOUND` on those two paths only. Not a `ReftableCheck` at all;
  these never reach the parser.
- **Refuse** — every `ReftableCheck`: `magic`, `version`, `footer-crc`, `truncated`,
  `block-type`, `restart-count`, `record-overrun`, `varint-overflow`, `tables-list`. Each is a
  structural fault on a file `tables.list` names, and each is a case where git's own `fsck`
  crashes.

`verifyIntegrity` (Part 8) gets its reftable implementation here: it returns one finding per
table that failed a check, and reports `badRefContent` as structurally unreachable — there is no
raw per-ref text in a reftable, so the loose-grammar fault class cannot exist.

**Interop row 11**, appended to `test/integration/reftable-ref-storage-interop.test.ts`: the seven
damaged fixtures, each asserting **git's exit code and signal beside tsgit's structured
refusal**, so the divergence is visible rather than silently untested. Use
`tryRunGitWithExit(args)` → `{ stdout, stderr, exitCode }`, which never throws and whose JSDoc
already names the codes (128 for a structural `fatal:`, 1 for `fsck`'s WARN/ERROR bits); the
signal-11 rows land as exit code 8 with `refs died of signal 11` on stderr. **tsgit never crashes
and never hangs on any of the seven** — assert that explicitly, because it is the property the
tier split exists to guarantee.

Put the reason for every loosened assertion **in the test**: a later reader must not "tighten"
row 11 into "tsgit matches git", because on five of the seven rows git has no defined behaviour
to match.

### TDD steps

1. **RED** — `test/unit/application/primitives/internal/reftable-source.test.ts`:
   `describe('Given each member of the reftable check union')` >
   `describe('When its tier is resolved')` > `it.each` over all nine members asserting `'refuse'`.
   **Expected failure:** `tierOf` does not exist.
2. **RED** — `it('Then a missing tables.list degrades to an empty stack')` and
   `it('Then a missing reftable directory degrades to an empty stack')` — **two isolated tests**,
   one per condition, because `if (A || B)` needs each arm proved alone.
3. **RED** — `it('Then a structural fault on a named table refuses')` for each of bad magic,
   truncation, bad CRC and version 9, asserting `.data.check` and `.data.reason` via try/catch.
4. **RED** — `it('Then a tables.list naming a missing file refuses after one reload')` — the
   Part 13 restart, now with its tier decided.
5. **RED** — `verifyIntegrity` on a reftable repository with one damaged table returns one
   finding naming that table's check, and never a `badRefContent`.
6. **RED** — interop row 11 over all seven fixtures.
7. **GREEN** — implement `reftable-source.ts`; wire it into `loadReftableStack` and the reftable
   backend's `verifyIntegrity`.
8. **REFACTOR** — express the degrade condition as one named predicate consumed by both the
   loader and `verifyIntegrity`; keep `tierOf` exhaustive with no `default` arm so a future
   `ReftableCheck` member is a compile error.

### Gate

```
npx vitest run test/unit/application/primitives test/integration/reftable-ref-storage-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives test/unit/application/primitives test/integration/reftable-ref-storage-interop.test.ts
```

### Commit

`feat(refs): refuse a structurally broken reftable and degrade an absent one`

## Part 15 — The reftable transaction

### Context

The write half of the backend, the second error code, and the browser degraded path. The heaviest
part in the plan — but it is a single protocol with a measured, step-by-step shape, and splitting
it would leave a half-written commit protocol on the branch.

New files:

- `src/application/primitives/reftable-transaction.ts` — the only place that mutates a stack.
- `test/unit/application/primitives/reftable-transaction.test.ts`

Edited: `src/application/primitives/reftable-ref-store.ts` (its `applyRefUpdates`),
`src/domain/refs/error.ts` + the four sibling error edits, `docs/use/errors.md`,
`test/integration/reftable-ref-storage-interop.test.ts`.

**The protocol, measured with a `reference-transaction` hook snapshotting `.git/reftable/` at
each state plus a tight `ls` loop over a 60 000-ref transaction:**

```
1  acquire   <dir>/tables.list.lock          fs.writeExclusive(path, empty)  -> FILE_EXISTS ⇒ retry
2  read      <dir>/tables.list               (fresh, NOT the memo)
3  verify    every `expected` against the freshly loaded stack
4  assign    update_index = stack.maxUpdateIndex + 1n
5  build     ref records + log records for the whole update list
6  write     <dir>/<name>.temp.<rand>        fs.writeExclusive
7  rename    -> <dir>/0x…-0x…-<rand>.ref
8  write     the new tables.list body        into the LOCK file
9  rename    <dir>/tables.list.lock -> tables.list        <- THE SINGLE COMMIT POINT
10 invalidate the per-Context stack memo
11 auto-compact (Part 16), best effort — never fails the transaction
```

Filenames observed in order during one transaction:

```
tables.list.lock                                     the stack lock, created empty
0x000000000003-0x000000000003-8c9dbb3a.temp.wXKo07   the new table, mkstemp suffix
0x000000000003-0x000000000003-3893be1f.ref           renamed into place — DIFFERENT random
```

**The `%08x` random is redrawn between the temp name and the final name** — it is
`reftable_rand()`, not a content hash, so it is unpredictable by construction. tsgit generates it
the same way (a random 32-bit value rendered `%08x`) and, under the stack lock, retries on a name
that already exists — `fs.writeExclusive` on the temp gives the collision check for free.
Transaction states from the hook: `prepared` is pre-state **+ a 0-byte `tables.list.lock`**, no
new table yet; `committed` is post-state with the lock gone.

**Step 3 is why `expected` belongs on `RefUpdate`** — the compare-and-swap must happen *after*
the lock, against a stack read under it, not against the memo.

**Retry policy (step 1).** git's `reftable.lockTimeout` defaults to **100 ms** with a jittered
backoff; `0` means one attempt, `-1` forever. Mirror the default and the semantics. **git never
breaks a stale lock** at any timeout — measured: a lock left by a `SIGKILL`ed process blocks
writes with `fatal: update_ref failed for ref '…': cannot lock references` at both
`lockTimeout=100` and `lockTimeout=0`, until a human removes it. **Reads are never blocked** — the
lock guards only the list rewrite.

**Crash safety.** Every step's residue is a state git already produces and already handles:

| crash after step | on disk | both tools read | recovery |
|---|---|---|---|
| 1–5 | pre-state + empty lock | pre-state | remove the lock |
| 6 | + an orphan `*.temp.*` | pre-state | ignored — not in `tables.list` |
| 7 | + an orphan `*.ref` | pre-state | ignored |
| 8 | lock holds the new body, `tables.list` unchanged | pre-state | remove the lock |
| 9 | post-state | post-state | none |

There is no window in which a reader sees a half-updated stack. **Everything that can refuse must
refuse before step 6** — that ordering is the same property Part 1 established, now at stack
scale.

**Cross-stack transactions.** A single update list may span both stacks — measured, git holds
both `tables.list.lock` files at `prepared` and commits both, and the two stacks keep
**independent `update_index` sequences**. Partition the list by `isPerWorktreeRef`, acquire both
locks in a **fixed order (common first, then worktree)** so two tsgit writers cannot deadlock,
commit each, release in reverse. The guarantee matches git's: each stack is individually
consistent; the pair is not atomic.

**Durability gap, stated rather than hidden.** git `fsync`s the lock fd before renaming it. The
`FileSystem` port has no `fsync`, so tsgit's commit is ordered but not durable against power loss
between the write and the rename — the same gap `atomicWriteRef` has always had, unchanged here
and out of scope to close. Record it in the module JSDoc.

**The degraded path (no `atomicRename`).** `BrowserFileSystem` omits the capability (Part 7), so
step 9 decomposes into: read the lock, overwrite `tables.list`, delete the lock. A crash between
the overwrite and the delete leaves the transaction **committed** and `tables.list.lock`
stranded — reads stay correct, but every subsequent write is blocked by a lock the writer itself
created, on a platform with no shell to remove it. The overwrite is a single
`createWritable()` → `write()` → `close()` and OPFS applies a writable stream at `close()`, so a
torn `tables.list` is not the failure mode; a stranded lock is.

**Stale-lock recovery, specified — this is the one sanctioned divergence from git here:**

- On the **atomic** path the lock body stays **empty**, byte-faithful to git, and a stale lock is
  **never** broken. `REFTABLE_LOCKED` names the path so the user can act.
- On the **degraded** path the transaction writes the new `tables.list` body into the lock
  (step 8) as it would anyway, and that body becomes the ownership proof. When acquiring a lock
  that already exists, compare its body to the on-disk `tables.list`:
  - **equal** ⇒ the commit provably completed and only the `rm` was lost. Breaking the lock is
    semantically a no-op, so break it and proceed.
  - **not equal** ⇒ indistinguishable from a live writer. Refuse `REFTABLE_LOCKED`.
- git never reads a lock body and never runs on OPFS, so the non-empty body cannot confuse it.
  State that in the code comment, next to the divergence.

**The second error code**, added the same five-place way as Part 2:

```ts
| { readonly code: 'REFTABLE_LOCKED'; readonly stack: string; readonly reason: string }

export const reftableLocked = (stack: string, reason: string): TsgitError =>
  new TsgitError({ code: 'REFTABLE_LOCKED', stack, reason });
```

Deliberately distinct from the existing `REF_LOCKED { name }`: the lock is on the **stack**, not
the ref, so the payload names the stack directory. Its `reason` names the lock path, which is the
actionable escape hatch tsgit owes its users given that it ships no `refs migrate` surface.
`docs/use/errors.md` row goes in `### Refs, reflog, revparse` between `REFLOG_NOT_FOUND` and
`REVPARSE_AMBIGUOUS`.

**Two write-side encodings a naive writer gets wrong.** A ref update writes **one ref record and
one log record**; committing on `main` wrote **two log records at the same `update_index`**,
`HEAD` and `refs/heads/main`, in one transaction — which is exactly the coupling Part 1 moved and
Part 10 folded. A deletion appends a ref tombstone carrying the **new** `update_index` **and one
log tombstone per existing reflog entry, each at that entry's own `update_index`**:

```
ref record:  'refs/heads/zzz'  update_index 4  value_type 0x0   (tombstone)
log record:  'refs/heads/zzz'  update_index 3  log_type 0x0     (reflog tombstone)
```

A writer that emits a single log tombstone at the new index leaves the old reflog entries visible.

**Interop rows 12–17 and 21–23**, appended to the existing suite:

| # | asserts |
|---|---|
| 12 | tsgit creates a ref in a git-made reftable repo → `git show-ref` sees it; `git fsck` and `git refs verify` clean |
| 13 | tsgit deletes a ref → gone from `git show-ref`; **its reflog entries gone from `git reflog`** |
| 14 | tsgit writes a symbolic ref → ≡ `git symbolic-ref` |
| 15 | tsgit commits on the branch `HEAD` points at → `git reflog HEAD` **and** `git reflog <branch>` both gain an entry **at the same index** |
| 16 | tsgit writes into a SHA-256 reftable repo → v2 table; `git show-ref` sees it |
| 17 | **the byte pin** — for a fixture whose logical content git reproduces exactly, the table tsgit writes is **byte-identical up to `log_position`** (assert against `buildReftableRefSection`'s output and against git's own bytes sliced to `log_position`), and records-equal beyond it |
| 21 | with `tables.list.lock` planted, tsgit raises `REFTABLE_LOCKED` naming the path and `git update-ref` says `cannot lock references`; **the stack is byte-unchanged**; reads succeed on both sides |
| 22 | crash residue — the table above replayed by aborting the write between steps; for each row git and tsgit read the same state afterwards |
| 23 | **the regression pin** — drive `updateRef` so the coupled-`HEAD` read fails; assert the throw **and** that `.git/refs`, `.git/logs` and `.git/reftable` are byte-identical to before. **Run on both backends** — this is a files-backend bug too, and it must fail on `main` before it passes here |

Row 17 is the accepted write contract in force: the declared `@writes` kind is
`equivalent-under-readback` because the log section cannot be byte-pinned, and the interop
assertion is strictly sharper than the declaration for the part that can. Row 23 is the direct
regression test for the measured write-then-diverge defect and must not be dropped.

Table content **is** deterministic given the same logical content and update indexes — the
five-ref fixture built twice from scratch with fixed `GIT_*_DATE` produced byte-identical tables
(536 and 165 bytes, matching SHA-256). Table *names* are not, and never can be.

### TDD steps

1. **RED** — `reftable-transaction.test.ts`:
   `describe('Given a stack and a two-ref update list')` >
   `describe('When the transaction commits')` >
   `it('Then both refs appear at one update index')`. **Expected failure:** the module does not
   exist.
2. **RED** — `it('Then tables.list gains exactly one entry, LF-terminated including the last')`.
3. **RED** — `it('Then the lock is created empty and removed on commit')`.
4. **RED** — step ordering: `it('Then an expected mismatch refuses before any table is written')`
   — assert the directory listing is unchanged and no `.temp.` file exists.
5. **RED** — `it('Then a held lock refuses with REFTABLE_LOCKED naming the lock path')`,
   asserting `.data.stack` and `.data.reason`; and a separate
   `it('Then a stale lock is never broken on the atomic path')`.
6. **RED** — degraded path (a memory context whose `fs` omits `atomicRename`): two isolated
   tests — a lock whose body equals `tables.list` is broken and the write proceeds; a lock whose
   body differs refuses `REFTABLE_LOCKED`.
7. **RED** — deletion encoding: a ref with three reflog entries produces one ref tombstone at the
   new index **and three log tombstones at indexes 1, 2 and 3**.
8. **RED** — cross-stack: an update list spanning a shared and a per-worktree ref acquires the
   common lock first, then the worktree lock, and commits both.
9. **RED** — `it('Then the per-Context stack memo is invalidated at commit')`.
10. **RED** — `test/unit/domain/refs/error.test.ts` factory test for `reftableLocked`.
11. **RED** — interop rows 12–17 and 21–23.
12. **GREEN** — implement the transaction, the reftable `applyRefUpdates`, the error code and its
    five-place wiring.
13. **REFACTOR** — extract lock acquisition (with the retry budget), table naming and the
    `tables.list` rewrite into named private functions each under 20 lines; put the fixed
    lock-order rule and the durability gap in the module JSDoc; add the `@writes`-adjacent
    comment explaining why the byte pin stops at `log_position`. Regenerate `reports/api.json` if
    any public type moved.

### Gate

```
npx vitest run test/unit/application/primitives test/unit/domain/refs test/integration/reftable-ref-storage-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives src/domain/refs src/domain/error.ts test/unit test/integration/reftable-ref-storage-interop.test.ts
```

### Commit

`feat(refs): commit reftable ref updates through git's stack lock protocol`

## Part 16 — Auto-compaction

### Context

Step 11 of every transaction, and the only place in this design where an error is deliberately
discarded. The policy is already pure and tested (Part 6); this part is its I/O protocol.

Edited: `src/application/primitives/reftable-transaction.ts`,
`test/unit/application/primitives/reftable-transaction.test.ts`,
`test/integration/reftable-ref-storage-interop.test.ts`.

**The protocol**, from the measured ordering plus git's `stack_compact_range`:

1. Acquire `tables.list.lock`; verify the stack is up to date, else abort `OUTDATED`.
2. Acquire `<table>.lock` for every table in the segment, **newest → oldest**. If one is already
   locked, best-effort: shrink the range to the tables locked so far; **if fewer than two remain,
   give up silently.**
3. **Release `tables.list.lock`** — concurrent appends may proceed while the merge runs.
4. Merge the locked tables into a temp file.
5. Re-acquire `tables.list.lock`; re-read `tables.list`; verify the compacted names still appear
   **in the same order**; abort `OUTDATED` if not.
6. Rename the temp file into place — **unless the merge produced an empty table**, in which case
   it is simply omitted from `tables.list`.
7. Write the new `tables.list` through the lock and rename it over.
8. **Unlink the merged tables — best effort**; failures are ignored, because a concurrent reader
   may still hold them.

The per-table lock names are `<table>.ref.lock`, observed alongside the stack lock during an
auto-compacting transaction.

**Three merge rules a naive implementation gets wrong** — the predicates come from Part 6, the
enforcement is here:

- **Tombstones are dropped only when the segment starts at table 0.** git's merge skips a ref or
  log deletion record `if (first == 0 && …is_deletion)`. Measured: `pack-refs --all` over a stack
  containing a deleted `refs/heads/p2` produced a single table with **no `p2` record and no `p2`
  reflog entries at all**. A partial compaction that drops tombstones resurrects the ref from an
  older table — the same failure mode as a concatenating reader.
- **An empty compaction result is not written.** If tombstones cancel everything in the range, the
  table is omitted.
- **The merged table's `min_update_index` is the oldest merged table's `min`, its
  `max_update_index` the newest's `max`.**

**Auto-compaction never fails a write.** Measured: with every table lock held by hand,
`git update-ref` still succeeded and the stack grew from depth 2 to 3; after the locks were
released, the next update compacted back to depth 1. This is the one place an error is swallowed,
and it is deliberate and narrow: **only** `REFTABLE_LOCKED` and the stack-outdated condition,
**only** from the compaction step, and **only** after the ref update has already committed.
Anything else propagates. Write that constraint as a comment at the catch site and keep the catch
to those two conditions — a bare `catch {}` here is the swallowed-exception defect the repo
refuses.

**There is no forced full compaction, and that is deliberate** — git's is `pack-refs --all` /
`gc`, and tsgit's arrives in Part 17. The consequence is precise: a tombstone is elided only when
an auto-compaction segment happens to start at table 0, so a deleted ref's tombstone can persist
across many updates. It is never *visible* — the merge join hides it — it only costs bytes, and
exactly what it costs in a git repository that never runs `gc`.

**Interop rows 18–20**, and the assertion discipline is the whole point of this part:

| # | asserts |
|---|---|
| 18 | tsgit writes 60 refs one at a time; after each, `git show-ref` ≡ tsgit's `listRefs`; and **the invariant**: `suggestCompactionSegment` over the resulting stack returns an empty segment |
| 19 | full compaction round trip — tsgit compacts a git-built stack; `git show-ref`, `git reflog` and `git fsck` all agree with the pre-state, and tombstones are elided only when the segment started at table 0 |
| 20 | interleaved writers — a `git update-ref` and a tsgit write against one stack, alternating; all refs present, stack geometric, no orphan files |

**Never assert the table count.** Auto-compaction's metric is the file size; log-block sizes are
zlib-dependent (git 145 bytes where Node produces 147); and the measured decision margins are as
thin as **432 vs 428 bytes**. A two-byte DEFLATE difference can therefore legitimately flip one
merge, leaving tsgit with a different *number* of tables than git for identical logical content —
**with both correct**. Table-for-table equality would flake on correct behaviour, which is the
worst kind of test: it fails for a reason the implementer cannot fix and teaches them to loosen
assertions. **Put that reason in the test**, in prose, so a later reader does not "tighten" it.
What is asserted instead is that tsgit's stack satisfies **git's own compaction rule** (empty
suggested segment) and that the merged view is identical.

Concurrency the rows must not contradict (measured): two shells each running 120 sequential
`git update-ref` calls against one stack both exited 0, all 241 refs present, final depth 4,
**zero orphan files**; the 100 ms retry absorbs contention transparently. A reader run while a
lock is held returns the correct pre-state. tsgit runs the identical protocol on identical files,
so a tsgit writer and a `git` writer interleave the same way two `git` processes do.

### TDD steps

1. **RED** — `reftable-transaction.test.ts`:
   `describe('Given a stack whose newest tables qualify for a merge')` >
   `describe('When a transaction commits')` >
   `it('Then the qualifying segment is merged into one table')`.
   **Expected failure:** compaction does not run.
2. **RED** — `it('Then the merged table carries the oldest min and the newest max update
   index')`.
3. **RED** — tombstones: **two isolated tests** — a segment starting at table 0 elides them; a
   segment starting mid-stack keeps them, and the previously deleted ref stays absent from the
   merged view.
4. **RED** — `it('Then an empty merge result is omitted from tables.list')`.
5. **RED** — `it('Then a held table lock shrinks the range')` and
   `it('Then fewer than two lockable tables gives up silently')` — two isolated tests.
6. **RED** — `it('Then a lock conflict during compaction leaves the ref update committed')` —
   the swallow, proved to be scoped: assert the ref is present and the stack grew by one.
7. **RED** — `it('Then a non-lock error during compaction propagates')` — the negative half, so
   the catch cannot widen into a bare swallow.
8. **RED** — `it('Then merged tables are unlinked and an unlink failure is ignored')`.
9. **RED** — `it('Then the stack is outdated between the two lock acquisitions and the
   compaction aborts')`.
10. **RED** — interop rows 18–20.
11. **GREEN** — implement the eight-step protocol inside the transaction module, consuming
    `suggestCompactionSegment` and `compactionMetric` unchanged.
12. **REFACTOR** — split the protocol into `lockSegment`, `mergeSegment` and `commitCompaction`,
    each under 20 lines; the merge itself reuses `serializeReftable` with the tombstone rule as
    an explicit boolean derived from `segment.start === 0` — never an inline literal comparison
    at the record filter.

### Gate

```
npx vitest run test/unit/application/primitives test/unit/domain/refs/reftable test/integration/reftable-ref-storage-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives src/domain/refs/reftable test/unit test/integration/reftable-ref-storage-interop.test.ts
```

### Commit

`feat(refs): keep the reftable stack geometric with auto-compaction`

## Part 17 — `packRefs` as a Tier-1 command

### Context

One new Tier-1 command, and the **full new-command surface gate** — nine coordinated edits, four
of which are pre-push-blocking and invisible to a local `validate`. It is not reftable-only:
`pack-refs` has real measured behaviour on the **files** backend and needs its own pinned matrix.

**Why it exists here:** git removes unreferenced `*.ref` tables only during `pack-refs --all` /
`gc`. An orphan `0x…-deadbeef.ref` planted in a reftable directory survived a normal
`update-ref` untouched and was removed by `git pack-refs --all`. Without the command, a crash at
step 6 or 7 of the transaction leaks that file **forever**. Cleanup lives in the same place and
at the same moment git performs it — faithful in mechanism and location, not merely in effect.
`packRefs` packs refs; **it deletes no objects**, so `extensions.preciousObjects` is unaffected
and still honoured by construction.

**Before writing a line, pin the files-backend matrix against real git in a `mktemp -d`
throwaway** (never the worktree), with `GIT_*` scrubbed, an isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1` and signing off. At minimum: `pack-refs --all` vs bare `pack-refs`; what
happens to loose files afterwards; the `packed-refs` header traits emitted
(`# pack-refs with: peeled fully-peeled sorted ` — note the trailing space
`src/domain/refs/packed-refs.ts` already reproduces); whether `HEAD` and other per-worktree refs
are packed; behaviour on an already-packed repository; and on an empty repository. Record the
measured rows in the docs page. `src/domain/refs/packed-refs.ts` already parses and serializes
the format byte-identically, so the command is a composition — but a composing command still
declares its own write surface.

**New source:** `src/application/commands/pack-refs.ts`, exporting
`packRefs(ctx, opts): Promise<PackRefsResult>` plus `PackRefsOptions` and `PackRefsResult`.
Follow `src/application/commands/pack-objects.ts`: `export const packRefs = async (ctx, opts) =>
{ await assertOperationalRepository(ctx); … }`, importing that guard from
`./internal/repo-state.js`. **Do not call `requireWorkTree`** — `packRefs` needs no work tree.
Return structured fields only (counts, names, oids) — no rendered line, no `bytes`, no
formatting options.

Behaviour by backend: on **files**, pack loose refs into `packed-refs` and remove the packed
loose files, matching the measured matrix; on **reftable**, compact the whole stack (segment
`[0, n)`, so tombstones are elided) and then, **under the `tables.list` lock**, unlink every
`*.ref` / `*.temp.*` in the directory that is absent from `tables.list`. Both behaviours live
behind the `RefStore` seam as a new verb rather than as a branch in the command.

**The nine surface gates — every one of them, in this part:**

1. **Barrel** `src/application/commands/index.ts` — insert at **line 222**, between
   `'./pack-objects.js'` and `'./pull.js'` (ordering is alphabetical by module specifier;
   `export * from` is never used):
   ```ts
   export {
     type PackRefsOptions,
     type PackRefsResult,
     packRefs,
   } from './pack-refs.js';
   ```
2. **`Repository` interface** `src/repository.ts` — insert at **line 253**, after `packObjects`:
   `  readonly packRefs: BindCtx<typeof commands.packRefs>;`. **The two-space indent is
   load-bearing** — both `tooling/check-doc-coverage.ts` and `tooling/audit-browser-surface.ts`
   parse this file with `/^ {2}readonly (\w+):\s*BindCtx</gm` (four spaces means Tier-2).
3. **Factory binding** `src/repository.ts` — insert at **line 633**, after the `packObjects`
   block, in the local `guard()` shape (defined at line 532; it only checks disposal — the tier
   guard lives inside the command):
   ```ts
   packRefs: ((packRefsOpts) => {
     guard();
     return commands.packRefs(ctx, packRefsOpts);
   }) as Repository['packRefs'],
   ```
4. **Facade key list** `test/unit/repository/repository.test.ts` — insert `'packRefs',` at
   **line 276**, between `'packObjects',` and `'primitives',`, inside
   `it('Then they exactly match the documented surface')`.
5. **Docs page** `docs/use/commands/pack-refs.md` — kebab-case of the binding. The six-section
   skeleton is documented in-repo at the tail of `docs/use/commands/README.md` under
   `## Page shape`: `## Signature`, `## Options` (`Field | Type | Default | Meaning`, with
   `(required)` / `(none)` explicit), optional `## Behaviour`, `## Examples` (2–4 snippets),
   `## Throws` (codes citing `../errors.md`), `## See also`. `docs/use/commands/init.md` is a
   short model. Every `See also` link must resolve — `check:doc-links` runs lychee over
   `docs/**/*.md`.
6. **Index row** `docs/use/commands/README.md` — insert at line 38, between the `packObjects`
   and `pull` rows: `` | [`packRefs`](pack-refs.md) | <one-line summary>. | ``.
   `check:doc-coverage` asserts the **exact substring** `` [`packRefs`](pack-refs.md) ``, and the
   page file's existence — nothing else. Also bump the header line 3 from **45 entries** to
   **46**. (The allowlist at `tooling/check-doc-coverage.allowlist.json` is currently
   non-functional — `loadAllowList` reads it from a `scripts/` path that does not exist — so ship
   the page, never an allowlist entry.)
7. **Root `README.md` line 47** — `- 45 Tier-1 commands · …` becomes **46**. `README.md` is a
   `files:` input to the `docs:json` wireit target, so this edit alone invalidates
   `reports/api.json`.
8. **Browser-surface coverage** — `tooling/audit-browser-surface.ts` is a **blocking** gate that
   greps `test/browser/**` and `test/parity/scenarios/**` for a literal
   `` /\brepo\.([a-zA-Z][\w]*)\s*\(/g `` match. Add
   `test/parity/scenarios/pack-refs.scenario.ts` containing a real `await repo.packRefs(…)`, and
   register it in `test/parity/scenarios/index.ts` (import alphabetically after
   `packObjectsScenario`; the `SCENARIOS` array is chronological, so append near it). Scenario
   files import with **`.ts` extensions**, follow the `Scenario<TResult>` contract in
   `test/parity/scenarios/types.ts`, and carry a `Surfaces closed:` JSDoc line. **`expected` must
   hold only deterministic readback facts** (loose refs pruned, `packed-refs` content) — never
   modification times or per-run identifiers; `tooling/audit-parity-fixtures.ts` fails `check:parity-fixtures`
   on nondeterminism. Do **not** use the allowlist
   (`tooling/audit-browser-surface.allowlist.json`) — `packRefs` is pure ref/OPFS I/O.
9. **Published subpath entry point** — a Tier-1 command is also published on its own. Four
   coordinated edits, all pre-push-blocking:
   - `package.json` `exports`: insert `"./commands/pack-refs"` between
     `"./commands/pack-objects"` and `"./commands/pull"`, copying the pack-objects entry's
     `import`/`require` × `types`/`default` shape. Gated by `check:exports` (`attw`) and
     `check:tarball`.
   - `rollup.config.ts` (entry map, ~line 42): add
     `'commands/pack-refs': 'src/application/commands/pack-refs.ts',`.
   - `.size-limit.json` (~line 230): add
     `{ "name": "Command (pack-refs)", "path": "dist/esm/commands/pack-refs.js", "limit": "1.5 kB", "gzip": true }`.
     Gated by `check:size` — if it fails, `rm -rf dist .wireit` and rebuild before believing it.
   - `reports/api.json`: `npm run docs:json`, commit the result. `check:doc-typedoc` regenerates
     and then `git diff --exit-code`s it, and it runs in `prepush`, **not** in `validate`.

**`@writes` block** — first JSDoc in `pack-refs.ts`:

```
 * @writes
 *   surface: packRefs
 *   kind:    equivalent-under-readback
 *   format:  git-packed-refs-state
```

paired by a `test/integration/pack-refs-interop.test.ts` whose `@proves` header carries
`bucket: cross-tool-interop` and `interopSurface: packRefs`. The pairing key is bare string
equality on the surface name.

**Interop rows** in that new file: the files matrix measured above, twinned against real git
(`packed-refs` bytes ≡ git's after the same operations, loose files pruned identically, `HEAD`
and per-worktree refs treated identically, idempotence on a second run); plus the reftable rows —
after `repo.packRefs()` on a git-built reftable stack, `git show-ref`, `git reflog` and
`git fsck` all agree with the pre-state, `suggestCompactionSegment` is empty, and a planted
orphan `0x…-deadbeef.ref` is gone while every table named by `tables.list` survives.
**Still never assert the table count.**

Any new error code follows the five-place checklist and gets a `## Throws` entry on the page.
Unit test at `test/unit/application/commands/pack-refs.test.ts`, mirroring
`pack-objects.test.ts` (JSDoc header with a `Coverage:` bullet list, `createMemoryContext`,
direct `(ctx, opts)` calls). `cspell.json` has no `packRefs`/`pack-refs` entry; both split into
known words, but run `npm run check:spelling` rather than assuming.

### TDD steps

1. **RED** — measure the files matrix against real git in a `mktemp -d` throwaway first, and
   write `test/integration/pack-refs-interop.test.ts`'s files rows from the measurements.
   **Expected failure:** `repo.packRefs` does not exist.
2. **RED** — `test/unit/application/commands/pack-refs.test.ts`:
   `describe('Given a files repository with two loose refs and one packed ref')` >
   `describe('When packRefs runs')` > `it('Then all three appear in packed-refs and the loose
   files are gone')`.
3. **RED** — `it('Then a second run is a no-op')`, and `it('Then an empty repository is
   unchanged')` — two isolated tests.
4. **RED** — `it('Then per-worktree refs are treated exactly as git treats them')`, per the
   measured row.
5. **RED** — reftable: `it('Then the whole stack compacts to one table')` and
   `it('Then an orphan table file is unlinked while every listed table survives')` — two
   isolated tests.
6. **RED** — `it('Then a deleted ref stays absent after a full compaction')` — the
   `start === 0` elision path, end to end.
7. **RED** — `test/unit/repository/repository.test.ts`'s key-list assertion.
8. **RED** — the reftable interop rows.
9. **GREEN** — implement the command and the backend verb; land all nine surface gates.
10. **REFACTOR** — keep `packRefs` a thin composition over the seam verb; no backend branch in
    the command body. Run `npm run validate`, then `npm run docs:json` and commit
    `reports/api.json` — a green `validate` does not clear the pre-push gate.

### Gate

```
npx vitest run test/unit/application/commands/pack-refs.test.ts test/unit/repository/repository.test.ts test/integration/pack-refs-interop.test.ts test/parity && npm run check:types && ./node_modules/.bin/biome check src/application/commands src/repository.ts test/unit test/integration/pack-refs-interop.test.ts test/parity/scenarios
```

### Commit

`feat(commands): add packRefs and clean orphaned reftable tables there`

## Part 18 — Reftable joins the backed set

### Context

The closing act, and the coordination point with the three sibling plans on this branch. Two
deliverables: one deletion that flips a refusal into a capability, and the cross-adapter parity
proof that the capability is real everywhere.

**The deletion.** The acceptance-gate plan lands a point-of-use refuse set carrying the
`REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }` code for the extensions git knows and
tsgit had not yet implemented. It ships containing three names — `objectFormat`, `refStorage`,
`compatObjectFormat`. The SHA-256 plan removes `objectFormat`. **This part removes
`refStorage`.** `compatObjectFormat` stays permanently: git itself refuses it on this build
(`fatal: compatibility hash algorithm support requires Rust`), so the set's steady-state
membership is exactly one name — a fact about how much this change implements, not a property of
the code. The code stays general so a future unimplemented extension joins by name, with no new
code and no new ADR.

Locate the set by grepping `REPOSITORY_EXTENSION_UNSUPPORTED` across `src/` — it is a named
constant near `readRepositoryFormat` / the acceptance-gate module in `src/repository/`. Do not
guess its file: the acceptance-gate plan, not this one, chose where it lives. Remove the one
entry and its refusal test, and replace the test with its inverse: **a repository declaring
`extensions.refStorage = reftable` now performs the operation instead of refusing it.** That
inverse test is the deliverable — a deletion with no positive assertion proves nothing.

Check `docs/use/errors.md`'s `REPOSITORY_EXTENSION_UNSUPPORTED` row: if it enumerates the member
names, it drops `refStorage` here. If the acceptance-gate plan wrote it generically, leave it.

**The parity scenario.** `test/parity/` proves cross-adapter agreement only, never faithfulness —
that is what the interop suite is for. New file
`test/parity/scenarios/reftable-refs.scenario.ts`, registered in
`test/parity/scenarios/index.ts` (import alphabetically; append to the chronological
`SCENARIOS` array). It materialises a reftable fixture into the adapter under test, then asserts
node ≡ memory ≡ browser across the read surfaces and, on the two adapters that can commit, the
write surfaces.

**The parity oracle is records, not bytes.** Node's zlib and the browser's `CompressionStream`
produce different log-block bytes for identical content, so a byte-equality assertion across
adapters would fail for a reason that is not a defect. The non-log prefix **is** byte-comparable
across adapters and is asserted as such — use `buildReftableRefSection` for that comparison, the
same function the interop byte pin targets. Write the reason into the scenario's JSDoc.

The browser adapter omits `atomicRename`, so its writes take the degraded commit path. Assert
that path produces the same records as the atomic one, and that a lock whose body equals
`tables.list` is broken and recovered from — the browser is the only adapter where that code runs,
so this is its only coverage outside the unit test.

`expected` must hold only deterministic readback facts. Table filenames carry a random suffix and
`tables.list` content is therefore **never reproducible** — five identical `git init` + commit
runs produced five different suffixes, and the random is redrawn even between the temp name and
the final name. Assert the merged ref view, the reflog entries and the emptiness of
`suggestCompactionSegment`; never a filename, never a table count.
`tooling/audit-parity-fixtures.ts` fails `check:parity-fixtures` on nondeterminism, and it is a
`validate` dependency.

**Final sweep before the commit** — these are the items a phase-boundary validate would otherwise
surface as a wasted round:

- `npm run validate` clean, then `npm run docs:json` and commit `reports/api.json` if it moved.
- `tooling/audit-write-surfaces.allowlist.json` is still `{ "surfaces": [] }` and
  `reports/write-surface-coverage.json` reports no `gaps`, no `allowlistRot`, no
  `orphanCoverage` — `surface: reftable` is claimed by
  `test/integration/reftable-ref-storage-interop.test.ts` and `surface: packRefs` by
  `test/integration/pack-refs-interop.test.ts`.
- `docs/use/errors.md` carries `INVALID_REFTABLE` and `REFTABLE_LOCKED` with their payload fields.
- The command count reads 46 in both `README.md` and `docs/use/commands/README.md`.
- `test-pyramid-budgets.json` ratios still hold (unit target 80 %, integration 15 %, warn above
  25) — this change adds several integration files, so check rather than assume.
- `test:parity:workers` / `:deno` / `:bun` are **not** in `validate` and this change touches
  adapters — run them. Watch for the known workerd break class: an `async` function returning a
  promise without `await`; `return await` is the fix.

### TDD steps

1. **RED** — the acceptance-gate refusal test's inverse: `describe('Given a repository declaring
   the reftable ref storage extension')` > `describe('When a ref is resolved')` >
   `it('Then it resolves instead of refusing')`, asserting the oid rather than the absence of a
   throw. **Expected failure:** it throws `REPOSITORY_EXTENSION_UNSUPPORTED`.
2. **RED** — a second inverse for the write side: `it('Then a ref update commits instead of
   refusing')`.
3. **RED** — `it('Then compatObjectFormat is still refused')`, so the deletion is proved to be
   one entry and not the whole set.
4. **RED** — `reftable-refs.scenario.ts`: read surfaces agree across adapters.
5. **RED** — the scenario's write half on memory and browser, with the browser exercising the
   degraded commit and the provably-completed lock break.
6. **RED** — `it('Then the non-log prefix is byte-identical across adapters')`.
7. **GREEN** — delete the `refStorage` entry from the refuse set; land the scenario and its
   registration.
8. **REFACTOR** — none expected. Run the final sweep above.

### Gate

```
npx vitest run test/unit/repository test/parity && npm run check:types && ./node_modules/.bin/biome check src/repository test/unit/repository test/parity/scenarios
```

### Commit

`feat(repository): stop refusing operations on reftable repositories`
