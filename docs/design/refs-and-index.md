# Design: Refs & Index

**Status: Proposed** — Phase 3 of the [backlog](../BACKLOG.md).

### Review Notes

Changes from deep architecture, format accuracy, and security reviews:

- **Renamed `domain/index/` to `domain/git-index/`** to eliminate barrel collision with `domain/index.ts`. All references updated.
- **`PackedRefs` type extended** with `peeling: 'none' | 'tags' | 'fully'` and `sorted: boolean` (replacing `hasPeeledTrait: boolean`). Semantics documented: `'tags'` = all peelable tag refs have peel lines; `'fully'` = ALL peelable refs have peel lines (absence = definitively not peelable).
- **Ref validation rules corrected** — per-component dot/lock checks (not whole-name), added leading/trailing `/` prohibition, added `\0` check, documented one-level ref acceptance for `HEAD`/`FETCH_HEAD` etc.
- **`peelOneLevel` extracted to `refs/peel.ts`** — SRP: `ref-types.ts` is pure type definitions only.
- **`RefName.from` vs `validateRefName` trust boundary documented** — `parseLooseRef` calls `validateRefName` on symbolic ref targets to prevent path traversal. `RefName.from` remains low-trust (for internal use only).
- **Loose refs support SHA-256** — `ObjectId.from()` already handles both 40-char and 64-char hex.
- **`StatData.mode` typed as `FileMode`** (not `number`) to match `IndexEntry.mode`. Callers must normalize numeric stat mode before calling `isStatClean`.
- **`nameLength` removed from `IndexEntryFlags`** — redundant with `path.length`, stale-prone. Serializer recomputes from path.
- **Security guards documented** — `entryCount * ENTRY_HEADER_SIZE <= bytes.length` before looping, extension `offset + size` bounds validated, `nameLength = 0xFFF` as sentinel documented, mandatory extensions (lowercase first byte) rejected, extended flag validated as zero in v2.
- **`serializePackedRefs` sorting contract documented** — always sorts by name, always writes header when entries present.
- **Extension boundary uses `hashSize`** (not hardcoded 20) for SHA-256 future-proofing.

---

## 1. Overview

Phase 3 adds the domain-layer representation of git references and the staging index. Git uses two mechanisms to track branch/tag state and working-tree staging:

1. **References (refs)** — pointers to object SHAs stored under `.git/refs/` (loose) or `.git/packed-refs` (packed). `HEAD` is a special symbolic ref.
2. **Index (staging area)** — a binary file at `.git/index` (v2 format) that caches stat data for tracked files and serves as the source of truth for `git status` and `git commit`.

This phase implements **domain-layer** parsing and serialization:
- Loose ref content parsing (`<sha>\n` or `ref: <target>\n`)
- Packed-refs file parsing (sorted text format with optional peel lines)
- Ref peeling logic (tag → commit → tree chain resolution types)
- Index v2 binary format parsing and serialization
- Index entry stat comparison for `status`

All code is pure — no I/O, no filesystem access. Functions accept strings or `Uint8Array` and return parsed types or serialized bytes. Actual file reads happen through the `FileSystem` port (Phase 4), wired by application primitives (Phase 7).

**Scope boundary:** This phase defines the _data structures and parsers_. Ref _resolution_ (walking the filesystem from a name to a SHA) is an application-layer concern (Phase 7) because it requires I/O. Phase 3 provides the building blocks: `parseLooseRef`, `parsePackedRefs`, `parseIndex`, `serializeIndex`.

---

## 2. Module Structure

```
src/domain/
├── refs/
│   ├── loose-ref.ts        # Parse/serialize loose ref content
│   ├── packed-refs.ts       # Parse packed-refs file content
│   ├── ref-types.ts         # Ref type definitions (SymbolicRef, DirectRef, PackedRefEntry, PackedRefs)
│   ├── peel.ts              # PeelResult type + peelOneLevel function
│   ├── ref-validation.ts    # Ref name validation (git-check-ref-format rules)
│   ├── error.ts             # RefsError union + factory functions
│   └── index.ts             # Barrel export
├── git-index/
│   ├── index-entry.ts       # IndexEntry type + stat comparison
│   ├── index-parser.ts      # Parse .git/index v2 binary format
│   ├── index-writer.ts      # Serialize index to binary format
│   ├── error.ts             # IndexError union + factory functions
│   └── index.ts             # Barrel export
├── error.ts                 # TsgitErrorData += RefsError | IndexError
└── index.ts                 # Barrel re-export
```

