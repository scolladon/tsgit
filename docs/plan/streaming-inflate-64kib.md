# Plan — streaming-inflate-64kib: fix pack-entry reads truncated at 64 KiB

TDD sequence. One slice = one atomic commit. `npm run validate` green before each
commit. Governed by ADR-359 (exact-slice reads), ADR-360 (remove `PACK_SLICE_HINT`),
ADR-361 (two-blob interop fixture); see `design/streaming-inflate-64kib.md`.

---

## Slice 1 — domain helper `entryOffsets` on `pack-index.ts` + barrel (fix)

### Context

**Surface decision:** `entryOffsets` is **internal** — consumed only by
`pack-registry.ts` inside `src/`. It is added to the domain barrel
`src/domain/storage/index.ts` so the application layer can import it from the
domain surface; it must NOT be re-exported from `src/index.node.ts`. Verify that
`src/index.node.ts` does not gain a new public export entry (no api.json churn,
no doc gate). There is a barrel-surface test at
`test/unit/application/primitives/index.test.ts` — check whether it asserts the
exported set of `src/domain/storage/index.ts`; if so, add `entryOffsets` to that
assertion.

**Source to change:**
- `src/domain/storage/pack-index.ts`
  - `readOffset(index, i)` — module-internal function at line 91; handles
    large-offset table (MSB check, 8-byte high/low word read). Returns `number`.
    Do NOT export.
  - `PackIndex.objectCount` — exported field on the interface, line 13. Range:
    `[0, objectCount)` is the iteration domain.
  - New export to add after `lookupPackIndex`:
    ```typescript
    export function entryOffsets(index: PackIndex): ReadonlyArray<number>
    ```
    Iterates `i ∈ [0, index.objectCount)`, calls `readOffset(index, i)` for each,
    returns the results as a plain array. Sorting and `packFileSize − digestLength`
    boundary are application-layer concerns.
  - Edge: `objectCount === 0` → return `[]`.

- `src/domain/storage/index.ts`
  - Line 41 currently exports `findByPrefix, lookupPackIndex, parsePackIndex`.
    Add `entryOffsets` to this export block.

**Test to extend:**
- `test/unit/domain/storage/pack-index.test.ts` — existing file; imports from
  `../../../../src/domain/storage/pack-index.js`; uses `buildTestIndex` from
  `./arbitraries.js` which already supports large offsets (`offset > 0x7fffffff`).
  Import `entryOffsets` alongside the existing imports.

**Property test lens check:**
`entryOffsets` iterates `readOffset(index, i)` for all `i` — it's a total function
over the index grammar and its output set equals `{readOffset(i) : 0 ≤ i < n}`.
The round-trip lens does not fit (no inverse). The counting-invariant lens fits:
`entryOffsets(index).length === index.objectCount` for arbitrary valid indices.
A `*.properties.test.ts` is **appropriate** for the counting invariant but
marginal — the example tests already pin this implicitly. Given the function is a
thin loop, property tests would tautologically re-implement the SUT. Skip; note
why in review.

### TDD steps

**RED** — in `test/unit/domain/storage/pack-index.test.ts`, add inside the
outermost `describe('pack-index', ...)` block, after the `lookupPackIndex`
describe:

```
describe('entryOffsets', () => {
  describe('Given a pack index with 0 entries', () => {
    describe('When entryOffsets is called', () => {
      it('Then returns an empty array', ...)
    })
  })
  describe('Given a pack index with 3 entries at known offsets', () => {
    describe('When entryOffsets is called', () => {
      it('Then returns all 3 offsets in index order', ...)
    })
  })
  describe('Given a pack index with 1 entry whose small-offset slot has MSB set (large-offset table)', () => {
    describe('When entryOffsets is called', () => {
      it('Then returns the large offset value correctly', ...)
    })
  })
})
```

Each test:
- **Arrange:** `buildTestIndex(entries)` → `parsePackIndex(bytes)` → assign to `index` (the
  pack index).
- **Act:** `const sut = entryOffsets; const result = sut(index);`
- **Assert:** exact values and `result.length === N`.

For the large-offset test use `buildTestIndex([{ id: '00'.repeat(20) as ObjectId, offset: 0x200000000, crc32: 0 }])`.

Import `entryOffsets` — this import will fail (RED) until the symbol is exported.

Run: `npx vitest run test/unit/domain/storage/pack-index.test.ts` → RED
(TypeScript compile error: `entryOffsets` not exported).

