# Plan: Phase 1 — Domain Object Model

Implements [design/domain-object-model.md](../design/domain-object-model.md).
Covers [backlog](../BACKLOG.md) items 1.1–1.8.

### Backlog → Step Mapping

| Backlog Item | Description | Steps |
|---|---|---|
| **1.1** | Value objects: ObjectId, RefName, FilePath, FileMode, AuthorIdentity | 3 (HashConfig), 4 (ObjectId, RefName, FilePath), 5 (FileMode), 6 (AuthorIdentity) |
| **1.2** | Blob: type, parse, serialize | 8 |
| **1.3** | Tree: type, TreeEntry, parse, serialize | 9 |
| **1.4** | Commit: type, CommitData, parse, serialize | 10 |
| **1.5** | Tag: type, TagData, parse, serialize | 11 |
| **1.6** | GitObject discriminated union | 12 |
| **1.7** | Object header parsing | 7 |
| **1.8** | Error types: TsgitError | 2 |
| — | Encoding utilities (shared foundation) | 1 |
| — | Barrel export | 13 |
| — | Final verification | 14 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step run: `npm run check:types && npm run test:unit && npm run check:architecture`

**Commit strategy:** One commit per completed step (green + refactor). Message format: `feat(domain): add <module> — <what it does>`. This keeps the feature branch bisectable.

## Prerequisites (before step 1)

1. Create directories: `src/domain/objects/`, `test/unit/domain/objects/`
2. Remove scaffold test: `test/unit/sample.test.ts`
3. In `vitest.config.ts`, change coverage `include` from `['src/**/*.ts']` to `['src/domain/**/*.ts']`. This prevents empty barrels in other directories (adapters, operators, transport) from breaking 100% thresholds. **Restore to `['src/**/*.ts']` when Phase 2+ adds code to those directories.**
4. Update `cspell.json` as needed throughout — new domain terms in code may trigger spelling failures

## File Conventions

- All source files under `src/domain/objects/`
- All test files under `test/unit/domain/objects/`
- File names: kebab-case (enforced by ls-lint)
- Test names: `<module>.test.ts`
- Test format: Given/When/Then titles, AAA body, `sut` variable
- **Import extensions:** All imports MUST use `.js` extension (`import { bytesToHex } from './encoding.js'`). Required by `"module": "Node16"` in tsconfig.

## Design Decisions (applied in this plan)

- **`parseContinuationValue` lives in `encoding.ts`**, not in `commit.ts`. It's a generic text-processing utility (strip leading space from continuation lines, join multi-line values). Both `commit.ts` and `tag.ts` import it from `encoding.ts`. It is **not** exported from the public barrel — it's internal to the domain.
- **Commit/tag parsers are lenient on SHA length.** `ObjectId.from()` accepts both 40 and 64 chars. The parser does not enforce that all SHAs in a commit match a specific `HashConfig`. This follows Postel's law: be liberal in what you accept. The storage layer (Phase 2) is responsible for SHA format consistency within a repository.
- **`RefName.from` and `FilePath.from` throw plain `Error`**, not `TsgitError`. They are simple non-empty-string guards, not domain parsing errors. This avoids bloating `DomainObjectError` with trivial validation variants.
- **`bytesToHex` uses a pre-computed lookup table** for performance (called per tree entry SHA — hot path). The initial implementation can use `toString(16)`, then optimize in the refactor step with a 256-entry hex table.
- **`hexToBytes` throws plain `Error`** on odd length or invalid chars — same rationale as `RefName.from`/`FilePath.from`. It's a generic encoding utility, not a git domain error.
- **`parseContinuationValue` caller responsibility:** The caller splits the header line into `key` and `value`, then passes the value as `lines[startIndex]`. Subsequent lines starting with space `0x20` are continuation lines — the function strips the leading space and joins them with `\n`. The caller handles key extraction; the function handles multi-line value assembly.
- **fast-check arbitraries** for domain types (`arbObjectId`, `arbTreeEntry`, `arbCommitData`, etc.) are created as shared test fixtures in `test/unit/domain/objects/arbitraries.ts`. Created in step 4 (first step needing arbitraries), extended incrementally in steps 9, 10.
- **Tests import directly from source modules**, not from the barrel. Example: `import { treeEntryCompare } from '../../../src/domain/objects/tree.js'`. The barrel (`index.ts`) is for library consumers. Tests may access internals that the barrel doesn't export.

