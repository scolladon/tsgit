# Design: Object Storage

**Status: Proposed** — Phase 2 of the [backlog](../BACKLOG.md).

### Review Notes

Changes from initial design after architecture, codebase consistency, and binary format reviews:

- **Pack index v2 scoped to SHA-1 only.** SHA-256 repos use index v3, a fundamentally different format. Removed `HashConfig` parameterization from pack index parsing and lookup. v3 support deferred to a future phase.
- **Error extension via layered union (not Option B).** `TsgitError` extracted to `domain/error.ts` with an aggregate `TsgitErrorData` union, preserving compile-time exhaustiveness. Each phase module contributes its own union type. See ADR `docs/adr/003-error-extension-strategy.md`.
- **`OBJECT_NOT_FOUND` and `AMBIGUOUS_SHORT_SHA` moved to Phase 7.** No Phase 2 function produces these — they are lookup pipeline concerns.
- **Redundant `hash` parameter removed** from `lookupPackIndex` and `findByPrefix` — `PackIndex` already contains its config.
- **CRC-32 scope corrected.** Covers the entire packed entry (header + base reference + compressed data), not just the compressed portion.
- **`baseOffset` renamed to `baseDistance`** to avoid confusion between "negative offset" and a positive distance value.
- **`PackWriterEntry.type` restricted to base types** (`1 | 2 | 3 | 4`) at compile time.
- **Parse/serialize pairs co-located** in `pack-entry.ts` (pack header + entry header). Removed duplicate `encodeVariableLengthSize` from `pack-writer.ts`.
- **Prefix validation rules** documented for `findByPrefix`.
- **`compareBytes` import path** documented — `domain/storage/` imports directly from `domain/objects/encoding.ts`, not the barrel.
- **Property-based test fixed** — pack entry header roundtrip restricted to base types (1–4).

Changes from second deep review:

- **Delta bounds checking added (§8.4).** COPY must validate `offset + size <= base.length` and `resultPosition + size <= targetLength`. INSERT must validate `resultPosition + N <= targetLength`. Trailing delta bytes after instructions fill the target are an error.
- **`serializePackfile` returns `PackfileResult`** with per-entry CRC-32 and offset metadata. Fixes design gap where caller had no way to obtain CRCs or offsets needed for `PackIndexWriterEntry`.
- **LRU cache `set` semantics clarified (§9.3).** Updating existing key subtracts old `byteSize` and adds new. `byteSize` must be > 0. `maxSize = 0` creates a no-op cache.
- **Error architecture diagram corrected (§12.3).** Acknowledges source-level bidirectional `import type` dependency, documents why it's safe at runtime (`verbatimModuleSyntax` erasure), and notes dependency-cruiser config change needed.
- **InsertInstruction.data uses `slice()` not `subarray()`** — allows GC of the delta buffer.
- **Empty delta validity clarified** — only `sourceLength = 0, targetLength = 0` with no instructions is valid.
- **Concurrency note added (§9.5)** — LRU cache is safe for single-threaded JavaScript.

---

## 1. Overview

Phase 2 adds the storage layer for reading and writing git objects. Git uses two storage mechanisms:

1. **Loose objects** — individual files at `.git/objects/xx/yyy...`, zlib-compressed `header || content`
2. **Packed objects** — multiple objects concatenated in `.pack` files with companion `.idx` index files

This phase implements the **domain-layer** binary format parsing and algorithms:
- Loose object path computation
- Pack index (`.idx` v2, SHA-1 only) parsing and fanout binary search
- Packfile (`.pack` v2) entry header parsing
- Delta instruction parsing and application (OBJ_OFS_DELTA, OBJ_REF_DELTA)
- LRU cache for delta base objects
- CRC-32 checksum (for pack entry integrity)
- Packfile and index serialization

All code is pure — no I/O, no compression, no hashing. Functions accept `Uint8Array` (already read/decompressed by the caller) and return parsed types or serialized bytes. The actual file I/O, zlib compression, and SHA computation happen through ports (Phase 4) wired by application primitives (Phase 7).

**SHA-256 scope:** The packfile format (`.pack` v2) works with any hash length — `parsePackEntryHeader` accepts `HashConfig` for REF_DELTA entries. The pack index format (`.idx` v2) is SHA-1 only. SHA-256 repositories use `.idx` v3 (a different format), deferred to a future phase.

---

## 2. Module Structure

```
src/domain/
├── error.ts               # TsgitError class + TsgitErrorData aggregate union (extracted from objects/)
├── objects/
│   ├── error.ts           # DomainObjectError union + factory functions (TsgitError import from ../error.ts)
│   └── ...
└── storage/
    ├── loose-path.ts      # Loose object path computation
    ├── pack-index.ts      # .idx v2 format parser + fanout lookup + prefix search
    ├── pack-entry.ts      # Pack entry type enum + pack/entry header codec
    ├── delta.ts           # Delta instruction parser + applyDelta
    ├── lru-cache.ts       # Generic LRU cache bounded by byte size
    ├── crc32.ts           # CRC-32 (ISO 3309) pure implementation
    ├── pack-writer.ts     # .pack + .idx serialization
    ├── error.ts           # StorageError union + factory functions
    └── index.ts           # Barrel export
```

---

## 3. Domain Boundary

Phase 2 sits in the domain layer. **No I/O dependencies.**

| Concern | Who handles it | Phase |
|---------|---------------|-------|
| Binary format parsing (`.idx`, `.pack` headers, delta instructions) | Domain (this phase) | 2 |
| Loose object path computation | Domain (this phase) | 2 |
| CRC-32 checksum | Domain (this phase) | 2 |
| LRU cache data structure | Domain (this phase) | 2 |
| File reads/writes | `FileSystem` port | 4 |
| Zlib compress/decompress | `Compressor` port | 4 |
| SHA-1/SHA-256 hashing | `HashService` port | 4 |
| Object lookup pipeline (loose → packed) | `readObject` primitive | 7 |
| Full packfile assembly with compression | `writePackfile` primitive | 7 |

**Dependency direction:** `domain/storage/` is a sibling module that depends on `domain/objects/` (imports ObjectId, HashConfig, ObjectType). Both depend on `domain/error.ts` (TsgitError class). Nothing imports from `domain/storage/` within the domain.

**Import paths for encoding utilities:** `domain/storage/` modules import `compareBytes`, `hexToBytes`, `bytesToHex`, and other encoding utilities directly from `domain/objects/encoding.ts` (not the barrel). These functions are intentionally not barrel-exported by Phase 1 (they are internal to the objects module). Cross-module direct imports within `domain/` are acceptable — the barrel boundary is for consumers outside `domain/`.

**Integration:** After Phase 2, `domain/index.ts` must be updated to also re-export from `./storage/index.js`.

---

## 4. Types

### 4.1 PackEntryType

