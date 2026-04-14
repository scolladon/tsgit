# Plan: Phase 2 — Object Storage

Implements [design/object-storage.md](../design/object-storage.md).
Covers [backlog](../BACKLOG.md) items 2.1–2.8.

### Backlog → Step Mapping

| Backlog Item | Description | Steps |
|---|---|---|
| **2.1** | Loose object reader | 3 (path computation) |
| **2.2** | Loose object writer | 3 (path computation) |
| **2.3** | Pack index reader | 7 |
| **2.4** | Packfile reader | 6 |
| **2.5** | Delta resolution | 8 |
| **2.6** | Delta base LRU cache | 5 |
| **2.7** | Object lookup pipeline | 7 (prefix search) — full pipeline in Phase 7 |
| **2.8** | Packfile writer | 9 |
| — | Error refactoring (TsgitError extraction) | 1 |
| — | StorageError union | 2 |
| — | CRC-32 | 4 |
| — | Pack entry types + header codec | 6 |
| — | Barrel export + verification | 10 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step run: `npm run check:types && npm run test:unit && npm run check:architecture`

**Commit strategy:** One commit per completed step (green + refactor). Message format: `feat(domain): add <module> — <what it does>` for new modules, `refactor(domain): <what changed>` for refactoring steps (e.g., step 1). Feature branch with worktree — never commit directly to main.

## Prerequisites (before step 1)

1. Create directories: `src/domain/storage/`, `test/unit/domain/storage/`
2. ADR `docs/adr/003-error-extension-strategy.md` is already committed — no action needed
3. Coverage config in `vitest.config.ts` already includes `src/domain/**/*.ts` — `storage/` is covered automatically
4. Update `cspell.json` as needed throughout — new domain terms (fanout, packfile, etc.) may trigger spelling failures

## File Conventions

- Source files under `src/domain/storage/` (except `domain/error.ts` which is at the domain root)
- Test files under `test/unit/domain/storage/`
- File names: kebab-case (enforced by ls-lint)
- Test names: `<module>.test.ts`
- Test format: Given/When/Then titles, AAA body, `sut` variable
- **Import extensions:** All imports MUST use `.js` extension
- **Direct imports from `domain/objects/`:** Import `compareBytes`, `hexToBytes`, `bytesToHex`, `encode`, `decode`, `indexOf` directly from `../objects/encoding.js` (not the barrel). Import `ObjectId`, `HashConfig`, `SHA1_CONFIG`, `ObjectType` from the barrel `../objects/index.js`.

## Design Decisions (applied in this plan)

- **`TsgitError` extracted to `domain/error.ts`** using `import type` for phase union types. Breaks no runtime cycles — `verbatimModuleSyntax` enforces type-only imports are erased. Existing tests importing from barrel are unaffected. See ADR-003.
- **dependency-cruiser config update** required in step 1: add `dependencyTypesNot: ['type-only']` to the `no-circular` rule to avoid false positives from the source-level type cycle.
- **Pack index is SHA-1 only** (v2 format). No `HashConfig` parameter on index functions. `parsePackEntryHeader` keeps `HashConfig` for REF_DELTA.
- **`serializePackfile` returns `PackfileResult`** with per-entry CRC-32 and offset — not a bare `Uint8Array`. Avoids forcing the caller to duplicate header encoding for CRC computation.
- **`InsertInstruction.data` uses `slice()`** (copy), not `subarray()` (zero-copy), to allow GC of the delta buffer.
- **`LruCache.set` requires `byteSize > 0`.** `maxSize = 0` creates a no-op cache.
- **fast-check arbitraries** for storage types live in `test/unit/domain/storage/arbitraries.ts`. Import `arbObjectId` from `../objects/arbitraries.js` when needed.
- **Tests import directly from source modules**, not from the barrel.

---

## Step 0: Prerequisites & Setup

**Create:** `src/domain/storage/`, `test/unit/domain/storage/`

No code — just directory creation and cspell updates if needed.

---

## Step 1: Extract `TsgitError` to `domain/error.ts`

**Create:** `src/domain/error.ts`
**Modify:** `src/domain/objects/error.ts`, `src/domain/objects/index.ts`, `src/domain/index.ts`
**Modify:** `.dependency-cruiser.cjs` (no-circular rule)
**Test:** Existing tests must still pass. No new test file — existing `error.test.ts` validates behavior.

This is a **refactoring step** — no new functionality, just relocating code.

### Actions:

1. Create `src/domain/error.ts`:
   - Move `TsgitError` class from `domain/objects/error.ts`
   - Move `extractDetail` helper
   - `import type { DomainObjectError } from './objects/error.js'`
   - Define `type TsgitErrorData = DomainObjectError` (StorageError added in step 2)
   - Export `TsgitError`, `TsgitErrorData`

2. Update `src/domain/objects/error.ts`:
   - Remove `TsgitError` class and `extractDetail`
   - Add `import { TsgitError } from '../error.js'`
   - Re-export `TsgitError` for barrel compatibility: `export { TsgitError } from '../error.js'`
   - Factory functions stay here, now importing `TsgitError` from parent

3. Update `src/domain/objects/index.ts`:
   - Barrel continues to export `TsgitError` (unchanged — comes through `error.ts` re-export)

4. Update `src/domain/index.ts`:
   - Add `export type { TsgitErrorData } from './error.js'`
   - Do NOT add an explicit `TsgitError` export — it already flows through `export * from './objects/index.js'` via the re-export chain in `objects/error.ts`. Adding it would create a duplicate named export (compile error).

5. Update `.dependency-cruiser.cjs`:
   - In the `no-circular` rule, change `to: { circular: true }` to `to: { circular: true, dependencyTypesNot: ['type-only'] }`. This suppresses false positives from the source-level type cycle created by `import type` in `domain/error.ts`.

### Verify:

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

All existing tests must pass without modification. If any test imports `TsgitError` directly from `domain/objects/error.ts`, it still works via the re-export.

---

## Step 2: `error.ts` — StorageError Union

**Create:** `src/domain/storage/error.ts`
**Test:** `test/unit/domain/storage/error.test.ts`
**Modify:** `src/domain/error.ts` (add `StorageError` to `TsgitErrorData`)

### Test first (red):

```
Given invalidPackHeader('bad magic'), When checking error.data.code, Then equals 'INVALID_PACK_HEADER'
Given invalidPackHeader('bad magic'), When checking error.data.reason, Then equals 'bad magic'
Given invalidPackIndex('fanout'), When checking error.data.code, Then equals 'INVALID_PACK_INDEX'
Given invalidPackEntry(42, 'truncated'), When checking error.data, Then offset is 42 and reason is 'truncated'
Given invalidDelta('source mismatch'), When checking error.data.code, Then equals 'INVALID_DELTA'
Given a storage TsgitError, When checking instanceof Error, Then returns true
Given a storage TsgitError, When accessing .name, Then equals 'TsgitError'
Given a storage TsgitError, When accessing .message, Then contains the error code
Given a storage TsgitError, When switching on data.code in exhaustive switch, Then all 11 cases handleable (7 domain + 4 storage) — this is a compile-time exhaustiveness check verified by `check:types`, written as a switch with a `never` default branch
```

### Implement (green):

- `StorageError` type: 4 variants (INVALID_PACK_HEADER, INVALID_PACK_INDEX, INVALID_PACK_ENTRY, INVALID_DELTA)
- Factory functions: `invalidPackHeader`, `invalidPackIndex`, `invalidPackEntry`, `invalidDelta`
- Update `domain/error.ts`:
  - `import type { StorageError } from './storage/error.js'`
  - Widen `TsgitErrorData = DomainObjectError | StorageError`
  - Add switch cases to `extractDetail`:
    - `INVALID_PACK_HEADER` → `data.reason`
    - `INVALID_PACK_INDEX` → `data.reason`
    - `INVALID_PACK_ENTRY` → `data.reason` (offset is contextual, reason is the detail)
    - `INVALID_DELTA` → `data.reason`

---

## Step 3: `loose-path.ts` — Loose Object Path

**Create:** `src/domain/storage/loose-path.ts`
**Test:** `test/unit/domain/storage/loose-path.test.ts`

Trivial module — single function, no internal dependencies.

### Test first (red):

```
Given a SHA-1 ObjectId 'aabbccdd...', When computing path, Then returns 'aa/bbccdd...'
Given a SHA-256 ObjectId (64 chars), When computing path, Then returns 'xx/yy...' (first 2 / rest)
Given any ObjectId, When computing path, Then first segment is 2 chars
Given any ObjectId, When computing path, Then second segment is remaining chars
Given any ObjectId, When computing path, Then contains exactly one '/'
```

### Implement (green):

```typescript
function computeLooseObjectPath(id: ObjectId): string {
  return `${id.slice(0, 2)}/${id.slice(2)}`;
}
```

### Property-based tests:

- For any `arbObjectId()`: `computeLooseObjectPath(id).replace('/', '') === id` (roundtrip minus separator)
- For any `arbObjectId()`: path has exactly one `/` at index 2

