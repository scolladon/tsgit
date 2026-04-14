# Design: Domain Object Model

**Status: Implemented** -- Phase 1 complete, all items verified with 100% coverage and mutation testing.

Phase 1 of the [backlog](../BACKLOG.md). Foundation for all layers above.

### Post-Implementation Notes

Changes made during implementation that deviate from or extend this design:

- **Tree entry name validation**: Rejects names containing `/`, `.`, and `..` (path traversal prevention)
- **Tag name validation**: Rejects empty names and names containing `\0`
- **Float timestamp rejection**: `Number.isInteger` check on identity timestamps
- **Duplicate gpgsig rejection**: Parser throws if a second `gpgsig` header appears
- **Empty-key header rejection**: Parser rejects headers with empty keys
- **Shared header block parser**: `parseOptionalHeaderBlock` extracted and shared between commit and tag parsers
- **bytesToHex optimization**: Uses array join instead of string concatenation
- **serializeTreeContent optimization**: Single-pass allocation instead of incremental buffer growth
- **Dead code removal**: Unreachable `lines.length === 0` guards removed
- **serializeIdentity validation**: Rejects name, email, and timezoneOffset containing newlines
- **formatContinuationHeader validation**: Rejects keys that are empty, contain newlines, or contain spaces
- **Tag name newline validation**: Both parse and serialize paths reject tag names containing `\n`
- **parseRequiredTagFields return type**: Returns `nextIndex` instead of relying on a magic number
- **Duplicate ExtraHeader removed**: Inline type used in `encoding.ts` instead of a separate `ExtraHeader` interface
- **sortTreeEntries Schwartzian transform**: Pre-encodes names once for O(N) encoding cost instead of O(N log N)
- **Dead code removal**: Unused `parseContinuationValue` removed from `encoding.ts`

---

## 1. Overview

Git stores four object types — blob, tree, commit, tag — each zlib-compressed and addressed by SHA-1 of `header || content`. This document defines the TypeScript types, binary format parsing/serialization, and design decisions for the domain object model.

---

## 2. Value Objects

Branded types prevent primitive obsession. No raw strings cross domain boundaries.

### HashConfig

The domain must support both SHA-1 (20 bytes / 40 hex) and SHA-256 (32 bytes / 64 hex). A `HashConfig` is passed to parsers that need to know the hash length (tree entries, object headers).

```typescript
interface HashConfig {
  readonly digestLength: 20 | 32;   // bytes
  readonly hexLength: 40 | 64;      // hex chars
}

const SHA1_CONFIG: HashConfig = { digestLength: 20, hexLength: 40 };
const SHA256_CONFIG: HashConfig = { digestLength: 32, hexLength: 64 };
```

### ObjectId

```typescript
// Nominal typing via branded strings
type ObjectId = string & { readonly __brand: unique symbol };
type RefName = string & { readonly __brand: unique symbol };
type FilePath = string & { readonly __brand: unique symbol };

// Smart constructors validate at creation, trusted after
const ObjectId = {
  from: (hex: string): ObjectId => {
    if (!/^[0-9a-f]{40}$/.test(hex) && !/^[0-9a-f]{64}$/.test(hex)) {
      throw invalidObjectId(hex);
    }
    return hex as ObjectId;
  },
  fromRaw: (bytes: Uint8Array): ObjectId => {
    return ObjectId.from(bytesToHex(bytes));
  },
};
```

`ObjectId` accepts both 40-char (SHA-1) and 64-char (SHA-256) hex strings. Once created, the length is implicit in the string. Parsers use `HashConfig.hexLength` to know what to expect.

### FileMode

```typescript
const FILE_MODE = {
  REGULAR: '100644',
  EXECUTABLE: '100755',
  SYMLINK: '120000',
  DIRECTORY: '40000',
  GITLINK: '160000',
} as const;

type FileMode = (typeof FILE_MODE)[keyof typeof FILE_MODE];
```