---

## Step 1: `encoding.ts` — Binary Encoding Utilities

**Create:** `src/domain/objects/encoding.ts`
**Test:** `test/unit/domain/objects/encoding.test.ts`

Shared helpers used by every subsequent module. No domain dependencies.
Can be built in parallel with steps 2 and 3 (no interdependencies).

### Test first (red):

```
Given a byte array [0xde, 0xad], When converting to hex, Then returns 'dead'
Given a hex string 'dead', When converting to bytes, Then returns Uint8Array [0xde, 0xad]
Given an empty hex string, When converting to bytes, Then returns empty Uint8Array
Given an odd-length hex string, When converting to bytes, Then throws
Given a hex string with non-hex chars, When converting to bytes, Then throws
Given two identical byte arrays, When comparing, Then returns 0
Given [0x01] and [0x02], When comparing, Then returns negative number
Given [0x02] and [0x01], When comparing, Then returns positive number
Given [0x01, 0x02] and [0x01], When comparing, Then returns positive (longer)
Given a byte array with target byte, When searching with indexOf, Then returns correct position
Given a byte array without target byte, When searching with indexOf, Then returns -1
Given fromIndex beyond array length, When searching with indexOf, Then returns -1
Given a string, When encoding to bytes, Then returns UTF-8 Uint8Array
Given a Uint8Array, When decoding to string, Then returns UTF-8 string
Given an empty string, When encoding to bytes, Then returns empty Uint8Array
Given multi-byte UTF-8 chars, When encoding then decoding, Then roundtrips correctly
Given lines ['first line', ' continuation'], When parsing continuation at index 0, Then value='first line\ncontinuation' and endIndex=1
Given lines ['header', ' line2', ' line3', 'next'], When parsing continuation at 0, Then value='header\nline2\nline3' and endIndex=2
Given lines ['gpgsig value', ' ', ' more'], When parsing continuation at 0, Then blank continuation (' ') becomes empty line in value
Given lines ['single'], When parsing continuation at 0, Then value='single' and endIndex=0
```

### Implement (green):

- `bytesToHex(bytes: Uint8Array): string` — initial impl with `toString(16)`, refactor to lookup table
- `hexToBytes(hex: string): Uint8Array` — throws on odd length or invalid chars
- `compareBytes(a: Uint8Array, b: Uint8Array): number`
- `indexOf(bytes: Uint8Array, target: number, fromIndex: number): number`
- `encode(str: string): Uint8Array` (wraps TextEncoder)
- `decode(bytes: Uint8Array): string` (wraps TextDecoder)
- `parseContinuationValue(lines: ReadonlyArray<string>, startIndex: number): { value: string; endIndex: number }` — generic multi-line header parser. Strips leading space from continuation lines. Used by commit.ts and tag.ts for gpgsig, mergetag, and any multi-line header. Internal — not exported from public barrel.

### Property-based tests:

- Roundtrip: `bytesToHex(hexToBytes(hex)) === hex` for any valid even-length hex string
- Roundtrip: `hexToBytes(bytesToHex(bytes))` equals original bytes
- Reflexive: `compareBytes(a, a) === 0` for any array
- Antisymmetric: `Math.sign(compareBytes(a, b)) === -Math.sign(compareBytes(b, a))`

---

## Step 2: `error.ts` — Error Types and Factories

**Create:** `src/domain/objects/error.ts`
**Test:** `test/unit/domain/objects/error.test.ts`

Must exist before any parser can be tested (parsers throw on invalid input).
Can be built in parallel with steps 1 and 3 (no interdependencies).

### Test first (red):