**GREEN** — in `src/domain/storage/pack-index.ts`:

Add after `lookupPackIndex`:
```typescript
export function entryOffsets(index: PackIndex): ReadonlyArray<number> {
  const offsets: number[] = [];
  for (let i = 0; i < index.objectCount; i += 1) {
    offsets.push(readOffset(index, i));
  }
  return offsets;
}
```

In `src/domain/storage/index.ts`, extend line 41:
```typescript
export { entryOffsets, findByPrefix, lookupPackIndex, parsePackIndex } from './pack-index.js';
```

Run: `npx vitest run test/unit/domain/storage/pack-index.test.ts` → GREEN.

**REFACTOR** — verify no duplication; `entryOffsets` is a thin, single-purpose
loop with no extractable sub-concern. No refactor needed.

### Gate

```
npx vitest run test/unit/domain/storage/pack-index.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/pack-index.ts src/domain/storage/index.ts
```

### Commit

```
fix(pack-index): export entryOffsets helper for all-entry offset iteration
```

---

## Slice 2 — `PackOffsetTable` + `nextOffsetForEntry` in `pack-registry.ts` (fix)

### Context

**Source to change:**
- `src/application/primitives/pack-registry.ts`

**Current state (exact lines to reference):**
- `RegisteredPack` interface: lines 12–17 — fields `name`, `index`, `packPath`,
  `idxPath`. The `offsetTable` field does not exist yet.
- `PackLookupHit`: lines 19–22 — unchanged.
- `loadPack(ctx, dir, entryName)`: line 55 — constructs and returns `RegisteredPack`.
  The `offsetTable` lazy closure is captured here where `ctx` and `packPath` are
  in scope.
- `createPackRegistry(ctx)`: lines 63–99 — unchanged shape.

**Imports to add:**
- `entryOffsets` from `'../../domain/storage/index.js'` (add to the existing
  destructured import on line 7).
- `type FileStat` from `'../../ports/file-system.js'` if needed (may already be
  transitively available; check — if `ctx.fs.stat` is typed, the result type is
  inferred).

**New exports to add** (two interfaces + one function):

```typescript
export interface PackOffsetTable {
  readonly sortedOffsets: ReadonlyArray<number>;
  readonly packFileSize: number;
  readonly trailerStart: number;
}
```

```typescript
// RegisteredPack extension:
export interface RegisteredPack {
  readonly name: string;
  readonly index: PackIndex;
  readonly packPath: string;
  readonly idxPath: string;
  /** Lazily-built, cached sorted entry offsets + trailer bound for this pack. */
  readonly offsetTable: () => Promise<PackOffsetTable>;
}
```

```typescript
export function nextOffsetForEntry(
  table: PackOffsetTable,
  offset: number,
): number
```

`nextOffsetForEntry` binary-searches `table.sortedOffsets` for `offset`:
- If not found → `throw invalidPackIndex('offset not in pack index: corrupt index')`.
- If found at last position → return `table.trailerStart`.
- Otherwise → return `table.sortedOffsets[rank + 1]!`.

`digestLength` is NOT a parameter — `trailerStart` in the table already encodes
it (computed as `packFileSize - ctx.hashConfig.digestLength` in `loadPack`).

The corrupt-index guard in the resolver (`nextOffset > packFileSize`) is enforced
by the caller after `nextOffsetForEntry` returns; no need to re-check inside
`nextOffsetForEntry` itself.

**`loadPack` change** — add the `offsetTable` lazy initializer:

```typescript
let cachedTable: PackOffsetTable | undefined;
const offsetTable = async (): Promise<PackOffsetTable> => {
  if (cachedTable !== undefined) return cachedTable;
  const stat = await ctx.fs.stat(packPath);
  const packFileSize = stat.size;
  const raw = entryOffsets(index);
  const sortedOffsets = [...raw].sort((a, b) => a - b);
  // The pack file trailer is a single pack-checksum digest (SHA-1: 20 bytes,
  // SHA-256: 32 bytes). The last entry's data ends exactly at trailerStart.
  const trailerStart = packFileSize - ctx.hashConfig.digestLength;
  cachedTable = { sortedOffsets, packFileSize, trailerStart };
  return cachedTable;
};
```