**Note:** Git stores directory mode as `40000` (5 chars), not `040000`. The parser must accept both; the serializer must write `40000`.

### AuthorIdentity

```typescript
interface AuthorIdentity {
  readonly name: string;
  readonly email: string;
  readonly timestamp: number;   // Unix seconds
  readonly timezoneOffset: string; // "+0200" or "-0500"
}
```

---

## 3. Git Object Types

### 3.1 Discriminated Union

```typescript
type GitObject =
  | Blob
  | Tree
  | Commit
  | Tag;

interface Blob {
  readonly type: 'blob';
  readonly id: ObjectId;
  readonly content: Uint8Array;
}

interface Tree {
  readonly type: 'tree';
  readonly id: ObjectId;
  readonly entries: ReadonlyArray<TreeEntry>;
}

interface Commit {
  readonly type: 'commit';
  readonly id: ObjectId;
  readonly data: CommitData;
}

interface Tag {
  readonly type: 'tag';
  readonly id: ObjectId;
  readonly data: TagData;
}
```

### 3.2 TreeEntry

```typescript
interface TreeEntry {
  readonly mode: FileMode;
  readonly name: string;
  readonly id: ObjectId;
}
```

### 3.3 CommitData

```typescript
interface CommitData {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders: ReadonlyArray<ExtraHeader>;
}

interface ExtraHeader {
  readonly key: string;
  readonly value: string;
}
```

`extraHeaders` captures unknown headers (e.g. `encoding`, `mergetag`) between `committer` and the blank line. Empty array when none exist — never `undefined`. The parser preserves them; the serializer reproduces them. This ensures roundtrip fidelity.

**gpgsig extraction rule:** When the parser encounters a `gpgsig` header, it extracts the full value (including continuation lines) into `gpgSignature` and **excludes** it from `extraHeaders`. The serializer writes `gpgSignature` as a `gpgsig` header with continuation lines, then writes `extraHeaders` in their original order. This avoids duplication.

### 3.4 TagData

```typescript
interface TagData {
  readonly object: ObjectId;
  readonly objectType: 'commit' | 'tree' | 'blob' | 'tag';
  readonly tagName: string;
  readonly tagger?: AuthorIdentity;
  readonly message: string;
  readonly gpgSignature?: string;
  readonly extraHeaders: ReadonlyArray<ExtraHeader>;
}
```

`tagger` is optional — older git versions and imported repositories may produce annotated tags without a tagger field. Same gpgsig extraction rule as commits: `gpgsig` goes into `gpgSignature`, not `extraHeaders`.

---

## 4. Binary Format

### 4.1 Object Header

All objects share the same header format:

```
<type> <size>\0<content>
```

- `<type>` — ASCII: `blob`, `tree`, `commit`, or `tag`
- `<size>` — ASCII decimal digits: byte count of `<content>` (not including the header)
- `\0` — null byte separator
- `<content>` — raw bytes, format depends on type

SHA-1 is computed over the entire `header || content` byte sequence (before zlib compression).

### 4.2 Blob Content

Raw bytes. No structure. Any byte sequence is valid.

### 4.3 Tree Content

Concatenation of variable-length entries, no separators between entries:

```
<mode> <name>\0<N-byte-hash>
```

- `<mode>` — ASCII octal digits. `40000` for directories (not `040000`).
- `<name>` — filename bytes (UTF-8). No path separators.
- `\0` — null byte after name.
- `<N-byte-hash>` — raw binary, NOT hex. N = `HashConfig.digestLength` (20 for SHA-1, 32 for SHA-256).

**Sort order:** Entries are sorted by **byte-level** comparison (not Unicode/locale-aware) with a virtual trailing `/` appended to directory names for comparison only. This matches git's C implementation which uses `memcmp`.

