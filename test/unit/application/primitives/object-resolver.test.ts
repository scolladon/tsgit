import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  PARSED_OBJECT_MEMO_FRACTION,
  PARSED_OBJECT_MEMO_MAX_ENTRIES,
  parsedObjectByteSize,
} from '../../../../src/application/primitives/internal/object-caches.js';
import {
  resolveObject,
  resolveObjectBytes,
} from '../../../../src/application/primitives/object-resolver.js';
import {
  createPackRegistry,
  deltaBaseCacheKey,
  type PackLookupHit,
  type PackOffsetTable,
  type PackRegistry,
  type RegisteredPack,
} from '../../../../src/application/primitives/pack-registry.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { permissionDenied, TsgitError } from '../../../../src/domain/error.js';
import * as gitObjectMod from '../../../../src/domain/objects/index.js';
import { type Blob, EMPTY_TREE_OID, type ObjectId } from '../../../../src/domain/objects/index.js';
import type { LruCache } from '../../../../src/domain/storage/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildMidx, type MidxSpec } from '../../domain/storage/arbitraries.js';
import { buildSeededContext, instrumentedContext } from './fixtures.js';
import { buildSyntheticPack, type EntrySpec, writeSyntheticPack } from './pack-fixture.js';

vi.mock('../../../../src/domain/storage/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/domain/storage/index.js')>();
  return { ...actual, createLruCache: vi.fn(actual.createLruCache) };
});

vi.mock('../../../../src/application/primitives/pack-registry.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../../src/application/primitives/pack-registry.js')
    >();
  return { ...actual, deltaBaseCacheKey: vi.fn(actual.deltaBaseCacheKey) };
});

const storage = await import('../../../../src/domain/storage/index.js');
const createLruCacheSpy = vi.mocked(storage.createLruCache);
const deltaBaseCacheKeySpy = vi.mocked(deltaBaseCacheKey);
const {
  createLruCache,
  encodeOfsDistance,
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  parsePackIndex,
  serializePackHeader,
} = storage;

const ENC = new TextEncoder();

/**
 * Narrows a resolved offset table to its no-`.rev` fallback arm and returns
 * the materialised offsets — every describe below that reads `sortedOffsets`
 * from a REAL table is exercising a pack `writeSyntheticPack` never gave a
 * `.rev`, so the fallback arm is the only one it can ever observe.
 */
function expectSortedOffsets(table: PackOffsetTable): Float64Array {
  if (table.kind !== 'sorted') {
    expect.unreachable(`expected the sorted fallback table, got kind=${table.kind}`);
  }
  return table.sortedOffsets;
}

function midxPath(ctx: Context): string {
  return `${ctx.layout.gitDir}/objects/pack/multi-pack-index`;
}

async function writeMidxBytes(ctx: Context, bytes: Uint8Array): Promise<void> {
  await ctx.fs.write(midxPath(ctx), bytes);
}

function healthyMidxSpec(overrides: Partial<MidxSpec> = {}): MidxSpec {
  return {
    version: 1,
    hashVersion: 1,
    digestLength: 20,
    numBaseFiles: 0,
    packNames: [],
    entries: [],
    ...overrides,
  };
}

/** Truncate to a size the parser cannot even read a header from — a Tier-B
 *  (merely-unusable) fault, discarded rather than denying the read. */
function truncateMidxTo8(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0, 8);
}

/**
 * Build a single-entry packfile (header + `entryBytes` + trailer) and write it
 * to the memory fs. Returns the on-disk pack path so a stub registry can read
 * slices from it at a controlled offset.
 */
async function writeRawSingleEntryPack(
  ctx: Context,
  name: string,
  entryBytes: Uint8Array,
): Promise<string> {
  const header = serializePackHeader(2, 1);
  const body = new Uint8Array(header.length + entryBytes.length);
  body.set(header, 0);
  body.set(entryBytes, header.length);
  const trailerHex = await ctx.hash.hashHex(body);
  const trailer = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    trailer[i] = Number.parseInt(trailerHex.slice(i * 2, i * 2 + 2), 16);
  }
  const packBytes = new Uint8Array(body.length + trailer.length);
  packBytes.set(body, 0);
  packBytes.set(trailer, body.length);
  const packPath = `${ctx.layout.gitDir}/objects/pack/pack-${name}.pack`;
  await ctx.fs.write(packPath, packBytes);
  return packPath;
}

/**
 * `readSlice`/`close` for a stub `RegisteredPack` that bypasses the
 * persistent-handle machinery entirely — reads go straight through
 * `ctx.fs.readSlice` against the file the test already wrote. Good enough
 * for stubs that only need to satisfy the type and produce correct bytes.
 */
function stubPackHandle(
  ctx: Context,
  packPath: string,
): Pick<
  RegisteredPack,
  'readSlice' | 'close' | 'hasRevIndex' | 'revIndex' | 'packPositions' | 'hasBitmap' | 'bitmapBytes'
> {
  return {
    readSlice: (offset, length) => ctx.fs.readSlice(packPath, offset, length),
    close: async () => undefined,
    // The object resolver never reads a pack's reverse index, position
    // mapping or bitmap — these fields exist only to satisfy the type.
    hasRevIndex: false,
    revIndex: async () => ({ kind: 'absent' }),
    packPositions: async () => new Uint32Array(0),
    hasBitmap: false,
    bitmapBytes: async () => ({ kind: 'absent' }),
  };
}

const noopDispose = async (): Promise<void> => undefined;

/**
 * A `PackRegistry` stub that resolves a fixed id to a fixed `{ packPath, offset }`
 * hit. `index` is a real (unrelated) `PackIndex` only to satisfy the type — the
 * object resolver never reads it. The entry at `offset` is whatever the caller
 * wrote into the pack file, so callers control exactly what the resolver parses.
 */
async function stubRegistry(
  ctx: Context,
  hits: ReadonlyArray<{
    readonly id: ObjectId;
    readonly packPath: string;
    readonly offset: number;
  }>,
): Promise<PackRegistry> {
  // A throwaway real PackIndex purely to fill the typed `index` field.
  const filler = await buildSyntheticPack(ctx, [
    { kind: 'base', type: 'blob', content: ENC.encode('filler') },
  ]);
  const fillerIndex = parsePackIndex(filler.idxBytes, 20);
  const lookup = async (id: ObjectId): Promise<PackLookupHit | undefined> => {
    const match = hits.find((h) => h.id === id);
    if (match === undefined) return undefined;
    const packPath = match.packPath;
    const pack: RegisteredPack = {
      name: 'stub',
      index: async () => fillerIndex,
      packPath,
      idxPath: `${packPath}.idx`,
      header: async () => ({ version: 2, objectCount: fillerIndex.objectCount }),
      offsetTable: async () => {
        const stat = await ctx.fs.stat(packPath);
        const packFileSize = stat.size;
        return {
          kind: 'sorted' as const,
          sortedOffsets: Float64Array.of(match.offset),
          packFileSize,
          trailerStart: packFileSize - 20,
        };
      },
      ...stubPackHandle(ctx, packPath),
    };
    return { pack, offset: match.offset };
  };
  return {
    all: async () => [],
    fileNames: async () => new Set(),
    assertLoadable: async () => {},
    refresh: () => undefined,
    settleRefresh: async () => {},
    lookup,
    dispose: noopDispose,
    health: async () => ({ accessible: [], unusable: [] }),
    indexFaults: async () => [],
    midxHealth: async () => ({
      artefact: undefined,
      faults: [],
      flatFilePresent: false,
      unresolvedPacks: [],
      unresolvedEntries: [],
      checksumOk: undefined,
    }),
    midxBitmap: async () => undefined,
    deltaBaseCache: createLruCache(1024),
  };
}