---

## 3. Domain Boundary

Phase 3 sits in the domain layer. **No I/O dependencies.**

| Concern | Who handles it | Phase |
|---------|---------------|-------|
| Loose ref content parsing (`<sha>\n`) | Domain (this phase) | 3 |
| Packed-refs file parsing | Domain (this phase) | 3 |
| Ref name validation | Domain (this phase) | 3 |
| Index v2 binary parsing/serialization | Domain (this phase) | 3 |
| Index entry stat comparison | Domain (this phase) | 3 |
| Reading `.git/refs/` files from disk | `FileSystem` port | 4 |
| Reading `.git/packed-refs` file | `FileSystem` port | 4 |
| Reading `.git/index` file | `FileSystem` port | 4 |
| `resolveRef` (name → SHA via filesystem walk) | `resolveRef` primitive | 7 |
| `updateRef` (atomic file write with lock) | `updateRef` primitive | 7 |
| `deleteRef` (remove file or packed-refs entry) | `deleteRef` primitive | 7 |
| `readIndex` / `writeIndex` (I/O wrapper) | `readIndex` primitive | 7 |

**Dependency direction:** `domain/refs/` and `domain/git-index/` are sibling modules at the same level as `domain/objects/` and `domain/storage/`. They import from `domain/objects/` (ObjectId, HashConfig, RefName, FilePath, FileMode, GitObject). Both contribute error types to `domain/error.ts`.

**Import paths:** Same convention as Phase 2. Import `ObjectId`, `HashConfig`, `SHA1_CONFIG`, `RefName`, `FilePath`, `FileMode`, `GitObject` from `../objects/index.js`. Import encoding utilities directly from `../objects/encoding.js`.

**Trust boundary — `RefName.from` vs `validateRefName`:**
- `RefName.from(name)` — low-trust constructor. Only checks non-empty. Used internally when the ref name originates from a trusted source (e.g., parsed from disk content written by git).
- `validateRefName(name)` — full git-check-ref-format validation. Used for all user-supplied ref names and for symbolic ref targets in `parseLooseRef` (to prevent path traversal).

---

## 4. Types

### 4.1 Ref Types

```typescript
/** A direct ref points to an object SHA. */
interface DirectRef {
  readonly type: 'direct';
  readonly target: ObjectId;
}

/** A symbolic ref points to another ref name (e.g., HEAD → refs/heads/main). */
interface SymbolicRef {
  readonly type: 'symbolic';
  readonly target: RefName;
}

/** Parsed content of a loose ref file. */
type LooseRef = DirectRef | SymbolicRef;
```

### 4.2 Packed Ref Entry

```typescript
/** A single entry from .git/packed-refs. */
interface PackedRefEntry {
  readonly name: RefName;
  readonly id: ObjectId;
  /** Peeled target (for annotated tags). Present when a `^<sha>` line follows. */
  readonly peeled?: ObjectId;
}

/** Parsed result of the entire packed-refs file. */
interface PackedRefs {
  readonly entries: ReadonlyArray<PackedRefEntry>;
  /**
   * Peeling completeness from the header traits:
   * - 'none': peel lines may or may not be present; if present, they are used
   * - 'tags': all peelable tag refs (refs/tags/) have peel lines
   * - 'fully': ALL peelable refs have peel lines (absence = definitively not peelable)
   */
  readonly peeling: 'none' | 'tags' | 'fully';
  /** Whether the file header has the `sorted` trait. */
  readonly sorted: boolean;
}
```

### 4.3 Peel Target

Located in `refs/peel.ts` (separate from type definitions for SRP).

```typescript
/** Result of peeling a git object to its target type. */
interface PeelResult {
  readonly type: ObjectType;
  readonly id: ObjectId;
}

/**
 * Given a parsed git object, return the peel target (one level).
 * - Tag → its `object` field
 * - Commit → its `tree` field
 * - Tree/Blob → undefined (terminal)
 */
function peelOneLevel(object: GitObject): PeelResult | undefined;
```

