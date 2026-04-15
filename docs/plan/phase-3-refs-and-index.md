# Plan: Phase 3 — Refs & Index

Implements [design/refs-and-index.md](../design/refs-and-index.md).
Covers [backlog](../BACKLOG.md) items 3.1–3.7.

### Backlog → Step Mapping

| Backlog Item | Description | Steps |
|---|---|---|
| **3.1** | Ref resolution (loose refs, symbolic refs, `HEAD`) | 3 (domain parsing — full resolution in Phase 7) |
| **3.2** | Packed-refs reader | 4 |
| **3.3** | Ref peeling | 1 (`peelOneLevel` in `peel.ts`) |
| **3.4** | Ref writer | 3 (serialize only — atomic file write and delete are Phase 7, no domain component for deletion) |
| **3.5** | Git index reader | 6 |
| **3.6** | Git index writer | 7 |
| **3.7** | Index entry comparison | 5 |
| — | Error types (RefsError + IndexError) | 0 |
| — | Ref name validation | 2 |
| — | Barrel export + verification | 8 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step run: `npm run check:types && npm run test:unit && npm run check:architecture`

**Commit strategy:** One commit per completed step (green + refactor). Message format: `feat(domain): add <module> — <what it does>` for new modules. Feature branch with worktree — never commit directly to main.

## Prerequisites (before step 0)

1. Create directories: `src/domain/refs/`, `src/domain/git-index/`, `test/unit/domain/refs/`, `test/unit/domain/git-index/`
2. Coverage config in `vitest.config.ts` already includes `src/domain/**/*.ts` — `refs/` and `git-index/` covered automatically
3. Update `cspell.json` as needed — new domain terms (peeled, refname, etc.) may trigger spelling failures

## File Conventions

- Source files under `src/domain/refs/` and `src/domain/git-index/`
- Test files under `test/unit/domain/refs/` and `test/unit/domain/git-index/`
- File names: kebab-case (enforced by ls-lint)
- Test names: `<module>.test.ts`
- Test format: Given/When/Then titles, AAA body, `sut` variable
- **Import extensions:** All imports MUST use `.js` extension
- **Imports from `domain/objects/`:** Import `ObjectId`, `RefName`, `FilePath`, `FileMode`, `HashConfig`, `SHA1_CONFIG`, `ObjectType`, `GitObject` from the barrel `../objects/index.js`. Import encoding utilities directly from `../objects/encoding.js`.
- **Error pattern:** Same as Phase 2 — module-local error unions with `import type` into `domain/error.ts`

## Design Decisions (applied in this plan)

- **`domain/git-index/`** (not `domain/index/`) to avoid barrel collision with `domain/index.ts`
- **Ref resolution deferred to Phase 7** — only content parsing and serialization here
- **`peelOneLevel` in `refs/peel.ts`** — separate from type definitions (SRP)
- **`validateRefName` called on symbolic ref targets** in `parseLooseRef` — prevents path traversal
- **`RefName.from` is low-trust** — used only for internal construction. User-facing input goes through `validateRefName`
- **Index extensions as opaque blobs** — mandatory (lowercase first byte) rejected, optional preserved
- **Index v2 only** — v3/v4 deferred
- **`nameLength` not exposed in `IndexEntryFlags`** — serializer recomputes from path
- **`StatData.mode` typed as `FileMode`** — callers normalize numeric mode before comparison
- **Checksum not validated/appended** — same pattern as Phase 2
- **Security guards** — entry count bounds check, extension size validation, extended flag = 0 in v2
- **fast-check arbitraries** in `test/unit/domain/refs/arbitraries.ts` and `test/unit/domain/git-index/arbitraries.ts`

---

## Step 0: Prerequisites & Error Types

**Create:** `src/domain/refs/`, `src/domain/git-index/`, `test/unit/domain/refs/`, `test/unit/domain/git-index/`
**Create:** `src/domain/refs/error.ts`, `src/domain/git-index/error.ts`
**Test:** `test/unit/domain/refs/error.test.ts`, `test/unit/domain/git-index/error.test.ts`
**Modify:** `src/domain/error.ts` (add `RefsError | IndexError` to `TsgitErrorData`)

### Actions:

1. Create `src/domain/refs/error.ts`:
   - `RefsError` type: 2 variants (`INVALID_REF`, `INVALID_PACKED_REFS`)
   - Factory functions: `invalidRef(reason)`, `invalidPackedRefs(reason)`