Pack entries use a 3-bit type field (values 1–4 for base objects, 6–7 for deltas). Type 5 is reserved and unused.

```typescript
const PACK_ENTRY_TYPE = {
  COMMIT: 1,
  TREE: 2,
  BLOB: 3,
  TAG: 4,
  // 5 is reserved
  OFS_DELTA: 6,
  REF_DELTA: 7,
} as const;

type PackEntryType = (typeof PACK_ENTRY_TYPE)[keyof typeof PACK_ENTRY_TYPE];

/** Base object types only (no deltas). Used by PackWriterEntry. */
type BasePackEntryType =
  | typeof PACK_ENTRY_TYPE.COMMIT
  | typeof PACK_ENTRY_TYPE.TREE
  | typeof PACK_ENTRY_TYPE.BLOB
  | typeof PACK_ENTRY_TYPE.TAG;
```

### 4.2 PackEntryHeader

Discriminated union — the discriminant is the `type` field. Delta entries carry additional fields for their base reference.

```typescript
type PackEntryHeader =
  | BasePackEntryHeader
  | OfsPackEntryHeader
  | RefPackEntryHeader;

interface BasePackEntryHeader {
  readonly type: typeof PACK_ENTRY_TYPE.COMMIT
    | typeof PACK_ENTRY_TYPE.TREE
    | typeof PACK_ENTRY_TYPE.BLOB
    | typeof PACK_ENTRY_TYPE.TAG;       // 1 | 2 | 3 | 4
  readonly size: number;                 // Uncompressed data size
  readonly dataOffset: number;           // Byte offset where compressed data starts
}

interface OfsPackEntryHeader {
  readonly type: typeof PACK_ENTRY_TYPE.OFS_DELTA;  // 6
  readonly size: number;                 // Uncompressed delta instructions size
  readonly dataOffset: number;           // Byte offset where compressed delta starts
  readonly baseDistance: number;         // Bytes backward from this entry to base entry (always positive)
}

interface RefPackEntryHeader {
  readonly type: typeof PACK_ENTRY_TYPE.REF_DELTA;  // 7
  readonly size: number;                 // Uncompressed delta instructions size
  readonly dataOffset: number;           // Byte offset where compressed delta starts
  readonly baseId: ObjectId;             // SHA of the base object
}
```

**`size`** is the uncompressed size of the data following the header. For base objects (types 1–4), this is the object content size. For delta objects (types 6–7), this is the size of the delta instruction sequence.

**`dataOffset`** is the absolute byte offset within the `.pack` file where the zlib-compressed data begins. The caller reads bytes from `dataOffset` to the next entry (obtained from the pack index) and decompresses them.

**`baseDistance`** (OFS_DELTA only) is the number of bytes backward from the start of _this_ entry to the start of the _base_ entry. The base entry's absolute offset = `thisEntryOffset - baseDistance`. Always a positive integer.

### 4.3 PackIndex

Zero-copy structure — keeps a reference to the raw `.idx` bytes and a `DataView` for integer reads. Lookup functions read directly from the buffer without materializing arrays.

**The `.idx` v2 format is SHA-1 only.** SHA-256 repositories use `.idx` v3 (deferred).

```typescript
interface PackIndex {
  readonly objectCount: number;
  // Pre-computed section offsets (derived from objectCount):
  readonly crc32TableOffset: number;
  readonly smallOffsetsTableOffset: number;
  readonly largeOffsetsTableOffset: number;
  readonly trailerOffset: number;
  // Internal — used by lookup functions in the same module:
  readonly _bytes: Uint8Array;            // Raw .idx file bytes (zero-copy reference)
  readonly _view: DataView;               // For big-endian integer reads
}
```

The `_bytes` and `_view` fields are module-internal implementation details. Consumers should not access them directly — use `lookupPackIndex` and `findByPrefix` instead.

Section offsets follow the v2 layout (see §6.1). Fixed offsets are constants:

```typescript
const IDX_MAGIC = 0xff744f63;            // "\377tOc"
const IDX_VERSION = 2;
const IDX_HEADER_SIZE = 8;               // magic (4) + version (4)
const IDX_FANOUT_SIZE = 1024;            // 256 × 4 bytes
const IDX_SHA_TABLE_OFFSET = 1032;       // IDX_HEADER_SIZE + IDX_FANOUT_SIZE
const IDX_SHA_LENGTH = 20;              // SHA-1 only for v2
```

Variable offsets (SHA-1 hardcoded, `H = 20`):

```
crc32TableOffset        = IDX_SHA_TABLE_OFFSET + objectCount × 20
smallOffsetsTableOffset = crc32TableOffset + objectCount × 4
largeOffsetsTableOffset = smallOffsetsTableOffset + objectCount × 4
trailerOffset           = (file length) − 40    (2 × 20 bytes)
```

**Why zero-copy?** Pack indices can be large (>100 MB for repos with millions of objects). Materializing arrays would double memory usage. DataView reads are fast and avoid allocation.

**GC trade-off:** The `_bytes` array holds a reference to the original buffer, preventing GC. For long-lived processes, callers who no longer need the index should release the reference.

### 4.4 DeltaParsed

Materialized representation of parsed delta instructions. Used for testing and inspection.

```typescript
interface DeltaParsed {
  readonly sourceLength: number;   // Expected base object length
  readonly targetLength: number;   // Expected result length after applying delta
  readonly instructions: ReadonlyArray<DeltaInstruction>;
}

type DeltaInstruction =
  | CopyInstruction
  | InsertInstruction;

interface CopyInstruction {
  readonly type: 'copy';
  readonly offset: number;         // Byte offset into base object
  readonly size: number;           // Number of bytes to copy
}

interface InsertInstruction {
  readonly type: 'insert';
  readonly data: Uint8Array;       // Literal bytes to insert
}
```

### 4.5 LruCache

Generic bounded cache for delta base objects. Evicts least-recently-used entries when byte budget is exceeded.

```typescript
interface LruCache<V> {
  /** Get a value, promoting it to most-recently-used. */
  get(key: string): V | undefined;
  /** Set a value with its byte cost. Evicts LRU entries if over budget. */
  set(key: string, value: V, byteSize: number): void;
  /** Check existence without promoting. */
  has(key: string): boolean;
  /** Remove a specific entry. */
  delete(key: string): boolean;
  /** Remove all entries. */
  clear(): void;
  /** Current byte usage. */
  readonly currentSize: number;
  /** Configured byte limit. */
  readonly maxSize: number;
  /** Number of cached entries. */
  readonly entryCount: number;
}
```

Key type is `string` because `ObjectId` is a branded string — `Map<string, ...>` works directly.

---

## 5. Loose Object Path

Loose objects are stored as individual files under `.git/objects/`. The path is derived from the hex SHA:

```
.git/objects/ab/cdef0123456789...
             ^^  ^^^^^^^^^^^^^^
             |   remaining hex chars
             first 2 hex chars (directory)
```