The actual peeling _algorithm_ (recursive tag → commit → tree chase) requires reading objects from storage, which is Phase 7. Phase 3 provides the type and the single-step peel logic.

### 4.4 Index Entry

The git index stores one entry per tracked file with stat cache data for fast `status` comparisons. Index v2 stores SHA-1 only (20 bytes). SHA-256 uses a different index format version.

```typescript
interface IndexEntry {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: FileMode;
  readonly uid: number;
  readonly gid: number;
  readonly fileSize: number;
  readonly id: ObjectId;          // Always SHA-1 in index v2
  readonly flags: IndexEntryFlags;
  readonly path: FilePath;
}

interface IndexEntryFlags {
  readonly assumeValid: boolean;
  readonly extended: boolean;      // Must be false in v2
  readonly stage: 0 | 1 | 2 | 3;
}
```

**`nameLength` omitted from `IndexEntryFlags`:** The 12-bit name length field in the binary format is a parsing hint only (capped at 0xFFF = 4095 as a sentinel for longer paths). The NUL terminator is the canonical path boundary. `serializeIndex` recomputes the field from `path.length` (capping at 0xFFF). Exposing it in the parsed type would create a stale-prone field.

### 4.5 Git Index

```typescript
interface GitIndex {
  readonly version: 2;
  readonly entries: ReadonlyArray<IndexEntry>;
  /** Extensions are preserved as opaque blobs for roundtrip fidelity. */
  readonly extensions: ReadonlyArray<IndexExtension>;
}

interface IndexExtension {
  readonly signature: string;   // 4-byte ASCII identifier
  readonly data: Uint8Array;    // Raw extension data (treated as immutable by convention)
}
```

---

## 5. Loose Ref Format

### 5.1 Direct Ref

A loose ref file contains a hex-encoded object ID followed by a newline:

```
<hex object ID>\n
```

The object ID is 40 characters for SHA-1 or 64 characters for SHA-256, determined by the repository's hash algorithm. `ObjectId.from()` already validates both lengths.

Example: `refs/heads/main` → `aabbccdd...\n`

### 5.2 Symbolic Ref

A symbolic ref file contains `ref: ` followed by the target ref path and a newline:

```
ref: <target-ref-path>\n
```

Example: `HEAD` → `ref: refs/heads/main\n`

### 5.3 Parsing

```typescript
function parseLooseRef(content: string): LooseRef;
```

**Algorithm:**
1. Trim trailing whitespace (handles `\n`, `\r\n`, or no newline)
2. If starts with `ref: ` → validate target via `validateRefName(rest)` → `SymbolicRef` (prevents path traversal like `ref: ../../../etc/passwd`)
3. Otherwise → validate as hex SHA via `ObjectId.from(trimmed)` → `DirectRef`
4. Invalid content → throw `INVALID_REF`

### 5.4 Serialization

```typescript
function serializeDirectRef(id: ObjectId): string;
function serializeSymbolicRef(target: RefName): string;
```

Returns the content string (with trailing `\n`) to be written to disk.

---

## 6. Packed-Refs Format

### 6.1 File Structure

The `.git/packed-refs` file is a text file with sorted ref entries:

```
# pack-refs with: peeled fully-peeled sorted 
<sha> <refname>
^<peeled-sha>
<sha> <refname>
...
```

- Comment lines start with `#`
- Each ref line: `<hex object ID> <space> <ref-name>`
- Optional peel line: `^<hex object ID>` (immediately after a tag ref)
- Header traits (space-separated after `# pack-refs with:`):
  - `peeled` — all tag refs (`refs/tags/`) that can be peeled have peel lines
  - `fully-peeled` — ALL refs that can be peeled have peel lines; absence of `^` line = not peelable
  - `sorted` — entries are sorted by ref name

**Peel lines are valid regardless of header traits.** The parser must accept `^` lines even when no peeling trait is declared. The trait only indicates _completeness_ of peeling, not _presence_.

### 6.2 Parsing

```typescript
function parsePackedRefs(content: string): PackedRefs;
```