---

## Step 4: `crc32.ts` — CRC-32

**Create:** `src/domain/storage/crc32.ts`
**Test:** `test/unit/domain/storage/crc32.test.ts`

Self-contained pure function. No domain dependencies.

### Test first (red):

```
Given empty data, When computing CRC-32, Then returns 0x00000000
Given ASCII '123456789', When computing CRC-32, Then returns 0xCBF43926
Given ASCII 'PACK', When computing CRC-32, Then returns known value (compute with reference impl)
Given a single byte [0x00], When computing CRC-32, Then returns known value
Given a single byte [0xFF], When computing CRC-32, Then returns known value
Given 1000 zero bytes, When computing CRC-32, Then returns known value
Given 1 MB of random data, When computing CRC-32 twice, Then results are identical (large data determinism)
Given any data, When computing CRC-32 twice, Then results are identical (deterministic)
Given any data, When computing CRC-32, Then result is unsigned 32-bit (>= 0 and < 2^32)
```

### Implement (green):

- `buildCrc32Table(): Uint32Array` — 256-entry pre-computed table (module-level constant)
- `crc32(data: Uint8Array): number` — iterate with table lookup, XOR init/final with `0xFFFFFFFF`

### Property-based tests:

- `crc32(data) === crc32(data)` for any `fc.uint8Array()`
- `crc32(data) >= 0 && crc32(data) < 2**32` for any data

---

## Step 5: `lru-cache.ts` — LRU Cache

**Create:** `src/domain/storage/lru-cache.ts`
**Test:** `test/unit/domain/storage/lru-cache.test.ts`

Generic data structure. No domain dependencies.

### Test first (red):

```
Given a new cache(100), When getting non-existent key, Then returns undefined
Given a new cache(100), When checking has for non-existent key, Then returns false
Given cache(100) with set('a', v, 50), When getting 'a', Then returns v
Given cache(100) with set('a', v, 50), When checking has('a'), Then returns true
Given cache(100) with set('a', v, 50), When checking currentSize, Then equals 50
Given cache(100) with set('a', v, 50), When checking entryCount, Then equals 1
Given cache(100) with set('a', v, 50), When checking maxSize, Then equals 100

// Eviction
Given cache(100) with entries totaling 100, When adding entry that pushes over 100, Then LRU entry evicted
Given cache(100) with A(40) then B(40) then C(40), When checking, Then A evicted, B and C remain
Given cache(100) with A(40) then B(40), When getting A then adding C(40), Then B evicted (A promoted by get)

// Size tracking
Given cache(100) with A(50), When updating A with byteSize 80, Then currentSize is 80 (not 130)
Given cache(100) with A(50) and B(30), When updating A with byteSize 90, Then B evicted, currentSize is 90

// Delete & clear
Given cache with entries, When deleting existing key, Then returns true and size decreases
Given cache with entries, When deleting non-existent key, Then returns false
Given cache with entries, When clearing, Then entryCount=0, currentSize=0
Given cleared cache, When getting previously set key, Then returns undefined

// Edge cases
Given cache(0), When setting any entry, Then entry is immediately evicted (no-op cache)
Given cache(0), When checking currentSize after set, Then equals 0
Given cache(50) with single 200-byte entry, When getting immediately after set, Then returns undefined (eviction runs during set, entry exceeds maxSize so it's evicted immediately)
Given set with byteSize=0, When calling, Then throws Error with message indicating byteSize must be positive (plain Error, not TsgitError — LruCache is a generic data structure with no domain dependency)

// has does not promote
Given cache(100) with A then B, When calling has(A) then adding C that evicts, Then A is evicted (has didn't promote)
```

### Implement (green):

- Internal `Node<V>` type: key, value, byteSize, prev, next
- Internal doubly-linked list: head (MRU), tail (LRU)
- `createLruCache<V>(maxSizeBytes: number): LruCache<V>` — closure over Map + list
- `get`: lookup + move to head
- `set`: validate `byteSize > 0`, update or insert, adjust `currentSize`, evict from tail
- `delete`: remove from map + list, adjust `currentSize`
- `clear`: reset everything

### Property-based tests:

- After any sequence of `set` operations with `fc.integer({ min: 1, max: 1000 })` for byteSize (not `fc.nat` — byteSize=0 throws), `currentSize <= maxSize` (for `maxSize >= 1`)
- After `set(k, v, s)` then `get(k)`, result is `v`
- After `clear()`, `entryCount === 0` and `currentSize === 0`
- `entryCount` always equals the number of distinct keys for which `get` returns non-undefined (testable from public API — the internal linked list is not accessible)