```
Given invalidObjectId('xyz'), When checking error.data.code, Then equals 'INVALID_OBJECT_ID'
Given invalidObjectId('xyz'), When checking error.data.value, Then equals 'xyz'
Given invalidObjectHeader('bad'), When checking error.data.code, Then equals 'INVALID_OBJECT_HEADER'
Given invalidTreeEntry(5, 'truncated'), When checking error.data, Then offset is 5 and reason is 'truncated'
Given invalidCommit('missing tree'), When checking error.data.code, Then equals 'INVALID_COMMIT'
Given invalidTag('missing object'), When checking error.data.code, Then equals 'INVALID_TAG'
Given invalidFileMode('999'), When checking error.data.code, Then equals 'INVALID_FILE_MODE'
Given invalidIdentity('bad', 'no email'), When checking error.data, Then line and reason correct
Given a TsgitError, When checking instanceof Error, Then returns true
Given a TsgitError, When accessing .name, Then equals 'TsgitError'
Given a TsgitError, When accessing .message, Then contains the error code
Given a TsgitError, When accessing .stack, Then stack trace exists
Given a TsgitError, When switching on data.code in exhaustive switch, Then all 7 cases are handleable
```

### Implement (green):

- `DomainObjectError` discriminated union type (7 variants: `INVALID_OBJECT_ID`, `INVALID_OBJECT_HEADER`, `INVALID_TREE_ENTRY`, `INVALID_COMMIT`, `INVALID_TAG`, `INVALID_FILE_MODE`, `INVALID_IDENTITY`)
- `TsgitError` class extending `Error` with `readonly data` property and `name = 'TsgitError'`
- Factory functions: `invalidObjectId`, `invalidObjectHeader`, `invalidTreeEntry`, `invalidCommit`, `invalidTag`, `invalidFileMode`, `invalidIdentity`

Note: `RefName.from` and `FilePath.from` (step 4) throw plain `Error`, not `TsgitError` — they are simple non-empty guards, not domain parsing errors.

---

## Step 3: `hash-config.ts` — Hash Configuration

**Create:** `src/domain/objects/hash-config.ts`
**Test:** `test/unit/domain/objects/hash-config.test.ts`

Tiny module. Can be built in parallel with steps 1 and 2 (no interdependencies).

### Test first (red):

```
Given SHA1_CONFIG, When reading digestLength, Then returns 20
Given SHA1_CONFIG, When reading hexLength, Then returns 40
Given SHA256_CONFIG, When reading digestLength, Then returns 32
Given SHA256_CONFIG, When reading hexLength, Then returns 64
```

### Implement (green):

- `HashConfig` readonly interface
- `SHA1_CONFIG` frozen constant
- `SHA256_CONFIG` frozen constant

---

## Step 4: `object-id.ts` — ObjectId, RefName, FilePath Branded Types

**Create:** `src/domain/objects/object-id.ts`
**Test:** `test/unit/domain/objects/object-id.test.ts`

Depends on: `encoding.ts`, `error.ts`

Creates all three branded types. `RefName` and `FilePath` have simple smart constructors (non-empty string validation). `ObjectId` has hex validation + raw byte conversion.

### Test first (red):

```
Given a valid 40-char hex string, When calling ObjectId.from, Then returns branded ObjectId
Given a valid 64-char hex string, When calling ObjectId.from, Then returns branded ObjectId
Given an invalid hex string, When calling ObjectId.from, Then throws INVALID_OBJECT_ID
Given an empty string, When calling ObjectId.from, Then throws INVALID_OBJECT_ID
Given uppercase hex, When calling ObjectId.from, Then throws INVALID_OBJECT_ID
Given a 39-char hex string, When calling ObjectId.from, Then throws INVALID_OBJECT_ID
Given a 20-byte Uint8Array, When calling ObjectId.fromRaw, Then returns 40-char hex ObjectId
Given a 32-byte Uint8Array, When calling ObjectId.fromRaw, Then returns 64-char hex ObjectId
Given a 19-byte Uint8Array, When calling ObjectId.fromRaw, Then throws INVALID_OBJECT_ID
Given a 0-byte Uint8Array, When calling ObjectId.fromRaw, Then throws INVALID_OBJECT_ID
Given two ObjectIds from same hex, When comparing with ===, Then returns true
Given a non-empty string, When calling RefName.from, Then returns branded RefName
Given an empty string, When calling RefName.from, Then throws Error (plain Error, not TsgitError)
Given a non-empty string, When calling FilePath.from, Then returns branded FilePath
Given an empty string, When calling FilePath.from, Then throws Error (plain Error, not TsgitError)
```