2. Create `src/domain/git-index/error.ts`:
   - `IndexError` type: 2 variants (`INVALID_INDEX_HEADER`, `INVALID_INDEX_ENTRY`)
   - Factory functions: `invalidIndexHeader(reason)`, `invalidIndexEntry(offset, reason)`

3. Update `src/domain/error.ts`:
   - `import type { RefsError } from './refs/error.js'`
   - `import type { IndexError } from './git-index/error.js'`
   - Widen `TsgitErrorData = DomainObjectError | StorageError | RefsError | IndexError`
   - Add switch cases to `extractDetail` (all new codes use `data.reason`)

4. Write tests for both error modules (same pattern as `storage/error.test.ts`)
5. Update exhaustive switch tests in both `test/unit/domain/objects/error.test.ts` AND `test/unit/domain/storage/error.test.ts` to include new codes

### Verify:

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 1: `ref-types.ts` + `peel.ts` — Ref Type Definitions & Peel

**Create:** `src/domain/refs/ref-types.ts`, `src/domain/refs/peel.ts`
**Test:** `test/unit/domain/refs/peel.test.ts`

Depends on: Step 0 (error types), `GitObject` from `domain/objects/`

### Types in `ref-types.ts` (pure type definitions, no functions):

- `DirectRef { type: 'direct'; target: ObjectId }`
- `SymbolicRef { type: 'symbolic'; target: RefName }`
- `LooseRef = DirectRef | SymbolicRef`
- `PackedRefEntry { name: RefName; id: ObjectId; peeled?: ObjectId }`
- `PackedRefs { entries: ReadonlyArray<PackedRefEntry>; peeling: 'none' | 'tags' | 'fully'; sorted: boolean }`

### Types + function in `peel.ts`:

- `PeelResult { type: ObjectType; id: ObjectId }`
- `peelOneLevel(object: GitObject): PeelResult | undefined`

### Test first (red):

```
Given a Tag object, When peeling, Then returns { type: tag.data.objectType, id: tag.data.object }
Given a Commit object, When peeling, Then returns { type: 'tree', id: commit.data.tree }
Given a Blob object, When peeling, Then returns undefined
Given a Tree object, When peeling, Then returns undefined
```

### Implement (green):

Switch on `object.type`:
- `'tag'` → `{ type: object.data.objectType, id: object.data.object }`
- `'commit'` → `{ type: 'tree', id: object.data.tree }`
- `'blob'` | `'tree'` → `undefined`

---

## Step 2: `ref-validation.ts` — Ref Name Validation

**Create:** `src/domain/refs/ref-validation.ts`
**Test:** `test/unit/domain/refs/ref-validation.test.ts`
**Create:** `test/unit/domain/refs/arbitraries.ts` (with `arbRefName()`)

Depends on: Step 0 (error types)

### Test first (red):

**Valid ref names:**
```
Given 'refs/heads/main', When validating, Then returns RefName
Given 'refs/tags/v1.0.0', When validating, Then returns RefName
Given 'HEAD', When validating, Then returns RefName (one-level accepted)
Given 'refs/remotes/origin/main', When validating, Then returns RefName
Given 'refs/heads/feature/my-branch', When validating, Then returns RefName
```

**Invalid ref names (one test per rule):**
```
Given 'refs/heads/..main' (double dots), When validating, Then throws INVALID_REF
Given 'refs/heads/main.lock' (component ends with .lock), When validating, Then throws INVALID_REF
Given 'refs/foo.lock/bar' (interior component ends with .lock), When validating, Then throws INVALID_REF
Given 'refs//heads' (consecutive slashes), When validating, Then throws INVALID_REF
Given 'refs/heads/' (trailing slash), When validating, Then throws INVALID_REF
Given '/refs/heads/main' (leading slash), When validating, Then throws INVALID_REF
Given '-refs' (starts with dash), When validating, Then throws INVALID_REF
Given '@' (single @), When validating, Then throws INVALID_REF
Given 'refs/heads/@{main}' (contains @{), When validating, Then throws INVALID_REF
Given 'refs/.hidden/main' (component starts with dot), When validating, Then throws INVALID_REF
Given 'refs/heads/trail.' (ends with dot), When validating, Then throws INVALID_REF
Given 'refs/heads/spa ce' (contains space), When validating, Then throws INVALID_REF
Given 'refs/heads/til~de' (contains ~), When validating, Then throws INVALID_REF
Given 'refs/heads/car^et' (contains ^), When validating, Then throws INVALID_REF
Given 'refs/heads/col:on' (contains :), When validating, Then throws INVALID_REF
Given 'refs/heads/quest?' (contains ?), When validating, Then throws INVALID_REF
Given 'refs/heads/star*' (contains *), When validating, Then throws INVALID_REF
Given 'refs/heads/bra[cket' (contains [), When validating, Then throws INVALID_REF
Given 'refs/heads/back\\slash' (contains \), When validating, Then throws INVALID_REF
Given '' (empty string), When validating, Then throws INVALID_REF
Given string with NUL byte, When validating, Then throws INVALID_REF
Given string with ASCII control char (0x01), When validating, Then throws INVALID_REF
```