---

## Step 6: `pack-entry.ts` — Pack Entry Types & Header Codec

**Create:** `src/domain/storage/pack-entry.ts`
**Test:** `test/unit/domain/storage/pack-entry.test.ts`

Depends on: `ObjectId`, `HashConfig` (from `domain/objects/`), `error.ts` (step 2).

### Test first (red):

**Pack header:**
```
Given bytes with magic 'PACK' version 2 count 42, When parsing, Then version=2 objectCount=42
Given bytes with wrong magic, When parsing, Then throws INVALID_PACK_HEADER with reason containing 'magic'
Given bytes with version 3, When parsing, Then throws INVALID_PACK_HEADER with reason containing 'version'
Given bytes too short (< 12), When parsing, Then throws INVALID_PACK_HEADER with reason containing 'truncated'
Given version=2 objectCount=100, When serializing then parsing, Then roundtrips
```

**Entry header (type+size):**
```
Given byte 0b0_001_0101 (type=1/COMMIT, size=5, no continuation), When parsing at offset 0, Then type=1 size=5 dataOffset=1
Given byte 0b1_010_0011 + 0b0_0000010 (type=2/TREE, size=35), When parsing, Then type=2 size=35 dataOffset=2
Given multi-byte size spanning 3 bytes, When parsing, Then size correctly assembled from 4+7+7 bits
Given byte 0b0_011_1010 (type=3/BLOB, size=10), When parsing at offset 0, Then type=3 size=10 dataOffset=1
Given byte 0b0_100_0000 (type=4/TAG, size=0), When parsing at offset 0, Then type=4 size=0 dataOffset=1
Given type=6/OFS_DELTA with distance encoding, When parsing, Then type=6 baseDistance correct dataOffset correct
Given type=7/REF_DELTA with SHA1_CONFIG, When parsing, Then type=7 baseId extracted (20 bytes) dataOffset=header+20
Given type=7/REF_DELTA with SHA256_CONFIG, When parsing, Then baseId extracted (32 bytes) dataOffset=header+32
Given type=5 (reserved), When parsing, Then throws INVALID_PACK_ENTRY with reason 'reserved type 5'
Given truncated bytes 0b1_001_0000 with no continuation byte, When parsing, Then throws INVALID_PACK_ENTRY with reason 'unexpected end of header'
```

**encodePackEntryHeader:**
```
Given type=1 size=5, When encoding, Then single byte 0b0_001_0101
Given type=3 size=16, When encoding, Then two bytes (continuation needed for size > 15)
Given type=4 size=0, When encoding, Then single byte with size bits = 0
```

**encodeOfsDistance:**
```
Given distance=0, When encoding, Then single byte 0x00
Given distance=127, When encoding, Then single byte 0x7F
Given distance=128, When encoding, Then two bytes with continuation
Given large distance (e.g. 100000), When encoding then building a full OFS_DELTA entry header (prepend type=6 size=0 byte + encoded distance), then parsing via parsePackEntryHeader, Then baseDistance matches original
```

**packEntryTypeToObjectType:**
```
Given COMMIT(1), When mapping, Then returns 'commit'
Given TREE(2), When mapping, Then returns 'tree'
Given BLOB(3), When mapping, Then returns 'blob'
Given TAG(4), When mapping, Then returns 'tag'
Given OFS_DELTA(6), When mapping, Then returns undefined
Given REF_DELTA(7), When mapping, Then returns undefined
```

### Implement (green):

- `PACK_ENTRY_TYPE` const object + `PackEntryType` and `BasePackEntryType` types
- `PackEntryHeader` discriminated union (3 variants)
- `PackHeader` interface
- `parsePackHeader(bytes: Uint8Array): PackHeader`
- `serializePackHeader(version: number, objectCount: number): Uint8Array`
- `parsePackEntryHeader(bytes: Uint8Array, offset: number, hash: HashConfig): PackEntryHeader`
- `encodePackEntryHeader(type: PackEntryType, size: number): Uint8Array`
- `encodeOfsDistance(distance: number): Uint8Array` — the inverse of the decoding formula. The encoding must produce the bijective representation. Algorithm: emit lowest 7 bits, then while remaining value > 0, subtract 1 (inverse of the `+1` in decoding), shift right 7, emit next 7 bits with MSB set on all but the last byte. Bytes are emitted in big-endian order (most significant first).
- `packEntryTypeToObjectType(type: PackEntryType): ObjectType | undefined`