### Property-based tests:

- Roundtrip: `ObjectId.fromRaw(hexToBytes(id))` equals the original id for valid 40-char ids
- Roundtrip: `ObjectId.fromRaw(hexToBytes(id))` equals the original id for valid 64-char ids
- Create `test/unit/domain/objects/arbitraries.ts` with `arbObjectId()` (generates valid 40-char lowercase hex). Extend in steps 9, 10 with `arbTreeEntry()`, `arbCommitData()`, etc.

### Implementation note:

TypeScript companion object pattern — same name for type and const:

```typescript
type ObjectId = string & { readonly __brand: unique symbol };
const ObjectId = { from: ..., fromRaw: ... };
// Both exported, TS resolves by context (type position vs value position)
```

---

## Step 5: `file-mode.ts` — FileMode Constant and Validation

**Create:** `src/domain/objects/file-mode.ts`
**Test:** `test/unit/domain/objects/file-mode.test.ts`

Depends on: `error.ts`

### Test first (red):

```
Given '100644', When validating, Then returns '100644' (REGULAR)
Given '100755', When validating, Then returns '100755' (EXECUTABLE)
Given '120000', When validating, Then returns '120000' (SYMLINK)
Given '40000', When validating, Then returns '40000' (DIRECTORY)
Given '160000', When validating, Then returns '160000' (GITLINK)
Given '999999', When validating, Then throws INVALID_FILE_MODE
Given '', When validating, Then throws INVALID_FILE_MODE
Given '040000', When normalizing, Then returns '40000'
Given '100644', When normalizing, Then returns '100644' (already normalized, idempotent)
Given '40000', When normalizing, Then returns '40000' (already normalized, idempotent)
Given '999999', When normalizing, Then throws INVALID_FILE_MODE
Given '40000', When checking isDirectory, Then returns true
Given '100644', When checking isDirectory, Then returns false
Given '100755', When checking isDirectory, Then returns false
```

`normalizeFileMode` normalizes first (`040000` → `40000`), then validates. Invalid modes throw even after normalization.

### Implement (green):

- `FILE_MODE` constant object
- `FileMode` type
- `validateFileMode(mode: string): FileMode`
- `normalizeFileMode(mode: string): FileMode` — normalize then validate
- `isDirectory(mode: FileMode): boolean`

---

## Step 6: `author-identity.ts` — Identity Parse/Serialize

**Create:** `src/domain/objects/author-identity.ts`
**Test:** `test/unit/domain/objects/author-identity.test.ts`

Depends on: `error.ts`

### Parsing algorithm:

Git uses the **last** `<` and `>` pair to find the email, not the first — because names can legally contain angle brackets. The parser must:
1. Find the last `>` in the line
2. Find the last `<` before that `>`
3. Everything before `<` (trimmed) is the name
4. Everything between `<` and `>` is the email
5. Everything after `> ` is `<timestamp> <timezone>`

### Test first (red):

```
Given 'Alice <alice@example.com> 1234567890 +0200', When parsing, Then name='Alice', email='alice@example.com', timestamp=1234567890, tz='+0200'
Given identity with negative timestamp, When parsing, Then timestamp is negative number
Given identity with -0500 timezone, When parsing, Then timezoneOffset is '-0500'
Given identity with +0000 timezone, When parsing, Then timezoneOffset is '+0000'
Given identity with -0000 timezone, When parsing, Then timezoneOffset is '-0000'
Given identity with empty name '<e@x.com> 0 +0000', When parsing, Then name is ''
Given 'A <B> C <real@email.com> 123 +0000', When parsing, Then email is 'real@email.com' (last <> pair)
Given malformed identity (no angle brackets), When parsing, Then throws INVALID_IDENTITY
Given malformed identity (no timestamp after >), When parsing, Then throws INVALID_IDENTITY
Given malformed identity (no timezone), When parsing, Then throws INVALID_IDENTITY
Given an AuthorIdentity, When serializing, Then produces 'Name <email> timestamp tz'
Given identity with empty name, When serializing, Then produces ' <email> timestamp tz'
Given an AuthorIdentity, When roundtripping parse(serialize(identity)), Then equals original
```