`digestLength` is available via `ctx.hashConfig.digestLength` (from
`src/domain/objects/hash-config.ts`; the context carries `hashConfig` at line 102
of `src/ports/context.ts`). The formula `packFileSize - digestLength` is correct —
the `.pack` file trailer is ONE digest (the SHA of all preceding pack content).
The `.idx` trailer is separate and not relevant to `.pack` read boundaries.

The returned `RegisteredPack` now includes `offsetTable`.

**Test to extend:**
- `test/unit/application/primitives/pack-registry.test.ts`
- `test/unit/application/primitives/pack-fixture.ts` — add a helper
  `buildTwoEntryPack` (or extend `writeSyntheticPack`) to produce a two-base-entry
  pack so unit tests can exercise the non-last-entry path of `nextOffsetForEntry`.
  `writeSyntheticPack` already supports multiple entries; the test can call it
  with two `{ kind: 'base', ... }` entries and extract offsets from the resulting
  idx.

**Context for `stubRegistry` in `object-resolver.test.ts` (Slice 3):**
`stubRegistry` constructs `RegisteredPack` inline. After this slice, `RegisteredPack`
requires an `offsetTable` field. The stub needs to be updated in Slice 3 to
provide a minimal `offsetTable: async () => ...`.

### TDD steps

**RED** — in `test/unit/application/primitives/pack-registry.test.ts`, add new
describe blocks:

```
describe('nextOffsetForEntry', () => {
  describe('Given a table with sortedOffsets=[100, 500, 900], packFileSize=1000, trailerStart=980', () => {
    describe('When nextOffsetForEntry is called with offset=100 (non-last)', () => {
      it('Then returns 500', ...)
    })
    describe('When nextOffsetForEntry is called with offset=900 (last)', () => {
      it('Then returns trailerStart = 980', ...)
    })
    describe('When nextOffsetForEntry is called with offset=200 (not in sortedOffsets)', () => {
      it('Then throws INVALID_PACK_INDEX with reason containing "offset not in pack index"', ...)
    })
  })
})

describe('RegisteredPack.offsetTable', () => {
  describe('Given a pack with 2 base entries', () => {
    describe('When offsetTable() is called twice', () => {
      it('Then ctx.fs.stat is called exactly once (lazy cache)', ...)
    })
    describe('When offsetTable() is called', () => {
      it('Then sortedOffsets contains both entry offsets in ascending order', ...)
    })
  })
})
```

Table construction for the `nextOffsetForEntry` tests (inline, no filesystem):
```typescript
const table: PackOffsetTable = {
  sortedOffsets: [100, 500, 900],
  packFileSize: 1000,
  trailerStart: 980,
};
const sut = nextOffsetForEntry;
```

Error assertion pattern (mutation-resistant):
```typescript
try {
  sut(table, 200);
  expect.unreachable();
} catch (error) {
  expect((error as TsgitError).data.code).toBe('INVALID_PACK_INDEX');
  expect((error as TsgitError).data.reason).toContain('offset not in pack index');
}
```

The `offsetTable` laziness test wraps `ctx.fs.stat` with a call counter (same
pattern as the `refresh()` test in the existing file).

Run: `npx vitest run test/unit/application/primitives/pack-registry.test.ts` → RED.

**GREEN** — implement in `src/application/primitives/pack-registry.ts`:

1. Add `PackOffsetTable` interface.
2. Add `offsetTable: () => Promise<PackOffsetTable>` to `RegisteredPack`.
3. Add `nextOffsetForEntry` exported function (binary search on `sortedOffsets`).
4. Update `loadPack` to build the lazy `offsetTable` closure capturing `ctx`,
   `index`, and `packPath`; return the extended `RegisteredPack`.

Run: `npx vitest run test/unit/application/primitives/pack-registry.test.ts` → GREEN.