```typescript
function computeLooseObjectPath(id: ObjectId): string;
// Returns relative path: "ab/cdef0123456789..."
// Caller prepends the .git/objects/ base path
```

**SHA-256 note:** SHA-256 produces 64 hex chars instead of 40. The same `xx/yyy...` split works. No special handling needed.

---

## 6. Pack Index Format (`.idx` v2, SHA-1 only)

### 6.1 Binary Layout

The `.idx` v2 file has a fixed structure with six sections. All SHA values are 20 bytes (SHA-1). SHA-256 uses `.idx` v3, which is a different format not covered here.

```
┌──────────────────────────────────────────────────────┐
│ Header                                    8 bytes    │
│   Magic: 0xff 0x74 0x4f 0x63 ("\377tOc")  4 bytes    │
│   Version: 2 (big-endian uint32)          4 bytes    │
├──────────────────────────────────────────────────────┤
│ Fanout Table                              1024 bytes │
│   256 × big-endian uint32                            │
│   fanout[i] = cumulative count of objects            │
│               with first SHA byte ≤ i                │
│   fanout[255] = total object count (N)               │
├──────────────────────────────────────────────────────┤
│ SHA-1 Table                              N × 20 bytes│
│   N × 20-byte SHA-1 values, sorted                   │
├──────────────────────────────────────────────────────┤
│ CRC-32 Table                              N × 4 bytes│
│   N × big-endian uint32 CRC-32 checksums             │
│   CRC-32 of the entire packed entry (type+size       │
│   header, optional base reference, compressed data)  │
├──────────────────────────────────────────────────────┤
│ Small Offsets Table                       N × 4 bytes│
│   N × big-endian uint32 pack file offsets            │
│   If MSB (bit 31) is set: value & 0x7FFFFFFF is an   │
│   index into the Large Offsets Table                 │
├──────────────────────────────────────────────────────┤
│ Large Offsets Table (optional)            M × 8 bytes│
│   M × big-endian uint64 offsets (for packs > 2 GB)   │
│   Only present when any small offset has MSB set     │
├──────────────────────────────────────────────────────┤
│ Trailer                                   40 bytes   │
│   20-byte SHA-1 of the .pack file                    │
│   20-byte SHA-1 of this .idx file (all bytes above)  │
└──────────────────────────────────────────────────────┘
```

### 6.2 Parsing

```typescript
function parsePackIndex(bytes: Uint8Array): PackIndex;
```

**Algorithm:**
1. Validate magic number at bytes 0–3 (must be `0xff744f63`)
2. Validate version at bytes 4–7 (must be `2`)
3. Read `objectCount = fanout[255]` at offset `8 + 255 × 4`
4. Compute section offsets from `objectCount` (SHA-1 hardcoded, 20 bytes per hash)
5. Validate total file size matches expected layout size
6. Return `PackIndex` with raw bytes and pre-computed offsets

**Validation checks:**
- Magic number match
- Version = 2
- Fanout table is monotonically non-decreasing: `fanout[i] ≤ fanout[i+1]`
- File size ≥ minimum expected size (header + fanout + SHA table + CRC32 + offsets + trailer)

### 6.3 Fanout Lookup

Given an `ObjectId`, find its pack file offset (or `undefined` if not in this pack).

```typescript
function lookupPackIndex(index: PackIndex, id: ObjectId): number | undefined;
```

**Algorithm:**
1. Convert `id` to raw bytes via `hexToBytes(id)` (one-time allocation)
2. Read the first byte `b` of the target SHA
3. Read `lo = (b === 0) ? 0 : fanout[b - 1]` and `hi = fanout[b]` from the fanout table
4. Binary search the SHA-1 table between indices `lo` (inclusive) and `hi` (exclusive)
   - Each entry is 20 bytes at `IDX_SHA_TABLE_OFFSET + i × 20`
   - Compare using `compareBytes` (byte-level memcmp)
5. If found at index `i`:
   - Read the 32-bit offset at `smallOffsetsTableOffset + i × 4`
   - If MSB is set: read the 64-bit offset from the large offsets table
   - Return the offset
6. If not found: return `undefined`

**Complexity:** O(log(N/256)) comparisons on average, where N is the total object count. The fanout table narrows the binary search to ~1/256th of the entries.

### 6.4 Prefix Search (Short SHA Disambiguation)

Given a partial hex prefix (e.g., `"abc12"`), find all matching ObjectIds in this pack index.

```typescript
function findByPrefix(
  index: PackIndex,
  prefix: string
): ReadonlyArray<ObjectId>;
```