### Property-based tests:

- Roundtrip: `parseIdentity(serializeIdentity(identity))` equals original for valid identities (name without `<>`, email without spaces)

---

## Step 7: `header.ts` — Object Header Parse/Serialize

**Create:** `src/domain/objects/header.ts`
**Test:** `test/unit/domain/objects/header.test.ts`

Depends on: `encoding.ts`, `error.ts`

### Test first (red):

```
Given 'blob 12\0' as bytes, When parsing, Then type='blob', size=12
Given 'tree 0\0' as bytes, When parsing, Then type='tree', size=0
Given 'commit 1234\0' as bytes, When parsing, Then type='commit', size=1234
Given 'tag 56\0' as bytes, When parsing, Then type='tag', size=56
Given 'blob 12\0<content>' as bytes, When parsing, Then contentOffset=8 (points past null)
Given 'invalid 12\0' as bytes, When parsing, Then throws INVALID_OBJECT_HEADER
Given bytes with no null terminator, When parsing, Then throws INVALID_OBJECT_HEADER
Given bytes with no space, When parsing, Then throws INVALID_OBJECT_HEADER
Given 'blob abc\0' (non-numeric size), When parsing, Then throws INVALID_OBJECT_HEADER
Given 'blob' type and size 42, When serializing, Then produces bytes for 'blob 42\0'
Given 'tree' type and size 0, When serializing, Then produces bytes for 'tree 0\0'
Given type and size, When roundtripping parse(serialize(type, size)), Then type and size match
```

### Implement (green):

- `ObjectType` type: `'blob' | 'tree' | 'commit' | 'tag'`
- `parseHeader(rawBytes: Uint8Array): { type: ObjectType; size: number; contentOffset: number }`
- `serializeHeader(type: ObjectType, contentSize: number): Uint8Array`

---

## Step 8: `blob.ts` — Blob Type and Parse/Serialize

**Create:** `src/domain/objects/blob.ts`
**Test:** `test/unit/domain/objects/blob.test.ts`

Depends on: `object-id.ts`

### Test first (red):

```
Given raw content bytes, When parsing blob, Then content shares the same ArrayBuffer (zero-copy)
Given empty content (0 bytes), When parsing blob, Then blob.content.length is 0
Given a blob, When serializing, Then returns byte-identical content
Given a blob, When roundtripping parse(serialize(blob)), Then content is byte-identical
Given binary content (all 256 byte values), When parsing blob, Then all bytes preserved
```

### Zero-copy verification:

```typescript
// Verify zero-copy by checking buffer identity
const source = new Uint8Array([1, 2, 3]);
const sut = parseBlobContent(dummyId, source);
expect(sut.content.buffer).toBe(source.buffer); // Same underlying ArrayBuffer
```

### Property-based tests:

- Roundtrip: `parseBlobContent(id, serializeBlobContent(blob)).content` equals original content for arbitrary `Uint8Array` (0–10000 bytes)

### Implement (green):

- `Blob` interface
- `parseBlobContent(id: ObjectId, content: Uint8Array): Blob`
- `serializeBlobContent(blob: Blob): Uint8Array`

---

## Step 9: `tree.ts` — Tree Type, Parse/Serialize, Sort

**Create:** `src/domain/objects/tree.ts`
**Test:** `test/unit/domain/objects/tree.test.ts`

Depends on: `encoding.ts`, `error.ts`, `hash-config.ts`, `object-id.ts`, `file-mode.ts`

Most complex parser. Binary format with raw hash bytes.

### Test first (red):