**REFACTOR** — the binary search in `nextOffsetForEntry` is the only complexity
worth reviewing. Confirm it handles a single-element array (only element is both
first and last → returns `trailerStart`). Confirm the sort comparator `(a, b) => a - b`
is safe for JavaScript numbers in the pack-file-size range (well below `2^53`).

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts
```

### Commit

```
fix(pack-registry): add PackOffsetTable and nextOffsetForEntry for exact-slice reads
```

---

## Slice 3 — `object-resolver.ts`: exact-slice read, delete `PACK_SLICE_HINT` (fix)

### Context

**Source to change:**
- `src/application/primitives/object-resolver.ts`

**Exact changes:**

1. **Line 28** — delete `const PACK_SLICE_HINT = 1 << 16;`.

2. **Imports** — add `nextOffsetForEntry` and `type PackOffsetTable` to the import
   from `'./pack-registry.js'` (line 25 currently imports `PackLookupHit`,
   `PackRegistry`).

3. **`readEntryHeaderWithChunk` signature** (lines 310–322) — change to:
   ```typescript
   async function readEntryHeaderWithChunk(
     ctx: Context,
     hit: PackLookupHit,
     nextOffset: number,
   ): Promise<{ header: PackEntryHeader; chunk: Uint8Array; headerEndInChunk: number }>
   ```
   Inside: `const sliceLength = nextOffset - hit.offset;` — if `sliceLength <= 0`,
   throw `invalidPackIndex('slice length ≤ 0: next offset not beyond entry offset')`.
   Read: `const chunk = await ctx.fs.readSlice(hit.pack.packPath, hit.offset, sliceLength)`.
   Parse and return as before.

4. **`collectDeltaChain`** (lines 184–235) — before calling `readEntryHeaderWithChunk`,
   resolve `nextOffset`:
   ```typescript
   const table = await currentHit.pack.offsetTable();
   const nextOffset = nextOffsetForEntry(table, currentHit.offset);
   if (nextOffset > table.packFileSize) {
     throw invalidPackIndex('next offset exceeds pack file size: corrupt index');
   }
   const { header, chunk, headerEndInChunk } = await readEntryHeaderWithChunk(ctx, currentHit, nextOffset);
   ```

5. **Both `streamInflate` calls** — replace:
   - Line ~200 (base branch):
     `await ctx.compressor.streamInflate(chunk, headerEndInChunk)` →
     `await ctx.compressor.inflate(chunk.subarray(headerEndInChunk))`
     Return shape: `baseContent: inflated` (direct `Uint8Array`, not `.output`).
   - Line ~211 (delta branch):
     `await ctx.compressor.streamInflate(chunk, headerEndInChunk)` →
     `await ctx.compressor.inflate(chunk.subarray(headerEndInChunk))`
     Usage: `const instructions = inflated;` (direct `Uint8Array`, not `.output`).

6. **`streamInflate` import** — after removing both call sites in `object-resolver.ts`,
   check `ctx.compressor.streamInflate` is no longer referenced here. The import is
   on the `Context` type (port interface) — it survives because `fetch-pack.ts` still
   uses it; no import change needed (it's not explicitly imported in object-resolver,
   it comes via the `ctx` type).

**`stubRegistry` in `object-resolver.test.ts`** — after Slice 2 adds `offsetTable`
to `RegisteredPack`, the existing `stubRegistry` construction on lines 57–82 no
longer type-checks (missing field). Fix by adding a real `offsetTable` closure
that reads the pack file's actual size via `ctx.fs.stat`. This avoids a sentinel
that would request a multi-megabyte `readSlice` from a small test pack:
```typescript
const packPath = match.packPath;
const pack: RegisteredPack = {
  name: 'stub',
  index: fillerIndex,
  packPath,
  idxPath: `${packPath}.idx`,
  offsetTable: async () => {
    const stat = await ctx.fs.stat(packPath);
    const packFileSize = stat.size;
    return {
      sortedOffsets: [match.offset],
      packFileSize,
      trailerStart: packFileSize - 20, // SHA-1 unit tests; digestLength=20
    };
  },
};
```

`stubRegistry` tests use `writeRawSingleEntryPack` which writes to the memory fs;
`ctx.fs.stat` works there. With one entry at `match.offset`, `nextOffsetForEntry`
returns `trailerStart = packFileSize - 20`, giving the exact slice for the entry.

**Test to extend (Slice 3 folds tests in, no separate test slice):**
- `test/unit/application/primitives/object-resolver.test.ts` — add new describe
  blocks covering the exact-slice behavior and error paths.

New test cases:

```
describe('Given a 2-entry pack where first entry is a base blob', () => {
  describe('When resolveObject is called on the first entry', () => {
    it('Then inflate is called with exactly chunk.subarray(headerEndInChunk)', ...)
    it('Then streamInflate is never called on this path', ...)
  })
})

describe('Given a single-entry pack with a base blob', () => {
  describe('When resolveObject is called', () => {
    it('Then the slice is [entryOffset, trailerStart) i.e. packFileSize − digestLength', ...)
  })
})