describe('object-resolver', () => {
  describe('Given the empty tree oid on a repo that never wrote it', () => {
    describe('When resolveObject is called', () => {
      it('Then returns a zero-entry tree', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = createPackRegistry(ctx);
        const sut = resolveObject;

        // Act
        const result = await sut(ctx, registry, EMPTY_TREE_OID, true, undefined);

        // Assert
        expect(result).toEqual({ type: 'tree', id: EMPTY_TREE_OID, entries: [] });
      });
    });
  });

  describe('Given the empty blob oid on a repo that never wrote it', () => {
    describe('When resolveObject is called', () => {
      it('Then throws OBJECT_NOT_FOUND (the empty-tree intercept is tree-only)', async () => {
        // Arrange — e69de29b… is the empty BLOB, not the empty tree; it is
        // NOT virtual and must still miss like any other absent object.
        const ctx = await buildSeededContext();
        const registry = createPackRegistry(ctx);
        const emptyBlobId = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391' as ObjectId;
        const sut = resolveObject;

        // Act
        try {
          await sut(ctx, registry, emptyBlobId, true);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code !== 'OBJECT_NOT_FOUND') {
            expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
          }
          expect(data.id).toBe(emptyBlobId);
        }
      });
    });
  });

  describe('Given a SHA-256 repo and the SHA-256 empty-tree oid', () => {
    describe('When resolveObject is called', () => {
      it('Then returns a zero-entry tree', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const registry = createPackRegistry(ctx);
        const emptyTreeOidSha256 =
          '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321' as ObjectId;
        const sut = resolveObject;

        // Act
        const result = await sut(ctx, registry, emptyTreeOidSha256, true, undefined);

        // Assert
        expect(result).toEqual({ type: 'tree', id: emptyTreeOidSha256, entries: [] });
      });
    });
  });

  describe('Given a SHA-1 repo and the SHA-1 empty-tree oid', () => {
    describe('When resolveObject is called', () => {
      it('Then returns a zero-entry tree', async () => {
        // Arrange — the literal, not the imported constant: asserting against
        // the same constant the implementation selects would let a selection
        // bug agree with itself.
        const ctx = createMemoryContext();
        const registry = createPackRegistry(ctx);
        const emptyTreeOidSha1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904' as ObjectId;
        const sut = resolveObject;

        // Act
        const result = await sut(ctx, registry, emptyTreeOidSha1, true, undefined);

        // Assert
        expect(result).toEqual({ type: 'tree', id: emptyTreeOidSha1, entries: [] });
      });
    });
  });

  describe('Given a SHA-256 repo and the SHA-1 empty-tree oid', () => {
    describe('When resolveObject is called', () => {
      it('Then throws OBJECT_NOT_FOUND (not intercepted under a mismatched hash config)', async () => {
        // Arrange — the SHA-1 empty-tree oid is the wrong length/value for a
        // SHA-256 repo's `emptyTreeOid`, so the intercept must not fire.
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        const registry = createPackRegistry(ctx);
        const sut = resolveObject;

        // Act
        try {
          await sut(ctx, registry, EMPTY_TREE_OID, true);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_NOT_FOUND');
          if (data.code !== 'OBJECT_NOT_FOUND') {
            expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
          }
        }
      });
    });
  });

  describe('Given a seeded loose blob', () => {
    describe('When resolveObject is called', () => {
      it('Then returns the parsed Blob', async () => {
        // Arrange
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const ctx = await buildSeededContext({ objects: [blob] });
        const { serializeObject } = await import('../../../../src/domain/objects/index.js');
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, id, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(new Uint8Array([1, 2, 3]));
      });
    });
  });

  describe('Given a missing id', () => {
    describe('When resolveObject is called', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, 'f'.repeat(40) as ObjectId, true);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given an aborted signal and a flat multi-pack-index with a flipped signature', () => {
    describe('When resolveObject is called', () => {
      it('Then the abort wins — OPERATION_ABORTED, never the midx fault, and no scan I/O', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const badMidx = new Uint8Array(16);
        badMidx.set([0x00, 0x49, 0x44, 0x58, 1, 1, 1, 0], 0);
        await ctx.fs.write(`${ctx.layout.gitDir}/objects/pack/multi-pack-index`, badMidx);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = createPackRegistry(instrumented);

        // Act
        let caught: unknown;
        try {
          await resolveObject(instrumented, registry, 'a'.repeat(40) as ObjectId, true);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
        const packDirCalls = calls().filter((call) => call.path.includes('objects/pack'));
        expect(packDirCalls).toEqual([]);
      });
    });
  });

  describe('Given an aborted signal', () => {
    describe('When resolveObject is called', () => {
      it('Then throws OPERATION_ABORTED before any fs call', async () => {
        // Arrange
        const controller = new AbortController();
        controller.abort();
        const ctx = await buildSeededContext({ signal: controller.signal });
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, 'a'.repeat(40) as ObjectId, true);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
        }
      });
    });
  });

  describe('Given verifyHash=false and a corrupted loose file', () => {
    describe('When resolveObject is called', () => {
      it('Then returns without verification error', async () => {
        // Arrange — craft a loose file whose content hash ≠ id.
        const ctx = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`;
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(loosePath, compressed);
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, fakeId, false);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given verifyHash=true and a corrupted loose file', () => {
    describe('When resolveObject is called', () => {
      it('Then throws OBJECT_HASH_MISMATCH', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fakeId = 'a'.repeat(40) as ObjectId;
        const { computeLooseObjectPath } = await import(
          '../../../../src/domain/storage/loose-path.js'
        );
        const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(fakeId)}`;
        const rawBytes = new TextEncoder().encode('blob 3\0xyz');
        const actualOid = await ctx.hash.hashHex(rawBytes);
        const compressed = await ctx.compressor.deflate(rawBytes);
        await ctx.fs.write(loosePath, compressed);
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, fakeId, true);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code !== 'OBJECT_HASH_MISMATCH') {
            expect.fail(`expected OBJECT_HASH_MISMATCH, got ${data.code}`);
          }
          expect(data.expected).toBe(fakeId);
          expect(data.actual).toBe(actualOid);
        }
      });
    });
  });

  describe('Given a synthetic pack with a base blob', () => {
    describe('When resolveObject is called', () => {
      it('Then returns the blob', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('hello packed blob');
        const [id] = await writeSyntheticPack(ctx, 'base-only', [
          { kind: 'base', type: 'blob', content },
        ]);
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, id as ObjectId, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(content);
      });
    });
  });

  describe('Given a synthetic pack with an OFS_DELTA entry', () => {
    describe('When resolveObject is called on the delta', () => {
      it('Then reconstructs the target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('ofs base content');
        const targetContent = new TextEncoder().encode('ofs target content — different');
        const ids = await writeSyntheticPack(ctx, 'ofs', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const deltaId = ids[1]!;
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, deltaId as ObjectId, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(targetContent);
      });
    });
  });

  describe('Given a synthetic pack with a REF_DELTA entry', () => {
    describe('When resolveObject is called on the delta', () => {
      it('Then reconstructs the target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('ref base');
        const targetContent = new TextEncoder().encode('ref target — different bytes');
        const ids = await writeSyntheticPack(ctx, 'ref', [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const baseId = ids[0]!;
        const ids2 = await writeSyntheticPack(ctx, 'ref-delta', [
          { kind: 'ref-delta', baseId, baseUncompressed: baseContent, targetContent },
        ]);
        const deltaId = ids2[0]!;
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, deltaId as ObjectId, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(targetContent);
      });
    });
  });

  describe('Given a synthetic pack with a base %s entry', () => {
    describe('When resolveObject is called', () => {
      it.each([
        [
          'commit',
          `tree ${'0'.repeat(40)}\nauthor a <a@a> 1 +0000\ncommitter a <a@a> 1 +0000\n\nm\n`,
        ],
        ['tree', ''],
        ['tag', `object ${'0'.repeat(40)}\ntype commit\ntag v1\ntagger a <a@a> 1 +0000\n\nt\n`],
      ] as const)('Then result.type equals the kind', async (kind, text) => {
        // Arrange — valid minimal content for each kind so parseObject succeeds
        // and result.type is strictly asserted; this kills isBase / packTypeName
        // StringLiteral mutants for 'tree' and 'tag'.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode(text);
        const [id] = await writeSyntheticPack(ctx, `base-${kind}`, [
          { kind: 'base', type: kind, content },
        ]);
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, id as ObjectId, false);

        // Assert
        expect(result.type).toBe(kind);
      });
    });
  });

  describe('bounded-size cap', () => {
    describe('Given a cached REF_DELTA base at the exact maxBytes boundary', () => {
      describe('When resolveObject is called', () => {
        it('Then accepts (cache-cap inclusive boundary)', async () => {
          // Arrange — cache contains a 5-byte payload, cap=5. Boundary kill
          // for the `actualSize > maxBytes` mutant: with `>=` it would
          // wrongly reject; with `>` it accepts.
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('abcde'); // 5 bytes
          const [baseId] = await writeSyntheticPack(ctx, 'cap-cache-eq-base', [
            { kind: 'base', type: 'blob', content: baseContent },
          ]);
          const [deltaId] = await writeSyntheticPack(ctx, 'cap-cache-eq-delta', [
            {
              kind: 'ref-delta',
              baseId: baseId!,
              baseUncompressed: baseContent,
              targetContent: new TextEncoder().encode('xy'),
            },
          ]);
          const registry = createPackRegistry(ctx);
          // Prime the cache with the base.
          await resolveObject(ctx, registry, baseId as ObjectId, false);

          // Act — exact boundary cap=5, base size=5 → accept.
          const result = await resolveObject(ctx, registry, deltaId as ObjectId, false, 5);

          // Assert
          expect(result.type).toBe('blob');
        });
      });
    });

    describe('Given a REF_DELTA whose base is in the LRU cache and exceeds maxBytes', () => {
      describe('When resolveObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE from enforceCachedCap', async () => {
          // Arrange — prime the deltaCache with a base larger than the cap,
          // then issue a capped REF_DELTA read whose base resolves via the
          // cache hit. The enforceCachedCap path must fire and reject; without
          // it, an oversized object admitted by an earlier uncapped read
          // would silently bypass the cap on subsequent capped reads.
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('cached-base-bytes');
          // Build a synthetic pack with the base so we have a real ObjectId.
          const [baseId] = await writeSyntheticPack(ctx, 'cap-cache-base', [
            { kind: 'base', type: 'blob', content: baseContent },
          ]);
          const [deltaId] = await writeSyntheticPack(ctx, 'cap-cache-delta', [
            {
              kind: 'ref-delta',
              baseId: baseId!,
              baseUncompressed: baseContent,
              targetContent: new TextEncoder().encode('xx'),
            },
          ]);
          const registry = createPackRegistry(ctx);
          // Prime the cache: an uncapped read admits the base.
          await resolveObject(ctx, registry, baseId as ObjectId, false);
          expect(ctx.deltaCache.get(baseId as ObjectId)).toBeDefined();

          // Act — capped REF_DELTA read; base resolves via cache hit.
          try {
            await resolveObject(ctx, registry, deltaId as ObjectId, false, 4);
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            // Assert — must be OBJECT_TOO_LARGE, NOT some downstream code
            // like OBJECT_NOT_FOUND that would indicate a different bypass.
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.id).toBe(baseId);
            expect(data.actualSize).toBe(baseContent.length);
            expect(data.limit).toBe(4);
          }
        });
      });
    });

    describe('Given a synthetic pack with an OFS_DELTA chain whose BASE exceeds maxBytes', () => {
      describe('When resolveObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE on the base (intermediate-base cap, not target-only)', async () => {
          // Arrange — base of 9 bytes + ofs-delta whose target is 2 bytes.
          // With maxBytes=4: the pre-apply check on the delta's target (2)
          // PASSES, but the base entry's declared size (9) exceeds the cap.
          // Without the fix (depth-gated enforcePackBaseCap), the base would
          // inflate into memory; the cap protects against this.
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('123456789');
          const targetContent = new TextEncoder().encode('xy');
          const ids = await writeSyntheticPack(ctx, 'cap-ofs-base-bypass', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ]);
          const deltaId = ids[1] as ObjectId;
          const registry = createPackRegistry(ctx);

          // Act — cap rejects on the base, not the target.
          try {
            await resolveObject(ctx, registry, deltaId, false, 4);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            // `actualSize=9` proves the cap fired on the BASE's declared size
            // (9 bytes) and not on the delta's target (2 bytes).
            expect(data.actualSize).toBe(9);
            expect(data.limit).toBe(4);
          }
        });
      });
    });

    describe('Given a delta whose declared target-size varint exceeds maxBytes', () => {
      describe('When resolveObject is called', () => {
        it('Then throws OBJECT_TOO_LARGE pre-apply (varint peek, not post-apply)', async () => {
          // Arrange — base 2 bytes, delta target 8 bytes, cap 4. The pre-
          // apply varint check reads targetSize=8 from the delta's leading
          // varints and rejects BEFORE the apply loop runs. Killing the
          // mutant that removes the pre-apply check leaves the post-apply
          // check still firing (with current.length=8 instead of declared 8).
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('ab');
          const targetContent = new TextEncoder().encode('abcdefgh');
          const ids = await writeSyntheticPack(ctx, 'cap-pre-apply', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ]);
          const deltaId = ids[1] as ObjectId;
          const registry = createPackRegistry(ctx);

          // Act
          try {
            await resolveObject(ctx, registry, deltaId, false, 4);
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            // Assert
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.actualSize).toBe(8);
            expect(data.limit).toBe(4);
          }
        });
      });
    });
  });

  describe('Given a pack-resolved target', () => {
    describe('When resolveObject is called', () => {
      it('Then the reconstructed bytes land in the delta cache', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('cache base');
        const targetContent = new TextEncoder().encode('cache target — different');
        const ids = await writeSyntheticPack(ctx, 'cache', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent },
        ]);
        const deltaId = ids[1]! as ObjectId;
        const registry = createPackRegistry(ctx);
        expect(ctx.deltaCache.get(deltaId)).toBeUndefined();

        // Act
        await resolveObject(ctx, registry, deltaId, true);

        // Assert — cacheEntry must have populated the cache; killing the
        // BlockStatement mutant that empties the function body.
        const cached = ctx.deltaCache.get(deltaId);
        expect(cached).toBeDefined();
        expect(cached!.length).toBeGreaterThan(0);
      });
    });
  });

  describe('deltaCache probe (A1 — warm delta-chain reads)', () => {
    describe('Given a warm delta-chain read that already populated the cache', () => {
      describe('When resolveObject is called again for the same id', () => {
        it('Then returns byte-identical bytes with zero pack touches', async () => {
          // Arrange — populate the cache with a real OFS_DELTA reconstruction,
          // then spy the pack-touching surfaces before the second read.
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('warm base content');
          const targetContent = new TextEncoder().encode('warm target content — different');
          const ids = await writeSyntheticPack(ctx, 'warm-ofs', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ]);
          const deltaId = ids[1]! as ObjectId;
          const registry = createPackRegistry(ctx);
          const first = await resolveObject(ctx, registry, deltaId, true);
          const lookupSpy = vi.spyOn(registry, 'lookup');
          const readSliceSpy = vi.spyOn(ctx.fs, 'readSlice');

          // Act
          const second = await resolveObject(ctx, registry, deltaId, true);

          // Assert — no re-walk of the chain: neither the registry lookup nor
          // any pack slice read fires on the warm path.
          expect((second as Blob).content).toEqual((first as Blob).content);
          expect(lookupSpy.mock.calls.length).toBe(0);
          expect(readSliceSpy.mock.calls.length).toBe(0);
        });
      });
    });

    describe('Given a poisoned deltaCache entry whose bytes do not hash to its key', () => {
      describe('When resolveObject is called with verifyHash true', () => {
        it('Then throws OBJECT_HASH_MISMATCH carrying the actual computed oid', async () => {
          // Arrange — no loose/pack copy exists for fakeId, so the only way to
          // reach a result is the deltaCache probe.
          const ctx = await buildSeededContext();
          const fakeId = 'e'.repeat(40) as ObjectId;
          const rawBytes = new TextEncoder().encode('blob 3\0xyz');
          const actualOid = (await ctx.hash.hashHex(rawBytes)) as ObjectId;
          ctx.deltaCache.set(fakeId, rawBytes, rawBytes.length);
          const registry = createPackRegistry(ctx);

          // Act
          try {
            await resolveObject(ctx, registry, fakeId, true);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_HASH_MISMATCH');
            if (data.code !== 'OBJECT_HASH_MISMATCH') {
              expect.fail(`expected OBJECT_HASH_MISMATCH, got ${data.code}`);
            }
            expect(data.expected).toBe(fakeId);
            expect(data.actual).toBe(actualOid);
          }
        });
      });
    });

    describe('Given a deltaCache entry for id whose content exceeds maxBytes', () => {
      describe('When resolveObject is called with a maxBytes cap', () => {
        it('Then throws OBJECT_TOO_LARGE from the cache-hit path', async () => {
          // Arrange — 10 content bytes cached under fakeId, cap = 5.
          const ctx = await buildSeededContext();
          const fakeId = 'c'.repeat(40) as ObjectId;
          const header = new TextEncoder().encode('blob 10\0');
          const content = new Uint8Array(10).fill(0x41);
          const cached = new Uint8Array(header.length + content.length);
          cached.set(header, 0);
          cached.set(content, header.length);
          ctx.deltaCache.set(fakeId, cached, cached.length);
          const registry = createPackRegistry(ctx);

          // Act
          try {
            await resolveObject(ctx, registry, fakeId, false, 5);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.id).toBe(fakeId);
            expect(data.actualSize).toBe(10);
            expect(data.limit).toBe(5);
          }
        });
      });
    });

    describe('Given a delta-cache hit', () => {
      describe('When resolveObjectBytes is called with verifyHash=false', () => {
        it('Then no hash is computed', async () => {
          // Arrange — the sync fast path must not pay for a hash it never uses.
          const ctx = await buildSeededContext();
          const fakeId = 'd'.repeat(40) as ObjectId;
          const rawBytes = new TextEncoder().encode('blob 3\0xyz');
          ctx.deltaCache.set(fakeId, rawBytes, rawBytes.length);
          const registry = createPackRegistry(ctx);
          const hashSpy = vi.spyOn(ctx.hash, 'hashHex');

          // Act
          const result = await resolveObjectBytes(ctx, registry, fakeId, false);

          // Assert
          expect(result).toEqual(rawBytes);
          expect(hashSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a delta-cache hit and a signal that aborts before the read returns', () => {
      describe('When resolveObjectBytes is called with verifyHash=false', () => {
        it('Then it rejects with OPERATION_ABORTED', async () => {
          // Arrange — verifyHash=false means the cache-hit arm no longer awaits
          // a hash, so it must poll for abort explicitly at the same point
          // instead, or a signal raised in flight would go unobserved.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          const fakeId = 'd'.repeat(40) as ObjectId;
          const rawBytes = new TextEncoder().encode('blob 3\0xyz');
          ctx.deltaCache.set(fakeId, rawBytes, rawBytes.length);
          const registry = createPackRegistry(ctx);
          vi.spyOn(ctx.deltaCache, 'get').mockImplementationOnce(() => {
            controller.abort();
            return rawBytes;
          });

          // Act
          try {
            await resolveObjectBytes(ctx, registry, fakeId, false);
            // Assert
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
          }
        });
      });
    });

    describe('Given an empty deltaCache and a seeded loose blob', () => {
      describe('When resolveObject is called', () => {
        it('Then resolves via the loose path unchanged', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: new TextEncoder().encode('cold miss loose content'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = createPackRegistry(ctx);
          expect(ctx.deltaCache.get(id)).toBeUndefined();

          // Act
          const result = await resolveObject(ctx, registry, id, true);

          // Assert
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(blob.content);
        });
      });
    });
  });

  describe('F2.3 — loose reads populate the delta cache', () => {
    describe('Given a loose object read once', () => {
      describe('When resolveObject returns', () => {
        it('Then the delta cache holds its raw loose-format bytes', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: ENC.encode('loose-cache-population content'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = createPackRegistry(ctx);
          expect(ctx.deltaCache.get(id)).toBeUndefined();

          // Act
          await resolveObject(ctx, registry, id, true);

          // Assert — cacheEntry must have populated the cache from the loose
          // return path, not just the pack/REF_DELTA-base paths.
          const cached = ctx.deltaCache.get(id);
          expect(cached).toBeDefined();
          expect(cached!.length).toBeGreaterThan(0);
        });
      });
    });

    describe('Given a loose object read twice on one Context', () => {
      describe('When the second read runs', () => {
        it('Then the compressor inflates once', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: ENC.encode('loose-cache-warm-read content'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = createPackRegistry(ctx);
          const inflateSpy = vi.spyOn(ctx.compressor, 'inflate');

          // Act
          const first = await resolveObject(ctx, registry, id, true);
          const second = await resolveObject(ctx, registry, id, true);

          // Assert — a warm read hits the cache instead of re-inflating.
          expect((second as Blob).content).toEqual((first as Blob).content);
          expect(inflateSpy.mock.calls.length).toBe(1);
        });
      });
    });
  });

  describe('Given a cold Context whose requested object is loose', () => {
    describe('When resolveObject reads it', () => {
      it('Then no readdir targets objects/pack and no .idx path is ever statted or read', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('cold-read loose content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const { serializeObject } = await import('../../../../src/domain/objects/index.js');
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        await writeSyntheticPack(ctx, 'cold-read-a', [
          { kind: 'base', type: 'blob', content: ENC.encode('a') },
        ]);
        await writeSyntheticPack(ctx, 'cold-read-b', [
          { kind: 'base', type: 'blob', content: ENC.encode('b') },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = createPackRegistry(instrumented);

        // Act
        const result = await resolveObject(instrumented, registry, id, true);

        // Assert
        expect(result.type).toBe('blob');
        const packDirReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
        );
        expect(packDirReaddirCalls).toEqual([]);
        // `exists` never fires for a stronger reason than "the scan didn't run
        // this time": scanPacks no longer calls it at all (the readdir fold
        // below replaced it), so this count is zero by construction, not by
        // this read happening to take the loose branch.
        const existsCalls = calls().filter((call) => call.method === 'exists');
        expect(existsCalls).toEqual([]);
        const idxTouches = calls().filter((call) => call.path.endsWith('.idx'));
        expect(idxTouches).toEqual([]);
      });
    });
  });

  describe('Given a Context whose readdir of objects/pack rejects with PERMISSION_DENIED', () => {
    describe('When resolveObject reads an object that is loose', () => {
      it('Then it resolves with the blob', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('permission-denied-pack-dir loose content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const { serializeObject } = await import('../../../../src/domain/objects/index.js');
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        const packDir = `${ctx.layout.gitDir}/objects/pack`;
        // The seeded context holds loose objects only, so create the pack dir
        // to match the on-disk shape this row describes: a pack directory that
        // exists and cannot be listed. The `readdir` stub below is keyed on
        // path and fires regardless, so the assertion has teeth either way —
        // this makes the arrangement honest, not the test load-bearing.
        await ctx.fs.mkdir(packDir);
        const stubCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            readdir: async (path: string) => {
              if (path === packDir) throw permissionDenied(packDir);
              return ctx.fs.readdir(path);
            },
          },
        };
        const registry = createPackRegistry(stubCtx);

        // Act
        const result = await resolveObject(stubCtx, registry, id, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(blob.content);
      });
    });
  });

  describe('Given a cold Context whose requested object is NOT loose but IS packed', () => {
    describe('When resolveObject reads it', () => {
      it('Then objects/pack is listed exactly once and the object still resolves', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = ENC.encode('cold-read packed content');
        const [id] = await writeSyntheticPack(ctx, 'cold-read-packed', [
          { kind: 'base', type: 'blob', content },
        ]);
        await writeMidxBytes(ctx, buildMidx(healthyMidxSpec()));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = createPackRegistry(instrumented);

        // Act
        const result = await resolveObject(instrumented, registry, id as ObjectId, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(content);
        const packDirReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
        );
        expect(packDirReaddirCalls).toHaveLength(1);
      });
    });
  });

  describe('Given a Tier-A multi-pack-index (flipped signature) and a loose object that exists', () => {
    describe('When resolveObject reads it', () => {
      it('Then the read throws INVALID_MULTI_PACK_INDEX with check signature before any fanout readdir runs', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('tier-a-denied loose content'),
          id: '' as ObjectId,
        };
        const ctx = await buildSeededContext({ objects: [blob] });
        const { serializeObject } = await import('../../../../src/domain/objects/index.js');
        const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
        const badMidx = new Uint8Array(16);
        badMidx.set([0x00, 0x49, 0x44, 0x58, 1, 1, 1, 0], 0);
        await writeMidxBytes(ctx, badMidx);
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = createPackRegistry(instrumented);

        // Act
        let caught: unknown;
        try {
          await resolveObject(instrumented, registry, id, true);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('INVALID_MULTI_PACK_INDEX');
        if (data.code === 'INVALID_MULTI_PACK_INDEX') {
          expect(data.check).toBe('signature');
        }
        const fanoutReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith(`/objects/${id.slice(0, 2)}`),
        );
        expect(fanoutReaddirCalls).toEqual([]);
      });
    });
  });

  describe('Given a Tier-B multi-pack-index (truncated) and a loose object that exists', () => {
    describe('When resolveObject reads it', () => {
      it('Then the blob resolves, the discard warn fires once, and objects/pack is never listed', async () => {
        // Arrange
        const blob: Blob = {
          type: 'blob',
          content: ENC.encode('tier-b-warned loose content'),
          id: '' as ObjectId,
        };
        const baseCtx = await buildSeededContext({ objects: [blob] });
        const { serializeObject } = await import('../../../../src/domain/objects/index.js');
        const id = (await baseCtx.hash.hashHex(
          serializeObject(blob, baseCtx.hashConfig),
        )) as ObjectId;
        const warn = vi.fn();
        const ctx = { ...baseCtx, logger: { warn } };
        await writeMidxBytes(ctx, truncateMidxTo8(buildMidx(healthyMidxSpec())));
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = createPackRegistry(instrumented);

        // Act
        const result = await resolveObject(instrumented, registry, id, true);

        // Assert
        expect(result.type).toBe('blob');
        expect(warn).toHaveBeenCalledTimes(1);
        const packDirReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
        );
        expect(packDirReaddirCalls).toEqual([]);
      });
    });
  });

  describe('loose-oid probe (A2/B7b — per-fanout-dir cache)', () => {
    describe('Given several seeded loose blobs', () => {
      describe('When resolveObject reads each of them, then reads every one again', () => {
        it('Then each touched fanout dir is readdir-ed at most once and the pack store is never probed', async () => {
          // Arrange
          const blobs: Blob[] = Array.from({ length: 5 }, (_, i) => ({
            type: 'blob',
            content: new TextEncoder().encode(`loose-oid-probe-content-${i}`),
            id: '' as ObjectId,
          }));
          const ctx = await buildSeededContext({ objects: blobs });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const ids = await Promise.all(
            blobs.map(
              async (blob) =>
                (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId,
            ),
          );
          const registry = createPackRegistry(ctx);
          const readdirSpy = vi.spyOn(ctx.fs, 'readdir');
          const existsSpy = vi.spyOn(ctx.fs, 'exists');

          // Act — resolve every id, then resolve every id again.
          for (const id of ids) {
            await resolveObject(ctx, registry, id, true);
          }
          for (const id of ids) {
            await resolveObject(ctx, registry, id, true);
          }

          // Assert — one readdir per DISTINCT touched prefix, never per object
          // or per read; the old per-object exists/realpath probe is gone.
          // exists() never fires at all: resolveObjectBytes's assertLoadable
          // gate is now the multi-pack-index load alone, and the pack
          // directory's own `exists` presence check moved behind the
          // deferred scan, which a loose HIT never forces.
          const touchedPrefixes = new Set(ids.map((id) => id.slice(0, 2)));
          expect(readdirSpy.mock.calls.length).toBe(touchedPrefixes.size);
          expect(existsSpy.mock.calls.length).toBe(0);
        });
      });
    });

    describe('Given a cached membership hit whose loose file was pruned out-of-band', () => {
      describe('When resolveObject is called again for the pruned id', () => {
        it('Then it degrades to a miss (OBJECT_NOT_FOUND), never a raw FILE_NOT_FOUND', async () => {
          // Arrange — read once so the fanout set caches the object, then
          // remove the file underneath the cache (an external `git gc` prune)
          const blob: Blob = {
            type: 'blob',
            content: new TextEncoder().encode('pruned-under-cache'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = createPackRegistry(ctx);
          await resolveObject(ctx, registry, id, true);
          // F2.3 also populates the delta cache on a loose read; drop that
          // entry so this probe exercises the fanout MEMBERSHIP cache's own
          // stale-hit degradation, not the (separately-tested) delta cache.
          ctx.deltaCache.delete(id);
          const { computeLooseObjectPath } = await import(
            '../../../../src/domain/storage/loose-path.js'
          );
          await ctx.fs.rm(`${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`);

          // Act
          try {
            await resolveObject(ctx, registry, id, true);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_NOT_FOUND');
            if (data.code !== 'OBJECT_NOT_FOUND') {
              expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
            }
            expect(data.id).toBe(id);
          }

          // Assert — the stale prefix set was dropped: a THIRD probe re-reads
          // the directory, sees the object gone, and never touches the file
          const readSpy = vi.spyOn(ctx.fs, 'read');
          await resolveObject(ctx, registry, id, true).catch(() => {});
          const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id)}`;
          expect(readSpy.mock.calls.map((call) => call[0])).not.toContain(loosePath);
        });
      });
    });

    describe('Given a seeded loose blob (membership hit)', () => {
      describe('When resolveObject resolves it', () => {
        it('Then the loose file is read via ctx.fs.read', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: new TextEncoder().encode('membership-hit-content'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = createPackRegistry(ctx);
          const readSpy = vi.spyOn(ctx.fs, 'read');

          // Act
          const result = await resolveObject(ctx, registry, id, true);

          // Assert
          expect(result.type).toBe('blob');
          expect(readSpy.mock.calls.length).toBe(1);
        });
      });
    });

    describe('Given a missing id with no loose file and no pack copy (membership miss)', () => {
      describe('When resolveObject is called', () => {
        it('Then throws OBJECT_NOT_FOUND without ever reading or exists-probing the loose path', async () => {
          // Arrange — the pack registry's own (unrelated) pack-dir existence
          // check still fires once on a cold registry; what must NOT happen
          // is a per-object exists/read probe against the loose object path.
          const ctx = await buildSeededContext();
          const registry = createPackRegistry(ctx);
          const missingId = 'b'.repeat(40) as ObjectId;
          const loosePathPattern = /\/objects\/[0-9a-f]{2}\/[0-9a-f]{38}$/;
          const readSpy = vi.spyOn(ctx.fs, 'read');
          const existsSpy = vi.spyOn(ctx.fs, 'exists');

          // Act
          try {
            await resolveObject(ctx, registry, missingId, true);
            // Assert
            expect.unreachable();
          } catch (error) {
            expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
          }

          // Assert
          expect(readSpy.mock.calls.length).toBe(0);
          expect(existsSpy.mock.calls.some(([path]) => loosePathPattern.test(path))).toBe(false);
        });
      });
    });

    describe('Given a fanout dir already probed as empty for one id', () => {
      describe('When writeObject adds a new object under the same prefix and resolveObject reads it', () => {
        it('Then the write invalidates the stale cache and the new object resolves via the loose path', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: new TextEncoder().encode('invalidation-after-write'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext();
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const prefix = id.slice(0, 2);
          const decoyId = `${prefix}${'0'.repeat(38)}` as ObjectId;
          const registry = createPackRegistry(ctx);
          try {
            // Primes the fanout-dir cache as empty for this prefix.
            await resolveObject(ctx, registry, decoyId, true);
            expect.unreachable();
          } catch (error) {
            expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
          }

          // Act
          await writeObject(ctx, blob);
          const result = await resolveObject(ctx, registry, id, true);

          // Assert
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(blob.content);
        });
      });
    });
  });

  describe('Given a synthetic pack with a 2-hop OFS_DELTA chain', () => {
    describe('When resolveObject is called on the tip', () => {
      it('Then applies deltas in reverse order', async () => {
        // Arrange — base ← delta1 ← delta2. Correct reconstruction applies delta2 on
        // delta1's output. Reversing the apply-loop direction yields the wrong bytes.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('AAAA');
        const mid = new TextEncoder().encode('BBBB');
        const tip = new TextEncoder().encode('CCCC');
        const ids = await writeSyntheticPack(ctx, 'ofs-chain', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent: mid },
          { kind: 'ofs-delta', baseIndex: 1, targetContent: tip },
        ]);
        const tipId = ids[2]!;
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, tipId as ObjectId, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(tip);
      });
    });
  });

  describe('offset-keyed delta base cache', () => {
    describe('Given an OFS delta chain read twice', () => {
      describe('When the second read runs', () => {
        it('Then the mid-chain bases are not re-inflated', async () => {
          // Arrange — base ← mid ← {tip1, tip2}: two tips share the SAME
          // mid-chain base. Reading tip1 first should populate the mid
          // level's offset-keyed entry; reading tip2 should then reuse it
          // instead of re-walking down to mid and base.
          const ctx = await buildSeededContext();
          const baseContent = ENC.encode('shared base content');
          const midContent = ENC.encode('shared mid content');
          const tip1Content = ENC.encode('tip one content');
          const tip2Content = ENC.encode('tip two content — different');
          const ids = await writeSyntheticPack(ctx, 'shared-mid', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: midContent },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: tip1Content },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: tip2Content },
          ]);
          const tip1Id = ids[2]! as ObjectId;
          const tip2Id = ids[3]! as ObjectId;
          const registry = createPackRegistry(ctx);
          await resolveObject(ctx, registry, tip1Id, true);
          const inflateSpy = vi.spyOn(ctx.compressor, 'inflate');

          // Act
          const result = await resolveObject(ctx, registry, tip2Id, true);

          // Assert — only tip2's own delta instructions are inflated; the
          // shared mid level (and the base beneath it) come from the
          // offset-keyed cache.
          expect((result as Blob).content).toEqual(tip2Content);
          expect(inflateSpy.mock.calls.length).toBe(1);
        });
      });
    });

    describe('Given a chain whose base was cached under (pack, offset)', () => {
      describe('When a different chain descends to that same offset', () => {
        it('Then the cached type is reused without re-splitting the header', async () => {
          // Arrange — base type 'tree' (not 'blob'): a hit that re-derived
          // (or defaulted) the type instead of reusing the cached one would
          // fail this. resolveObjectBytes is used so the reconstructed
          // target need not be a structurally valid tree body.
          const ctx = await buildSeededContext();
          const midContent = ENC.encode('tree-typed mid content');
          const tip1Content = ENC.encode('tip one');
          const tip2Content = ENC.encode('tip two — different');
          const ids = await writeSyntheticPack(ctx, 'tree-typed-mid', [
            { kind: 'base', type: 'tree', content: new Uint8Array() },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: midContent },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: tip1Content },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: tip2Content },
          ]);
          const tip1Id = ids[2]! as ObjectId;
          const tip2Id = ids[3]! as ObjectId;
          const registry = createPackRegistry(ctx);
          await resolveObjectBytes(ctx, registry, tip1Id, false);

          // Act
          const bytes = await resolveObjectBytes(ctx, registry, tip2Id, false);

          // Assert — header carries the propagated 'tree' type.
          const header = new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0)));
          expect(header).toBe(`tree ${tip2Content.length}`);
        });
      });
    });

    describe('Given the pack registry is refreshed', () => {
      describe('When the same (pack, offset) is read again', () => {
        it('Then the stale entry is not served', async () => {
          // Arrange — gen1's base entry occupies the pack's very first
          // offset (always right after the fixed-size pack header,
          // regardless of entry count or content). Reading its tip caches
          // that offset under gen1's content; a Context-scoped cache would
          // keep serving it after the pack is replaced — refresh() must drop
          // the binding instead.
          const ctx = await buildSeededContext();
          const contentA = ENC.encode('generation one base content');
          const gen1 = await writeSyntheticPack(ctx, 'swap', [
            { kind: 'base', type: 'blob', content: contentA },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: ENC.encode('generation one tip') },
          ]);
          const tip1Id = gen1[1]! as ObjectId;
          const registry = createPackRegistry(ctx);
          await resolveObject(ctx, registry, tip1Id, true);

          // Act — refresh, then replace the SAME pack name with a new
          // generation whose first entry (the same on-disk offset) is a base
          // with different bytes and no delta at all.
          registry.refresh();
          const contentB = ENC.encode('generation two — completely different bytes');
          const gen2 = await writeSyntheticPack(ctx, 'swap', [
            { kind: 'base', type: 'blob', content: contentB },
          ]);
          const newBaseId = gen2[0]! as ObjectId;
          const result = await resolveObject(ctx, registry, newBaseId, true);

          // Assert
          expect((result as Blob).content).toEqual(contentB);
        });
      });
    });

    describe('Given an intermediate larger than the byte cap', () => {
      describe('When resolveObject is called', () => {
        it('Then it is not cached and the read still succeeds', async () => {
          // Arrange — a deltaCacheMaxBytes sized so the 1-byte base fits under
          // the cap once the fixed per-entry overhead is added (1 + 200 = 201
          // <= 205), while BOTH the 64-byte mid intermediate (64 + 200 = 264)
          // AND the tip's own reconstructed entry (11 + 200 = 211, also
          // cached under its own offset once fully resolved) exceed it — a
          // cap that fit the tip too would evict the base via normal LRU
          // eviction, defeating the point of this fixture. Every oversized
          // entry is silently dropped by LruCache.set rather than thrown
          // from, and the read still completes correctly.
          const ctx = createMemoryContext({ deltaCacheMaxBytes: 205 });
          const baseContent = ENC.encode('a');
          const midContent = new Uint8Array(64).fill(0x42);
          const tipContent = ENC.encode('tip content');
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: midContent },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: tipContent },
          ]);
          const packBase = `${ctx.layout.gitDir}/objects/pack/pack-oversize-mid`;
          await ctx.fs.write(`${packBase}.pack`, built.packBytes);
          await ctx.fs.write(`${packBase}.idx`, built.idxBytes);
          const tipId = built.ids[2]! as ObjectId;
          const baseOffset = built.offsets[0]!;
          const midOffset = built.offsets[1]!;
          const registry = createPackRegistry(ctx);

          // Act
          const result = await resolveObject(ctx, registry, tipId, true);

          // Assert — the 1-byte base fits under the cap and IS cached
          // (proving the key/pack-name shape used below is right, so the
          // mid's absence is the size cap, not a lookup miss); the 64-byte
          // mid is not.
          expect((result as Blob).content).toEqual(tipContent);
          expect(
            registry.deltaBaseCache.get(deltaBaseCacheKey('pack-oversize-mid', baseOffset)),
          ).toBeDefined();
          expect(
            registry.deltaBaseCache.get(deltaBaseCacheKey('pack-oversize-mid', midOffset)),
          ).toBeUndefined();
        });
      });
    });

    describe('Given a zero-length intermediate', () => {
      describe('When resolveObject is called', () => {
        it('Then the fixed per-entry overhead keeps the size positive and set does not throw', async () => {
          // Arrange — mid reconstructs to an EMPTY blob. LruCache.set throws
          // on byteSize <= 0; a naive `content.length` sizer would pass 0
          // straight through and crash the read instead of merely caching it
          // under the fixed overhead alone.
          const ctx = await buildSeededContext();
          const baseContent = ENC.encode('non-empty base');
          const emptyMid = new Uint8Array(0);
          const tipContent = ENC.encode('tip content');
          const built = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: emptyMid },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: tipContent },
          ]);
          const packBase = `${ctx.layout.gitDir}/objects/pack/pack-zero-mid`;
          await ctx.fs.write(`${packBase}.pack`, built.packBytes);
          await ctx.fs.write(`${packBase}.idx`, built.idxBytes);
          const tipId = built.ids[2]! as ObjectId;
          const midOffset = built.offsets[1]!;
          const registry = createPackRegistry(ctx);

          // Act
          const result = await resolveObject(ctx, registry, tipId, true);

          // Assert — the read succeeds AND the entry is genuinely retained,
          // not merely "didn't crash".
          expect((result as Blob).content).toEqual(tipContent);
          const cached = registry.deltaBaseCache.get(deltaBaseCacheKey('pack-zero-mid', midOffset));
          expect(cached).toBeDefined();
          expect(cached!.content.length).toBe(0);
        });
      });
    });

    describe('Given a single non-delta base object (no delta chain at all)', () => {
      describe('When resolveObject reads it cold', () => {
        it('Then the delta-base cache stays empty — nothing will ever probe this offset as an intermediate', async () => {
          // Arrange — a lone base entry, never a delta target or a delta base.
          const ctx = await buildSeededContext();
          const content = ENC.encode('a lone base object');
          const [id] = await writeSyntheticPack(ctx, 'pack-single-base', [
            { kind: 'base', type: 'blob', content },
          ]);
          const registry = createPackRegistry(ctx);

          // Act
          const result = await resolveObject(ctx, registry, id as ObjectId, true);

          // Assert
          expect((result as Blob).content).toEqual(content);
          expect(registry.deltaBaseCache.entryCount).toBe(0);
        });
      });
    });

    describe('Given an OFS_DELTA chain of two levels (base -> mid -> tip)', () => {
      describe('When resolveObject resolves the tip', () => {
        it("Then each level's cache key is computed once — probed and reused for the write, not recomputed", async () => {
          // Arrange — 3 levels touch the offset-keyed cache: the base (probed
          // then, since deltas.length > 0, cache-written under a freshly
          // computed key) plus mid and tip (each probed once, then their
          // SAME probe key reused for the write). A double-computation per
          // delta level would total 6 calls (3 probes + 3 writes); reuse
          // brings it to 4 (3 probes + 1 fresh write for the base alone).
          const ctx = await buildSeededContext();
          const ids = await writeSyntheticPack(ctx, 'pack-key-reuse', [
            { kind: 'base', type: 'blob', content: ENC.encode('base') },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: ENC.encode('mid') },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: ENC.encode('tip') },
          ]);
          const tipId = ids[2]! as ObjectId;
          const registry = createPackRegistry(ctx);
          deltaBaseCacheKeySpy.mockClear();

          // Act
          await resolveObject(ctx, registry, tipId, false);

          // Assert
          expect(deltaBaseCacheKeySpy).toHaveBeenCalledTimes(4);
        });
      });
    });
  });

  describe('Given a REF_DELTA whose base is a %s', () => {
    describe('When resolveObject is called', () => {
      it.each([
        ['tree', new Uint8Array()],
        [
          'tag',
          new TextEncoder().encode(
            `object ${'0'.repeat(40)}\ntype commit\ntag v1\ntagger a <a@a> 1 +0000\n\nt\n`,
          ),
        ],
      ] as const)('Then typeNameToPackType matches the kind', async (kind, baseContent) => {
        // Arrange
        const ctx = await buildSeededContext();
        const [baseId] = await writeSyntheticPack(ctx, `ref-${kind}-base`, [
          { kind: 'base', type: kind, content: baseContent },
        ]);
        const [deltaId] = await writeSyntheticPack(ctx, `ref-${kind}-delta`, [
          {
            kind: 'ref-delta',
            baseId: baseId!,
            baseUncompressed: baseContent,
            targetContent: baseContent,
          },
        ]);
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, deltaId as ObjectId, false);

        // Assert
        expect(result.type).toBe(kind);
      });
    });
  });

  describe('Given an OFS_DELTA chain of exactly length 50 (at cap)', () => {
    describe('When resolveObject is called', () => {
      it('Then reconstructs without throwing DELTA_CHAIN_TOO_DEEP', async () => {
        // Arrange — base + 50 chained OFS deltas. Depth walker hits exactly
        // MAX_DELTA_CHAIN_DEPTH=50, but the guard uses `>`, not `>=`, so this must
        // succeed. Kills the `depth >= MAX_DELTA_CHAIN_DEPTH` mutant.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('x');
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
        for (let i = 0; i < 50; i += 1) {
          const target = new TextEncoder().encode(`t-${i}`);
          entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
        }
        const ids = await writeSyntheticPack(ctx, 'at-cap', entries);
        const tipId = ids.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, tipId, false);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a REF_DELTA whose base is a commit', () => {
    describe('When resolveObject is called', () => {
      it('Then typeNameToPackType returns the commit constant', async () => {
        // Arrange — round-trip a valid commit base into the pack, then a REF_DELTA
        // pointing at it. Ensures splitHeader/typeNameToPackType hit the 'commit' arm.
        const ctx = await buildSeededContext();
        const { serializeObject } = await import('../../../../src/domain/objects/index.js');
        const treeId = 'a'.repeat(40) as ObjectId;
        const commitObj = {
          type: 'commit' as const,
          id: '' as ObjectId,
          data: {
            tree: treeId,
            parents: [],
            author: {
              name: 'a',
              email: 'a@a.com',
              timestamp: 1,
              timezoneOffset: '+0000' as const,
            },
            committer: {
              name: 'a',
              email: 'a@a.com',
              timestamp: 1,
              timezoneOffset: '+0000' as const,
            },
            message: 'm',
            extraHeaders: [],
          },
        };
        const commitBytes = serializeObject(commitObj, ctx.hashConfig);
        // Strip the `commit <n>\0` header so the pack stores only the content.
        const nul = commitBytes.indexOf(0);
        const commitContent = commitBytes.subarray(nul + 1);
        const [baseId] = await writeSyntheticPack(ctx, 'ref-commit-base', [
          { kind: 'base', type: 'commit', content: commitContent },
        ]);
        // REF_DELTA that rebuilds the same commit content (delta is a pure INSERT).
        const [deltaId] = await writeSyntheticPack(ctx, 'ref-commit-delta', [
          {
            kind: 'ref-delta',
            baseId: baseId!,
            baseUncompressed: commitContent,
            targetContent: commitContent,
          },
        ]);
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, deltaId as ObjectId, false);

        // Assert — the reconstructed object must be a commit (not mis-typed as blob).
        expect(result.type).toBe('commit');
      });
    });
  });

  describe('exact-slice reads', () => {
    describe('Given a 2-entry pack where the first entry is a base blob', () => {
      describe('When resolveObject is called on the first entry', () => {
        it('Then inflate is called with exactly chunk.subarray(headerEndInChunk)', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = ENC.encode('exact-slice inflate argument');
          const ids = await writeSyntheticPack(ctx, 'exact-inflate-arg', [
            { kind: 'base', type: 'blob', content },
            { kind: 'base', type: 'blob', content: ENC.encode('second entry') },
          ]);
          const firstId = ids[0] as ObjectId;
          const sut = resolveObject;
          const registry = createPackRegistry(ctx);
          const inflateSpy = vi.spyOn(ctx.compressor, 'inflate');

          // Act
          const result = await sut(ctx, registry, firstId, false);

          // Assert — the call to inflate on the pack path uses subarray; find the
          // pack-path call (loose inflate also calls inflate; pack read is NOT the
          // first call since there's no loose file)
          expect(result.type).toBe('blob');
          // Find the call whose argument is NOT a small loose-style compressed buffer.
          // The pack inflate call receives chunk.subarray(headerEndInChunk).
          // Since there is no loose file for this id, the only inflate call is from
          // the pack read path.
          const calls = inflateSpy.mock.calls;
          expect(calls.length).toBe(1);
          // The argument must be a Uint8Array subarray (not a zero-offset view of the full chunk).
          const arg = calls.at(-1)![0] as Uint8Array;
          expect(arg).toBeInstanceOf(Uint8Array);
          // The deflated content round-trips back to the original — sanity check.
          const decompressed = await ctx.compressor.inflate(arg);
          expect(decompressed).toEqual(content);
        });

        it('Then streamInflate is never called on this path', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = ENC.encode('no-stream-inflate');
          const ids = await writeSyntheticPack(ctx, 'no-stream-inflate', [
            { kind: 'base', type: 'blob', content },
            { kind: 'base', type: 'blob', content: ENC.encode('second') },
          ]);
          const firstId = ids[0] as ObjectId;
          const sut = resolveObject;
          const registry = createPackRegistry(ctx);
          const streamInflateSpy = vi.spyOn(ctx.compressor, 'streamInflate');

          // Act
          await sut(ctx, registry, firstId, false);

          // Assert — streamInflate must never be called anywhere in the resolve path
          expect(streamInflateSpy.mock.calls.length).toBe(0);
        });
      });
    });

    describe('Given a single-entry pack with a base blob', () => {
      describe('When resolveObject is called', () => {
        it('Then the slice is [entryOffset, trailerStart) i.e. packFileSize − digestLength', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = ENC.encode('single-entry trailer-bound');
          const ids = await writeSyntheticPack(ctx, 'single-trailer', [
            { kind: 'base', type: 'blob', content },
          ]);
          const id = ids[0] as ObjectId;
          const sut = resolveObject;
          const registry = createPackRegistry(ctx);
          // Compute expected slice length from the real offset table before the act.
          const packs = await registry.all();
          const table = await packs[0]!.offsetTable();
          const entryOffset = expectSortedOffsets(table)[0]!;
          const expectedSliceLength = table.trailerStart - entryOffset;
          const readSliceSpy = vi.spyOn(packs[0]!, 'readSlice');

          // Act
          const result = await sut(ctx, registry, id, false);

          // Assert — exact slice length = trailerStart - entryOffset
          expect(result.type).toBe('blob');
          expect(readSliceSpy.mock.calls.length).toBe(1);
          const [offset, sliceLength] = readSliceSpy.mock.calls[0]!;
          expect(offset).toBe(entryOffset);
          expect(sliceLength).toBe(expectedSliceLength);
        });
      });
    });

    describe('Given a corrupt table where a non-last entry next offset equals packFileSize exactly', () => {
      describe('When resolveObject is called', () => {
        it('Then the entry is still read — the guard rejects only strictly-greater next offsets', async () => {
          // Arrange — a real single-entry pack, but a stubbed table where the entry
          // is non-last and its next offset === packFileSize (a corrupt .idx whose
          // extra offset sits exactly at the entry's end). The `>` guard must let
          // `nextOffset === packFileSize` through, so the read proceeds and recovers
          // the blob from [entryOffset, nextOffset).
          const ctx = await buildSeededContext();
          const content = ENC.encode('next-offset-equals-pack-file-size');
          const ids = await writeSyntheticPack(ctx, 'eq-boundary', [
            { kind: 'base', type: 'blob', content },
          ]);
          const id = ids[0] as ObjectId;
          const realPack = (await createPackRegistry(ctx).all())[0]!;
          const realTable = await realPack.offsetTable();
          const entryOffset = expectSortedOffsets(realTable)[0]!;
          const boundary = realTable.trailerStart; // the entry's real end
          const pack: RegisteredPack = {
            ...realPack,
            offsetTable: async () => ({
              kind: 'sorted' as const,
              sortedOffsets: Float64Array.of(entryOffset, boundary),
              packFileSize: boundary,
              trailerStart: boundary - ctx.hashConfig.digestLength,
            }),
          };
          const registry: PackRegistry = {
            all: async () => [pack],
            fileNames: async () => new Set(),
            assertLoadable: async () => {},
            refresh: () => undefined,
            settleRefresh: async () => {},
            lookup: async (lookupId) =>
              lookupId === id ? { pack, offset: entryOffset } : undefined,
            dispose: noopDispose,
            health: async () => ({ accessible: [pack], unusable: [] }),
            indexFaults: async () => [],
            midxHealth: async () => ({
              artefact: undefined,
              faults: [],
              flatFilePresent: false,
              unresolvedPacks: [],
              unresolvedEntries: [],
              checksumOk: undefined,
            }),
            midxBitmap: async () => undefined,
            deltaBaseCache: createLruCache(1024),
          };
          const sut = resolveObject;

          // Act
          const result = await sut(ctx, registry, id, false);

          // Assert — read proceeds at the === boundary; blob recovered intact
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(content);
        });
      });
    });

    describe('Given a pack where nextOffset equals offset (corrupt index: slice length ≤ 0)', () => {
      describe('When resolveObject is called', () => {
        it('Then throws INVALID_PACK_INDEX with slice length reason', async () => {
          // Arrange — manufacture a stub registry where offsetTable returns
          // sortedOffsets=[offset] and packFileSize=offset (so trailerStart=offset-20,
          // which means nextOffsetForEntry returns trailerStart = offset-20 < offset →
          // sliceLength ≤ 0 guard fires). Actually: for a single entry, nextOffset
          // = trailerStart = packFileSize - 20. We set packFileSize = offset + 5 so
          // trailerStart = offset + 5 - 20 = offset - 15 < offset → sliceLength ≤ 0.
          const ctx = await buildSeededContext();
          const content = ENC.encode('corrupt-slice');
          const deflated = await ctx.compressor.deflate(content);
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, content.length),
            ...deflated,
          ]);
          const packPath = await writeRawSingleEntryPack(ctx, 'corrupt-slice', entry);
          const entryOffset = 12; // pack header is 12 bytes
          const targetId = 'c'.repeat(40) as ObjectId;
          // Use a stub registry that returns a table with packFileSize=entryOffset+5
          // so trailerStart = entryOffset + 5 - 20 = entryOffset - 15 → next < offset.
          const filler = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENC.encode('filler') },
          ]);
          const fillerIndex = parsePackIndex(filler.idxBytes, 20);
          const pack: RegisteredPack = {
            name: 'stub-corrupt-slice',
            index: async () => fillerIndex,
            packPath,
            idxPath: `${packPath}.idx`,
            header: async () => ({ version: 2, objectCount: fillerIndex.objectCount }),
            offsetTable: async () => ({
              kind: 'sorted' as const,
              sortedOffsets: Float64Array.of(entryOffset),
              packFileSize: entryOffset + 5,
              trailerStart: entryOffset + 5 - 20, // = entryOffset - 15 → next is trailerStart < entryOffset
            }),
            ...stubPackHandle(ctx, packPath),
          };
          const registry: PackRegistry = {
            all: async () => [],
            fileNames: async () => new Set(),
            assertLoadable: async () => {},
            refresh: () => undefined,
            settleRefresh: async () => {},
            lookup: async (id) => (id === targetId ? { pack, offset: entryOffset } : undefined),
            dispose: noopDispose,
            health: async () => ({ accessible: [pack], unusable: [] }),
            indexFaults: async () => [],
            midxHealth: async () => ({
              artefact: undefined,
              faults: [],
              flatFilePresent: false,
              unresolvedPacks: [],
              unresolvedEntries: [],
              checksumOk: undefined,
            }),
            midxBitmap: async () => undefined,
            deltaBaseCache: createLruCache(1024),
          };
          const sut = resolveObject;

          // Act
          try {
            await sut(ctx, registry, targetId, false);
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            // Assert
            expect(data.code).toBe('INVALID_PACK_INDEX');
            if (data.code !== 'INVALID_PACK_INDEX') {
              expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
            }
            expect(data.reason).toContain('slice length');
          }
        });
      });
    });

    describe('Given a pack where nextOffset exactly equals offset (corrupt index: slice length === 0)', () => {
      describe('When resolveObject is called', () => {
        it('Then throws INVALID_PACK_INDEX with slice length reason', async () => {
          // Arrange — single-entry pack where packFileSize = entryOffset + digestLength (20),
          // so trailerStart = packFileSize - 20 = entryOffset. For a single entry,
          // nextOffsetForEntry returns trailerStart = entryOffset, giving sliceLength = 0.
          // This exercises the exact zero boundary of the `sliceLength <= 0` guard,
          // killing the `< 0` mutant that would pass sliceLength=0 through.
          const ctx = await buildSeededContext();
          const content = ENC.encode('zero-slice');
          const deflated = await ctx.compressor.deflate(content);
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, content.length),
            ...deflated,
          ]);
          const packPath = await writeRawSingleEntryPack(ctx, 'zero-slice', entry);
          const entryOffset = 12; // pack header is 12 bytes
          const digestLength = 20; // SHA-1
          const targetId = 'z'.repeat(40) as ObjectId;
          // packFileSize = entryOffset + digestLength → trailerStart = entryOffset → sliceLength = 0
          const filler = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENC.encode('filler') },
          ]);
          const fillerIndex = parsePackIndex(filler.idxBytes, 20);
          const pack: RegisteredPack = {
            name: 'stub-zero-slice',
            index: async () => fillerIndex,
            packPath,
            idxPath: `${packPath}.idx`,
            header: async () => ({ version: 2, objectCount: fillerIndex.objectCount }),
            offsetTable: async () => ({
              kind: 'sorted' as const,
              sortedOffsets: Float64Array.of(entryOffset),
              packFileSize: entryOffset + digestLength,
              trailerStart: entryOffset, // = entryOffset + digestLength - digestLength
            }),
            ...stubPackHandle(ctx, packPath),
          };
          const registry: PackRegistry = {
            all: async () => [],
            fileNames: async () => new Set(),
            assertLoadable: async () => {},
            refresh: () => undefined,
            settleRefresh: async () => {},
            lookup: async (id) => (id === targetId ? { pack, offset: entryOffset } : undefined),
            dispose: noopDispose,
            health: async () => ({ accessible: [pack], unusable: [] }),
            indexFaults: async () => [],
            midxHealth: async () => ({
              artefact: undefined,
              faults: [],
              flatFilePresent: false,
              unresolvedPacks: [],
              unresolvedEntries: [],
              checksumOk: undefined,
            }),
            midxBitmap: async () => undefined,
            deltaBaseCache: createLruCache(1024),
          };
          const sut = resolveObject;

          // Act
          try {
            await sut(ctx, registry, targetId, false);
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            // Assert
            expect(data.code).toBe('INVALID_PACK_INDEX');
            if (data.code !== 'INVALID_PACK_INDEX') {
              expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
            }
            expect(data.reason).toContain('slice length');
          }
        });
      });
    });

    describe('Given a pack where nextOffset > packFileSize (corrupt index)', () => {
      describe('When resolveObject is called', () => {
        it('Then throws INVALID_PACK_INDEX with next offset exceeds reason', async () => {
          // Arrange — manufacture a stub registry where offsetTable returns
          // sortedOffsets=[offset, offset+1000] and packFileSize=offset+500, so
          // nextOffsetForEntry returns offset+1000 > packFileSize=offset+500.
          const ctx = await buildSeededContext();
          const content = ENC.encode('corrupt-next-exceeds');
          const deflated = await ctx.compressor.deflate(content);
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, content.length),
            ...deflated,
          ]);
          const packPath = await writeRawSingleEntryPack(ctx, 'corrupt-next-exceeds', entry);
          const entryOffset = 12;
          const targetId = 'e'.repeat(40) as ObjectId;
          const filler = await buildSyntheticPack(ctx, [
            { kind: 'base', type: 'blob', content: ENC.encode('filler') },
          ]);
          const fillerIndex = parsePackIndex(filler.idxBytes, 20);
          const pack: RegisteredPack = {
            name: 'stub-corrupt-exceeds',
            index: async () => fillerIndex,
            packPath,
            idxPath: `${packPath}.idx`,
            header: async () => ({ version: 2, objectCount: fillerIndex.objectCount }),
            offsetTable: async () => ({
              kind: 'sorted' as const,
              sortedOffsets: Float64Array.of(entryOffset, entryOffset + 1000),
              packFileSize: entryOffset + 500,
              trailerStart: entryOffset + 500 - 20,
            }),
            ...stubPackHandle(ctx, packPath),
          };
          const registry: PackRegistry = {
            all: async () => [],
            fileNames: async () => new Set(),
            assertLoadable: async () => {},
            refresh: () => undefined,
            settleRefresh: async () => {},
            lookup: async (id) => (id === targetId ? { pack, offset: entryOffset } : undefined),
            dispose: noopDispose,
            health: async () => ({ accessible: [pack], unusable: [] }),
            indexFaults: async () => [],
            midxHealth: async () => ({
              artefact: undefined,
              faults: [],
              flatFilePresent: false,
              unresolvedPacks: [],
              unresolvedEntries: [],
              checksumOk: undefined,
            }),
            midxBitmap: async () => undefined,
            deltaBaseCache: createLruCache(1024),
          };
          const sut = resolveObject;

          // Act
          try {
            await sut(ctx, registry, targetId, false);
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            // Assert
            expect(data.code).toBe('INVALID_PACK_INDEX');
            if (data.code !== 'INVALID_PACK_INDEX') {
              expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
            }
            expect(data.reason).toContain('next offset exceeds pack file size');
          }
        });
      });
    });

    describe('Given a 2-entry pack with an OFS_DELTA entry', () => {
      describe('When resolveObject is called on the delta entry', () => {
        it('Then each chain step reads its own exact slice and the delta reconstructs correctly', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const baseContent = ENC.encode('ofs-exact-base');
          const targetContent = ENC.encode('ofs-exact-target-different');
          const ids = await writeSyntheticPack(ctx, 'ofs-exact-slice', [
            { kind: 'base', type: 'blob', content: baseContent },
            { kind: 'ofs-delta', baseIndex: 0, targetContent },
          ]);
          const deltaId = ids[1] as ObjectId;
          const sut = resolveObject;
          const registry = createPackRegistry(ctx);
          // Compute expected slice lengths from the real offset table before resolveObject runs.
          const packs = await registry.all();
          const table = await packs[0]!.offsetTable();
          const [off0, off1] = expectSortedOffsets(table);
          // delta entry (off1) is resolved first, then base (off0).
          const expectedDeltaSlice = table.trailerStart - off1!;
          const expectedBaseSlice = off1! - off0!;
          const readSliceSpy = vi.spyOn(packs[0]!, 'readSlice');
          const streamInflateSpy = vi.spyOn(ctx.compressor, 'streamInflate');

          // Act
          const result = await sut(ctx, registry, deltaId, false);

          // Assert — correct content reconstruction
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(targetContent);
          // streamInflate must never be called
          expect(streamInflateSpy.mock.calls.length).toBe(0);
          // Each of the 2 chain steps called readSlice with exact lengths, both
          // against the SAME pack's persistent handle (not one open per step).
          expect(readSliceSpy.mock.calls.length).toBe(2);
          // First call: delta entry (tip of chain, resolved first)
          expect(readSliceSpy.mock.calls[0]![1]).toBe(expectedDeltaSlice);
          // Second call: base entry
          expect(readSliceSpy.mock.calls[1]![1]).toBe(expectedBaseSlice);
        });
      });
    });
  });

  describe('persistent per-pack handle (A4 — one open per pack, not per step)', () => {
    describe('Given a synthetic pack with a 5-hop OFS_DELTA chain', () => {
      describe('When resolveObject is called on the tip', () => {
        it('Then ctx.fs.openWithNoFollow is called exactly once for the pack', async () => {
          // Arrange — 5 sequential chain steps each used to open+read+close their
          // own FileHandle before A4. The persistent handle must open the pack
          // ONCE and serve every step's readSlice through it.
          const ctx = await buildSeededContext();
          const step0 = ENC.encode('step-0');
          const step1 = ENC.encode('step-1-longer');
          const step2 = ENC.encode('step-2-longer-still');
          const step3 = ENC.encode('step-3-even-longer-again');
          const step4 = ENC.encode('step-4-the-tip-of-the-chain');
          const ids = await writeSyntheticPack(ctx, 'deep-ofs-chain', [
            { kind: 'base', type: 'blob', content: step0 },
            { kind: 'ofs-delta', baseIndex: 0, targetContent: step1 },
            { kind: 'ofs-delta', baseIndex: 1, targetContent: step2 },
            { kind: 'ofs-delta', baseIndex: 2, targetContent: step3 },
            { kind: 'ofs-delta', baseIndex: 3, targetContent: step4 },
          ]);
          const tipId = ids[4]!;
          const registry = createPackRegistry(ctx);
          const openSpy = vi.spyOn(ctx.fs, 'openWithNoFollow');

          // Act
          const result = await resolveObject(ctx, registry, tipId as ObjectId, true);

          // Assert — one open for the whole chain walk; byte-identical output.
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(step4);
          expect(openSpy.mock.calls.length).toBe(1);
        });
      });
    });
  });

  describe('Given a REF_DELTA whose cached base bytes lack a NUL but contain a valid-looking type prefix', () => {
    describe('When resolveObject is called', () => {
      it('Then splitHeader throws OBJECT_NOT_FOUND (not a downstream delta error)', async () => {
        // Arrange — poison the cache with `blob 9 garbage` (no NUL). If the nulIdx
        // guard is skipped, the subsequent space-based typeName parse would succeed
        // and return a wrong type/content, producing a delta error. We assert
        // OBJECT_NOT_FOUND to pin the nulIdx guard.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('ref base');
        const targetContent = new TextEncoder().encode('ref target');
        const [baseId] = await writeSyntheticPack(ctx, 'ref-no-nul-base', [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const [deltaId] = await writeSyntheticPack(ctx, 'ref-no-nul-delta', [
          {
            kind: 'ref-delta',
            baseId: baseId!,
            baseUncompressed: baseContent,
            targetContent,
          },
        ]);
        const bad = new TextEncoder().encode('blob 9 garbage');
        ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, deltaId as ObjectId, false);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given cached bytes with a NUL but no space in the header slice', () => {
    describe('When resolveObject is called', () => {
      it('Then splitHeader throws OBJECT_NOT_FOUND (not a downstream delta error)', async () => {
        // Arrange — `blob\0` gives a valid type name only if the space guard is
        // skipped (subarray(0, -1) on 5 bytes yields "blob"). We assert
        // OBJECT_NOT_FOUND to pin the space guard.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('ref base');
        const targetContent = new TextEncoder().encode('ref target');
        const [baseId] = await writeSyntheticPack(ctx, 'ref-no-space-base', [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const [deltaId] = await writeSyntheticPack(ctx, 'ref-no-space-delta', [
          {
            kind: 'ref-delta',
            baseId: baseId!,
            baseUncompressed: baseContent,
            targetContent,
          },
        ]);
        const bad = new TextEncoder().encode('blob\0');
        ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, deltaId as ObjectId, false);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('Given an OFS_DELTA chain of length 51', () => {
    describe('When resolveObject is called', () => {
      it('Then throws DELTA_CHAIN_TOO_DEEP', async () => {
        // Arrange — base + 51 chained OFS deltas, each delta reconstructs unique bytes
        // so every entry has a distinct id (prevents pack-lookup collisions).
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('base');
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
        for (let i = 0; i < 51; i += 1) {
          const target = new TextEncoder().encode(`target-${i}`);
          entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
        }
        const ids = await writeSyntheticPack(ctx, 'long-chain', entries);
        const tipId = ids.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, tipId, false);
          throw new Error('should not reach here');
        } catch (error) {
          if (!(error instanceof TsgitError)) throw error;
          // Assert
          expect(error.data.code).toBe('DELTA_CHAIN_TOO_DEEP');
        }
      });
    });
  });

  describe('Given an OFS_DELTA chain of length 51, with a lower object already warming the delta-base cache', () => {
    describe('When resolveObject reads the tip', () => {
      it('Then it still throws DELTA_CHAIN_TOO_DEEP — the cache hit must not hide the depth beneath it', async () => {
        // Arrange — same 51-deep chain as the cold case above, but position 25
        // is resolved FIRST: that populates the delta-base cache for every
        // offset from position 25 down to the true base. Resolving the tip
        // afterwards walks only 26 levels (51 down to 25) before hitting that
        // cache — a naive cache hit would stop counting there and let a chain
        // that is truly 51 deep report as 26.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('base');
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
        for (let i = 0; i < 51; i += 1) {
          const target = new TextEncoder().encode(`target-${i}`);
          entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
        }
        const ids = await writeSyntheticPack(ctx, 'long-chain-warm', entries);
        const lowerId = ids[25]! as ObjectId;
        const tipId = ids.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act — warm the cache with the lower object first.
        await resolveObject(ctx, registry, lowerId, false);
        let caught: unknown;
        try {
          await resolveObject(ctx, registry, tipId, false);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('DELTA_CHAIN_TOO_DEEP');
      });
    });
  });

  describe('Given an OFS_DELTA chain of length 60, warmed bottom-up in five successive 10-level steps', () => {
    describe('When resolveObject finally reads the tip', () => {
      it('Then it still throws DELTA_CHAIN_TOO_DEEP — a resumed cache hit must carry its OWN depth into every level it re-caches, not just the level it resumed at', async () => {
        // Arrange — a 60-deep OFS chain (10 over the cap). Each of the five
        // warm-up reads is, on its own, well within MAX_DELTA_CHAIN_DEPTH —
        // resolving position 20 after position 10 only ever walks 10 fresh
        // levels before hitting the position-10 cache entry. Only the
        // COMPOUNDED total (10 → 20 → 30 → 40 → 50 → 60) exceeds the cap. A
        // cache-hit resumption that drops its own resumed depth would let
        // every successive warm step re-anchor its own re-cached levels at
        // depth zero instead of inheriting what came before, letting the
        // truly-60-deep tip slip through as if it were only 10 deep.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('base');
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
        for (let i = 0; i < 60; i += 1) {
          const target = new TextEncoder().encode(`target-${i}`);
          entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
        }
        const ids = await writeSyntheticPack(ctx, 'long-chain-successive-warm', entries);
        const registry = createPackRegistry(ctx);

        // Act — warm the cache bottom-up in five 10-level steps, then read the tip.
        for (const position of [10, 20, 30, 40, 50]) {
          await resolveObject(ctx, registry, ids[position] as ObjectId, false);
        }
        let caught: unknown;
        try {
          await resolveObject(ctx, registry, ids.at(-1) as ObjectId, false);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('DELTA_CHAIN_TOO_DEEP');
      });
    });
  });

  describe('Given a pack whose chain crosses a REF_DELTA hop into a second chain', () => {
    describe('When the cumulative depth exceeds MAX_DELTA_CHAIN_DEPTH even though each segment is within it', () => {
      it('Then the read refuses with the DELTA_CHAIN_TOO_DEEP error data', async () => {
        // Arrange — pack A: base + 30 OFS deltas (depth 30, within the 50
        // cap on its own). Pack B: a REF_DELTA into A's tip, plus 25 more
        // OFS deltas on top (a further 26-level segment, also within the
        // cap on its own). Neither segment alone crosses
        // MAX_DELTA_CHAIN_DEPTH, but resolving B's tip must walk BOTH to
        // reconstruct it — a true depth the old REF_DELTA arm's hardcoded
        // `baseChainDepth: 0` never counted.
        const ctx = await buildSeededContext();
        let aContent = ENC.encode('a-base');
        const aEntries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: aContent }];
        for (let i = 0; i < 30; i += 1) {
          aContent = ENC.encode(`a-${i}`);
          aEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: aContent });
        }
        const aIds = await writeSyntheticPack(ctx, 'ref-hop-a', aEntries);
        const aTipId = aIds.at(-1)!;

        const bEntries: EntrySpec[] = [
          {
            kind: 'ref-delta',
            baseId: aTipId,
            baseUncompressed: aContent,
            targetContent: ENC.encode('b-0'),
          },
        ];
        for (let i = 0; i < 25; i += 1) {
          bEntries.push({
            kind: 'ofs-delta',
            baseIndex: i,
            targetContent: ENC.encode(`b-${i + 1}`),
          });
        }
        const bIds = await writeSyntheticPack(ctx, 'ref-hop-b', bEntries);
        const bTipId = bIds.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act
        let caught: unknown;
        try {
          await resolveObject(ctx, registry, bTipId, false);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('DELTA_CHAIN_TOO_DEEP');
        if (data.code !== 'DELTA_CHAIN_TOO_DEEP') {
          expect.fail(`expected DELTA_CHAIN_TOO_DEEP, got ${data.code}`);
        }
        expect(data.depth).toBe(51);
      });
    });
  });

  describe('Given nested REF_DELTA hops whose combined depth exceeds the cap', () => {
    describe('When resolveObject reads the final hop', () => {
      it('Then refuses with DELTA_CHAIN_TOO_DEEP rather than recursing past the cap', async () => {
        // Arrange — 55 packs, each holding exactly one entry: pack 0 a real
        // base blob, every later pack a single REF_DELTA whose base is the
        // previous pack's object. Each pack's own segment is depth 1 —
        // trivially within the 50 cap — but reconstructing the LAST pack's
        // entry recurses through every earlier hop, so the true cumulative
        // depth (54) exceeds the cap. Pins that `externalDepth` bounds the
        // recursion itself, not just a single hop's local walk.
        const ctx = await buildSeededContext();
        const HOP_COUNT = 55;
        const baseContent = ENC.encode('hop-base');
        const [firstId] = await writeSyntheticPack(ctx, 'nested-ref-0', [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        let previousId = firstId!;
        let previousContent = baseContent;
        for (let i = 1; i < HOP_COUNT; i += 1) {
          const targetContent = ENC.encode(`hop-${i}`);
          const [id] = await writeSyntheticPack(ctx, `nested-ref-${i}`, [
            {
              kind: 'ref-delta',
              baseId: previousId,
              baseUncompressed: previousContent,
              targetContent,
            },
          ]);
          previousId = id!;
          previousContent = targetContent;
        }
        const registry = createPackRegistry(ctx);

        // Act
        let caught: unknown;
        try {
          await resolveObject(ctx, registry, previousId as ObjectId, false);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('DELTA_CHAIN_TOO_DEEP');
        if (data.code !== 'DELTA_CHAIN_TOO_DEEP') {
          expect.fail(`expected DELTA_CHAIN_TOO_DEEP, got ${data.code}`);
        }
        expect(data.depth).toBe(51);
      });
    });
  });

  describe('Given a chain that stays within the cap across a REF hop', () => {
    describe('When resolveObject is called', () => {
      it('Then it still resolves — no over-refusal regression', async () => {
        // Arrange — pack A: base + 10 OFS deltas (depth 10). Pack B: a
        // REF_DELTA into A's tip, plus 10 more OFS deltas on top. True
        // combined depth is 21 (10 + 1 REF hop + 10) — comfortably within
        // the 50 cap — so the fix's depth threading must not over-refuse.
        const ctx = await buildSeededContext();
        let aContent = ENC.encode('within-a-base');
        const aEntries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: aContent }];
        for (let i = 0; i < 10; i += 1) {
          aContent = ENC.encode(`within-a-${i}`);
          aEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: aContent });
        }
        const aIds = await writeSyntheticPack(ctx, 'within-cap-a', aEntries);
        const aTipId = aIds.at(-1)!;

        const bEntries: EntrySpec[] = [
          {
            kind: 'ref-delta',
            baseId: aTipId,
            baseUncompressed: aContent,
            targetContent: ENC.encode('within-b-0'),
          },
        ];
        let bTipContent = ENC.encode('within-b-0');
        for (let i = 0; i < 10; i += 1) {
          bTipContent = ENC.encode(`within-b-${i + 1}`);
          bEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: bTipContent });
        }
        const bIds = await writeSyntheticPack(ctx, 'within-cap-b', bEntries);
        const bTipId = bIds.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, bTipId, false);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(bTipContent);
      });
    });
  });

  describe('Given a REF_DELTA hop whose offset-keyed cache entry was populated by an earlier cold read', () => {
    describe('When a later read resumes from that cache entry across the hop', () => {
      it('Then the true cumulative depth is still enforced on resumption, not just the walked levels', async () => {
        // Arrange — pack A: base + 20 OFS deltas (A's tip is depth 20).
        // Pack B: a REF_DELTA into A's tip (entry 0), plus 35 more OFS
        // deltas on top. First resolve B's entry 0 directly — this warms
        // the offset-keyed delta-base cache for entry 0 with its TRUE
        // depth (21: the REF hop itself plus A's own 20-deep chain), not
        // the old code's hardcoded `baseChainDepth: 0`. Then resolve B's
        // tip (35 levels above entry 0): the walk resumes from that cached
        // entry, and 35 (walked) + 21 (cached) = 56 must still refuse, even
        // though the cache hit sits entirely below the REF hop.
        const ctx = await buildSeededContext();
        let aContent = ENC.encode('cache-a-base');
        const aEntries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: aContent }];
        for (let i = 0; i < 20; i += 1) {
          aContent = ENC.encode(`cache-a-${i}`);
          aEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: aContent });
        }
        const aIds = await writeSyntheticPack(ctx, 'cache-hop-a', aEntries);
        const aTipId = aIds.at(-1)!;

        const bEntries: EntrySpec[] = [
          {
            kind: 'ref-delta',
            baseId: aTipId,
            baseUncompressed: aContent,
            targetContent: ENC.encode('cache-b-0'),
          },
        ];
        let bContent = ENC.encode('cache-b-0');
        for (let i = 0; i < 35; i += 1) {
          bContent = ENC.encode(`cache-b-${i + 1}`);
          bEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: bContent });
        }
        const bIds = await writeSyntheticPack(ctx, 'cache-hop-b', bEntries);
        const bEntry0Id = bIds[0]! as ObjectId;
        const bTipId = bIds.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act — cold read warms the offset-keyed cache at entry 0's position.
        await resolveObject(ctx, registry, bEntry0Id, false);
        let caught: unknown;
        try {
          await resolveObject(ctx, registry, bTipId, false);
        } catch (error) {
          caught = error;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        const data = (caught as TsgitError).data;
        expect(data.code).toBe('DELTA_CHAIN_TOO_DEEP');
        if (data.code !== 'DELTA_CHAIN_TOO_DEEP') {
          expect.fail(`expected DELTA_CHAIN_TOO_DEEP, got ${data.code}`);
        }
        expect(data.depth).toBe(56);
      });
    });
  });

  describe('Given a REF_DELTA chain whose true cumulative depth exceeds the cap when resolved cold', () => {
    describe('When the REF hop base is resolved directly first — warming the id-keyed delta cache — and the same tip is resolved again', () => {
      it('Then the cold read refuses but the warm read admits the identical chain, since the id-keyed cache reports depth 0', async () => {
        // Arrange — the same two-pack REF_DELTA fixture as the cross-hop
        // refusal test above: pack A (base + 30 OFS deltas, tip depth 30)
        // and pack B (a REF_DELTA into A's tip, plus 25 more OFS deltas).
        // The true combined depth exceeds MAX_DELTA_CHAIN_DEPTH, so a cold
        // read of B's tip refuses. Resolving A's tip DIRECTLY afterwards
        // populates the id-keyed `ctx.deltaCache` for it — a cache that
        // reports depth 0 for any hit, per the documented residual in
        // `resolveBaseForRefDelta` and `Phase1Result.baseChainDepth`. A
        // second read of the SAME tip then resumes the REF hop from that
        // warm entry and — despite the chain's true length being unchanged
        // — succeeds, because the id-keyed hit undercounts. The cap still
        // bounded the recursion and I/O each read performed; it did not
        // bound the reconstructed chain's true length once warm.
        const ctx = await buildSeededContext();
        let aContent = ENC.encode('cache-consequence-a-base');
        const aEntries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: aContent }];
        for (let i = 0; i < 30; i += 1) {
          aContent = ENC.encode(`cache-consequence-a-${i}`);
          aEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: aContent });
        }
        const aIds = await writeSyntheticPack(ctx, 'cache-consequence-a', aEntries);
        const aTipId = aIds.at(-1)! as ObjectId;

        const bEntries: EntrySpec[] = [
          {
            kind: 'ref-delta',
            baseId: aTipId,
            baseUncompressed: aContent,
            targetContent: ENC.encode('cache-consequence-b-0'),
          },
        ];
        let bTipContent = ENC.encode('cache-consequence-b-0');
        for (let i = 0; i < 25; i += 1) {
          bTipContent = ENC.encode(`cache-consequence-b-${i + 1}`);
          bEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: bTipContent });
        }
        const bIds = await writeSyntheticPack(ctx, 'cache-consequence-b', bEntries);
        const bTipId = bIds.at(-1)! as ObjectId;
        const registry = createPackRegistry(ctx);

        // Act — cold read of the tip: nothing has warmed A's id-cache yet.
        let coldCaught: unknown;
        try {
          await resolveObject(ctx, registry, bTipId, false);
        } catch (error) {
          coldCaught = error;
        }

        // Resolve A's tip directly — populates the id-keyed ctx.deltaCache
        // for aTipId with its raw bytes; that cache reports chainDepth 0.
        await resolveObject(ctx, registry, aTipId, false);

        // A second read of the SAME tip resumes the REF hop from that warm
        // cache entry instead of walking pack A's chain again.
        const warmResult = await resolveObject(ctx, registry, bTipId, false);

        // Assert
        expect(coldCaught).toBeInstanceOf(TsgitError);
        expect((coldCaught as TsgitError).data.code).toBe('DELTA_CHAIN_TOO_DEEP');
        expect(warmResult.type).toBe('blob');
        expect((warmResult as Blob).content).toEqual(bTipContent);
      });
    });
  });

  describe('Given cached bytes with an unknown type name', () => {
    describe('When splitHeader runs typeNameToPackType', () => {
      it('Then throws OBJECT_NOT_FOUND', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('ref base');
        const targetContent = new TextEncoder().encode('ref target');
        const [baseId] = await writeSyntheticPack(ctx, 'ref-unknown-base', [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const [deltaId] = await writeSyntheticPack(ctx, 'ref-unknown-delta', [
          {
            kind: 'ref-delta',
            baseId: baseId!,
            baseUncompressed: baseContent,
            targetContent,
          },
        ]);
        const bad = new TextEncoder().encode('weird 5\0hello');
        ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
        const registry = createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, deltaId as ObjectId, false);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
      });
    });
  });

  describe('enforceCachedCap guard', () => {
    describe('Given a capped REF_DELTA whose cached base buffer has no NUL and exceeds the cap', () => {
      describe('When resolveObject runs', () => {
        it('Then throws OBJECT_NOT_FOUND (kills the nulIdx<0 conditional)', async () => {
          // Arrange — poison the cache with a header-less buffer LARGER than the
          // cap, then issue a capped REF_DELTA read whose base resolves via the
          // cache hit. With the `if (nulIdx < 0) return` guard intact, the cap is
          // skipped and `splitHeader` rejects the buffer as OBJECT_NOT_FOUND. If
          // the conditional is forced `false`, the cap runs with `nulIdx = -1`,
          // computes `actualSize = cached.length`, and throws OBJECT_TOO_LARGE
          // instead — a different observable code.
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('cap-no-nul base');
          // Target stays at 2 bytes so the pre-apply cap passes and the base
          // (cache) path runs — the pre-apply cap fires on the delta target.
          const targetContent = new TextEncoder().encode('xy');
          const [baseId] = await writeSyntheticPack(ctx, 'cap-no-nul-base', [
            { kind: 'base', type: 'blob', content: baseContent },
          ]);
          const [deltaId] = await writeSyntheticPack(ctx, 'cap-no-nul-delta', [
            { kind: 'ref-delta', baseId: baseId!, baseUncompressed: baseContent, targetContent },
          ]);
          // 14-byte buffer, no NUL anywhere.
          const bad = new TextEncoder().encode('blob 9 garbage');
          ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
          const registry = createPackRegistry(ctx);

          // Act — cap = 4, far below the 14-byte poisoned buffer.
          try {
            await resolveObject(ctx, registry, deltaId as ObjectId, false, 4);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_NOT_FOUND');
            if (data.code !== 'OBJECT_NOT_FOUND') {
              expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
            }
          }
        });
      });
    });

    describe('Given a capped REF_DELTA whose cached base buffer starts with a NUL and exceeds the cap', () => {
      describe('When resolveObject runs', () => {
        it('Then throws OBJECT_TOO_LARGE (kills the nulIdx<0 equality operator)', async () => {
          // Arrange — cached buffer with the NUL at index 0, so `nulIdx === 0`.
          // With `nulIdx < 0` the guard is false → the cap runs → content size
          // `length - 1` exceeds the cap → OBJECT_TOO_LARGE. The `<=` mutant
          // makes `0 <= 0` true → the guard returns early → `splitHeader` then
          // throws OBJECT_NOT_FOUND, a different code.
          const ctx = await buildSeededContext();
          const baseContent = new TextEncoder().encode('cap-nul0 base');
          // Target stays at 2 bytes so the pre-apply cap passes and the base
          // (cache) path runs — the pre-apply cap fires on the delta target.
          const targetContent = new TextEncoder().encode('xy');
          const [baseId] = await writeSyntheticPack(ctx, 'cap-nul0-base', [
            { kind: 'base', type: 'blob', content: baseContent },
          ]);
          const [deltaId] = await writeSyntheticPack(ctx, 'cap-nul0-delta', [
            { kind: 'ref-delta', baseId: baseId!, baseUncompressed: baseContent, targetContent },
          ]);
          // 21 bytes: NUL at index 0, then 20 content bytes → content size 20.
          const bad = new Uint8Array(21);
          bad[0] = 0x00;
          bad.fill(0x41, 1);
          ctx.deltaCache.set(baseId as ObjectId, bad, bad.length);
          const registry = createPackRegistry(ctx);

          // Act — cap = 4, content size 20 > 4.
          try {
            await resolveObject(ctx, registry, deltaId as ObjectId, false, 4);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_TOO_LARGE');
            if (data.code !== 'OBJECT_TOO_LARGE') {
              expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
            }
            expect(data.id).toBe(baseId);
            expect(data.actualSize).toBe(20);
            expect(data.limit).toBe(4);
          }
        });
      });
    });
  });

  describe('OFS_DELTA base-offset guard', () => {
    describe('Given an OFS_DELTA whose base distance points before the pack body (negative offset)', () => {
      describe('When resolveObject runs', () => {
        it('Then throws OBJECT_NOT_FOUND', async () => {
          // Arrange — a single OFS_DELTA at offset 12 with a base distance of
          // 100, so `nextOffset = 12 - 100 = -88`. The `if (nextOffset < 0)`
          // guard must throw OBJECT_NOT_FOUND. Forcing the conditional `false`
          // would carry a negative offset into the next chain hop instead.
          const ctx = await buildSeededContext();
          const deltaBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0),
            ...encodeOfsDistance(100),
            ...deltaBody,
          ]);
          const packPath = await writeRawSingleEntryPack(ctx, 'ofs-negative', entry);
          const targetId = 'a'.repeat(40) as ObjectId;
          const registry = await stubRegistry(ctx, [{ id: targetId, packPath, offset: 12 }]);

          // Act
          try {
            await resolveObject(ctx, registry, targetId, false);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('OBJECT_NOT_FOUND');
            if (data.code !== 'OBJECT_NOT_FOUND') {
              expect.fail(`expected OBJECT_NOT_FOUND, got ${data.code}`);
            }
          }
        });
      });
    });

    describe('Given an OFS_DELTA whose base distance lands exactly on offset 0', () => {
      describe('When resolveObject runs', () => {
        it('Then the chain proceeds past the negative guard and throws INVALID_PACK_INDEX (kills the nextOffset<0 equality operator)', async () => {
          // Arrange — a single OFS_DELTA at offset 12 with base distance 12, so
          // `nextOffset = 12 - 12 = 0`. With `nextOffset < 0` the guard is false
          // → the walker continues with offset 0 → nextOffsetForEntry cannot find 0
          // in sortedOffsets → INVALID_PACK_INDEX. The `<=` mutant makes `0 <= 0`
          // true → throws OBJECT_NOT_FOUND before reaching nextOffsetForEntry.
          const ctx = await buildSeededContext();
          const deltaBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0),
            ...encodeOfsDistance(12),
            ...deltaBody,
          ]);
          const packPath = await writeRawSingleEntryPack(ctx, 'ofs-zero', entry);
          const targetId = 'a'.repeat(40) as ObjectId;
          const registry = await stubRegistry(ctx, [{ id: targetId, packPath, offset: 12 }]);

          // Act — walker does not short-circuit at 0; nextOffsetForEntry
          // rejects offset 0 as absent from the sorted index.
          try {
            await resolveObject(ctx, registry, targetId, false);
            // Assert
            expect.unreachable();
          } catch (error) {
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_PACK_INDEX');
            if (data.code !== 'INVALID_PACK_INDEX') {
              expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
            }
          }
        });
      });
    });
  });

  describe('Given a pack base entry whose declared size lies small but inflates large', () => {
    describe('When a capped resolveObject runs', () => {
      it('Then the post-apply cap throws OBJECT_TOO_LARGE', async () => {
        // Arrange — a base blob entry whose header declares size 1 (so the
        // pre-inflate `enforcePackBaseCap` passes the cap of 4) while the zlib
        // body inflates to 40 bytes. With no deltas the post-apply check in
        // `resolvePackChain` is the only guard left; emptying its block lets the
        // oversized object through silently.
        const ctx = await buildSeededContext();
        const bigContent = new TextEncoder().encode('A'.repeat(40));
        const deflated = await ctx.compressor.deflate(bigContent);
        const entry = new Uint8Array([
          // Declares size 1, not 40 — the deliberate lie.
          ...encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, 1),
          ...deflated,
        ]);
        const packPath = await writeRawSingleEntryPack(ctx, 'lying-size-base', entry);
        const targetId = 'a'.repeat(40) as ObjectId;
        const registry = await stubRegistry(ctx, [{ id: targetId, packPath, offset: 12 }]);

        // Act — cap 4, actual inflated content 40 bytes.
        try {
          await resolveObject(ctx, registry, targetId, false, 4);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_TOO_LARGE');
          if (data.code !== 'OBJECT_TOO_LARGE') {
            expect.fail(`expected OBJECT_TOO_LARGE, got ${data.code}`);
          }
          expect(data.actualSize).toBe(40);
          expect(data.limit).toBe(4);
        }
      });
    });
  });

  describe('Given a REF_DELTA whose base id does not match the base content hash', () => {
    describe('When resolveObject runs', () => {
      it('Then the base resolves without hash verification', async () => {
        // Arrange — the REF_DELTA declares base id `B`, but the entry the stub
        // registry maps `B` to holds content that hashes to something else.
        // `resolveBaseForRefDelta` resolves the base with verifyHash=false, so
        // the mismatch is tolerated. Flipping that argument to `true` makes the
        // recursive `resolveObject` verify the base and throw OBJECT_HASH_MISMATCH.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('mismatch base content');
        const targetContent = new TextEncoder().encode('mismatch target content');
        const fakeBaseId = 'b'.repeat(40) as ObjectId;
        const targetId = 'd'.repeat(40) as ObjectId;
        // Pack A — the base blob, reached only via the stub's fake-id mapping.
        const basePack = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: baseContent },
        ]);
        const basePackPath = `${ctx.layout.gitDir}/objects/pack/pack-mismatch-base.pack`;
        await ctx.fs.write(basePackPath, basePack.packBytes);
        // The base's real id must differ from the fake id we look it up by.
        expect(basePack.ids[0]).not.toBe(fakeBaseId);
        // Pack B — a REF_DELTA that declares `fakeBaseId` as its base.
        const deltaPack = await buildSyntheticPack(ctx, [
          {
            kind: 'ref-delta',
            baseId: fakeBaseId,
            baseUncompressed: baseContent,
            targetContent,
          },
        ]);
        const deltaPackPath = `${ctx.layout.gitDir}/objects/pack/pack-mismatch-delta.pack`;
        await ctx.fs.write(deltaPackPath, deltaPack.packBytes);
        const registry = await stubRegistry(ctx, [
          { id: targetId, packPath: deltaPackPath, offset: 12 },
          { id: fakeBaseId, packPath: basePackPath, offset: 12 },
        ]);

        // Act
        const result = await resolveObject(ctx, registry, targetId, false);

        // Assert — base resolved unverified; the delta reconstructs the target.
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(targetContent);
      });
    });
  });

  describe('parsed-object memo (byte-capped commit/tag memo)', () => {
    const IDENTITY = {
      name: 'Test',
      email: 'test@example.com',
      timestamp: 1_700_000_000,
      timezoneOffset: '+0000',
    } as const;

    async function writeCommitWithMessage(ctx: Context, message: string): Promise<ObjectId> {
      return writeObject(ctx, {
        type: 'commit',
        id: '' as ObjectId,
        data: {
          tree: EMPTY_TREE_OID,
          parents: [],
          author: IDENTITY,
          committer: IDENTITY,
          message,
          extraHeaders: [],
        },
      });
    }

    async function writeTagWithMessage(
      ctx: Context,
      targetId: ObjectId,
      tagName: string,
      message: string,
    ): Promise<ObjectId> {
      return writeObject(ctx, {
        type: 'tag',
        id: '' as ObjectId,
        data: {
          object: targetId,
          objectType: 'commit',
          tagName,
          tagger: IDENTITY,
          message,
          extraHeaders: [],
        },
      });
    }

    // `gitObjectMod.parseObject` is a module-namespace export shared by every
    // test in this describe — Vitest's ESM `vi.spyOn`/`mockRestore` cycle
    // does not reliably zero `.mock.calls` between successive spy/restore
    // pairs on the SAME property, so every assertion below counts calls
    // made SINCE a captured baseline rather than trusting an absolute total.
    function parseCallsSince(spy: ReturnType<typeof vi.spyOn>, baseline: number): number {
      return spy.mock.calls.length - baseline;
    }

    describe('Given a commit read twice on one Context', () => {
      describe('When the second read runs', () => {
        it('Then it is not re-parsed', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const commitId = await writeCommitWithMessage(ctx, 'memo hit commit');
          const registry = createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObject');
          const baseline = parseSpy.mock.calls.length;

          // Act
          const first = await resolveObject(ctx, registry, commitId, false);
          const second = await resolveObject(ctx, registry, commitId, false);

          // Assert
          expect(second).toEqual(first);
          expect(parseCallsSince(parseSpy, baseline)).toBe(1);
          parseSpy.mockRestore();
        });
      });
    });

    describe('Given a tag read twice on one Context', () => {
      describe('When the second read runs', () => {
        it('Then it is not re-parsed', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const commitId = await writeCommitWithMessage(ctx, 'tag target');
          const tagId = await writeTagWithMessage(ctx, commitId, 'v1', 'memo hit tag');
          const registry = createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObject');
          const baseline = parseSpy.mock.calls.length;

          // Act
          const first = await resolveObject(ctx, registry, tagId, false);
          const second = await resolveObject(ctx, registry, tagId, false);

          // Assert
          expect(second).toEqual(first);
          expect(parseCallsSince(parseSpy, baseline)).toBe(1);
          parseSpy.mockRestore();
        });
      });
    });

    describe('Given a commit larger than the memo byte cap', () => {
      describe('When it is read twice', () => {
        it('Then it is not cached and both reads still succeed', async () => {
          // Arrange — a 1-byte deltaCache budget floors the memo's own cap
          // below any real message, so this entry is always over-cap.
          const ctx = createMemoryContext({ deltaCacheMaxBytes: 1 });
          const message = 'a message long enough to exceed a near-zero memo cap';
          const commitId = await writeCommitWithMessage(ctx, message);
          const registry = createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObject');
          const baseline = parseSpy.mock.calls.length;

          // Act
          const first = await resolveObject(ctx, registry, commitId, false);
          const second = await resolveObject(ctx, registry, commitId, false);

          // Assert — never cached, so every read re-parses.
          expect(second).toEqual(first);
          expect(parseCallsSince(parseSpy, baseline)).toBe(2);
          parseSpy.mockRestore();
        });
      });
    });

    describe('Given a commit whose unbounded-length fields sum to zero', () => {
      describe('When it is read twice', () => {
        it('Then the fixed overhead alone keeps the size positive, set does not throw, and the second read hits the memo', async () => {
          // Arrange — an empty message, no gpg signature, no extra headers and
          // no parents is a real, valid commit (`git commit
          // --allow-empty-message`) whose message/signature/headers/parents
          // terms all sum to 0; PARSED_OBJECT_FIXED_OVERHEAD_BYTES alone must
          // keep the sizer's result positive.
          const ctx = await buildSeededContext();
          const commitId = await writeCommitWithMessage(ctx, '');
          const registry = createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObject');
          const baseline = parseSpy.mock.calls.length;

          // Act
          const first = await resolveObject(ctx, registry, commitId, false);
          const second = await resolveObject(ctx, registry, commitId, false);

          // Assert — no throw reached this line, and the entry was genuinely
          // cached rather than silently dropped.
          expect(second).toEqual(first);
          expect(parseCallsSince(parseSpy, baseline)).toBe(1);
          parseSpy.mockRestore();
        });
      });
    });

    describe('Given the sizer applied to commits differing only in parent count', () => {
      describe('When comparing an octopus merge against a single-parent commit', () => {
        it('Then every extra parent adds exactly one hex-oid width to the size', () => {
          // Arrange — identical message/signature/headers; only parents differ.
          const shared = { message: 'm', extraHeaders: [] };
          const hexLength = 40;
          const oneParent = { ...shared, parents: ['a'.repeat(40) as ObjectId] };
          const fourParents = {
            ...shared,
            parents: Array.from({ length: 4 }, () => 'a'.repeat(40) as ObjectId),
          };
          const sut = parsedObjectByteSize;

          // Act
          const oneParentSize = sut(oneParent, hexLength);
          const fourParentsSize = sut(fourParents, hexLength);

          // Assert
          expect(fourParentsSize - oneParentSize).toBe(3 * hexLength);
        });
      });

      describe('When comparing a SHA-256 repo against a SHA-1 repo for the same parent count', () => {
        it('Then the wider hex oid width is reflected, not a SHA-1-shaped assumption', () => {
          // Arrange
          const data = { message: 'm', extraHeaders: [], parents: ['a'.repeat(64) as ObjectId] };
          const sut = parsedObjectByteSize;

          // Act
          const sha1Size = sut(data, 40);
          const sha256Size = sut(data, 64);

          // Assert
          expect(sha256Size - sha1Size).toBe(24);
        });
      });
    });

    describe('Given the memo is created for the first time', () => {
      describe('When createLruCache is called to build it', () => {
        it('Then it is given an entry cap, not just a byte cap', async () => {
          // Arrange — a byte cap alone admits unboundedly many small entries;
          // the entry cap is a second, independent defence.
          const ctx = await buildSeededContext();
          const commitId = await writeCommitWithMessage(ctx, 'entry cap wiring');
          const registry = createPackRegistry(ctx);
          createLruCacheSpy.mockClear();

          // Act
          await resolveObject(ctx, registry, commitId, false);

          // Assert
          const memoCall = createLruCacheSpy.mock.calls.find(
            (call) => call[0] === ctx.deltaCache.maxSize * PARSED_OBJECT_MEMO_FRACTION,
          );
          expect(memoCall?.[1]).toBe(PARSED_OBJECT_MEMO_MAX_ENTRIES);
        });
      });
    });

    describe('Given a deltaCache sized so the byte budget never binds', () => {
      describe('When more entries than PARSED_OBJECT_MEMO_MAX_ENTRIES are inserted', () => {
        it('Then the entry cap itself evicts down to the cap, not the byte budget', async () => {
          // Arrange — a deltaCache large enough that the memo's own byte
          // share never binds at PARSED_OBJECT_MEMO_MAX_ENTRIES tiny
          // entries; only the entry-count cap can be what evicts. Direct
          // `.set()` calls on the memo itself (grabbed off the createLruCache
          // spy's own return value) keep this fast — resolving
          // PARSED_OBJECT_MEMO_MAX_ENTRIES + 1 distinct real commits through
          // resolveObject would be impractical.
          const ctx = createMemoryContext({
            deltaCacheMaxBytes: PARSED_OBJECT_MEMO_MAX_ENTRIES * 100,
          });
          const commitId = await writeCommitWithMessage(ctx, 'entry cap eviction seed');
          const registry = createPackRegistry(ctx);
          createLruCacheSpy.mockClear();
          await resolveObject(ctx, registry, commitId, false);
          const memoCallIndex = createLruCacheSpy.mock.calls.findIndex(
            (call) => call[1] === PARSED_OBJECT_MEMO_MAX_ENTRIES,
          );
          const memo = createLruCacheSpy.mock.results[memoCallIndex]?.value as LruCache<unknown>;

          // Act
          for (let i = 0; i <= PARSED_OBJECT_MEMO_MAX_ENTRIES; i += 1) {
            memo.set(`synthetic-${i}`, {}, 1);
          }

          // Assert — capped at the entry count; the byte budget (far larger
          // than PARSED_OBJECT_MEMO_MAX_ENTRIES tiny 1-byte entries) never bound.
          expect(memo.entryCount).toBe(PARSED_OBJECT_MEMO_MAX_ENTRIES);
        });
      });
    });

    describe('Given entries exceeding the memo cap', () => {
      describe('When a fourth commit is read after the first is touched again', () => {
        it('Then the least-recently-used entry is evicted, not the oldest-inserted one', async () => {
          // Arrange — cap fits exactly three same-size, parentless, 10-char
          // messages: A, B, C fill it exactly (no eviction yet). Re-reading A
          // promotes it to MRU, leaving B — untouched since its own insert —
          // as the LRU tail. A plain FIFO would evict A on the next insert
          // (oldest inserted); an LRU evicts B instead (least recently
          // touched). Sized via the production sizer itself (default sha1
          // hexLength=40, matching this Context's unspecified algorithm) so
          // the cap tracks PARSED_OBJECT_FIXED_OVERHEAD_BYTES automatically.
          const perEntry = parsedObjectByteSize({ message: 'AAAAAAAAAA', extraHeaders: [] }, 40);
          const cap = perEntry * 3;
          const ctx = createMemoryContext({
            deltaCacheMaxBytes: cap / PARSED_OBJECT_MEMO_FRACTION,
          });
          const commitA = await writeCommitWithMessage(ctx, 'AAAAAAAAAA');
          const commitB = await writeCommitWithMessage(ctx, 'BBBBBBBBBB');
          const commitC = await writeCommitWithMessage(ctx, 'CCCCCCCCCC');
          const commitD = await writeCommitWithMessage(ctx, 'DDDDDDDDDD');
          const registry = createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObject');
          const baseline = parseSpy.mock.calls.length;

          // Act + Assert — interleave reads and check the running parse count.
          await resolveObject(ctx, registry, commitA, false);
          expect(parseCallsSince(parseSpy, baseline)).toBe(1);
          await resolveObject(ctx, registry, commitB, false);
          expect(parseCallsSince(parseSpy, baseline)).toBe(2);
          await resolveObject(ctx, registry, commitC, false);
          expect(parseCallsSince(parseSpy, baseline)).toBe(3);
          await resolveObject(ctx, registry, commitA, false); // promote A to MRU
          expect(parseCallsSince(parseSpy, baseline)).toBe(3);
          await resolveObject(ctx, registry, commitD, false); // evicts B, not A
          expect(parseCallsSince(parseSpy, baseline)).toBe(4);
          await resolveObject(ctx, registry, commitB, false); // B was evicted
          expect(parseCallsSince(parseSpy, baseline)).toBe(5);
          await resolveObject(ctx, registry, commitA, false); // A survived
          expect(parseCallsSince(parseSpy, baseline)).toBe(5);
          parseSpy.mockRestore();
        });
      });
    });

    describe("Given a Context whose deltaCache has a zero byte budget (fsck's audit shape)", () => {
      describe('When the same commit is read twice', () => {
        it('Then it is re-parsed every time, never memoised', async () => {
          // Arrange — mirrors fsck's own audit Context: a distinct,
          // zero-budget deltaCache swapped onto an otherwise-normal Context.
          const ctx = await buildSeededContext();
          const commitId = await writeCommitWithMessage(ctx, 'audit isolation');
          const auditCtx: Context = Object.freeze({
            ...ctx,
            deltaCache: createLruCache<Uint8Array>(0),
          });
          const registry = createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObject');
          const baseline = parseSpy.mock.calls.length;

          // Act
          await resolveObject(auditCtx, registry, commitId, false);
          await resolveObject(auditCtx, registry, commitId, false);

          // Assert
          expect(parseCallsSince(parseSpy, baseline)).toBe(2);
          parseSpy.mockRestore();
        });
      });
    });
  });
});