```
Given a single entry '100644 hello.txt\0<20-byte-sha>', When parsing with SHA1_CONFIG, Then mode='100644', name='hello.txt', id=hex of sha
Given multiple entries concatenated, When parsing, Then returns all entries in order
Given directory mode '40000' in bytes, When parsing, Then mode is '40000' (not '040000')
Given entry with non-ASCII UTF-8 name, When parsing, Then name is correctly decoded
Given entry with name containing a space, When parsing, Then name includes the space
Given SHA-256 tree (32-byte hashes), When parsing with SHA256_CONFIG, Then ObjectIds are 64-char hex
Given truncated content (cuts off mid-hash), When parsing, Then throws INVALID_TREE_ENTRY
Given truncated content (no null after name), When parsing, Then throws INVALID_TREE_ENTRY
Given empty content (0 bytes), When parsing, Then entries is empty array
Given tree with entries, When serializing with SHA1_CONFIG, Then produces byte-identical binary
Given tree with sorted entries from a real git tree, When roundtripping parse(serialize(tree)), Then output bytes are identical to input bytes
Given unsorted entries, When serializing, Then entries are written in sorted order
Given entries 'foo' (file) and 'foo.c' (file), When sorting, Then 'foo' comes before 'foo.c'
Given entries 'foo' (dir) and 'foo.c' (file), When sorting, Then 'foo.c' comes before 'foo' (dir gets virtual '/')
Given entries 'foo' (dir) and 'foo-bar' (file), When sorting, Then 'foo-bar' comes before 'foo' (dir)
Given multiple directories, When sorting, Then sorted by byte-level comparison with trailing '/'
```

`serializeTreeContent` auto-sorts entries before writing. Git requires sorted tree entries — producing unsorted output would create an invalid object.

### Property-based tests:

- Sort is idempotent: `sort(sort(entries))` equals `sort(entries)`
- Sort is byte-consistent: for adjacent sorted entries, `treeEntryCompare(a, b) <= 0`
- Tree roundtrip: `parseTreeContent(id, serializeTreeContent(tree, hash), hash)` preserves all entries
- Arbitraries: create `arbTreeEntry()` in `test/unit/domain/objects/arbitraries.ts` (valid mode, non-empty name without null bytes, valid ObjectId)

### Implement (green):

- `TreeEntry` interface
- `Tree` interface
- `parseTreeContent(id: ObjectId, content: Uint8Array, hash: HashConfig): Tree`
- `serializeTreeContent(tree: Tree, hash: HashConfig): Uint8Array` — auto-sorts entries
- `sortTreeEntries(entries: ReadonlyArray<TreeEntry>): ReadonlyArray<TreeEntry>`
- `treeEntryCompare(a: TreeEntry, b: TreeEntry): number`

---

## Step 10: `commit.ts` — Commit Type, Parse/Serialize

**Create:** `src/domain/objects/commit.ts`
**Test:** `test/unit/domain/objects/commit.test.ts`

Depends on: `encoding.ts`, `error.ts`, `object-id.ts`, `author-identity.ts`

### Continuation lines:

Any header value can span multiple lines. Continuation lines are prefixed with a single space `0x20`. This applies to `gpgsig`, `mergetag`, and any unknown header. Uses `parseContinuationValue` from `encoding.ts` (created in step 1).

### Test first (red):

```
Given a minimal commit (tree + author + committer + message), When parsing, Then all fields correct and extraHeaders is empty array
Given a commit with 0 parents (root commit), When parsing, Then parents is empty array
Given a commit with 1 parent, When parsing, Then parents has one entry
Given a commit with 3 parents (octopus merge), When parsing, Then parents has three entries
Given a commit with gpgsig header, When parsing, Then gpgSignature contains the full signature
Given a commit with gpgsig header, When parsing, Then extraHeaders does NOT contain gpgsig
Given gpgsig with continuation lines (leading space), When parsing, Then spaces are stripped from each line
Given gpgsig with blank lines inside PGP block, When parsing, Then blank continuation lines (just 0x20) are preserved as empty lines
Given a commit with encoding header, When parsing, Then encoding is in extraHeaders
Given a commit with mergetag header (multi-line), When parsing, Then mergetag is in extraHeaders with continuation lines joined
Given a commit with unknown extra header, When parsing, Then it is preserved in extraHeaders
Given content with missing tree field, When parsing, Then throws INVALID_COMMIT
Given content with tree not as first line, When parsing, Then throws INVALID_COMMIT
Given a commit with empty message, When parsing, Then message is ''
Given a commit with message without trailing newline, When parsing, Then message has no trailing newline
Given a commit, When serializing, Then gpgsig is written with continuation lines (leading space per line)
Given a commit, When serializing, Then extraHeaders appear after committer, before blank line, with continuation lines
Given a commit, When roundtripping parse(serialize(commit)), Then all fields match byte-for-byte
Given a GPG-signed commit from real git, When roundtripping, Then bytes are identical
```