describe('Given a pack where nextOffset equals offset (corrupt index)', () => {
  describe('When resolveObject is called', () => {
    it('Then throws INVALID_PACK_INDEX', ...)
  })
})

describe('Given a pack where nextOffset > packFileSize (corrupt index)', () => {
  describe('When resolveObject is called', () => {
    it('Then throws INVALID_PACK_INDEX', ...)
  })
})

describe('Given a 2-entry pack with an OFS_DELTA entry', () => {
  describe('When resolveObject is called on the delta entry', () => {
    it('Then each step in the chain reads its own exact slice', ...)
    it('Then the delta reconstructs correctly', ...)
  })
})
```

**Mutation-resistant patterns:**
- Use `vi.spyOn(ctx.compressor, 'inflate')` to capture the argument; assert
  `spy.mock.calls[0][0]` is the exact subarray (bytes-equal). Import `vi` from
  `'vitest'`.
- Use a separate `vi.spyOn(ctx.compressor, 'streamInflate')` spy and assert
  `streamInflateSpy.mock.calls.length === 0`.
- Corrupt-index tests: try/catch + `.data.code` + `.data.reason` assertions
  (not bare `toThrow`).
- Separate test for OFS_DELTA (each chain step gets its own exact slice) and a
  separate test for REF_DELTA (already covered by existing passing tests; verify
  they still pass with the new signature).

**How to manufacture a corrupt-offset test pack:**
Use `writeSyntheticPack` to create a real pack, then wrap `createPackRegistry`
with a custom `ctx.fs.stat` that returns an impossibly small `size` (e.g. 0) for
the pack path, causing `trailerStart = 0 - 20 = -20` → `nextOffset > packFileSize`
fires. Alternatively, patch `pack.offsetTable` directly in a stub registry to
return a table where `sortedOffsets = [entryOffset]` and
`packFileSize = entryOffset` (so `trailerStart = entryOffset - 20 < nextOffset`
fires the guard).

### TDD steps

**RED** — add new tests to `object-resolver.test.ts` covering:
1. The `inflate`-spy test (exact subarray argument).
2. The `streamInflate`-not-called test.
3. The corrupt-index guards.
4. The single-entry trailer-bound test.
5. The OFS_DELTA exact-slice test.

Also update `stubRegistry` to add the `offsetTable` field (which fixes the type
error introduced by Slice 2).

Run: `npx vitest run test/unit/application/primitives/object-resolver.test.ts` →
tests for inflate-spy / streamInflate-not-called / corrupt-index guards RED
(implementation still uses old `PACK_SLICE_HINT` path); type errors from missing
`offsetTable` on `RegisteredPack` in `stubRegistry` are also RED.

**GREEN** — implement all five changes listed above in `object-resolver.ts`.
Fix `stubRegistry` with the sentinel `offsetTable`.

Run: `npx vitest run test/unit/application/primitives/object-resolver.test.ts` → GREEN.

Also run the full resolver + registry + pack-index suite together to confirm
nothing regressed:
```
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/domain/storage/pack-index.test.ts
```

**REFACTOR** — confirm no `PACK_SLICE_HINT` residual references remain
(`grep -n PACK_SLICE_HINT src/`). Confirm `streamInflate` is referenced only in
`fetch-pack.ts` post-change (`grep -n streamInflate src/`).

### Gate

```
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/domain/storage/pack-index.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/pack-registry.ts src/domain/storage/pack-index.ts src/domain/storage/index.ts
```

### Commit

```
fix(object-resolver): exact-slice pack reads via next-entry offset; remove PACK_SLICE_HINT
```

---

## Slice 4 — interop: large packed blob + two-blob next-offset fixture (test)

### Context

**New file:**
- `test/integration/large-object-pack-interop.test.ts`

**Interop helpers to import** (all from `./interop-helpers.js`):
- `GIT_AVAILABLE`, `makePeerPair`, `initBothRepos`, `type PeerPair`, `runGit`, `git`

**tsgit entry point:**
- `createNodeContext` from `'../../src/adapters/node/node-adapter.js'`
- `readBlob` from `'../../src/application/primitives/read-blob.js'`
  (`readBlob(ctx, id)` → `Promise<Blob>`, where `blob.content` is the
  `Uint8Array` payload).

**Node fs helpers:**
- `readdir`, `copyFile`, `mkdir`, `writeFile` from `'node:fs/promises'`
- `path` from `'node:path'`
- `crypto` from `'node:crypto'` (for `randomBytes(N)`)

**Four fixtures:**

| Fixture | Setup | Assert |
|---------|-------|--------|
| **P1** | 140 000-byte random blob committed + `git gc` in `peer`; pack copied to `ours` | `readBlob(ctx, blobId).content.length === 140_000`; byte-identical to `git cat-file -p` |
| **P2** | same pack, same blob | read with `resolveObject(ctx, registry, id, true)` (verifyHash=true) → no `OBJECT_HASH_MISMATCH` |
| **P3** | 140 000-byte and 80 000-byte distinct random blobs committed + `git gc`; pack copied to `ours` | both blobs byte-identical; confirms non-last-entry next-offset boundary |
| **P4** | same 140 000-byte blob committed but NO `git gc` (loose) | `readBlob` succeeds; regression guard |

**Pack copy idiom** (P1/P2/P3):
```typescript
const packDir = path.join(peer, '.git', 'objects', 'pack');
const oursPackDir = path.join(ours, '.git', 'objects', 'pack');
await mkdir(oursPackDir, { recursive: true });
const entries = await readdir(packDir);
for (const entry of entries) {
  if (entry.endsWith('.pack') || entry.endsWith('.idx')) {
    await copyFile(path.join(packDir, entry), path.join(oursPackDir, entry));
  }
}
```

**Commit setup** (signing off):
```typescript
git(peer, 'config', 'commit.gpgsign', 'false');
git(peer, 'config', 'user.name', 'Test');
git(peer, 'config', 'user.email', 'test@example.com');
```

**Random blob creation** (two distinct seeds for P3):
```typescript
import { randomBytes } from 'node:crypto';
const blob1 = randomBytes(140_000);  // seed A
const blob2 = randomBytes(80_000);   // seed B — guaranteed different OIDs
```

Write blob files: `writeFile(path.join(peer, 'big1.bin'), blob1)`.

**Binary content readback** — `runGit` calls `.toString()` on the `execFileSync`
result, which corrupts arbitrary binary bytes. For binary blobs, call
`execFileSync` directly (not via `runGit`) with no encoding option, keeping the
raw `Buffer`:
```typescript
import { execFileSync } from 'node:child_process';
const catFileBuf = execFileSync(
  'git',
  ['-C', peer, 'cat-file', '-p', blobId],
  { env: SAFE_ENV },  // import SAFE_ENV via runGitEnv() from interop-helpers
);
// catFileBuf is a Buffer; compare to tsgit result (also a Buffer/Uint8Array)
expect(Buffer.compare(catFileBuf, Buffer.from(blob.content))).toBe(0);
```
`runGitEnv()` from `interop-helpers.ts` returns a copy of the scrubbed env. Use
it here to preserve the isolation discipline (`GIT_*` scrubbed, `HOME` isolated)
without re-implementing it.

**`beforeEach` / `afterEach` pattern:**
```typescript
let pair: PeerPair;
beforeEach(async () => {
  pair = await makePeerPair('large-pack');
  initBothRepos(pair.peer, pair.ours);
  git(pair.peer, 'config', 'commit.gpgsign', 'false');
});
afterEach(async () => { await pair.dispose(); });
```

**Timeout** — `git gc` on a 220 KB file is fast, but the test setup involves
multiple git operations. Use `{ timeout: 60_000 }` on the describe or individual
it blocks (same pattern as `fetch-pack.test.ts` and `config-interop.test.ts`).

**`readObject` primitive** — for P2's hash verification test, use `resolveObject`
directly (import from `src/application/primitives/object-resolver.js`) with
`verifyHash: true`, or use `readBlob` which calls `readObject` with default
`verifyHash: false` — use `readObject(ctx, id, { verifyHash: true })` from
`src/application/primitives/read-object.js` for the explicit hash verification.

**`__resetConfigCacheForTests`** — `createNodeContext` reads config lazily; if P4
runs after P1–P3 in the same context, there is no shared context state to reset
(each fixture creates a fresh `createNodeContext({ workDir: pair.ours })`). No
cache reset needed.

### TDD steps

**RED** — write the full test file with all four describe blocks. Since none of
the existing `large-object-pack-interop.test.ts` exists, all tests are new and
RED on the old `PACK_SLICE_HINT` code.

After Slice 3 lands, re-run: P1, P2, P3, P4 should all be GREEN. This slice
must be authored against the post-Slice-3 codebase.

Order of authorship: write the test file first (as RED against the pre-fix codebase
to confirm the bug), then verify GREEN after Slice 3.

Structure:
```
describe.skipIf(!GIT_AVAILABLE)('large-object pack interop', () => {
  describe('P1: single large packed blob (140 KB)', () => {
    describe('Given a 140 KB random blob packed via git gc', () => {
      describe('When readBlob is called via tsgit', () => {
        it('Then returns 140 000 bytes byte-identical to git cat-file -p', ...)
      })
    })
  })
  describe('P2: hash verification on large packed blob', () => {
    describe('Given the same 140 KB packed blob', () => {
      describe('When readObject is called with verifyHash=true', () => {
        it('Then succeeds without OBJECT_HASH_MISMATCH', ...)
      })
    })
  })
  describe('P3: two adjacent large blobs — next-offset boundary', () => {
    describe('Given a 140 KB blob and an 80 KB blob packed together via git gc', () => {
      describe('When both blobs are read via tsgit', () => {
        it('Then both return byte-identical content to git cat-file -p', ...)
      })
    })
  })
  describe('P4: loose large blob regression guard', () => {
    describe('Given a 140 KB blob NOT packed (no gc)', () => {
      describe('When readBlob is called via tsgit', () => {
        it('Then returns 140 000 bytes (loose path unaffected)', ...)
      })
    })
  })
})
```

**GREEN** — with Slice 3 in place, `npx vitest run test/integration/large-object-pack-interop.test.ts` → GREEN.

**REFACTOR** — extract a shared `setupPackedPeer` helper inside the test file if
P1 and P3 share non-trivial setup logic. Keep it file-local (not exported to
`interop-helpers.ts`).

### Gate

```
npx vitest run test/integration/large-object-pack-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/large-object-pack-interop.test.ts
```

Phase-boundary gate (run once at phase end, not per slice):
```
npm run validate
```

### Commit

```
test(interop): large packed blob reads via exact-slice; two-blob next-offset boundary
```

---

## Decision candidates

All architectural decisions for this change are pre-decided by ADR-359/360/361.
One new load-bearing decision was surfaced during planning:

### DC-1: `trailerStart` formula in `loadPack`

The trailer of a `.pack` file is a single pack-checksum digest (20 bytes SHA-1,
32 bytes SHA-256). The correct formula is `packFileSize − digestLength`.

**Alternatives considered:**
- **(a) `packFileSize − digestLength`** — correct; the pack trailer is a single
  digest over the pack contents. Recommended.
- **(b) `packFileSize − digestLength * 2`** — incorrect; confuses the pack
  trailer with the idx trailer (which has two digests: the pack checksum + the idx
  self checksum). The idx trailer is irrelevant to the `.pack` read boundary.
- **(c) `packFileSize − 20`** — hard-codes SHA-1; breaks on SHA-256 repos.

**Recommendation: (a).** Use `ctx.hashConfig.digestLength` directly. `digestLength`
is `20` for SHA-1 (all current repos) and `32` for SHA-256. This is the same field
already used in `object-resolver.ts` via `ctx.hashConfig.digestLength`.

### DC-2: `nextOffset > packFileSize` guard placement

The design specifies this guard. Two placement options:

- **(a) In `collectDeltaChain` after `nextOffsetForEntry` returns** — guard is
  applied once per entry, at the point the offset is consumed. Recommended because
  it sits beside the slice-length guard in `readEntryHeaderWithChunk`, making
  the full validity window `[offset, nextOffset)` visible in one place.
- **(b) Inside `nextOffsetForEntry`** — conflates offset-table concerns with
  pack-file-size concerns; `nextOffsetForEntry` takes a `table` which already
  carries `packFileSize`, so the check is mechanically possible, but the error
  message would be misleading (corrupt index vs. corrupt pack file size).

**Recommendation: (a).** Guard in `collectDeltaChain`.

### DC-3: Property test for `entryOffsets` counting invariant

- **(a) Skip** — the counting invariant (`result.length === index.objectCount`)
  is implicitly verified by the three example tests; the loop has no algebraic
  structure beyond a linear map; a property test would tautologically re-implement
  the SUT (the oracle is `for i: readOffset(i)`). Skip with written justification.
- **(b) Add a `*.properties.test.ts`** — marginal value; the property oracle
  would duplicate the SUT loop.

**Recommendation: (a).** Document why in the pack-index test file comment.