### Create `test/unit/domain/refs/arbitraries.ts`:

- `arbRefName()` — generates valid ref names satisfying all 11 rules. Strategy: `fc.array(arbComponent, {min:2, max:4}).map(c => c.join('/'))` where `arbComponent` generates `[a-z][a-z0-9-]{0,10}` strings.

### Implement (green):

Single function checking all 11 rules with early returns. Each rule check is a one-liner. Returns `name as RefName` on success.

### Property-based tests:

- Any string accepted by `validateRefName` does not contain `..`, `//`, `~`, `^`, `:`, `?`, `*`, `[`, `\`, space, NUL, or control chars
- Any `arbRefName()` is accepted by `validateRefName`

---

## Step 3: `loose-ref.ts` — Loose Ref Parsing & Serialization

**Create:** `src/domain/refs/loose-ref.ts`
**Test:** `test/unit/domain/refs/loose-ref.test.ts`

Depends on: Steps 0 + 2 (error types, `validateRefName`)

### Test first (red):

```
Given '<40-char-sha>\n', When parsing, Then returns DirectRef with correct ObjectId
Given '<64-char-sha>\n' (SHA-256), When parsing, Then returns DirectRef
Given 'ref: refs/heads/main\n', When parsing, Then returns SymbolicRef with target 'refs/heads/main'
Given '<sha>\r\n', When parsing, Then handles CRLF gracefully
Given '<sha>' (no trailing newline), When parsing, Then handles gracefully
Given 'ref: refs/heads/main' (no newline), When parsing, Then handles gracefully
Given '' (empty), When parsing, Then throws INVALID_REF
Given 'not-a-sha', When parsing, Then throws INVALID_REF
Given 'ref: ' (empty target), When parsing, Then throws INVALID_REF
Given 'ref: \n' (whitespace-only target after trim), When parsing, Then throws INVALID_REF
Given 'ref: ../../../etc/passwd\n' (path traversal), When parsing, Then throws INVALID_REF
Given any ObjectId, When serializing then parsing, Then roundtrips
Given any RefName (via arbRefName), When serializing symbolic then parsing, Then roundtrips
```

### Implement (green):

- `parseLooseRef(content: string): LooseRef`
  1. Trim trailing whitespace
  2. If starts with `ref: ` → validate target via `validateRefName(rest)` → `{ type: 'symbolic', target }`
  3. Else → `{ type: 'direct', target: ObjectId.from(trimmed) }`
  4. Invalid → throw `INVALID_REF`

- `serializeDirectRef(id: ObjectId): string` → `${id}\n`
- `serializeSymbolicRef(target: RefName): string` → `ref: ${target}\n`

---

## Step 4: `packed-refs.ts` — Packed-Refs Parsing & Serialization

**Create:** `src/domain/refs/packed-refs.ts`
**Test:** `test/unit/domain/refs/packed-refs.test.ts`

Depends on: Steps 0 + 1 (error types, `PackedRefEntry`/`PackedRefs` types)

### Test first (red):

```
Given empty string, When parsing, Then returns empty entries, peeling='none', sorted=false
Given '# pack-refs with: peeled fully-peeled sorted\n', When parsing, Then peeling='fully', sorted=true
Given '# pack-refs with: peeled sorted\n', When parsing, Then peeling='tags', sorted=true
Given '# pack-refs with: sorted\n', When parsing, Then peeling='none', sorted=true
Given 3 ref lines, When parsing, Then returns 3 entries with correct SHAs and names
Given ref line followed by ^<sha>, When parsing, Then entry has peeled field
Given ref line without peel, When parsing, Then peeled is undefined
Given peel line present without header trait, When parsing, Then peel line still accepted
Given multiple comment lines, When parsing, Then comments skipped
Given invalid SHA in ref line, When parsing, Then throws INVALID_PACKED_REFS
Given peel line without preceding ref, When parsing, Then throws INVALID_PACKED_REFS
Given line with wrong format (no space), When parsing, Then throws INVALID_PACKED_REFS
Given entries in non-sorted order, When serializing, Then output is sorted by name
Given entries with peeled, When serializing, Then header includes peeled trait
Given serialized then parsed PackedRefs, When roundtripping, Then all entries and traits preserved
```

### Implement (green):

- `parsePackedRefs(content: string): PackedRefs`
- `serializePackedRefs(refs: PackedRefs): string`

### Property-based tests:

- Roundtrip: `parsePackedRefs(serializePackedRefs(refs))` preserves all entries (using `arbRefName()` and `arbObjectId()`)

---

## Step 5: `index-entry.ts` — Index Entry Types & Stat Comparison

**Create:** `src/domain/git-index/index-entry.ts`
**Test:** `test/unit/domain/git-index/index-entry.test.ts`

Depends on: Step 0 (error types). No dependency on refs steps.

### Types to define:

- `IndexEntry` — stat data + SHA + flags + path (no `nameLength` in flags)
- `IndexEntryFlags` — `{ assumeValid, extended, stage }`
- `StatData` — 10 stat fields with `mode: FileMode`
- `GitIndex` — `{ version: 2, entries, extensions }`
- `IndexExtension` — `{ signature, data }`

### Test first (red):

```
Given identical IndexEntry and StatData, When comparing, Then isStatClean returns true
Given different mtimeSeconds, When comparing, Then returns false
Given different mtimeNanoseconds, When comparing, Then returns false
Given different ctimeSeconds, When comparing, Then returns false
Given different ctimeNanoseconds, When comparing, Then returns false
Given different dev, When comparing, Then returns false
Given different ino, When comparing, Then returns false
Given different mode, When comparing, Then returns false
Given different uid, When comparing, Then returns false
Given different gid, When comparing, Then returns false
Given different fileSize, When comparing, Then returns false
```

### Property-based tests:

- For any `IndexEntry`, `isStatClean(entry, extractStat(entry))` returns true
- For any `IndexEntry` with one field mutated, `isStatClean` returns false

---

## Step 6: `index-parser.ts` — Index V2 Parser

**Create:** `src/domain/git-index/index-parser.ts`
**Test:** `test/unit/domain/git-index/index-parser.test.ts`
**Create:** `test/unit/domain/git-index/arbitraries.ts` (shared test helpers)

Depends on: Step 5 (entry types), Step 0 (error types)

### Test helper: `buildTestIndex`

Create a test utility that builds a valid `.git/index` v2 `Uint8Array` from entries. Algorithm:
1. Write 12-byte header: `DIRC` + version 2 + entry count
2. For each entry: write 40 bytes stat, 20-byte SHA, 2-byte flags, path + NUL padding
3. Optionally append extensions (signature + size + data)
4. Append 20-byte zero checksum

### Test first (red):

```
Given valid index with 0 entries and 0 extensions (32 bytes), When parsing, Then version=2, entries empty, no extensions
Given valid index with 1 entry, When parsing, Then entry has correct stat fields, SHA, flags, path
Given valid index with 3 entries, When parsing, Then all entries correct
Given index with entries in non-sorted order, When parsing, Then entries returned as-is
Given index with optional extension (uppercase signature), When parsing, Then extension preserved
Given index with mandatory extension (lowercase signature), When parsing, Then throws INVALID_INDEX_ENTRY
Given index with extended flag set, When parsing, Then throws INVALID_INDEX_ENTRY
Given entry with nameLength = 0xFFF and long path, When parsing, Then reads actual NUL-terminated path
Given wrong signature (not DIRC), When parsing, Then throws INVALID_INDEX_HEADER
Given version != 2, When parsing, Then throws INVALID_INDEX_HEADER
Given truncated header (< 12 bytes), When parsing, Then throws INVALID_INDEX_HEADER
Given crafted entryCount exceeding file capacity, When parsing, Then throws INVALID_INDEX_HEADER
Given extension with size exceeding remaining bytes, When parsing, Then throws INVALID_INDEX_ENTRY
Given truncated entry, When parsing, Then throws INVALID_INDEX_ENTRY
Given entry with flags.stage = 2, When parsing, Then stage field is 2
Given entry with assumeValid = true, When parsing, Then flag is set
```

### Implement (green):

`parseIndex(bytes: Uint8Array): GitIndex` per design §8.2, including all security guards.

---

## Step 7: `index-writer.ts` — Index V2 Serializer

**Create:** `src/domain/git-index/index-writer.ts`
**Test:** `test/unit/domain/git-index/index-writer.test.ts`

Depends on: Steps 5 + 6 (entry types, parser for roundtrip tests)

### Test first (red):

```
Given 0 entries, When serializing, Then output is 12-byte header only (no checksum)
Given 1 entry, When serializing then parsing, Then roundtrips
Given 3 entries, When serializing, Then entries are in path-sorted order
Given entry with path 'a/b/c.txt', When serializing, Then padding aligns to 8-byte boundary
Given entry with path exactly filling 8-byte boundary, When serializing, Then 8 bytes of NUL padding added
Given entry with path >= 4095 bytes, When serializing, Then nameLength field set to 0xFFF
Given index with extensions, When serializing then parsing, Then extensions roundtrip
Given 1 entry, When serializing, Then output does NOT include trailing checksum
```

### Implement (green):

`serializeIndex(index: GitIndex): Uint8Array` per design §8.3-8.4.

### Property-based tests:

- Roundtrip: `parseIndex(concat(serializeIndex(index), zeroChecksum))` preserves all entries
- Entry padding: for any path length, total entry size is multiple of 8

---

## Step 8: Barrel Export & Final Verification

**Create:** `src/domain/refs/index.ts`, `src/domain/git-index/index.ts`
**Modify:** `src/domain/index.ts`

### Actions:

1. Create `src/domain/refs/index.ts` — barrel exporting:
   - From `ref-types.ts`: `DirectRef`, `SymbolicRef`, `LooseRef`, `PackedRefEntry`, `PackedRefs`
   - From `peel.ts`: `PeelResult`, `peelOneLevel`
   - From `ref-validation.ts`: `validateRefName`
   - From `loose-ref.ts`: `parseLooseRef`, `serializeDirectRef`, `serializeSymbolicRef`
   - From `packed-refs.ts`: `parsePackedRefs`, `serializePackedRefs`
   - From `error.ts`: `RefsError`, `invalidRef`, `invalidPackedRefs`

2. Create `src/domain/git-index/index.ts` — barrel exporting:
   - From `index-entry.ts`: `IndexEntry`, `IndexEntryFlags`, `StatData`, `GitIndex`, `IndexExtension`, `isStatClean`
   - From `index-parser.ts`: `parseIndex`
   - From `index-writer.ts`: `serializeIndex`
   - From `error.ts`: `IndexError`, `invalidIndexHeader`, `invalidIndexEntry`

3. Update `src/domain/index.ts`:
   - Add `export * from './refs/index.js'`
   - Add `export * from './git-index/index.js'`

4. Update `knip.json` entry points if needed.

### Verify:

```bash
npm run validate   # Full quality gate
```

---

## Step 9: Mutation Testing & Branch Finalization

**Not a code step** — finalization workflow per CLAUDE.md §5.

1. Run `npx stryker run` — fix surviving mutants, accept only provably equivalent ones
2. Run 4× parallel reviews: code review, security review, performance review, test review
3. Update docs: BACKLOG.md (mark 3.1–3.7 as done), design doc (post-implementation notes)
4. Squash-and-merge to main
5. Cleanup: delete feature branch and worktree

---

## Dependency Graph

```
Step 0  (errors + setup)
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
     Step 8                  │
       │                     ▼
       └─────────────> Step 9 (mutations + finalize)
```

**Parallelizable groups:**
- After step 0: steps 1, 2, 5 can all run in parallel
- After steps 1+2: steps 3, 4 can run in parallel
- After step 5: steps 6, 7 can run in parallel (step 7 roundtrip tests depend on step 6)
- Steps 3/4 (refs) and 6/7 (index) are fully independent — can run in parallel across submodules