### Property-based tests:

- Roundtrip: `parseCommitContent(id, serializeCommitContent(commit))` preserves all fields
- Arbitraries: create `arbCommitData()` in `test/unit/domain/objects/arbitraries.ts` (valid tree ObjectId, 0-3 parent ObjectIds, valid identities, message without null bytes)

### Implement (green):

- `CommitData` interface, `ExtraHeader` interface
- `Commit` interface
- `parseCommitContent(id: ObjectId, content: Uint8Array): Commit`
- `serializeCommitContent(commit: Commit): Uint8Array`
- Uses `parseContinuationValue` from `encoding.ts` for gpgsig, mergetag, and any multi-line header

---

## Step 11: `tag.ts` — Tag Type, Parse/Serialize

**Create:** `src/domain/objects/tag.ts`
**Test:** `test/unit/domain/objects/tag.test.ts`

Depends on: `encoding.ts`, `error.ts`, `object-id.ts`, `author-identity.ts`

Uses `parseContinuationValue` from `encoding.ts` (same as commit.ts — no coupling between peer modules).

### Test first (red):

```
Given a complete tag, When parsing, Then object, objectType, tagName, tagger, message are correct and extraHeaders is empty array
Given a tag without tagger field, When parsing, Then tagger is undefined
Given a tag with gpgsig header, When parsing, Then gpgSignature extracted, excluded from extraHeaders
Given a tag with extra headers (continuation lines), When parsing, Then extraHeaders preserves them
Given a tag pointing to another tag, When parsing, Then objectType is 'tag'
Given a tag pointing to a blob, When parsing, Then objectType is 'blob'
Given a tag with invalid objectType, When parsing, Then throws INVALID_TAG
Given content missing object field, When parsing, Then throws INVALID_TAG
Given content missing type field, When parsing, Then throws INVALID_TAG
Given a tag, When serializing, Then produces correct format with fields in order
Given a tag without tagger, When serializing, Then tagger line is omitted
Given a tag with extraHeaders, When serializing, Then extra headers appear with continuation lines
Given a tag, When roundtripping parse(serialize(tag)), Then all fields match
```

### Implement (green):

- `TagData` interface
- `Tag` interface
- `parseTagContent(id: ObjectId, content: Uint8Array): Tag`
- `serializeTagContent(tag: Tag): Uint8Array`

---

## Step 12: `git-object.ts` — Discriminated Union + Dispatch Parser

**Create:** `src/domain/objects/git-object.ts`
**Test:** `test/unit/domain/objects/git-object.test.ts`

Depends on: all above modules.

### Test first (red):

```
Given raw blob bytes (header + content), When calling parseObject, Then returns Blob with correct content
Given raw tree bytes (header + content), When calling parseObject, Then returns Tree with correct entries
Given raw commit bytes (header + content), When calling parseObject, Then returns Commit with correct fields
Given raw tag bytes (header + content), When calling parseObject, Then returns Tag with correct fields
Given raw bytes with invalid header type, When calling parseObject, Then throws INVALID_OBJECT_HEADER
Given header size != actual content length, When calling parseObject, Then throws INVALID_OBJECT_HEADER
Given a Blob, When calling serializeObject, Then produces header + content bytes
Given a Tree, When calling serializeObject, Then produces header + content bytes
Given any GitObject, When roundtripping parseObject(serializeObject(obj)), Then equals original
```

### Exhaustive type checking:

Verified by `npm run check:types`, not by a runtime test. Implement a `assertNever` helper:

```typescript
function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${value}`);
}

// In parseObject/serializeObject switch:
switch (type) {
  case 'blob': ...
  case 'tree': ...
  case 'commit': ...
  case 'tag': ...
  default: assertNever(type); // Compile error if a case is missing
}
```

This is compile-time enforced — no runtime test needed. `check:types` catches it.

### Implement (green):

- `GitObject` type alias (union of Blob | Tree | Commit | Tag)
- `parseObject(id: ObjectId, rawBytes: Uint8Array, hash: HashConfig): GitObject` — `HashConfig` is only passed to tree parsing; commit/tag ignore it (SHA leniency decision)
- `serializeObject(object: GitObject, hash: HashConfig): Uint8Array` — same: `HashConfig` only affects tree serialization
- `assertNever(value: never): never` utility

---

## Step 13: `index.ts` — Barrel Export

**Update:** `src/domain/objects/index.ts`
**No test file needed** — barrel exports are verified by `check:types` and `check:dead-code`.

Re-export all **public** types and functions:
- Types: `ObjectId`, `RefName`, `FilePath`, `FileMode`, `AuthorIdentity`, `HashConfig`, `GitObject`, `Blob`, `Tree`, `TreeEntry`, `Commit`, `CommitData`, `Tag`, `TagData`, `ExtraHeader`, `TsgitError`, `DomainObjectError`, `ObjectType`
- Constants: `FILE_MODE`, `SHA1_CONFIG`, `SHA256_CONFIG`
- Functions: all `parse*Content`, `serialize*Content`, `parseObject`, `serializeObject`, `parseHeader`, `serializeHeader`, `parseIdentity`, `serializeIdentity`, `sortTreeEntries`, `ObjectId.from`, `ObjectId.fromRaw`, `RefName.from`, `FilePath.from`, `validateFileMode`, `normalizeFileMode`, `isDirectory`
- Utilities: `bytesToHex`, `hexToBytes`

**Not exported** (internal): `parseContinuationValue`, `treeEntryCompare`, `assertNever`, `indexOf`, `encode`, `decode`, `compareBytes`

Update `src/domain/index.ts` to re-export from `./objects/index.js`.

---

## Step 14: Final Verification

```bash
npm run check               # biome lint + format
npm run check:types         # tsc strict
npm run check:architecture  # dependency-cruiser (domain has no outward imports)
npm run check:spelling      # cspell
npm run check:dead-code     # knip (no unused exports)
npm run check:duplicates    # jscpd
npm run test:coverage       # 100% on all KPIs
npm run test:mutation:incremental  # stryker (target: 0 survivors)
npm run build               # rollup produces dist/
```

Then:
- Update `docs/BACKLOG.md`: mark items 1.1–1.8 as `[x]`

---

## Dependencies Between Steps

```
┌──────────────────────────────────────────────────────────────┐
│  Steps 1, 2, 3 can be built in PARALLEL (no interdeps)       │
└──────────────────────────────────────────────────────────────┘

Step 1 (encoding)   Step 2 (error)   Step 3 (hash-config)
         │                │                   │
         ├────────────────┼───────────────────┤
         │                │                   │
         ▼                ▼                   │
   Step 4 (object-id + refname + filepath)    │
         │                                    │
         ├──────────── Step 5 (file-mode) ────┘
         │                    │
         ├──── Step 6 ────────┤
         │   (identity)       │
         │                    │
         ▼                    ▼
   Step 7 (header)    Step 9 (tree) ←── needs encoding + hash-config
         │                    │          + object-id + file-mode
         ▼                    │          (NO dependency on header)
   Step 8 (blob)              │
         │                    │
         ├────────────────────┤
         │                    │
         ▼                    ▼
   Step 10 (commit)    Step 11 (tag)  ←── can be built in PARALLEL
         │                    │            both use encoding.ts for
         └────────┬───────────┘            parseContinuationValue
                  │
                  ▼
          Step 12 (git-object) ←── depends on header + all object types
                  │
                  ▼
          Step 13 (barrel export)
                  │
                  ▼
          Step 14 (final verification)
```