**Algorithm:**
1. Split content by `\n`
2. Parse header line for traits (`peeled`, `fully-peeled`, `sorted`)
3. Map traits to `peeling`: both → `'fully'`, only `peeled` → `'tags'`, neither → `'none'`
4. For each non-comment, non-empty line:
   - If starts with `^` → peel line, attach to previous entry
   - Otherwise → parse as `<sha> <refname>`, create `PackedRefEntry`
   - Peel line without preceding ref → throw `INVALID_PACKED_REFS`
5. Return `PackedRefs` with entries, peeling, and sorted flag

### 6.3 Serialization

```typescript
function serializePackedRefs(refs: PackedRefs): string;
```

**Contract:**
- Always sorts entries by ref name lexicographically (git requires sorted output)
- Always writes the header line with the appropriate traits when entries are present
- Omits header when entries are empty (matches git behavior for empty packed-refs)
- Peel lines are written for entries that have a `peeled` value
- The `peeling` and `sorted` fields control the header traits emitted

### 6.4 Lookup

Since packed-refs entries are sorted, lookup can use binary search on the parsed array. However, the actual lookup (by ref name) is an application-layer concern because it involves checking loose refs first. Phase 3 provides the parsed data structure.

---

## 7. Ref Name Validation

Git ref names follow strict rules from `git-check-ref-format`:

```typescript
function validateRefName(name: string): RefName;
```