**Validation rules:**
- Minimum prefix length: 4 hex chars (matches git's minimum)
- Maximum prefix length: 40 hex chars (full SHA-1)
- Must contain only valid hex characters (`[0-9a-f]`)
- Throws `INVALID_PACK_INDEX` on invalid prefix

**Algorithm:**
1. Pad `prefix` with `'0'`s to 40 chars → `lowerHex`
2. Pad `prefix` with `'f'`s to 40 chars → `upperHex`
3. Convert both to 20-byte arrays: `lowerBytes`, `upperBytes`
4. Use first byte to narrow via fanout (same as §6.3)
5. Binary search for lower bound: first index `≥ lowerBytes`
6. Binary search for upper bound: first index `> upperBytes`
7. Collect all SHA entries between lower and upper bound
8. Convert each to hex via `bytesToHex`, return as `ObjectId` array

**Edge case:** Prefix may have odd length (e.g., `"abc"` = 1.5 bytes). Pad to even length before converting to bytes: `"abc"` → `"abc0"` (lower) / `"abcf"` (upper), then pad to 40 chars.

---

## 7. Packfile Format (`.pack` v2)

### 7.1 File Structure

```
┌──────────────────────────────────────────────────────┐
│ Header                                    12 bytes   │
│   Magic: "PACK" (0x5041434b)              4 bytes    │
│   Version: 2 (big-endian uint32)          4 bytes    │
│   Object count (big-endian uint32)        4 bytes    │
├──────────────────────────────────────────────────────┤
│ Entry 0                                   variable   │
│   Variable-length type+size header                   │
│   [OFS_DELTA: variable-length base distance]         │
│   [REF_DELTA: 20-byte base SHA-1]                    │
│   Zlib-compressed data                               │
├──────────────────────────────────────────────────────┤
│ Entry 1                                   variable   │
│ ...                                                  │
│ Entry N−1                                 variable   │
├──────────────────────────────────────────────────────┤
│ Trailer                                   20 bytes   │
│   SHA-1 checksum of all preceding bytes              │
└──────────────────────────────────────────────────────┘
```

### 7.2 Pack File Header

```typescript
interface PackHeader {
  readonly version: number;
  readonly objectCount: number;
}

function parsePackHeader(bytes: Uint8Array): PackHeader;
function serializePackHeader(version: number, objectCount: number): Uint8Array;
```

Both functions live in `pack-entry.ts` to keep the parse/serialize pair co-located.

**Validation:**
- Bytes 0–3 must be `"PACK"` (`0x5041434b`)
- Version must be `2`
- Object count is at bytes 8–11, big-endian uint32

### 7.3 Entry Header Encoding

The type and uncompressed size are encoded in a variable-length integer:

```
Byte 0: [C][TTT][SSSS]
         │   │     └── size bits 3:0 (4 bits)
         │   └── type (3 bits)
         └── continuation flag (1 = more bytes follow)

Byte 1+: [C][SSSSSSS]
          │     └── next 7 size bits
          └── continuation flag
```

**Decoding algorithm:**

```
type  = (byte0 >> 4) & 0x07
size  = byte0 & 0x0F
shift = 4
while (byte has MSB set):
  read next byte
  size |= (byte & 0x7F) << shift
  shift += 7
```

**Size limits:** JavaScript `number` supports up to 2^53 − 1. The variable-length encoding can represent arbitrarily large sizes, but in practice git objects rarely exceed a few GB. Using `number` is safe for all realistic sizes.

### 7.4 OFS_DELTA Distance Encoding

After the type+size header, OFS_DELTA entries encode the distance backward to their base:

```
Byte 0: [C][DDDDDDD]
         │     └── distance bits 6:0
         └── continuation flag

Byte 1+: [C][DDDDDDD]
          │     └── next 7 distance bits
          └── continuation flag

Decoding: distance = byte0 & 0x7F
          for each continuation byte:
            distance = ((distance + 1) << 7) | (byte & 0x7F)
```

**Note:** The `+1` before shifting is critical — it ensures the encoding is bijective (each value has exactly one representation). This differs from standard LEB128.

The result is the number of bytes backward from the _start of this entry_ to the _start of the base entry_. Base absolute offset = `thisEntryOffset - baseDistance`.

### 7.5 Entry Parsing

```typescript
function parsePackEntryHeader(
  bytes: Uint8Array,
  offset: number,
  hash: HashConfig
): PackEntryHeader;
```

`HashConfig` is needed because REF_DELTA entries read `hash.digestLength` bytes for the base SHA (20 for SHA-1, 32 for SHA-256). The packfile format itself supports both hash lengths.

**Algorithm:**
1. Read the variable-length type+size encoding starting at `offset`
2. Based on type:
   - Types 1–4 (base objects): `dataOffset` = current position
   - Type 6 (OFS_DELTA): read the variable-length base distance, then `dataOffset` = current position
   - Type 7 (REF_DELTA): read `hash.digestLength` bytes as base SHA, then `dataOffset` = current position
3. Return the appropriate `PackEntryHeader` variant

**The function does NOT decompress the entry data.** It only parses the uncompressed header bytes to determine the entry type, size, and where the compressed data begins. The caller:
1. Knows the entry boundaries (from the pack index, or by decompressing through)
2. Decompresses the data at `dataOffset`
3. For base objects: the decompressed data is the object content
4. For delta objects: the decompressed data is the delta instruction sequence (§8)

### 7.6 Mapping Pack Entry Types to Object Types

```typescript
function packEntryTypeToObjectType(type: PackEntryType): ObjectType | undefined;
```

Maps types 1–4 to `'commit'`, `'tree'`, `'blob'`, `'tag'`. Returns `undefined` for delta types (6, 7) since deltas resolve to a base type.

---

## 8. Delta Resolution

Git uses delta compression to reduce pack file size. A delta object stores instructions to reconstruct a target object from a base object. Delta chains can be multiple levels deep: delta → delta → ... → base.

### 8.1 Delta Format

```
┌──────────────────────────────────────────────────────┐
│ Source length          variable-length integer        │
│ Target length          variable-length integer        │
├──────────────────────────────────────────────────────┤
│ Instructions           repeated until end of data    │
│   COPY  (MSB=1) or INSERT (MSB=0)                   │
└──────────────────────────────────────────────────────┘
```

The source and target lengths use standard LEB128-like encoding:

```
Byte 0: [C][VVVVVVV]     7 value bits
Byte 1: [C][VVVVVVV]    next 7 value bits
...
C=0 terminates.
```

### 8.2 COPY Instruction

Copies a range of bytes from the base (source) object to the target.

```
Byte 0: [1][SSS][OOOO]
         │   │     └── which offset bytes are present (bits 0-3)
         │   └── which size bytes are present (bits 4-6)
         └── instruction type marker (always 1 for COPY)

Offset bytes (0-4 present, little-endian):
  bit 0 set → read 1 byte → offset bits 7:0
  bit 1 set → read 1 byte → offset bits 15:8
  bit 2 set → read 1 byte → offset bits 23:16
  bit 3 set → read 1 byte → offset bits 31:24

Size bytes (0-3 present, little-endian):
  bit 4 set → read 1 byte → size bits 7:0
  bit 5 set → read 1 byte → size bits 15:8
  bit 6 set → read 1 byte → size bits 23:16

Defaults: offset = 0 when no offset bits set.
          size = 0x10000 (65536) when size decodes to 0.
```

**If size is 0 after decoding, it means 0x10000** (64 KB). This conversion applies whenever size decodes to 0, regardless of whether any size bits were present. The instruction byte `0x80` (all selector bits zero) copies 64 KB from offset 0.

### 8.3 INSERT Instruction

Inserts literal bytes into the target.

```
Byte 0: [0][NNNNNNN]
         │     └── number of bytes to insert (1-127)
         └── instruction type marker (always 0 for INSERT)

Followed by exactly N bytes of literal data.
```

**N must be 1–127.** A value of 0 is reserved and invalid.

### 8.4 Apply Algorithm

```typescript
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array;
```

**Algorithm:**
1. Parse `sourceLength` and `targetLength` from the delta header
2. Validate `base.length === sourceLength` (mismatch → `INVALID_DELTA`)
3. Allocate result buffer of `targetLength` bytes
4. Process instructions sequentially until delta bytes are consumed:
   - **COPY:** read offset + size, then:
     - Validate `offset + size <= base.length` (out-of-bounds read → `INVALID_DELTA`)
     - Validate `resultPosition + size <= targetLength` (result overflow → `INVALID_DELTA`)
     - Copy `base[offset..offset+size]` to `result[resultPosition..resultPosition+size]`
   - **INSERT:** read N, then:
     - Validate `resultPosition + N <= targetLength` (result overflow → `INVALID_DELTA`)
     - Copy next N literal bytes from the delta stream to `result[resultPosition..resultPosition+N]`
5. Validate no unprocessed bytes remain in the delta stream (trailing bytes → `INVALID_DELTA`)
6. Validate `resultPosition === targetLength` (underfill → `INVALID_DELTA`)
7. Return result buffer

**Bounds checking rationale:** A malformed delta can specify COPY ranges past the end of the base buffer. In JavaScript, `Uint8Array` access beyond bounds silently returns `undefined` → `0`, producing corrupted output instead of a clear error. Git's `patch-delta.c` validates `cp_off + cp_size <= src_size`. We match this with explicit bounds checks that throw `INVALID_DELTA`.

**Why single-pass allocation?** We know `targetLength` upfront from the delta header — one allocation, no resizing. This is a performance advantage over streaming approaches.

**Empty delta:** A delta with `sourceLength = 0, targetLength = 0` and no instructions is valid — it represents an empty object derived from an empty base. A delta with `sourceLength > 0, targetLength > 0` but no instructions is invalid (step 6 fails because `resultPosition = 0 ≠ targetLength`).

### 8.5 Materialized Parsing

For testing and debugging, a separate function parses delta instructions into a structured representation:

```typescript
function parseDelta(delta: Uint8Array): DeltaParsed;
```

Returns a `DeltaParsed` (§4.4) with the source/target lengths and instruction list. `applyDelta` does NOT call this internally — it processes instructions in a single pass for performance.

**`InsertInstruction.data` allocation:** `parseDelta` uses `delta.slice()` (copy) for `InsertInstruction.data`, not `delta.subarray()` (zero-copy view). This allows the original delta buffer to be garbage collected. The `applyDelta` function does not allocate instruction objects at all — it copies INSERT bytes directly from the delta stream to the result buffer.

### 8.6 Iterative Delta Resolution

Delta chains can be multiple levels deep. The resolution algorithm MUST be iterative, not recursive, to avoid stack overflow on deep chains.

**Algorithm** (implemented in the application layer, using domain functions):

```
function resolveObject(packData, entryOffset, index, cache):
  stack = []
  currentOffset = entryOffset

  // Phase 1: Walk the chain, collecting entries to resolve
  while true:
    header = parsePackEntryHeader(packData, currentOffset)
    if header.type is base (1-4):
      decompress entry data → baseContent
      break
    if header.type is REF_DELTA:
      stack.push(header)
      currentOffset = lookupInIndex(header.baseId)
    if header.type is OFS_DELTA:
      stack.push(header)
      currentOffset = currentOffset - header.baseDistance

  // Phase 2: Apply deltas bottom-up
  result = baseContent
  while stack is not empty:
    deltaHeader = stack.pop()
    decompress delta data → deltaInstructions
    result = applyDelta(result, deltaInstructions)
    cache.set(deltaHeader, result, result.byteLength)

  return result
```

**Note:** This orchestration logic lives in the application layer (Phase 7), NOT in the domain. Phase 2 provides the pure building blocks: `parsePackEntryHeader`, `applyDelta`, and `LruCache`. The domain does not perform I/O or decompression.

**Testing note:** Delta chain resolution is NOT tested in Phase 2 — only the building blocks (`applyDelta`, `parsePackEntryHeader`, `LruCache`) are tested here. Integration tests for full chain resolution belong in Phase 7.

---

## 9. LRU Cache

### 9.1 Purpose

Deep delta chains require resolving every base object. Without caching, the same base is decompressed and delta-applied repeatedly. The LRU cache stores resolved intermediate results, bounded by a configurable byte limit (default 64 MB).

### 9.2 API

```typescript
function createLruCache<V>(maxSizeBytes: number): LruCache<V>;
```

`maxSizeBytes` must be ≥ 0. A value of 0 creates a **no-op cache**: every `set` adds then immediately evicts. This is useful for disabling caching without changing call sites.

Returns a `LruCache<V>` (§4.5) backed by a doubly-linked list for LRU ordering and a `Map` for O(1) key lookup.

### 9.3 Implementation Strategy

```
Map<string, Node<V>>     ←→     DoublyLinkedList<Node<V>>
       ↑                                  ↑
   O(1) lookup                     O(1) eviction
```

Each `Node` stores:
- `key: string`
- `value: V`
- `byteSize: number`
- `prev: Node | null`
- `next: Node | null`

**Operations:**
- **`get(key)`:** Look up in Map. If found, move node to head (most-recently-used). Return value.
- **`set(key, value, byteSize)`:** `byteSize` must be > 0 (zero-sized entries would accumulate without triggering eviction). If key exists, subtract old `byteSize` from `currentSize`, update value/size, add new `byteSize` to `currentSize`, and move to head. If new, create node at head and add `byteSize` to `currentSize`. Then evict from tail until `currentSize ≤ maxSize`.
- **`delete(key)`:** Remove node from list and Map. Subtract `byteSize` from `currentSize`.
- **`clear()`:** Reset list and Map. Set `currentSize = 0`.

**Edge case:** If a single entry exceeds `maxSize`, it is still added (evicting everything else) but will itself be evicted on the next `set`. This avoids silently dropping oversized objects.

### 9.4 Immutability Note

The `LruCache` is inherently mutable — it's a stateful data structure. This is an intentional exception to the FP-first principle. Caches are inherently side-effectful. The cache is isolated behind a clean interface and does not leak mutation to the rest of the domain.

### 9.5 Concurrency Note

The `LruCache` is safe for single-threaded use. JavaScript's event loop guarantees atomic synchronous execution of `get`/`set`/`delete` — no concurrent mutations can occur even when the Phase 7 lookup pipeline uses `Promise.all` for parallel async operations, because cache access is synchronous within each microtask.

---

## 10. CRC-32

Git uses CRC-32 (ISO 3309, polynomial `0xEDB88320` reflected) for pack entry integrity. This is the standard CRC-32 algorithm used by zlib — NOT CRC-32C (Castagnoli, different polynomial).

### 10.1 API

```typescript
function crc32(data: Uint8Array): number;
```

Returns a 32-bit unsigned integer.

### 10.2 Implementation

Pre-computed 256-entry lookup table + byte iteration:

```typescript
// Build table once at module load
const CRC32_TABLE: Uint32Array = buildCrc32Table();

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC32_TABLE[(c ^ data[i]!) & 0xFF]! ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
```

Pure, zero-dependency, ~20 lines. The `>>> 0` ensures unsigned 32-bit result.

---

## 11. Pack Writer

Serializes git objects into `.pack` and `.idx` files. The caller is responsible for:
- Serializing each object's content (using Phase 1 `serializeObject`)
- Compressing each object's content (via `Compressor` port in Phase 4)
- Computing the SHA of each object (for the index)
- Computing the SHA of the final pack/index files (for trailers)

### 11.1 Pack File Serialization

```typescript
interface PackWriterEntry {
  readonly type: BasePackEntryType;      // 1 | 2 | 3 | 4 — base types only, no deltas
  readonly uncompressedSize: number;     // Size before compression
  readonly compressedData: Uint8Array;   // Already zlib-compressed by caller
}

/** Per-entry metadata produced during pack serialization. */
interface PackEntryMeta {
  readonly crc32: number;                // CRC-32 of entire packed entry (header + compressed data)
  readonly offset: number;               // Byte offset of this entry within the .pack file
}

/** Result of pack file serialization. */
interface PackfileResult {
  readonly data: Uint8Array;                        // Pack bytes (without trailing SHA checksum)
  readonly entries: ReadonlyArray<PackEntryMeta>;    // Per-entry metadata, same order as input
}

function serializePackfile(
  entries: ReadonlyArray<PackWriterEntry>
): PackfileResult;
// Returns pack bytes AND per-entry metadata (CRC-32 + offset).
// Caller appends the SHA checksum to `data`.
// Caller uses `entries` metadata to build PackIndexWriterEntry[].
```

**Algorithm:**
1. Write pack header: magic `"PACK"`, version `2`, object count
2. Initialize `currentOffset = 12` (pack header is always 12 bytes)
3. For each entry:
   a. Encode the type+size header via `encodePackEntryHeader(entry.type, entry.uncompressedSize)`
   b. Compute `crc32(concat(headerBytes, entry.compressedData))`
   c. Record `{ crc32, offset: currentOffset }` in the metadata array
   d. Append header bytes and compressed data to the output buffer
   e. Advance `currentOffset` by `headerBytes.length + entry.compressedData.length`
4. Return `{ data: outputBuffer, entries: metadataArray }`

**Why `PackfileResult` instead of bare `Uint8Array`?** The CRC-32 and offset of each entry are emergent properties of serialization — the caller cannot compute them without duplicating the header encoding logic. Returning them alongside the pack bytes keeps information-flow clean and avoids DRY violations.

**Why no trailing SHA in `data`?** Computing the SHA requires a `HashService` port. The domain layer returns the raw bytes; the application layer hashes and appends the checksum.

**Why `BasePackEntryType` only?** Phase 2 v1 does not implement delta encoding (§16.9). Restricting the type at compile time prevents passing delta types without the required base reference fields.

**Caller workflow:**
1. Prepare `PackWriterEntry[]` and keep corresponding `ObjectId[]` aligned by index
2. Call `serializePackfile(entries)` → `{ data, entries: PackEntryMeta[] }`
3. Hash `data` via `HashService` → `packChecksum`. Append checksum to `data`.
4. Build `PackIndexWriterEntry[]` by zipping `ObjectId[]` with `PackEntryMeta[]`
5. Call `serializePackIndex(indexEntries, packChecksum)`

### 11.2 Pack Index Serialization

```typescript
interface PackIndexWriterEntry {
  readonly id: ObjectId;               // Object SHA-1
  readonly crc32: number;              // CRC-32 of entire packed entry
  readonly offset: number;             // Byte offset in .pack file
}

function serializePackIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array
): Uint8Array;
// Returns index bytes WITHOUT the trailing self-checksum.
// Caller appends the SHA-1 checksum of all returned bytes.
```

**Validation:** `packChecksum.length` must be 20 (SHA-1). Throws `INVALID_PACK_INDEX` otherwise.

**Algorithm:**
1. Sort entries by ObjectId (byte-level sort)
2. Build fanout table from sorted entries
3. Write header: magic `0xff744f63`, version `2`
4. Write fanout table (256 × uint32 big-endian)
5. Write sorted SHA-1 table (N × 20 bytes)
6. Write CRC-32 table (N × uint32 big-endian)
7. Write offset table (N × uint32 big-endian; set MSB for offsets > 2^31)
8. Write large offset table if needed (M × uint64 big-endian)
9. Write pack checksum
10. Return bytes (caller appends the index self-checksum)

### 11.3 Delta Compression (Stretch — Not in Phase 2 v1)

Delta encoding (finding an optimal delta from base to target) is a separate, computationally expensive algorithm. Phase 2 focuses on delta _resolution_ (applying deltas). Delta _creation_ is deferred:
- For `push`, the server typically receives a thin pack and indexes it
- For initial implementation, packs contain only base objects (no deltas)
- Delta encoding can be added as a performance optimization later

---

## 12. Error Types

New error variants for the storage layer, extending the `TsgitError` pattern from Phase 1.

### 12.1 StorageError Union

Only errors that Phase 2 code actually throws. Lookup pipeline errors (`OBJECT_NOT_FOUND`, `AMBIGUOUS_SHORT_SHA`) belong in Phase 7 (primitives).

```typescript
type StorageError =
  | { readonly code: 'INVALID_PACK_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_PACK_INDEX'; readonly reason: string }
  | {
      readonly code: 'INVALID_PACK_ENTRY';
      readonly offset: number;
      readonly reason: string;
    }
  | { readonly code: 'INVALID_DELTA'; readonly reason: string };
```

### 12.2 Factory Functions

```typescript
const invalidPackHeader = (reason: string): TsgitError => ...;
const invalidPackIndex = (reason: string): TsgitError => ...;
const invalidPackEntry = (offset: number, reason: string): TsgitError => ...;
const invalidDelta = (reason: string): TsgitError => ...;
```

### 12.3 TsgitError Extension Strategy

The `TsgitError` class must accept both `DomainObjectError` and `StorageError`. To preserve compile-time exhaustive switch checking while avoiding circular imports, the error architecture is restructured:

**Approach: Layered union with shared `TsgitError` at `domain/error.ts`**

1. Extract `TsgitError` class from `domain/objects/error.ts` to a new shared file `domain/error.ts`
2. Define `TsgitErrorData = DomainObjectError | StorageError` as an aggregate union in `domain/error.ts`
3. `TsgitError.data` is typed as `TsgitErrorData` — exhaustive switch checking preserved
4. Each phase module (`domain/objects/error.ts`, `domain/storage/error.ts`) exports its own union type and factory functions, importing `TsgitError` from `domain/error.ts`
5. The `extractDetail` helper in `domain/error.ts` handles all error codes exhaustively

**Source-level dependency (bidirectional, but safe at runtime):**
```
domain/error.ts  ──import type──>  domain/objects/error.ts  (type-only, erased at runtime)
domain/error.ts  ──import type──>  domain/storage/error.ts  (type-only, erased at runtime)

domain/objects/error.ts  ──import──>  domain/error.ts  (runtime: TsgitError class)
domain/storage/error.ts  ──import──>  domain/error.ts  (runtime: TsgitError class)
```

At the TypeScript source level, there is a bidirectional dependency between `domain/error.ts` and each phase error module. This is safe because:
1. `verbatimModuleSyntax: true` (in tsconfig) enforces `import type` for type-only imports
2. `import type` is erased at compile time — no runtime `import` statement is emitted
3. The emitted JavaScript has strictly one-directional flow: children import the `TsgitError` class from the parent

**Dependency-cruiser:** The `no-circular` rule must exclude type-only edges to avoid false positives. Add `dependencyTypesNot: ['type-only']` to the rule's `to` clause.

Neither child module imports from the other. Future phases add their own union types to `TsgitErrorData` in `domain/error.ts`.

**This decision warrants an ADR:** See `docs/adr/003-error-extension-strategy.md`.

---

## 13. Function Signatures

### pack-entry.ts

Pack header + pack entry header parsing and serialization (parse/serialize pairs co-located).

```typescript
// Pack file header
function parsePackHeader(bytes: Uint8Array): PackHeader;
function serializePackHeader(version: number, objectCount: number): Uint8Array;

// Pack entry header (type + size variable-length encoding)
function parsePackEntryHeader(
  bytes: Uint8Array,
  offset: number,
  hash: HashConfig
): PackEntryHeader;
function encodePackEntryHeader(type: PackEntryType, size: number): Uint8Array;

// OFS_DELTA distance encoding
function encodeOfsDistance(distance: number): Uint8Array;

// Type mapping
function packEntryTypeToObjectType(type: PackEntryType): ObjectType | undefined;
```

### loose-path.ts

```typescript
function computeLooseObjectPath(id: ObjectId): string;
```

### pack-index.ts

```typescript
function parsePackIndex(bytes: Uint8Array): PackIndex;

function lookupPackIndex(
  index: PackIndex,
  id: ObjectId
): number | undefined;

function findByPrefix(
  index: PackIndex,
  prefix: string
): ReadonlyArray<ObjectId>;
```

### delta.ts

```typescript
function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array;
function parseDelta(delta: Uint8Array): DeltaParsed;
```

### lru-cache.ts

```typescript
function createLruCache<V>(maxSizeBytes: number): LruCache<V>;
```

### crc32.ts

```typescript
function crc32(data: Uint8Array): number;
```

### pack-writer.ts

```typescript
function serializePackfile(
  entries: ReadonlyArray<PackWriterEntry>
): PackfileResult;

function serializePackIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array
): Uint8Array;
```

---

## 14. Testing Strategy

### 14.1 Unit Tests

Every parser/serializer pair gets:
- **Known-value tests:** Parse hand-crafted binary data, assert field values
- **Roundtrip tests:** `serialize(parse(data)) === data` (byte-identical)
- **Error cases:** Truncated input, invalid magic, bad version, corrupt headers

### 14.2 Module-Specific Tests

**loose-path.ts:**
- SHA-1 id → `"xx/yyy..."` (40 hex chars)
- SHA-256 id → `"xx/yyy..."` (64 hex chars)

**pack-index.ts:**
- Parse a real `.idx` file (fixture), verify object count, fanout monotonicity
- Lookup known objects, verify correct offsets
- Lookup non-existent object → `undefined`
- Prefix search with varying prefix lengths (4, 7, 20, 40 chars)
- Prefix matching 0, 1, and multiple objects
- Invalid prefix: too short (<4), non-hex, too long (>40) → error
- Large offset handling (MSB set → 64-bit table)

**pack-entry.ts:**
- Decode type+size header with 1, 2, 3, 4 bytes
- All six pack entry types (1–4, 6, 7)
- OFS_DELTA distance decoding (various chain depths)
- REF_DELTA base SHA extraction (SHA-1 and SHA-256)
- Roundtrip: `decode(encode(type, size))` preserves values (base types only)
- Pack header parse/serialize roundtrip

**delta.ts:**
- Apply known delta to known base, verify exact result
- COPY instruction: various offset/size combinations, zero-size = 65536
- COPY: full-buffer copy (offset=0, size=base.length)
- COPY: out-of-bounds read (offset + size > base.length) → `INVALID_DELTA`
- COPY: result overflow (resultPosition + size > targetLength) → `INVALID_DELTA`
- COPY with `0x80` instruction byte (64KB from offset 0) when base < 64KB → `INVALID_DELTA`
- INSERT instruction: 1 byte, max 127 bytes
- INSERT: result overflow (resultPosition + N > targetLength) → `INVALID_DELTA`
- Multiple instructions in sequence (including consecutive INSERTs with no COPY)
- Source/target length mismatch → error
- Empty delta: `sourceLength = 0, targetLength = 0`, no instructions → valid (empty result)
- Empty delta: `sourceLength > 0, targetLength > 0`, no instructions → `INVALID_DELTA` (underfill)
- Trailing bytes after instructions fill the target → `INVALID_DELTA`

**lru-cache.ts:**
- Set/get basic operations
- LRU eviction order (oldest access evicted first)
- Byte size tracking and enforcement
- Oversized single entry (larger than maxSize)
- Delete and clear operations
- Access promotes entry (not evicted prematurely)
- Entry count tracking
- Update existing key with different byteSize → currentSize adjusted correctly
- `createLruCache(0)` → no-op cache, entries evicted immediately
- `set` with `byteSize = 0` → rejected (throws or documented precondition)

**crc32.ts:**
- Known test vectors: `crc32(b"") = 0x00000000`, `crc32(b"123456789") = 0xCBF43926`
- Large data (1 MB+) matches reference implementation

**pack-writer.ts:**
- Serialize single-object pack, parse back, verify header and entry
- Serialize multi-object pack, verify entries in order
- Index serialization: fanout table correctness, sorted SHA order
- Large offset table presence when offset > 2^31
- Invalid packChecksum length → error

### 14.3 Property-Based Tests (fast-check)

```typescript
// Pack entry header roundtrip (base types only — delta types need
// additional header fields that encodePackEntryHeader doesn't produce)
fc.assert(
  fc.property(
    fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<BasePackEntryType>,
    fc.nat(2 ** 32),
    (type, size) => {
      const encoded = encodePackEntryHeader(type, size);
      const decoded = parsePackEntryHeader(encoded, 0, SHA1_CONFIG);
      expect(decoded.type).toBe(type);
      expect(decoded.size).toBe(size);
    }
  )
);

// Delta apply produces correct target length
fc.assert(
  fc.property(arbDelta(), ({ base, delta, expected }) => {
    const result = applyDelta(base, delta);
    expect(result.length).toBe(expected.length);
    expect(result).toEqual(expected);
  })
);

// LRU cache: currentSize never exceeds maxSize after set operations
fc.assert(
  fc.property(
    fc.array(fc.tuple(fc.string(), fc.nat(1000))),
    fc.integer({ min: 1, max: 10000 }),
    (entries, maxSize) => {
      const cache = createLruCache<null>(maxSize);
      for (const [key, size] of entries) {
        cache.set(key, null, size);
      }
      expect(cache.currentSize).toBeLessThanOrEqual(maxSize);
    }
  )
);

// CRC-32 deterministic
fc.assert(
  fc.property(fc.uint8Array({ maxLength: 10000 }), (data) => {
    expect(crc32(data)).toBe(crc32(data));
  })
);

// Pack index roundtrip: serialize → parse → lookup finds all entries
fc.assert(
  fc.property(arbPackIndexEntries(), (entries) => {
    const packChecksum = new Uint8Array(20);
    const serialized = serializePackIndex(entries, packChecksum);
    // Append a 20-byte self-checksum placeholder for parsing
    const withTrailer = new Uint8Array(serialized.length + 20);
    withTrailer.set(serialized);
    const parsed = parsePackIndex(withTrailer);
    for (const entry of entries) {
      expect(lookupPackIndex(parsed, ObjectId.from(entry.id))).toBe(entry.offset);
    }
  })
);
```

### 14.4 Interop Tests

Parse real git-generated `.idx` and `.pack` files:
- Create a test fixture repo with `git init && git add && git commit && git gc`
- Extract the `.idx` and `.pack` files
- Parse and verify object counts, lookup known SHAs, resolve deltas
- Compare parsed objects with `git cat-file` output

### 14.5 Coverage Targets

- 100% line, branch, function, statement coverage
- 0 surviving non-equivalent mutants (Stryker)

### 14.6 Not Tested in Phase 2

Delta chain resolution (§8.6) is an application-layer concern tested in Phase 7. Phase 2 only tests the pure building blocks: `applyDelta` (single delta application), `parsePackEntryHeader` (header parsing), and `LruCache` (cache operations). The integration of these components into a full resolution pipeline is covered by Phase 7 tests.

---

## 15. Implementation Order

Following internal dependency chain, each step using TDD:

0. **domain/error.ts** — Extract `TsgitError` class to shared location. Define `TsgitErrorData` aggregate union. Update `domain/objects/error.ts` to import `TsgitError` from `domain/error.ts`. Create ADR `docs/adr/003-error-extension-strategy.md`.

1. **error.ts** — `StorageError` union + factory functions. Import `TsgitError` from `domain/error.ts`. Update `TsgitErrorData` to include `StorageError`.

2. **loose-path.ts** — Trivial, no internal deps. Depends on `ObjectId` from domain/objects.

3. **crc32.ts** — Self-contained pure function. No domain dependencies.

4. **lru-cache.ts** — Generic data structure. No domain dependencies.

5. **pack-entry.ts** — `PackEntryType` enum + pack header + entry header codec + `encodeOfsDistance`. Depends on `ObjectId`, `HashConfig`, `error.ts`.

6. **pack-index.ts** — `.idx` v2 parser + lookup + prefix search. Depends on `pack-entry.ts`, encoding utilities (direct import from `domain/objects/encoding.ts`), `error.ts`.

7. **delta.ts** — Delta parser + `applyDelta`. Depends on `error.ts` only.

8. **pack-writer.ts** — Pack + index serialization. Depends on `pack-entry.ts`, `crc32.ts`, encoding utilities.

Each step: **Red** (write test, must fail) → **Green** (minimal implementation) → **Refactor** (clean up, keep tests green).

---

## 16. Key Design Decisions

### 16.1 Zero-Copy Pack Index

**Decision:** Store raw `.idx` bytes in `PackIndex`, use `DataView` for integer reads and direct byte access for SHA comparison.

**Why:** Pack indices can be large (100+ MB for repos with millions of objects). Materializing into typed arrays would double memory usage. DataView reads are fast and allocation-free during lookup.

### 16.2 Iterative Delta Resolution (Not Recursive)

**Decision:** Delta chains are resolved iteratively using an explicit stack.

**Why:** Deep delta chains (50+ levels) can occur in practice. Recursive resolution risks stack overflow. The iterative approach with a stack has bounded memory usage proportional to chain depth.

### 16.3 Single-Pass Delta Application

**Decision:** `applyDelta` processes instructions in one pass, allocating the result buffer upfront from the target length in the delta header.

**Why:** The target length is known before processing any instructions. Single allocation avoids resizing. The instruction stream is consumed sequentially — no random access needed.

### 16.4 LRU Cache as Mutable Exception

**Decision:** The `LruCache` uses internal mutation (linked list + Map) despite the FP-first principle.

**Why:** A cache is inherently stateful. An immutable persistent data structure would add overhead (allocations on every access) without benefit. The mutable implementation is isolated behind a clean, narrow interface and does not leak state.

### 16.5 Domain-Only Phase (No I/O)

**Decision:** Phase 2 contains only pure domain functions. All I/O (file access, compression, hashing) is deferred to ports (Phase 4) and application primitives (Phase 7).

**Why:** Hexagonal architecture requires the domain to have zero outward dependencies. This makes all Phase 2 code testable with plain `Uint8Array` inputs — no mocks, no filesystem, no platform APIs.

### 16.6 CRC-32 in Domain

**Decision:** Include a pure CRC-32 implementation in the domain, not as a port.

**Why:** CRC-32 is a fixed, simple algorithm (~20 lines) with no platform variation. It doesn't benefit from hardware acceleration (unlike SHA). Making it a port would add unnecessary indirection.

### 16.7 Pack Checksum Excluded from Serialization

**Decision:** `serializePackfile` and `serializePackIndex` return bytes _without_ trailing SHA checksums. The caller appends them.

**Why:** SHA computation requires a `HashService` port (platform-specific: Node.js uses OpenSSL, browsers use SubtleCrypto). The domain layer cannot call these. The application layer hashes the serialized bytes and appends the checksum.

### 16.8 Error Extension via Layered Union

**Decision:** Extract `TsgitError` to `domain/error.ts` with an aggregate `TsgitErrorData = DomainObjectError | StorageError | ...` union. Each phase contributes its error variants. Exhaustive switch checking is preserved.

**Why:** Avoids the loss of compile-time exhaustiveness (rejected Option B: `{ readonly code: string }`). Avoids circular imports (rejected Option A: widening in `domain/objects/error.ts`). Scales to future phases by adding new union members to `TsgitErrorData`.

### 16.9 No Delta Encoding (Phase 2 v1)

**Decision:** Phase 2 implements delta _resolution_ (applying deltas) but not delta _encoding_ (creating deltas). Packs written by `serializePackfile` contain only base objects.

**Why:** Delta encoding is a complex optimization (needs a rolling hash, window scanning, and heuristics for base selection). The initial implementation works correctly without it — objects are just slightly larger. Delta encoding can be added later as a performance optimization.

### 16.10 Pack Index v2 Scoped to SHA-1

**Decision:** Pack index parsing and serialization target the `.idx` v2 format with SHA-1 (20-byte hashes) only. SHA-256 support deferred.

**Why:** The `.idx` v2 format was designed for SHA-1. SHA-256 repositories use `.idx` v3, which has a fundamentally different structure. Parameterizing v2 with variable hash lengths would produce output incompatible with real SHA-256 git repos. The packfile format (`.pack` v2) does support any hash length — `parsePackEntryHeader` accepts `HashConfig` for REF_DELTA entries.