```typescript
function treeEntryCompare(a: TreeEntry, b: TreeEntry): number {
  const aBytes = encodeEntryName(a.name, a.mode === '40000');
  const bBytes = encodeEntryName(b.name, b.mode === '40000');
  return compareBytes(aBytes, bBytes);
}

function encodeEntryName(name: string, isDirectory: boolean): Uint8Array {
  const nameBytes = textEncoder.encode(name);
  if (!isDirectory) return nameBytes;
  const result = new Uint8Array(nameBytes.length + 1);
  result.set(nameBytes);
  result[nameBytes.length] = 0x2f; // '/'
  return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
```

**Why byte-level, not string comparison:** JavaScript string comparison uses UTF-16 code unit ordering, which differs from byte ordering for multi-byte UTF-8 characters. Git uses `memcmp` on raw bytes. Using JS `<` / `>` on strings would produce incorrect sort order for filenames with non-ASCII characters.

**Parsing algorithm** (requires `HashConfig`):
1. Read bytes until space `0x20` → mode (ASCII octal)
2. Read bytes until null `0x00` → name (UTF-8)
3. Read exactly `HashConfig.digestLength` bytes → hash (raw binary, convert to hex for ObjectId)
4. Repeat until end of content

### 4.4 Commit Content

```
tree <hex-sha>\n               ← 40 chars (SHA-1) or 64 chars (SHA-256)
parent <hex-sha>\n             ← 0 or more
author <name> <email> <ts> <tz>\n
committer <name> <email> <ts> <tz>\n
[<extra-key> <value>\n]        ← 0 or more (encoding, mergetag, gpgsig)
\n
<message>
```

**Field order is mandatory.** Git rejects reordered commits.

**Identity format:** `Name <email> 1234567890 +0200`
- Name and email are UTF-8
- Timestamp is decimal Unix seconds
- Timezone is `+HHMM` or `-HHMM`

**gpgsig header:** Continuation lines are prefixed with a single space `0x20`. Even empty lines within the PGP block are stored as `0x20 0x0a`. The parser must strip exactly one leading space per continuation line.

**Encoding header:** Commits may contain an `encoding` header (e.g., `encoding ISO-8859-1`). When present, the message body is in that encoding, not UTF-8. We preserve `encoding` as an extra header for roundtrip fidelity but always decode message bodies as UTF-8. This matches isomorphic-git's behavior and covers 99%+ of real-world repos. Full charset support can be added later if needed.

**Parsing algorithm:**
1. Read lines until blank line `\n\n`
2. First line must start with `tree ` (otherwise throw `INVALID_COMMIT`)
3. Subsequent `parent ` lines (collect into array)
4. `author ` line → parse identity
5. `committer ` line → parse identity
6. Any remaining lines before blank → extra headers (handle continuation lines)
7. Everything after blank line → message (to EOF)

### 4.5 Tag Content

```
object <hex-sha>\n             ← 40 chars (SHA-1) or 64 chars (SHA-256)
type <object-type>\n
tag <tag-name>\n
tagger <name> <email> <ts> <tz>\n
\n
<message>
```

Same continuation-line convention for `gpgsig` as commits.

---

## 5. Parser/Serializer Design

### 5.1 Principles

- **Pure functions**: `parse(bytes) → GitObject`, `serialize(object) → Uint8Array`
- **Zero-copy where possible**: Use `DataView` and `Uint8Array.subarray()` to reference original buffer
- **Fail fast**: Invalid input throws typed `TsgitError`, never returns partial results
- **Roundtrip fidelity**: `serialize(parse(bytes))` must produce byte-identical output
- **No TextDecoder for binary**: Tree entries contain raw SHA bytes — use typed array access, not string decoding

### 5.2 Module Structure

```
src/domain/objects/
├── encoding.ts         # bytesToHex, hexToBytes, compareBytes, indexOf, TextEncoder/Decoder
├── error.ts            # TsgitError class + DomainObjectError union + factory functions
├── hash-config.ts      # HashConfig type, SHA1_CONFIG, SHA256_CONFIG
├── object-id.ts        # ObjectId branded type + smart constructor
├── file-mode.ts        # FileMode constant + validation + normalize
├── author-identity.ts  # AuthorIdentity type + parse/serialize
├── header.ts           # Object header parse/serialize (<type> <size>\0)
├── blob.ts             # Blob type + parse/serialize
├── tree.ts             # Tree type + TreeEntry + parse/serialize + sort
├── commit.ts           # Commit type + CommitData + parse/serialize
├── tag.ts              # Tag type + TagData + parse/serialize
├── git-object.ts       # GitObject discriminated union + dispatch parser
└── index.ts            # Barrel export
```