**Rules (from git-check-ref-format specification):**
1. No double dots (`..`) anywhere in the name
2. No ASCII control characters (< 0x20), no DEL (0x7F), no space, no NUL (`\0`)
3. No `~`, `^`, `:`, `?`, `*`, `[`, `\`
4. No slash-separated component may begin with `.` (e.g., `refs/.hidden/main` is invalid)
5. Full name cannot end with `.`
6. No slash-separated component may end with `.lock` (e.g., `refs/foo.lock/bar` is invalid)
7. Cannot contain `@{`
8. Cannot be the single character `@`
9. Cannot begin or end with `/`
10. No consecutive slashes (`//`) — no empty path components
11. Cannot begin with `-` (stricter than git's general ref validation — git only enforces this for branches, but we apply it universally for safety)

**One-level refs:** Git normally requires at least one `/` (e.g., `refs/heads/main`) unless `--allow-onelevel` is set. Special refs like `HEAD`, `FETCH_HEAD`, `ORIG_HEAD`, `MERGE_HEAD`, `CHERRY_PICK_HEAD` are one-level. `validateRefName` accepts one-level refs by default — the application layer can enforce multi-level when creating branch names.

Returns `RefName` (branded string) on success, throws `INVALID_REF` on violation.

---

## 8. Index V2 Binary Format

### 8.1 File Structure

```
┌──────────────────────────────────────────────────────┐
│ Header                                    12 bytes   │
│   Signature: "DIRC"                       4 bytes    │
│   Version: 2 (big-endian uint32)          4 bytes    │
│   Entry count (big-endian uint32)         4 bytes    │
├──────────────────────────────────────────────────────┤
│ Entry 0                                   variable   │
│   ctime seconds (uint32)                  4 bytes    │
│   ctime nanoseconds (uint32)              4 bytes    │
│   mtime seconds (uint32)                  4 bytes    │
│   mtime nanoseconds (uint32)              4 bytes    │
│   dev (uint32)                            4 bytes    │
│   ino (uint32)                            4 bytes    │
│   mode (uint32)                           4 bytes    │
│   uid (uint32)                            4 bytes    │
│   gid (uint32)                            4 bytes    │
│   file size (uint32)                      4 bytes    │
│   SHA-1 (20 bytes)                        20 bytes   │
│   flags (uint16)                          2 bytes    │
│     bit 15: assume-valid                             │
│     bit 14: extended (must be 0 in v2)               │
│     bits 13-12: stage (0-3)                          │
│     bits 11-0: name length (max 0xFFF, sentinel)     │
│   entry path (variable, NUL-terminated)              │
│   padding to 8-byte boundary             1-8 bytes   │
├──────────────────────────────────────────────────────┤
│ Entry 1...N-1                             variable   │
├──────────────────────────────────────────────────────┤
│ Extensions (optional)                     variable   │
│   Signature (4 bytes ASCII)                          │
│   Size (uint32)                                      │
│   Data (size bytes)                                  │
│   ... repeat for each extension                      │
├──────────────────────────────────────────────────────┤
│ Checksum                                  20 bytes   │
│   SHA-1 of all preceding bytes                       │
└──────────────────────────────────────────────────────┘
```

### 8.2 Parsing

```typescript
function parseIndex(bytes: Uint8Array): GitIndex;
```

**Algorithm:**
1. Validate signature `"DIRC"` at bytes 0-3
2. Validate version = 2 at bytes 4-7
3. Read entry count at bytes 8-11
4. **Security guard:** validate `entryCount * ENTRY_HEADER_SIZE <= bytes.length - INDEX_HEADER_SIZE - INDEX_CHECKSUM_SIZE` before looping (prevents DoS via crafted entry count)
5. For each entry:
   a. Read 40-byte stat fields (10 × uint32) via DataView
   b. Read 20-byte SHA-1
   c. Read 2-byte flags (assume-valid, extended, stage, name length)
   d. **Validate:** if extended flag is set, throw `INVALID_INDEX_ENTRY` (extended flags not supported in v2)
   e. Read NUL-terminated path name. The `nameLength` field in flags is advisory (capped at 0xFFF as a sentinel for paths >= 4095 bytes). **The NUL terminator is the canonical path boundary.**
   f. Skip padding to 8-byte boundary (relative to entry start)
6. Parse extensions until `hashSize` bytes remain (20 for SHA-1):
   a. Read 4-byte signature
   b. Read 4-byte size (uint32)
   c. **Security guard:** validate `offset + size <= bytes.length - hashSize` before slicing
   d. **Mandatory extension check:** if signature starts with a lowercase letter (a-z) and is not a recognized extension, throw `INVALID_INDEX_ENTRY` (mandatory extensions cannot be ignored). Uppercase-first-byte extensions (A-Z) are optional and preserved as opaque blobs.
   e. Read `size` bytes of data
7. Last `hashSize` bytes are the checksum (not validated here — `HashService` is Phase 4)

### 8.3 Serialization

```typescript
function serializeIndex(index: GitIndex): Uint8Array;
```

Returns index bytes **without** the trailing checksum (same pattern as `serializePackfile`/`serializePackIndex`). The caller appends the checksum via `HashService`.

### 8.4 Entry Padding

Each entry is padded with 1-8 NUL bytes to align the total entry size to a multiple of 8 bytes.

```typescript
const ENTRY_HEADER_SIZE = 62; // 10 × uint32 (40) + SHA-1 (20) + flags (2)

// pathByteLength = byte length of the encoded path string, EXCLUDING the NUL terminator
const entryLength = ENTRY_HEADER_SIZE + pathByteLength;
const paddedLength = (entryLength + 8) & ~7;
const paddingBytes = paddedLength - entryLength;
// paddingBytes is 1-8: always includes at least 1 NUL (the path terminator).
// The +8 in the formula encodes both the minimum-1-NUL guarantee and the alignment.
```

This is algebraically equivalent to git's `align_flex_name` macro: `(offsetof(data) + nameLength + 8) & ~7 = (62 + pathByteLength + 8) & ~7 = (70 + pathByteLength) & ~7`.

---

## 9. Index Entry Stat Comparison

For `git status`, git compares the current working-tree file stats against the cached stats in the index. If they match, git assumes the file hasn't changed (fast path). If they differ, git hashes the file to verify.

```typescript
interface StatData {
  readonly ctimeSeconds: number;
  readonly ctimeNanoseconds: number;
  readonly mtimeSeconds: number;
  readonly mtimeNanoseconds: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: FileMode;
  readonly uid: number;
  readonly gid: number;
  readonly fileSize: number;
}

/**
 * Compare working-tree stat data against an index entry's cached stat.
 * Returns true if the stats match (file assumed unchanged).
 */
function isStatClean(entry: IndexEntry, stat: StatData): boolean;
```

**`StatData.mode` is `FileMode`** (not `number`) to match `IndexEntry.mode`. The caller (application layer) must normalize the numeric stat mode from `fs.stat()` to a `FileMode` string before calling `isStatClean`.

**Fields compared:**
- `ctimeSeconds`, `ctimeNanoseconds`
- `mtimeSeconds`, `mtimeNanoseconds`
- `dev`, `ino`
- `mode`
- `uid`, `gid`
- `fileSize`

**Platform quirks:**
- On Windows, `ino` is always 0 and should be skipped
- On some filesystems, nanosecond timestamps are not available (0)
- `dev` may differ across mounts

These platform-specific behaviors are **not** handled in the domain layer. The domain provides the raw comparison; the application layer decides which fields to skip based on platform detection.

---

## 10. Error Types

### 10.1 RefsError Union

```typescript
type RefsError =
  | { readonly code: 'INVALID_REF'; readonly reason: string }
  | { readonly code: 'INVALID_PACKED_REFS'; readonly reason: string };
```

### 10.2 IndexError Union

```typescript
type IndexError =
  | { readonly code: 'INVALID_INDEX_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_INDEX_ENTRY'; readonly offset: number; readonly reason: string };
```

### 10.3 TsgitError Extension

`domain/error.ts` updated:

```typescript
type TsgitErrorData = DomainObjectError | StorageError | RefsError | IndexError;
```

`extractDetail` extended with new cases — all use `data.reason`.

---

## 11. Function Signatures

### refs/loose-ref.ts

```typescript
function parseLooseRef(content: string): LooseRef;
function serializeDirectRef(id: ObjectId): string;
function serializeSymbolicRef(target: RefName): string;
```

### refs/packed-refs.ts

```typescript
function parsePackedRefs(content: string): PackedRefs;
function serializePackedRefs(refs: PackedRefs): string;
```

### refs/ref-validation.ts

```typescript
function validateRefName(name: string): RefName;
```

### refs/peel.ts

```typescript
function peelOneLevel(object: GitObject): PeelResult | undefined;
```

### git-index/index-parser.ts

```typescript
function parseIndex(bytes: Uint8Array): GitIndex;
```

### git-index/index-writer.ts

```typescript
function serializeIndex(index: GitIndex): Uint8Array;
```

### git-index/index-entry.ts

```typescript
function isStatClean(entry: IndexEntry, stat: StatData): boolean;
```

---

## 12. Testing Strategy

### 12.1 Unit Tests

**loose-ref.ts:**
- Parse direct ref (`<sha>\n`) → `DirectRef`
- Parse symbolic ref (`ref: refs/heads/main\n`) → `SymbolicRef`
- Parse SHA-256 direct ref (64-char hex) → `DirectRef`
- Parse with `\r\n` line ending → handles gracefully
- Parse with no trailing newline → handles gracefully
- Parse invalid hex → throws `INVALID_REF`
- Parse empty string → throws `INVALID_REF`
- Parse `ref: ` (empty target) → throws `INVALID_REF`
- Parse `ref: \n` (whitespace-only target) → throws `INVALID_REF`
- Parse `ref: ../../../etc/passwd\n` → throws `INVALID_REF` (path traversal blocked)
- Roundtrip: `parseLooseRef(serializeDirectRef(id))` preserves id
- Roundtrip: `parseLooseRef(serializeSymbolicRef(target))` preserves target

**packed-refs.ts:**
- Parse empty string → empty entries, peeling='none', sorted=false
- Parse file with `# pack-refs with: peeled fully-peeled sorted` → peeling='fully', sorted=true
- Parse file with `# pack-refs with: peeled sorted` → peeling='tags'
- Parse 3 ref lines → 3 entries with correct SHAs and names
- Parse entry with peel line → `peeled` field populated
- Parse entry without peel line → `peeled` is undefined
- Parse peel line without header trait → still accepted (traits indicate completeness, not presence)
- Skip comment lines
- Invalid SHA in ref line → throws `INVALID_PACKED_REFS`
- Peel line without preceding ref → throws `INVALID_PACKED_REFS`
- Given entries in non-sorted order, When serializing, Then output is sorted by name
- Roundtrip: serialize then parse preserves all entries and traits

**ref-validation.ts:**
- Valid: `refs/heads/main`, `refs/tags/v1.0`, `HEAD`, `refs/remotes/origin/main`, `refs/heads/feature/my-branch`
- Invalid (one test per rule):
  - `refs/heads/..main` (double dots)
  - `refs/heads/main.lock` (component ends with .lock)
  - `refs/foo.lock/bar` (interior component ends with .lock)
  - `refs//heads` (consecutive slashes)
  - `refs/heads/` (trailing slash)
  - `/refs/heads/main` (leading slash)
  - `-refs` (starts with dash)
  - `@` (single @)
  - `refs/heads/@{main}` (contains @{)
  - `refs/.hidden/main` (component starts with dot)
  - `refs/heads/trail.` (ends with dot)
  - `refs/heads/spa ce` (contains space)
  - `refs/heads/til~de` (contains ~)
  - `refs/heads/car^et` (contains ^)
  - `refs/heads/col:on` (contains :)
  - `refs/heads/quest?` (contains ?)
  - `refs/heads/star*` (contains *)
  - `refs/heads/bra[cket` (contains [)
  - `refs/heads/back\\slash` (contains \)
  - `` (empty string)
  - String with NUL byte → throws `INVALID_REF`
  - String with ASCII control char → throws `INVALID_REF`

**peel.ts / peelOneLevel:**
- Tag object → returns `{ type: tag.data.objectType, id: tag.data.object }`
- Commit object → returns `{ type: 'tree', id: commit.data.tree }`
- Blob → returns undefined
- Tree → returns undefined

**index-parser.ts / index-writer.ts:**
- Parse hand-crafted index with 0 entries (32 bytes total) → valid, no extensions
- Parse index with 1 entry → correct stat fields, SHA, path
- Parse index with 3 entries → all entries correct, sorted by path
- Parse index with entries in non-sorted order → entries returned as-is (no sort enforcement)
- Parse with extension → extension preserved with correct signature and data
- Parse with mandatory extension (lowercase first byte) → throws `INVALID_INDEX_ENTRY`
- Parse with extended flag set → throws `INVALID_INDEX_ENTRY` (not supported in v2)
- Parse with nameLength = 0xFFF and long path → reads actual NUL-terminated path
- Wrong signature → throws `INVALID_INDEX_HEADER`
- Wrong version → throws `INVALID_INDEX_HEADER`
- Truncated header (< 12 bytes) → throws `INVALID_INDEX_HEADER`
- Crafted entryCount exceeding file size → throws `INVALID_INDEX_HEADER`
- Extension with size exceeding remaining bytes → throws `INVALID_INDEX_ENTRY`
- Truncated entry → throws `INVALID_INDEX_ENTRY`
- Entry with flags.stage = 2 → stage field is 2
- Entry with assumeValid = true → flag is set
- Roundtrip: `parseIndex(serializeIndex(index))` preserves all fields
- Entry padding: verify 8-byte alignment for various path lengths

**index-entry.ts:**
- Identical stats → `isStatClean` returns true
- Different mtimeSeconds → returns false
- Different mtimeNanoseconds → returns false
- Different ctimeSeconds → returns false
- Different ctimeNanoseconds → returns false
- Different dev → returns false
- Different ino → returns false
- Different mode → returns false
- Different uid → returns false
- Different gid → returns false
- Different fileSize → returns false

### 12.2 Property-Based Tests

- `arbRefName()` arbitrary generates valid ref names satisfying all rules
- Ref name validation: any string accepted does not contain `..`, `//`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, space, NUL, or control chars
- Ref name validation: any `arbRefName()` is accepted by `validateRefName`
- Index roundtrip: serialize then parse preserves all entries for arbitrary entry data
- Packed-refs roundtrip: serialize then parse preserves all entries (using `arbRefName()` for names)
- For any `IndexEntry`, `isStatClean(entry, extractStat(entry))` returns true

### 12.3 Coverage Targets

- 100% line, branch, function, statement coverage
- 0 surviving non-equivalent mutants (Stryker)

---

## 13. Key Design Decisions

### 13.1 Refs and Index as Separate Submodules

**Decision:** `domain/refs/` and `domain/git-index/` are separate directories, not merged.

**Why:** Refs and index are conceptually distinct git subsystems with different binary formats and different access patterns. `git-index/` is named to avoid a barrel collision with `domain/index.ts`.

### 13.2 Ref Resolution is Phase 7, Not Phase 3

**Decision:** Phase 3 parses ref _content_. Phase 7 _resolves_ ref names by walking the filesystem.

**Why:** Ref resolution requires I/O (checking loose refs, falling back to packed-refs, following symbolic refs). The domain layer cannot perform I/O. Phase 3 provides the pure parsers; Phase 7 composes them with the `FileSystem` port.

### 13.3 Index Extensions as Opaque Blobs

**Decision:** Index extensions are preserved as opaque `{ signature, data }` pairs. Mandatory extensions (lowercase first byte in signature) are rejected with an error. Optional extensions (uppercase first byte) are preserved without parsing.

**Why:** Extension formats are complex and most are optional optimizations (e.g., cached tree, resolve-undo). Parsing them all in Phase 3 would be scope creep. Preserving them as opaque blobs ensures roundtrip fidelity. Rejecting mandatory extensions is required by the git spec — an implementation that ignores them produces incorrect behavior.

### 13.4 Index V2 Only

**Decision:** Only index format version 2 is supported. Version 3 and 4 deferred.

**Why:** Version 2 is the most widely used format. Version 3 adds extended flags (intent-to-add, skip-worktree) which require only 2 extra bytes per entry. Version 4 uses path prefix compression. Both can be added later without breaking the v2 API.

### 13.5 Stat Comparison in Domain, Platform Quirks in Application

**Decision:** `isStatClean` compares all fields. Platform-specific field skipping is the caller's responsibility.

**Why:** The domain layer doesn't know which platform it's running on. The application layer knows (via the adapter) and can decide to skip `ino` on Windows or nanoseconds on HFS+.

### 13.6 Checksum Not Validated in Domain

**Decision:** `parseIndex` does not validate the trailing SHA-1 checksum. `serializeIndex` does not append one.

**Why:** Same pattern as Phase 2 — SHA computation requires `HashService` (Phase 4). The domain returns parsed data; the application layer verifies integrity.

### 13.7 `validateRefName` Accepts One-Level Refs

**Decision:** `validateRefName` does not require a `/` in the ref name. Special refs like `HEAD`, `FETCH_HEAD`, `ORIG_HEAD` are accepted.

**Why:** These refs are valid and widely used. The application layer enforces multi-level names where needed (e.g., when creating branches under `refs/heads/`).

---

## 14. Implementation Order

Following internal dependency chain:

0. **Error types** — `RefsError` + `IndexError` unions, update `TsgitErrorData`
1. **ref-types.ts + peel.ts** — Type definitions (`DirectRef`, `SymbolicRef`, `LooseRef`, `PackedRefEntry`, `PackedRefs`), `PeelResult`, `peelOneLevel`
2. **ref-validation.ts** — `validateRefName` (all 11 rules)
3. **loose-ref.ts** — `parseLooseRef`, `serializeDirectRef`, `serializeSymbolicRef`
4. **packed-refs.ts** — `parsePackedRefs`, `serializePackedRefs`
5. **index-entry.ts** — `IndexEntry`, `IndexEntryFlags`, `StatData`, `GitIndex`, `IndexExtension`, `isStatClean`
6. **index-parser.ts** — `parseIndex`
7. **index-writer.ts** — `serializeIndex`
8. **Barrel exports** — `refs/index.ts`, `git-index/index.ts`, update `domain/index.ts`

```
Step 0  (errors)
  │
  ├──────────┬──────────┐
  ▼          ▼          ▼
Step 1     Step 2     Step 5
(types+    (valid.)   (entry)
 peel)       │          │
  │    ┌─────┘          ├──────────┐
  ├────┤                ▼          ▼
  ▼    ▼              Step 6     Step 7
Step 3  Step 4        (parser)   (writer)
(loose)  (packed)       │          │
  │        │            └────┬─────┘
  └────┬───┘                 ▼
       ▼              Step 8 (barrels + verify)
     Step 8
```

**Parallelizable groups:**
- After step 0: steps 1, 2, 5 can run in parallel
- After steps 1+2: steps 3, 4 can run in parallel
- After step 5: steps 6, 7 can run in parallel (step 7 depends on step 6 for roundtrip tests)
- Steps 3/4 (refs) and 6/7 (index) are fully independent