### Property-based tests:

- Pack header roundtrip: `parsePackHeader(serializePackHeader(2, n)) === { version: 2, objectCount: n }`
- Entry header roundtrip (base types only): `parsePackEntryHeader(encodePackEntryHeader(t, s), 0, SHA1_CONFIG)` preserves type and size for `t ∈ {1,2,3,4}` and `s ∈ [0, 2^32]`
- OFS distance roundtrip: for any `fc.integer({ min: 1, max: 2**32 })`, build a full OFS_DELTA entry header (type=6 size=0 byte + `encodeOfsDistance(d)`), parse with `parsePackEntryHeader`, verify `baseDistance === d`

---

## Step 7: `pack-index.ts` — Pack Index Parser & Lookup

**Create:** `src/domain/storage/pack-index.ts`
**Test:** `test/unit/domain/storage/pack-index.test.ts`
**Create:** `test/unit/domain/storage/arbitraries.ts` (shared arbitraries for storage tests)

Depends on: encoding utilities (direct import from `domain/objects/encoding.ts`), `error.ts`.

### Test first (red):

**parsePackIndex:**
```
Given a valid hand-crafted .idx v2 with 0 objects, When parsing, Then objectCount=0
Given a valid .idx v2 with 3 objects, When parsing, Then objectCount=3 and offsets computed correctly
Given wrong magic bytes, When parsing, Then throws INVALID_PACK_INDEX
Given version != 2, When parsing, Then throws INVALID_PACK_INDEX
Given non-monotonic fanout (fanout[i] > fanout[i+1]), When parsing, Then throws INVALID_PACK_INDEX
Given truncated file (too short for declared objectCount), When parsing, Then throws INVALID_PACK_INDEX
```

**lookupPackIndex:**
```
Given an index with 3 known objects, When looking up existing id, Then returns correct offset
Given an index with 3 known objects, When looking up non-existent id, Then returns undefined
Given an index with objects starting with byte 0x00, When looking up, Then fanout edge case (lo=0) works
Given an index with objects starting with byte 0xFF, When looking up, Then fanout edge case works
Given an index with large offsets (MSB set), When looking up, Then reads from 64-bit offset table
```

**findByPrefix:**
```
Given an index with 3 objects, When searching prefix matching exactly 1, Then returns array of 1
Given an index with 3 objects, When searching prefix matching 0, Then returns empty array
Given an index with objects sharing a prefix, When searching that prefix, Then returns all matches
Given prefix shorter than 4 chars, When searching, Then throws INVALID_PACK_INDEX
Given prefix longer than 40 chars, When searching, Then throws INVALID_PACK_INDEX
Given prefix with non-hex chars, When searching, Then throws INVALID_PACK_INDEX
Given odd-length prefix 'abc', When searching, Then correctly pads and searches
Given even-length prefix (e.g. 6 chars) matching 1 object, When searching, Then returns that object
Given full 40-char prefix, When searching, Then returns 0 or 1 match
```

### Implement (green):

- `PackIndex` interface (with `_bytes`, `_view`, computed offsets)
- `parsePackIndex(bytes: Uint8Array): PackIndex`
- `lookupPackIndex(index: PackIndex, id: ObjectId): number | undefined` — fanout + binary search
- `findByPrefix(index: PackIndex, prefix: string): ReadonlyArray<ObjectId>` — validate prefix, pad, bound search
- Internal helpers: `readFanout(index, byte)`, `compareShaAtIndex(index, i, targetBytes)`

### Create `test/unit/domain/storage/arbitraries.ts`:

- `arbHexPrefix(minLen?, maxLen?)` — generates valid hex prefixes (`[0-9a-f]{minLen..maxLen}`)
- Re-export `arbObjectId` from `../objects/arbitraries.js`
- `arbPackIndexInput(count?)` — generates sorted `{ id: ObjectId, offset: number, crc32: number }[]` (uses a plain inline type, not `PackIndexWriterEntry` which doesn't exist until Step 9)

### Helper: `buildTestIndex`

Create a test utility in `arbitraries.ts` that builds a valid `.idx` v2 `Uint8Array` from a list of `{ id: ObjectId, offset: number, crc32: number }`. This is ~50-70 lines — essentially a simplified index serializer needed before `serializePackIndex` exists (Step 9). Algorithm:
1. Sort entries by ObjectId (byte-level via `hexToBytes` + `compareBytes`)
2. Write 8-byte header: magic `0xff744f63` + version 2
3. Build 1024-byte fanout table: for each entry, increment `fanout[firstByte]` through `fanout[255]`
4. Write N × 20-byte sorted SHA-1 table (via `hexToBytes` for each id)
5. Write N × 4-byte CRC-32 table
6. Write N × 4-byte offset table (set MSB for offsets > 2^31, add large offset table if needed)
7. Write 40-byte trailer (20 zero bytes for pack checksum + 20 zero bytes for self-checksum)

This helper is used by all Step 7 unit tests and property-based tests. It is NOT a dependency on Step 9 — it's test-only code.

### Property-based tests:

- Roundtrip: `buildTestIndex(entries)` → `parsePackIndex` → `lookupPackIndex` finds every entry at correct offset
- For any `arbObjectId()` not in the index, `lookupPackIndex` returns `undefined`
- `findByPrefix` with full 40-char id returns same result as `lookupPackIndex` (0 or 1 match)

**Note:** The `serializePackIndex` → `parsePackIndex` roundtrip test is deferred to Step 9, where both functions are available. Step 7 uses `buildTestIndex` instead.

---

## Step 8: `delta.ts` — Delta Parser & Apply

**Create:** `src/domain/storage/delta.ts`
**Test:** `test/unit/domain/storage/delta.test.ts`

Depends on: `error.ts` only.

### Test first (red):

**applyDelta:**
```
Given base 'hello' and delta that copies all, When applying, Then result equals 'hello'
Given base 'hello world' and delta with COPY offset=6 size=5, When applying, Then result is 'world'
Given base and delta with INSERT of literal bytes, When applying, Then result contains inserted bytes
Given base and delta with mixed COPY + INSERT instructions, When applying, Then result matches expected
Given base and delta with COPY size=0 (→ 0x10000), When applying with base >= 64KB, Then copies 64KB
Given base < 64KB and delta with COPY 0x80 instruction, When applying, Then throws INVALID_DELTA (out of bounds)
Given delta with source length != base.length, When applying, Then throws INVALID_DELTA
Given delta with COPY offset+size > base.length, When applying, Then throws INVALID_DELTA
Given delta with COPY that overflows result buffer, When applying, Then throws INVALID_DELTA
Given delta with INSERT that overflows result buffer, When applying, Then throws INVALID_DELTA
Given delta with trailing bytes after result is full, When applying, Then throws INVALID_DELTA
Given delta with INSERT N=0, When applying, Then throws INVALID_DELTA
Given empty delta (sourceLength=0, targetLength=0, no instructions), When applying with empty base, Then returns empty Uint8Array
Given delta with sourceLength>0 targetLength>0 but no instructions, When applying, Then throws INVALID_DELTA (underfill)
Given delta with COPY spanning entire base (offset=0, size=base.length), When applying, Then result equals base
Given delta with multiple consecutive INSERT instructions, When applying, Then all literal data present
Given delta with instructions that partially fill target (e.g. COPY 5 bytes but targetLength=10), When applying, Then throws INVALID_DELTA (underfill — instructions present but result not complete)
```

**Test construction guidance:** Use the `buildDelta` helper (see below) to construct delta byte sequences. Example for "COPY offset=6 size=5 from 'hello world'":
```
sourceLength = 11 → encoded as [0x0B]
targetLength = 5  → encoded as [0x05]
COPY instruction: offset=6, size=5 → byte 0x91 (MSB=1, bit0=offset byte present, bit4=size byte present) + [0x06] (offset) + [0x05] (size)
Full delta: [0x0B, 0x05, 0x91, 0x06, 0x05]
```

**parseDelta:**
```
Given a delta with 1 COPY + 1 INSERT, When parsing, Then returns correct sourceLength, targetLength, and 2 instructions
Given a COPY instruction, When parsed, Then type='copy' with correct offset and size
Given an INSERT instruction, When parsed, Then type='insert' with correct data (copied, not subarray)
Given same delta, When parsed, Then InsertInstruction.data is independent copy (modify original → parse unaffected)
Given delta with INSERT N=0, When parsing, Then throws INVALID_DELTA (same as applyDelta)
```

**Biome complexity note:** `applyDelta` involves a loop with bit-testing branches (COPY/INSERT), nested bounds checks, and error throws. This may exceed Biome's `noExcessiveCognitiveComplexity` limit of 15. Plan for extraction into helpers: `decodeCopyInstruction(bytes, pos)`, `decodeInsertInstruction(bytes, pos)`, `validateCopyBounds(offset, size, baseLen, resultPos, targetLen)`. These reduce nesting and keep each function under the threshold.

### Helper: `buildDelta`

Create a test utility in `test/unit/domain/storage/arbitraries.ts` that builds a binary delta `Uint8Array` from a structured description:
```typescript
function buildDelta(
  sourceLength: number,
  targetLength: number,
  instructions: ReadonlyArray<
    | { type: 'copy'; offset: number; size: number }
    | { type: 'insert'; data: Uint8Array }
  >
): Uint8Array;
```

Algorithm:
1. Encode `sourceLength` and `targetLength` as LEB128-like variable-length integers
2. For each instruction:
   - COPY: set MSB=1, determine which offset/size bytes are needed (non-zero bytes), set selector bits, emit instruction byte + offset bytes + size bytes (little-endian)
   - INSERT: emit byte with MSB=0 and N in bits 6:0, then emit N literal bytes
3. Concatenate all bytes

This helper is used by all `applyDelta` and `parseDelta` tests to avoid hand-crafting binary delta buffers. The `arbDelta()` arbitrary uses `buildDelta` internally.

### Implement (green):

- Internal `readVariableLengthInt(bytes, offset): { value, nextOffset }` — LEB128-style for source/target lengths
- `applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array` — single-pass, bounds-checked
- `parseDelta(delta: Uint8Array): DeltaParsed` — materializes instructions, uses `slice()` for INSERT data
- `DeltaParsed`, `DeltaInstruction`, `CopyInstruction`, `InsertInstruction` types

### Property-based tests:

- `arbDelta()` arbitrary (defined in `test/unit/domain/storage/arbitraries.ts`) generates `{ base, delta, expected }` triples:
  - Generate random base bytes
  - Generate a sequence of COPY and INSERT instructions that produce a known target
  - Serialize into delta format
  - Verify `applyDelta(base, delta)` equals expected
- `applyDelta` result always has `length === targetLength` from the delta header
- `parseDelta(delta).sourceLength` matches the encoded source length

---

## Step 9: `pack-writer.ts` — Pack & Index Serialization

**Create:** `src/domain/storage/pack-writer.ts`
**Test:** `test/unit/domain/storage/pack-writer.test.ts`

Depends on: `pack-entry.ts` (step 6), `crc32.ts` (step 4), encoding utilities. Tests also import `parsePackIndex`/`lookupPackIndex` from step 7 for roundtrip verification.

### Test first (red):

**serializePackfile:**
```
Given 1 entry (BLOB, compressed data), When serializing, Then result.data starts with PACK header (magic+v2+count=1)
Given 1 entry, When serializing, Then result.data contains encoded type+size header followed by compressed data
Given 1 entry, When serializing, Then result.entries[0].offset equals 12 (pack header size)
Given 1 entry, When serializing, Then result.entries[0].crc32 equals crc32(header + compressedData)
Given 3 entries, When serializing, Then result.entries offsets are sequential and non-overlapping
Given 3 entries, When serializing, Then result.data can be parsed back: parsePackHeader gives count=3
Given 0 entries, When serializing, Then result.data is just the 12-byte pack header with count=0
Given entries, When serializing, Then result.data does NOT include trailing checksum
```

**serializePackIndex:**
```
Given 3 entries with known ObjectIds, When serializing, Then starts with magic 0xff744f63 + version 2
Given 3 entries, When serializing, Then fanout table has correct cumulative counts
Given 3 entries, When serializing, Then SHA table is sorted
Given 3 entries, When serializing, Then CRC-32 table matches entry order (after sort)
Given 3 entries, When serializing, Then offset table matches entry order (after sort)
Given entry with offset > 2^31, When serializing, Then small offset has MSB set and large offset table present
Given packChecksum of wrong length, When serializing, Then throws INVALID_PACK_INDEX
Given 0 entries, When serializing, Then produces valid index with objectCount=0
Given 3 known entries, When serializing then appending 20-byte placeholder checksum then parsing with parsePackIndex, Then lookupPackIndex finds each entry at correct offset (deterministic roundtrip)
```

### Implement (green):

- `PackWriterEntry`, `PackEntryMeta`, `PackfileResult`, `PackIndexWriterEntry` types
- `serializePackfile(entries): PackfileResult` — write header, encode each entry, compute CRC + offset
- `serializePackIndex(entries, packChecksum): Uint8Array` — sort, build fanout, write all sections

### Property-based tests:

- Roundtrip: serialize pack entries → parse header → verify count matches
- Roundtrip: `serializePackIndex(entries, checksum)` → append 20-byte placeholder → `parsePackIndex` → `lookupPackIndex` finds every entry at correct offset (this is the full roundtrip deferred from Step 7 — now both `serializePackIndex` and `parsePackIndex` are available)
- CRC-32 values in `PackfileResult.entries` match independently computed `crc32(header + compressedData)` for each entry

---

## Step 10: Barrel Export & Final Verification

**Create:** `src/domain/storage/index.ts`
**Modify:** `src/domain/index.ts`

### Actions:

1. Create `src/domain/storage/index.ts` — barrel exporting all public types and functions:
   - From `loose-path.ts`: `computeLooseObjectPath`
   - From `pack-index.ts`: `PackIndex`, `parsePackIndex`, `lookupPackIndex`, `findByPrefix`
   - From `pack-entry.ts`: `PACK_ENTRY_TYPE`, `PackEntryType`, `BasePackEntryType`, `PackEntryHeader`, `BasePackEntryHeader`, `OfsPackEntryHeader`, `RefPackEntryHeader`, `PackHeader`, `parsePackHeader`, `serializePackHeader`, `parsePackEntryHeader`, `encodePackEntryHeader`, `encodeOfsDistance`, `packEntryTypeToObjectType`
   - From `delta.ts`: `DeltaParsed`, `DeltaInstruction`, `CopyInstruction`, `InsertInstruction`, `applyDelta`, `parseDelta`
   - From `lru-cache.ts`: `LruCache`, `createLruCache`
   - From `crc32.ts`: `crc32`
   - From `pack-writer.ts`: `PackWriterEntry`, `PackEntryMeta`, `PackfileResult`, `PackIndexWriterEntry`, `serializePackfile`, `serializePackIndex`
   - From `error.ts`: `StorageError`, `invalidPackHeader`, `invalidPackIndex`, `invalidPackEntry`, `invalidDelta`

2. Update `src/domain/index.ts`:
   - Add `export * from './storage/index.js'`

### Verify:

```bash
npm run validate   # Full quality gate
```

All checks must pass: types, lint, format, architecture, unit tests, coverage (100%).

**Interop tests (design §14.4):** Deferred to Phase 7 integration tests. Interop tests require reading real `.pack`/`.idx` files from disk (via `FileSystem` port), decompressing entries (via `Compressor` port), and verifying against `git cat-file`. These depend on ports not yet defined. Phase 2 unit tests use hand-crafted binary fixtures and property-based generation instead.

---

## Step 11: Mutation Testing & Branch Finalization

**Not a code step** — this is the finalization workflow per CLAUDE.md §5.

1. Run `npx stryker run` — fix surviving mutants, accept only provably equivalent ones
2. Run in parallel: code review, security review, performance review, test review agents
3. Update docs: BACKLOG.md (mark 2.1–2.8 as done), design doc (add post-implementation notes)
4. Squash-and-merge to main
5. Cleanup: delete feature branch and worktree

---

## Dependency Graph

Source code import dependencies traced per step:

- **Step 2** (StorageError): depends on Step 1
- **Step 3** (loose-path): depends on Step 1 (ObjectId from objects, no storage deps)
- **Step 4** (crc32): depends on nothing (self-contained)
- **Step 5** (lru-cache): depends on nothing (self-contained)
- **Step 6** (pack-entry): depends on Step 2 (error factories) + ObjectId/HashConfig from objects
- **Step 7** (pack-index): depends on Step 2 (error factories) + encoding from objects. Does NOT depend on Step 6.
- **Step 8** (delta): depends on Step 2 (error factories)
- **Step 9** (pack-writer): source depends on Steps 4 + 6. Tests also use Step 7.

```
Step 0  (setup)
  │
  ▼
Step 1  (extract TsgitError)
  │
  ├──────────────┬──────────────┬──────────────┐
  ▼              ▼              ▼              ▼
Step 2         Step 3         Step 4         Step 5
(StorageError) (loose-path)   (crc32)        (lru-cache)
  │
  ├──────────────┬──────────────┐
  ▼              ▼              ▼
Step 6         Step 7         Step 8
(pack-entry)   (pack-index)   (delta)
  │              │
  └──────┬───────┘
         ▼
       Step 9  (pack-writer) ← also depends on step 4 (crc32)
         │
         ▼
       Step 10 (barrel + verify)
         │
         ▼
       Step 11 (mutations + finalize)
```

**Parallelizable groups:**
- After step 1: steps 2, 3, 4, 5 can all run in parallel
- After step 2: steps 6, 7, 8 can all run in parallel
- Step 9 waits for steps 4, 6, 7 (source deps on 4+6, test dep on 7)
- Steps 3 and 5 have no downstream dependents within Phase 2 — they can complete independently