### 5.3 Function Signatures

**Input convention:**
- `rawBytes` = full object bytes including header (`<type> <size>\0<content>`)
- `content` = object content only, after header (what the header's `size` field describes)
- `serialize*` functions return `content` only (no header). The caller wraps with `serializeHeader` when needed.

```typescript
// Header
function parseHeader(rawBytes: Uint8Array): { type: ObjectType; size: number; contentOffset: number };
function serializeHeader(type: ObjectType, contentSize: number): Uint8Array;

// Object (takes rawBytes with header, dispatches to specific parser with content)
function parseObject(id: ObjectId, rawBytes: Uint8Array, hash: HashConfig): GitObject;
function serializeObject(object: GitObject, hash: HashConfig): Uint8Array; // returns header + content

// Blob (takes content only, returns content only)
function parseBlobContent(id: ObjectId, content: Uint8Array): Blob;
function serializeBlobContent(blob: Blob): Uint8Array;

// Tree (takes content only, requires HashConfig for hash length)
function parseTreeContent(id: ObjectId, content: Uint8Array, hash: HashConfig): Tree;
function serializeTreeContent(tree: Tree, hash: HashConfig): Uint8Array;
function sortTreeEntries(entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry>;

// Commit (takes content only)
function parseCommitContent(id: ObjectId, content: Uint8Array): Commit;
function serializeCommitContent(commit: Commit): Uint8Array;

// Tag (takes content only)
function parseTagContent(id: ObjectId, content: Uint8Array): Tag;
function serializeTagContent(tag: Tag): Uint8Array;

// Identity (shared by commit and tag)
function parseIdentity(line: string): AuthorIdentity;
function serializeIdentity(identity: AuthorIdentity): string;
```

`parseObject` is the high-level entry: it parses the header, extracts `content` via `contentOffset`, then dispatches to the type-specific `parse*Content` function. `serializeObject` does the reverse: calls `serialize*Content`, measures the byte length, prepends `serializeHeader`.

### 5.4 Encoding Utilities Module

Shared helpers used by all parsers. Located at `src/domain/objects/encoding.ts`.

**Public** (exported from barrel):

```typescript
function bytesToHex(bytes: Uint8Array): string;
function hexToBytes(hex: string): Uint8Array;
```

**Internal** (used by parsers, not exported from barrel):

```typescript
// Binary ↔ String (UTF-8) — thin wrappers, consumers use TextEncoder/TextDecoder directly
function encode(str: string): Uint8Array;
function decode(bytes: Uint8Array): string;

// Byte operations
function compareBytes(a: Uint8Array, b: Uint8Array): number;
function indexOf(bytes: Uint8Array, target: number, fromIndex: number): number;
```

### 5.5 Zero-Copy Parsing Strategy

For blobs and tree entries, avoid copying bytes:

```typescript
// Blob: reference the original buffer slice
function parseBlobContent(id: ObjectId, content: Uint8Array): Blob {
  return { type: 'blob', id, content: content.subarray(0) };
}

// Tree: raw byte access for hash extraction
function parseTreeEntry(
  buffer: Uint8Array,
  offset: number,
  hash: HashConfig
): { entry: TreeEntry; nextOffset: number } {
  // Read mode (scan until space 0x20)
  // Read name (scan until null 0x00)
  // Read hash.digestLength raw bytes, convert to hex via bytesToHex
  // No buffer allocation for the entry itself
}
```

For commits and tags, string decoding via `TextDecoder` is required (field values are text).

**GC trade-off:** `subarray()` creates a view over the original buffer, not a copy. The original decompressed buffer cannot be garbage collected while any view (e.g., a blob's `content`) references it. For large repos with many parsed objects:
- **Default:** zero-copy via `subarray()` — fastest, lowest allocation
- **When to copy:** If the caller needs to release the source buffer (e.g., after processing a packfile), call `new Uint8Array(blob.content)` to create an independent copy. This is the caller's responsibility, not the parser's.

---

## 6. Error Types

Scoped to Phase 1 (domain object model) only. Later phases add their own error variants (e.g., `MERGE_CONFLICT`, `NETWORK_ERROR`, `REF_NOT_FOUND`).

```typescript
// Phase 1 domain errors
type DomainObjectError =
  | { readonly code: 'INVALID_OBJECT_ID'; readonly value: string }
  | { readonly code: 'INVALID_OBJECT_HEADER'; readonly reason: string }
  | { readonly code: 'INVALID_TREE_ENTRY'; readonly offset: number; readonly reason: string }
  | { readonly code: 'INVALID_COMMIT'; readonly reason: string }
  | { readonly code: 'INVALID_TAG'; readonly reason: string }
  | { readonly code: 'INVALID_FILE_MODE'; readonly value: string }
  | { readonly code: 'INVALID_IDENTITY'; readonly line: string; readonly reason: string };
```

**Error class structure:**

```typescript
class TsgitError extends Error {
  constructor(readonly data: DomainObjectError) {
    super(`${data.code}: ${'reason' in data ? data.reason : 'value' in data ? data.value : ''}`);
    this.name = 'TsgitError';
  }
}
```

Errors are thrown as `TsgitError` instances — pattern-matchable via `switch (error.data.code)`, with stack traces via `Error` inheritance. The `data` property carries the discriminated union.

**Factory functions** (one per error code, for readability):

```typescript
const invalidObjectId = (value: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OBJECT_ID', value });

const invalidObjectHeader = (reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_OBJECT_HEADER', reason });

// ... etc
```

Later phases extend the union:

```typescript
// Phase 2+
type StorageError = { readonly code: 'OBJECT_NOT_FOUND'; readonly objectId: ObjectId } | ...;
// Phase 5+
type MergeError = { readonly code: 'MERGE_CONFLICT'; readonly conflicts: ReadonlyArray<FilePath> } | ...;
// Full union
type TsgitErrorData = DomainObjectError | StorageError | MergeError | ...;
```

---

## 7. Key Design Decisions

### 7.1 Branded Types vs Classes

**Decision:** Branded string types for `ObjectId`, `RefName`, `FilePath`. Not classes.

**Why:** Branded types are zero-runtime-cost (just type-level branding). They serialize to plain strings in JSON. They work with `===` comparison. Classes would add prototype chain overhead and break structural equality.

### 7.2 Readonly Everywhere

**Decision:** All properties on all domain types are `readonly`. All arrays are `ReadonlyArray`.

**Why:** Immutability is a core principle (PRD section 5.1). Git objects are content-addressed — mutating one would change its identity. Readonly enforcement catches mutations at compile time.

### 7.3 Uint8Array, Not Buffer

**Decision:** Use `Uint8Array` throughout, never Node.js `Buffer`.

**Why:** `Uint8Array` is available on all platforms (Node, browser, Deno, edge). `Buffer` is Node-only. Since `Buffer` extends `Uint8Array`, Node code can pass `Buffer` instances transparently — no conversion needed.

### 7.4 Error Strategy

**Decision:** Throw `TsgitError` class instances with a `.data` discriminated union. Not `Result<T, E>`.

**Why:** Git operations are I/O-heavy with deep call stacks. `Result` types would require wrapping at every level, adding boilerplate without benefit. Thrown errors with typed `.data` provide both stack traces and pattern matching. The public API can optionally wrap in `Result` at the boundary if users prefer it.

### 7.5 Extra Headers Preservation

**Decision:** Parse and preserve unknown commit/tag headers in `extraHeaders`.

**Why:** Roundtrip fidelity. Git allows arbitrary headers (e.g. `encoding`, `mergetag`, custom signing). Dropping them would produce different bytes on re-serialization, changing the SHA — a correctness bug.

---

## 8. Testing Strategy

### 8.1 Unit Tests

Every parser/serializer pair gets:
- **Roundtrip test**: `serialize(parse(bytes))` === `bytes` (byte-identical)
- **Known-value tests**: Parse hand-crafted binary data, assert field values
- **Edge cases**: Empty blob, tree with single entry, commit with 0 parents, commit with 10 parents, GPG-signed commit, tag pointing to tag
- **Error cases**: Truncated input, invalid mode, non-hex SHA, missing required field

### 8.2 Property-Based Tests (fast-check)

```typescript
// Roundtrip: arbitrary blob content
fc.assert(
  fc.property(fc.uint8Array({ minLength: 0, maxLength: 10000 }), (content) => {
    const serialized = serializeBlobContent({ type: 'blob', id: dummyId, content });
    const parsed = parseBlobContent(dummyId, serialized);
    expect(parsed.content).toEqual(content);
  })
);

// Tree entry sort is idempotent
fc.assert(
  fc.property(fc.array(arbTreeEntry()), (entries) => {
    const sorted = sortTreeEntries(entries);
    const resorted = sortTreeEntries(sorted);
    expect(resorted).toEqual(sorted);
  })
);

// Tree entry sort matches byte comparison
fc.assert(
  fc.property(fc.array(arbTreeEntry()), (entries) => {
    const sorted = sortTreeEntries(entries);
    for (let i = 1; i < sorted.length; i++) {
      expect(treeEntryCompare(sorted[i - 1]!, sorted[i]!)).toBeLessThanOrEqual(0);
    }
  })
);

// Commit roundtrip: parse(serialize(commit)) preserves all fields
fc.assert(
  fc.property(arbCommitData(), (data) => {
    const commit: Commit = { type: 'commit', id: dummyId, data };
    const bytes = serializeCommitContent(commit);
    const parsed = parseCommitContent(dummyId, bytes);
    expect(parsed.data).toEqual(data);
  })
);
```

### 8.3 Interop Tests

Parse real objects extracted from canonical git repositories. Verify field values match `git cat-file` output.

### 8.4 ObjectId Verification Strategy

The parser does NOT verify that `id` matches the actual SHA of the content. This is intentional:
- **Parsing is a hot path** — hashing on every parse doubles the cost
- **The storage layer** (Phase 2) is responsible for verifying SHA integrity when reading from disk
- **The caller** computes the id before calling `parseObject` and is responsible for correctness
- An optional `verifyObject(object, rawBytes, hashFn)` utility can be provided for callers who want explicit verification

---

## 9. Implementation Order

1. `encoding.ts` — bytesToHex, hexToBytes, compareBytes, indexOf, TextEncoder/Decoder wrappers
2. `error.ts` — TsgitError class, DomainObjectError union, factory functions
3. `hash-config.ts` — HashConfig type, SHA1_CONFIG, SHA256_CONFIG
4. `object-id.ts` — ObjectId branded type + smart constructor (depends on encoding, error)
5. `file-mode.ts` — FileMode constant + validation + normalize (depends on error)
6. `author-identity.ts` — parse/serialize identity lines (depends on error)
7. `header.ts` — object header parse/serialize (depends on encoding, error)
8. `blob.ts` — simplest object type (depends on header)
9. `tree.ts` — binary format with raw hash bytes + sort (depends on encoding, hash-config, object-id, file-mode)
10. `commit.ts` — text format with identity + extra headers + gpgsig extraction (depends on encoding, object-id, author-identity)
11. `tag.ts` — similar to commit (depends on encoding, object-id, author-identity)
12. `git-object.ts` — GitObject discriminated union + dispatch parser (depends on all above)

Each step: test (red) → implement (green) → refactor. TDD throughout.
