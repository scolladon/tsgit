import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  memoByteValve,
  OBJECT_CACHE_ENTRY_OVERHEAD_BYTES,
  PARSED_OBJECT_DIAL_BYTES_PER_ENTRY,
  parsedObjectByteSize,
} from '../../../../src/application/primitives/internal/object-caches.js';
import {
  readEntryHeaderWithChunk,
  resolveObject,
  resolveObjectContentWithDepth,
  resolveObjectWithSize,
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
import {
  type Blob,
  EMPTY_TREE_OID,
  type ObjectContent,
  type ObjectId,
  serializeHeader,
} from '../../../../src/domain/objects/index.js';
import type { LruCache } from '../../../../src/domain/storage/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildMidx, type MidxSpec } from '../../domain/storage/arbitraries.js';
import {
  buildSeededContext,
  instrumentedContext,
  writeLooseWithDeclaredSize,
  writeRawObjectBytes,
} from './fixtures.js';
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
 * A `RegisteredPack` every field of which throws if invoked. Used to prove a
 * `readEntryHeaderWithChunk` guard clause returns/throws BEFORE touching the
 * pack at all — a mutant that weakens or deletes the guard surfaces as this
 * stub's own "unexpected pack access" error instead of the expected one.
 */
function unusedPack(): RegisteredPack {
  const boom = (): never => {
    throw new Error('unexpected pack access');
  };
  return {
    name: 'unused',
    index: boom,
    packPath: 'unused',
    idxPath: 'unused',
    header: boom,
    offsetTable: boom,
    readSlice: boom,
    close: boom,
    hasRevIndex: false,
    revIndex: boom,
    packPositions: boom,
    hasBitmap: false,
    bitmapBytes: boom,
  };
}

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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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

  describe('Given a pack written directly to disk after the registry already scanned an empty pack directory', () => {
    describe('When resolveObject is called for the newly-packed id', () => {
      it('Then it resolves via one re-scan retry, mirroring reprepare_packed_git', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);
        await registry.all(); // force the (empty) generation the writeSyntheticPack below bypasses
        const content = new TextEncoder().encode('packed after scan\n');
        const [id] = await writeSyntheticPack(ctx, 'late-pack', [
          { kind: 'base', type: 'blob', content },
        ]);

        // Act
        const result = await resolveObject(ctx, registry, id as ObjectId, true);

        // Assert
        expect(result.type).toBe('blob');
        expect((result as Blob).content).toEqual(content);
      });
    });
  });

  describe('Given the registry still misses after a re-scan (id genuinely absent everywhere)', () => {
    describe('When resolveObject is called', () => {
      it('Then it throws OBJECT_NOT_FOUND after exactly one re-scan (one extra pack-directory listing)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = await createPackRegistry(instrumented);
        await registry.all();
        const packDir = `${ctx.layout.gitDir}/objects/pack`;
        const baseline = calls().length; // ignore the arrange-time listing

        // Act
        try {
          await resolveObject(instrumented, registry, 'f'.repeat(40) as ObjectId, true);
          expect.unreachable();
        } catch (error) {
          // Assert
          expect(error).toBeInstanceOf(TsgitError);
          expect((error as TsgitError).data.code).toBe('OBJECT_NOT_FOUND');
        }
        const packDirListings = calls()
          .slice(baseline)
          .filter((call) => call.method === 'readdir' && call.path === packDir);
        expect(packDirListings).toHaveLength(1);
      });
    });
  });

  describe('Given many concurrent full misses for objects packed after the registry already scanned', () => {
    describe('When resolveObject is called concurrently for each', () => {
      it('Then every read resolves and the pack directory is only re-listed once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const { ctx: instrumented, calls } = instrumentedContext(ctx);
        const registry = await createPackRegistry(instrumented);
        await registry.all();
        const packDir = `${ctx.layout.gitDir}/objects/pack`;
        const entries = await Promise.all(
          Array.from({ length: 5 }, async (_unused, i) => {
            const content = new TextEncoder().encode(`concurrent-late-pack-${i}\n`);
            const [id] = await writeSyntheticPack(instrumented, `concurrent-late-pack-${i}`, [
              { kind: 'base', type: 'blob', content },
            ]);
            return { id: id as ObjectId, content };
          }),
        );
        const baseline = calls().length; // ignore the writes' own bookkeeping reads

        // Act
        const results = await Promise.all(
          entries.map(({ id }) => resolveObject(instrumented, registry, id, true)),
        );

        // Assert
        results.forEach((result, i) => {
          expect(result.type).toBe('blob');
          expect((result as Blob).content).toEqual(entries[i]?.content);
        });
        const packDirListings = calls()
          .slice(baseline)
          .filter((call) => call.method === 'readdir' && call.path === packDir);
        expect(packDirListings).toHaveLength(1);
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
        const registry = await createPackRegistry(instrumented);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);
        expect(ctx.deltaCache.get(deltaId)).toBeUndefined();

        // Act
        await resolveObject(ctx, registry, deltaId, true);

        // Assert — cacheEntry must have populated the cache; killing the
        // BlockStatement mutant that empties the function body.
        const cached = ctx.deltaCache.get(deltaId);
        expect(cached).toBeDefined();
        expect(cached?.content.length).toBeGreaterThan(0);
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
          const registry = await createPackRegistry(ctx);
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
          const content = new TextEncoder().encode('xyz');
          const rawBytes = new TextEncoder().encode('blob 3\0xyz');
          const actualOid = (await ctx.hash.hashHex(rawBytes)) as ObjectId;
          ctx.deltaCache.set(fakeId, { type: 'blob', content }, content.length);
          const registry = await createPackRegistry(ctx);

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
          const content = new Uint8Array(10).fill(0x41);
          ctx.deltaCache.set(fakeId, { type: 'blob', content }, content.length);
          const registry = await createPackRegistry(ctx);

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
      describe('When resolveObjectContentWithDepth is called with verifyHash=false', () => {
        it('Then no hash is computed', async () => {
          // Arrange — the sync fast path must not pay for a hash it never uses.
          const ctx = await buildSeededContext();
          const fakeId = 'd'.repeat(40) as ObjectId;
          const content = new TextEncoder().encode('xyz');
          ctx.deltaCache.set(fakeId, { type: 'blob', content }, content.length);
          const registry = await createPackRegistry(ctx);
          const hashSpy = vi.spyOn(ctx.hash, 'hashHex');
          const createHasherSpy = vi.spyOn(ctx.hash, 'createHasher');

          // Act
          const result = await resolveObjectContentWithDepth(
            ctx,
            registry,
            fakeId,
            false,
            undefined,
            0,
          );

          // Assert
          expect(result.type).toBe('blob');
          expect(result.content).toEqual(content);
          expect(hashSpy).not.toHaveBeenCalled();
          expect(createHasherSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a delta-cache hit with verifyHash true', () => {
      describe('When resolveObjectContentWithDepth is called', () => {
        it('Then the hasher receives the canonical header then the content, in that order', async () => {
          // Arrange — the order is the mutant kill: a swapped or dropped
          // update call would still hash *something*, but not the canonical
          // `<type> <size>\0<content>` scheme.
          const ctx = await buildSeededContext();
          const fakeId = 'f'.repeat(40) as ObjectId;
          const content = new TextEncoder().encode('xyz');
          ctx.deltaCache.set(fakeId, { type: 'blob', content }, content.length);
          const registry = await createPackRegistry(ctx);
          const updateSpy = vi.fn();
          vi.spyOn(ctx.hash, 'createHasher').mockReturnValue({
            update: updateSpy,
            digest: vi.fn(),
            digestHex: vi.fn().mockResolvedValue(fakeId),
          });

          // Act
          await resolveObjectContentWithDepth(ctx, registry, fakeId, true, undefined, 0);

          // Assert
          expect(updateSpy.mock.calls).toHaveLength(2);
          expect(updateSpy.mock.calls[0]?.[0]).toEqual(serializeHeader('blob', content.length));
          expect(updateSpy.mock.calls[1]?.[0]).toEqual(content);
        });
      });
    });

    describe('Given a fresh loose read', () => {
      describe('When it populates ctx.deltaCache', () => {
        it('Then currentSize equals content.byteLength + 32', async () => {
          // Arrange
          const content = new TextEncoder().encode('hello world');
          const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
          const ctx = await buildSeededContext({ objects: [blob] });
          const id = (await ctx.hash.hashHex(
            gitObjectMod.serializeObject(blob, ctx.hashConfig),
          )) as ObjectId;
          const registry = await createPackRegistry(ctx);

          // Act
          await resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0);

          // Assert
          expect(ctx.deltaCache.currentSize).toBe(
            content.byteLength + OBJECT_CACHE_ENTRY_OVERHEAD_BYTES,
          );
        });
      });
    });

    describe('Given a delta-cache hit and a signal that aborts before the read returns', () => {
      describe('When resolveObjectContentWithDepth is called with verifyHash=false', () => {
        it('Then it rejects with OPERATION_ABORTED', async () => {
          // Arrange — verifyHash=false means the cache-hit arm no longer awaits
          // a hash, so it must poll for abort explicitly at the same point
          // instead, or a signal raised in flight would go unobserved.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          const fakeId = 'd'.repeat(40) as ObjectId;
          const content = new TextEncoder().encode('xyz');
          const cached = { type: 'blob' as const, content };
          ctx.deltaCache.set(fakeId, cached, content.length);
          const registry = await createPackRegistry(ctx);
          vi.spyOn(ctx.deltaCache, 'get').mockImplementationOnce(() => {
            controller.abort();
            return cached;
          });

          // Act
          try {
            await resolveObjectContentWithDepth(ctx, registry, fakeId, false, undefined, 0);
            // Assert
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data.code).toBe('OPERATION_ABORTED');
          }
        });
      });
    });

    describe('Given a signal that aborts while probing loose-object presence (a miss)', () => {
      describe('When resolveObjectContentWithDepth would otherwise proceed to the pack registry', () => {
        it('Then it throws OPERATION_ABORTED before ever calling registry.lookup', async () => {
          // Arrange — abort from inside the loose-presence probe's own
          // readdir call, so the abort lands strictly between the loose
          // miss and the pack lookup.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          const fakeId = 'e'.repeat(40) as ObjectId;
          const baseReaddir = ctx.fs.readdir.bind(ctx.fs);
          const abortingCtx: Context = {
            ...ctx,
            fs: {
              ...ctx.fs,
              readdir: (async (path: string) => {
                controller.abort();
                return baseReaddir(path);
              }) as typeof ctx.fs.readdir,
            },
          };
          const registry = await createPackRegistry(abortingCtx);
          const lookupSpy = vi.spyOn(registry, 'lookup');

          // Act
          let caught: unknown;
          try {
            await resolveObjectContentWithDepth(abortingCtx, registry, fakeId, false, undefined, 0);
            expect.unreachable();
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
          expect(lookupSpy).not.toHaveBeenCalled();
        });
      });
    });

    describe('Given a signal that aborts during the pack registry lookup itself', () => {
      describe('When resolveObjectContentWithDepth would otherwise proceed to resolve the pack chain', () => {
        it('Then it throws OPERATION_ABORTED before resolving the chain — collectDeltaChain never even reads the offset table', async () => {
          // Arrange — offsetTable() is the very FIRST thing
          // resolvePackChainWithDepth's collectDeltaChain does, ahead of
          // even that function's OWN internal checkAborted (inside its
          // probe loop) — so "never called" proves THIS checkAborted, not
          // the inner one, is what caught the abort.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          const content = new TextEncoder().encode('abort-before-chain');
          const [id] = await writeSyntheticPack(ctx, 'abort-lookup', [
            { kind: 'base', type: 'blob', content },
          ]);
          const registry = await createPackRegistry(ctx);
          const baseLookup = registry.lookup.bind(registry);
          let offsetTableSpy: RegisteredPack['offsetTable'] | undefined;
          vi.spyOn(registry, 'lookup').mockImplementationOnce(async (oid) => {
            controller.abort();
            const hit = await baseLookup(oid);
            if (hit === undefined) return hit;
            const spy = vi.fn(hit.pack.offsetTable.bind(hit.pack));
            offsetTableSpy = spy;
            return { ...hit, pack: { ...hit.pack, offsetTable: spy } };
          });

          // Act
          let caught: unknown;
          try {
            await resolveObjectContentWithDepth(ctx, registry, id as ObjectId, false, undefined, 0);
            expect.unreachable();
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(offsetTableSpy).not.toHaveBeenCalled();
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
        });
      });
    });

    describe('Given a signal that aborts while reading the pack chain bytes, with hash verification requested', () => {
      describe('When resolveObjectContentWithDepth would otherwise proceed to verifyObjectContent', () => {
        it('Then it throws OPERATION_ABORTED before ever hashing the resolved content', async () => {
          // Arrange — verifyHash=true so verifyObjectContent's OWN checkAborted
          // sits AFTER its digestHex call, not before; with verifyHash=false
          // that inner check would fire at verifyObjectContent's very first
          // statement, making it indistinguishable from THIS checkAborted
          // (nothing observable happens between them). No hasher being
          // created therefore proves THIS site caught the abort.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          const content = new TextEncoder().encode('abort-after-chain');
          const [id] = await writeSyntheticPack(ctx, 'abort-chain', [
            { kind: 'base', type: 'blob', content },
          ]);
          const registry = await createPackRegistry(ctx);
          const baseLookup = registry.lookup.bind(registry);
          vi.spyOn(registry, 'lookup').mockImplementationOnce(async (oid) => {
            const hit = await baseLookup(oid);
            if (hit === undefined) return hit;
            const baseReadSlice = hit.pack.readSlice.bind(hit.pack);
            return {
              ...hit,
              pack: {
                ...hit.pack,
                readSlice: async (offset: number, length: number) => {
                  controller.abort();
                  return baseReadSlice(offset, length);
                },
              },
            };
          });
          const hashSpy = vi.spyOn(ctx.hash, 'hashHex');
          const createHasherSpy = vi.spyOn(ctx.hash, 'createHasher');

          // Act
          let caught: unknown;
          try {
            await resolveObjectContentWithDepth(ctx, registry, id as ObjectId, true, undefined, 0);
            expect.unreachable();
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(hashSpy).not.toHaveBeenCalled();
          expect(createHasherSpy).not.toHaveBeenCalled();
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
        });
      });
    });

    describe('Given a loose object and a signal that aborts once its hash has been computed', () => {
      describe('When resolveObjectContentWithDepth is called with verifyHash=true', () => {
        it('Then it rejects with OPERATION_ABORTED even though the computed hash matches', async () => {
          // Arrange — the hash matches (real bytes, real id), so nothing
          // BUT this checkAborted stands between a successful hashHex and a
          // normal, successful return.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          const content = new TextEncoder().encode('hash me then abort');
          const id = await writeObject(ctx, { type: 'blob', content, id: '' as ObjectId });
          const registry = await createPackRegistry(ctx);
          const baseCreateHasher = ctx.hash.createHasher.bind(ctx.hash);
          vi.spyOn(ctx.hash, 'createHasher').mockImplementationOnce(() => {
            const hasher = baseCreateHasher();
            return {
              update: hasher.update.bind(hasher),
              digest: hasher.digest.bind(hasher),
              digestHex: async () => {
                const result = await hasher.digestHex();
                controller.abort();
                return result;
              },
            };
          });

          // Act
          let caught: unknown;
          try {
            await resolveObjectContentWithDepth(ctx, registry, id, true, undefined, 0);
            expect.unreachable();
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
        });
      });
    });

    describe('Given a signal that aborts while reading the FIRST level of a multi-level OFS_DELTA chain', () => {
      describe('When resolveObjectContentWithDepth would otherwise keep walking toward the base', () => {
        it('Then it stops after that one level — the walk never reads a second level', async () => {
          // Arrange — collectDeltaChain's own per-level checkAborted (at the
          // TOP of its loop) is what must stop the walk before a second
          // readSlice call; readSlice's own call count is the only way to
          // observe that the SECOND level was never even reached.
          const controller = new AbortController();
          const ctx = await buildSeededContext({ signal: controller.signal });
          let content = new TextEncoder().encode('multi-level-base');
          const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content }];
          for (let i = 0; i < 4; i += 1) {
            content = new TextEncoder().encode(`multi-level-${i}`);
            entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: content });
          }
          const ids = await writeSyntheticPack(ctx, 'multi-level-abort', entries);
          const id = ids.at(-1) as ObjectId;
          const registry = await createPackRegistry(ctx);
          const baseLookup = registry.lookup.bind(registry);
          let readSliceSpy: RegisteredPack['readSlice'] | undefined;
          vi.spyOn(registry, 'lookup').mockImplementationOnce(async (oid) => {
            const hit = await baseLookup(oid);
            if (hit === undefined) return hit;
            const baseReadSlice = hit.pack.readSlice.bind(hit.pack);
            let calls = 0;
            const spy = vi.fn(async (offset: number, length: number) => {
              calls += 1;
              if (calls === 1) controller.abort();
              return baseReadSlice(offset, length);
            });
            readSliceSpy = spy;
            return { ...hit, pack: { ...hit.pack, readSlice: spy } };
          });

          // Act
          let caught: unknown;
          try {
            await resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0);
            expect.unreachable();
          } catch (error) {
            caught = error;
          }

          // Assert
          expect(caught).toBeInstanceOf(TsgitError);
          expect((caught as TsgitError).data.code).toBe('OPERATION_ABORTED');
          expect(readSliceSpy).toHaveBeenCalledTimes(1);
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
          const registry = await createPackRegistry(ctx);
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

  describe('loose reads populate the delta cache', () => {
    describe('Given a loose object read once', () => {
      describe('When resolveObject returns', () => {
        it('Then the delta cache holds its type and content', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: ENC.encode('loose-cache-population content'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = await createPackRegistry(ctx);
          expect(ctx.deltaCache.get(id)).toBeUndefined();

          // Act
          await resolveObject(ctx, registry, id, true);

          // Assert — cacheEntry must have populated the cache from the loose
          // return path, not just the pack/REF_DELTA-base paths.
          const cached = ctx.deltaCache.get(id);
          expect(cached).toBeDefined();
          expect(cached?.type).toBe('blob');
          expect(cached?.content.length).toBeGreaterThan(0);
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
          const registry = await createPackRegistry(ctx);
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

  describe('Given a loose blob whose header size claim disagrees with its body length', () => {
    describe('When resolveObjectContentWithDepth is called', () => {
      it('Then it returns the real content and the claim as declaredSize, and never caches the object', async () => {
        // Arrange
        const content = ENC.encode('hello world!'); // 12 bytes
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0);

        // Assert
        expect(result.content).toEqual(content);
        expect(result.declaredSize).toBe(5);
        expect(ctx.deltaCache.has(id)).toBe(false);
      });
    });
  });

  describe('Given an honest loose blob (no size-lying header)', () => {
    describe('When resolveObjectContentWithDepth is called', () => {
      it('Then it caches the object under its id', async () => {
        // Arrange
        const content = ENC.encode('hello world!');
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        const registry = await createPackRegistry(ctx);

        // Act
        await resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0);

        // Assert
        expect(ctx.deltaCache.has(id)).toBe(true);
      });
    });
  });

  describe('Given a loose commit whose header size claim disagrees with its body length', () => {
    describe('When resolveObjectContentWithDepth is called', () => {
      it('Then it throws INVALID_OBJECT_HEADER with the verbatim size-mismatch reason', async () => {
        // Arrange
        const content = ENC.encode('commit body');
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'commit', content);
        await writeLooseWithDeclaredSize(ctx, id, 'commit', 400, content);
        const registry = await createPackRegistry(ctx);

        // Act
        try {
          await resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_OBJECT_HEADER');
          if (data.code === 'INVALID_OBJECT_HEADER') {
            expect(data.reason).toBe(
              `size mismatch: header says 400, actual content is ${content.byteLength}`,
            );
          }
        }
      });
    });
  });

  describe('Given a loose blob whose header size claim disagrees with its body length, read with verifyHash true', () => {
    describe('When resolveObjectContentWithDepth is called', () => {
      it('Then it throws OBJECT_HASH_MISMATCH hashing the stored (lying) header', async () => {
        // Arrange
        const content = ENC.encode('hello world!');
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);
        const registry = await createPackRegistry(ctx);
        const storedLyingBytes = new Uint8Array(
          serializeHeader('blob', 5).length + content.byteLength,
        );
        storedLyingBytes.set(serializeHeader('blob', 5), 0);
        storedLyingBytes.set(content, serializeHeader('blob', 5).length);
        const expectedActual = (await ctx.hash.hashHex(storedLyingBytes)) as ObjectId;

        // Act
        try {
          await resolveObjectContentWithDepth(ctx, registry, id, true, undefined, 0);
          // Assert
          expect.unreachable();
        } catch (error) {
          const data = (error as TsgitError).data;
          expect(data.code).toBe('OBJECT_HASH_MISMATCH');
          if (data.code === 'OBJECT_HASH_MISMATCH') {
            expect(data.expected).toBe(id);
            expect(data.actual).toBe(expectedActual);
          }
        }
      });
    });
  });

  describe('Given a lying loose blob read once without verifyHash, then read again with verifyHash true', () => {
    describe('When the second resolveObjectContentWithDepth call runs', () => {
      it('Then it still refuses OBJECT_HASH_MISMATCH — the unverified read never cached it', async () => {
        // Arrange
        const content = ENC.encode('hello world!');
        const ctx = await buildSeededContext();
        const id = await writeRawObjectBytes(ctx, 'blob', content);
        await writeLooseWithDeclaredSize(ctx, id, 'blob', 5, content);
        const registry = await createPackRegistry(ctx);
        await resolveObjectContentWithDepth(ctx, registry, id, false, undefined, 0);

        // Act
        try {
          await resolveObjectContentWithDepth(ctx, registry, id, true, undefined, 0);
          // Assert
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data.code).toBe('OBJECT_HASH_MISMATCH');
        }
      });
    });
  });

  describe('Given the empty tree oid', () => {
    describe('When resolveObjectContentWithDepth is called', () => {
      it('Then declaredSize equals the (zero) content length', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObjectContentWithDepth(
          ctx,
          registry,
          EMPTY_TREE_OID,
          false,
          undefined,
          0,
        );

        // Assert
        expect(result.declaredSize).toBe(0);
        expect(result.content.byteLength).toBe(0);
      });
    });
  });

  describe('Given a delta-cache hit', () => {
    describe('When resolveObjectContentWithDepth resolves it', () => {
      it('Then declaredSize equals the cached content length', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const fakeId = 'e'.repeat(40) as ObjectId;
        const content = ENC.encode('cached content');
        ctx.deltaCache.set(fakeId, { type: 'blob', content }, content.length);
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObjectContentWithDepth(
          ctx,
          registry,
          fakeId,
          false,
          undefined,
          0,
        );

        // Assert
        expect(result.declaredSize).toBe(content.byteLength);
      });
    });
  });

  describe('Given a synthetic pack with a base blob', () => {
    describe('When resolveObjectContentWithDepth resolves it', () => {
      it('Then declaredSize equals the reconstructed content length', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const content = ENC.encode('hello packed blob');
        const [id] = await writeSyntheticPack(ctx, 'base-only-declared-size', [
          { kind: 'base', type: 'blob', content },
        ]);
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObjectContentWithDepth(
          ctx,
          registry,
          id as ObjectId,
          false,
          undefined,
          0,
        );

        // Assert
        expect(result.declaredSize).toBe(content.byteLength);
      });
    });
  });

  describe('Given a commit resolved once', () => {
    describe('When resolveObjectWithSize is called', () => {
      it('Then it returns the memoised parse alongside its size', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const commitText = [
          `tree ${'b'.repeat(40)}`,
          'author A <a@a.com> 0 +0000',
          'committer A <a@a.com> 0 +0000',
          '',
          'msg',
        ].join('\n');
        const id = await writeRawObjectBytes(ctx, 'commit', ENC.encode(commitText));
        const registry = await createPackRegistry(ctx);

        // Act
        const first = await resolveObjectWithSize(ctx, registry, id, false);
        const second = await resolveObjectWithSize(ctx, registry, id, false);

        // Assert
        expect(first.object.type).toBe('commit');
        expect(first.size).toBe(ENC.encode(commitText).byteLength);
        expect(second.object).toBe(first.object);
      });
    });
  });

  describe('Given a cold Context whose requested object is loose', () => {
    describe('When resolveObject reads it', () => {
      it('Then objects/pack is listed once and every unclaimed pack index is consulted before the loose fallback', async () => {
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
        const registry = await createPackRegistry(instrumented);

        // Act
        const result = await resolveObject(instrumented, registry, id, true);

        // Assert
        expect(result.type).toBe('blob');
        const packDirReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
        );
        expect(packDirReaddirCalls).toHaveLength(1);
        // `exists` never fires for a stronger reason than "the scan didn't run
        // this time": scanPacks no longer calls it at all (the readdir fold
        // below replaced it), so this count is zero by construction, not by
        // this read happening to take the loose branch.
        const existsCalls = calls().filter((call) => call.method === 'exists');
        expect(existsCalls).toEqual([]);
        // Neither pack claims this loose-only id, so the pack-first order
        // must rule BOTH out via their own `.idx` before falling to loose —
        // the price a mixed store pays for consulting packs first, matching
        // git's own find_pack_entry over unclaimed packs.
        const idxTouches = calls().filter((call) => call.path.endsWith('.idx'));
        expect(idxTouches).toEqual([
          { method: 'stat', path: `${ctx.layout.gitDir}/objects/pack/pack-cold-read-a.idx` },
          { method: 'read', path: `${ctx.layout.gitDir}/objects/pack/pack-cold-read-a.idx` },
          { method: 'stat', path: `${ctx.layout.gitDir}/objects/pack/pack-cold-read-b.idx` },
          { method: 'read', path: `${ctx.layout.gitDir}/objects/pack/pack-cold-read-b.idx` },
        ]);
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
        const registry = await createPackRegistry(stubCtx);

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
        const registry = await createPackRegistry(instrumented);

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
        const registry = await createPackRegistry(instrumented);

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
      it('Then the blob resolves, the discard warn fires once, and objects/pack is listed only once for the shared listing', async () => {
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
        const registry = await createPackRegistry(instrumented);

        // Act
        const result = await resolveObject(instrumented, registry, id, true);

        // Assert
        expect(result.type).toBe('blob');
        expect(warn).toHaveBeenCalledTimes(1);
        const packDirReaddirCalls = calls().filter(
          (call) => call.method === 'readdir' && call.path.endsWith('/objects/pack'),
        );
        expect(packDirReaddirCalls).toHaveLength(1);
      });
    });
  });

  describe('loose-oid probe (A2/B7b — per-fanout-dir cache)', () => {
    describe('Given several seeded loose blobs', () => {
      describe('When resolveObject reads each of them, then reads every one again', () => {
        it('Then each touched fanout dir is readdir-ed at most once, objects/pack is listed once for the shared listing, and the pack scan is never forced', async () => {
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
          const registry = await createPackRegistry(ctx);
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
          // Plus exactly one more: assertLoadable's gate now shares
          // packDirListing with the scan, so the FIRST read of this
          // generation lists objects/pack once — memoised, so the second
          // pass over the same ids adds none. exists() never fires at all:
          // the pack directory's own `exists` presence check moved behind
          // the deferred scan, which a loose HIT never forces.
          const touchedPrefixes = new Set(ids.map((id) => id.slice(0, 2)));
          expect(readdirSpy.mock.calls.length).toBe(touchedPrefixes.size + 1);
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
          const registry = await createPackRegistry(ctx);
          await resolveObject(ctx, registry, id, true);
          // A loose read also populates the delta cache on a loose read; drop that
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
          const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);
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
        it('Then the cached type is reused without re-deriving it', async () => {
          // Arrange — base type 'tree' (not 'blob'): a hit that re-derived
          // (or defaulted) the type instead of reusing the cached one would
          // fail this. resolveObjectContentWithDepth is used so the reconstructed
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
          const registry = await createPackRegistry(ctx);
          await resolveObjectContentWithDepth(ctx, registry, tip1Id, false, undefined, 0);

          // Act
          const result = await resolveObjectContentWithDepth(
            ctx,
            registry,
            tip2Id,
            false,
            undefined,
            0,
          );

          // Assert — the propagated 'tree' type, not a re-derived/defaulted one.
          expect(result.type).toBe('tree');
          expect(result.content).toEqual(tip2Content);
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
          const registry = await createPackRegistry(ctx);
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
          // Arrange — deltaBaseCacheMaxBytes=1200 gives a ¼ chain budget of
          // 300 bytes. The 1-byte base fits once the fixed per-entry
          // overhead is added (1 + 200 = 201 <= 300) and is inserted first
          // (nearest-base-first), leaving only 99 bytes of budget behind it —
          // both the 64-byte mid intermediate (264) and the tip's own
          // reconstructed entry (211, also cached under its own offset once
          // fully resolved) would push the running total past 300 and are
          // refused. `cacheDeltaBase` never sees a whole-cache-sized entry
          // here (every candidate is well under the 1200-byte cache); the
          // refusal is the per-chain budget, and the read still completes
          // correctly regardless of what got cached.
          const ctx = createMemoryContext({ deltaBaseCacheMaxBytes: 1200 });
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
          const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);
          deltaBaseCacheKeySpy.mockClear();

          // Act
          await resolveObject(ctx, registry, tipId, false);

          // Assert
          expect(deltaBaseCacheKeySpy).toHaveBeenCalledTimes(4);
        });
      });
    });
  });

  describe('Given an OFS_DELTA chain whose levels exceed the per-chain insert budget', () => {
    describe('When resolveObject resolves the tip', () => {
      it('Then only the base-nearest levels are cached and the returned bytes are unchanged', async () => {
        // Arrange — deltaBaseCacheMaxBytes=2000 gives a ¼ chain budget of 500
        // bytes. Each level's cache entry costs content.length + 200 (fixed
        // overhead), so base (1 byte -> 201) and mid1 (1 byte -> 201) fit
        // (cumulative 402 <= 500) while mid2 (any size) would push past 500
        // and is refused, along with the tip after it.
        const ctx = createMemoryContext({ deltaBaseCacheMaxBytes: 2000 });
        const baseContent = ENC.encode('a');
        const mid1Content = ENC.encode('b');
        const mid2Content = ENC.encode('c');
        const tipContent = ENC.encode('tip content');
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent: mid1Content },
          { kind: 'ofs-delta', baseIndex: 1, targetContent: mid2Content },
          { kind: 'ofs-delta', baseIndex: 2, targetContent: tipContent },
        ]);
        const packBase = `${ctx.layout.gitDir}/objects/pack/pack-budget-chain`;
        await ctx.fs.write(`${packBase}.pack`, built.packBytes);
        await ctx.fs.write(`${packBase}.idx`, built.idxBytes);
        const tipId = built.ids[3]! as ObjectId;
        const [baseOffset, mid1Offset, mid2Offset, tipOffset] = built.offsets;
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, tipId, true);

        // Assert — bytes identical to an unbudgeted read.
        expect((result as Blob).content).toEqual(tipContent);
        // Assert — nearest-base-first: base and mid1 resident, mid2 and the
        // tip's own delta level pruned.
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-budget-chain', baseOffset!)),
        ).toBeDefined();
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-budget-chain', mid1Offset!)),
        ).toBeDefined();
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-budget-chain', mid2Offset!)),
        ).toBeUndefined();
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-budget-chain', tipOffset!)),
        ).toBeUndefined();
        expect(registry.deltaBaseCache.entryCount).toBe(2);
      });
    });
  });

  describe('Given a base larger than the per-chain insert budget feeding a small delta level', () => {
    describe('When resolveObject resolves the tip', () => {
      it('Then the oversized base is skipped but the delta level is still cached', async () => {
        // Arrange — deltaBaseCacheMaxBytes=1000 gives a ¼ chain budget of
        // 250 bytes. The base alone (60 bytes -> 260) exceeds it and must be
        // skipped even though it is the FIRST insert attempted (budget = 0
        // remaining used); the delta level (1 byte -> 201) still fits.
        const ctx = createMemoryContext({ deltaBaseCacheMaxBytes: 1000 });
        const baseContent = new Uint8Array(60).fill(0x41);
        const tipContent = ENC.encode('t');
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent: tipContent },
        ]);
        const packBase = `${ctx.layout.gitDir}/objects/pack/pack-oversized-base`;
        await ctx.fs.write(`${packBase}.pack`, built.packBytes);
        await ctx.fs.write(`${packBase}.idx`, built.idxBytes);
        const tipId = built.ids[1]! as ObjectId;
        const [baseOffset, tipOffset] = built.offsets;
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, tipId, true);

        // Assert
        expect((result as Blob).content).toEqual(tipContent);
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-oversized-base', baseOffset!)),
        ).toBeUndefined();
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-oversized-base', tipOffset!)),
        ).toBeDefined();
      });
    });
  });

  describe('Given a single-level chain whose base entry exactly fills the per-chain budget', () => {
    describe('When resolveObject resolves the tip', () => {
      it('Then the base is cached — the budget check is not-greater-than, not at-least', async () => {
        // Arrange — deltaBaseCacheMaxBytes=804 gives a ¼ chain budget of
        // 201 bytes, exactly the base entry's cost (1-byte content + 200
        // fixed overhead). A mutant flipping `>` to `>=` would refuse this.
        const ctx = createMemoryContext({ deltaBaseCacheMaxBytes: 804 });
        const baseContent = ENC.encode('a');
        const tipContent = ENC.encode('z');
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent: tipContent },
        ]);
        const packBase = `${ctx.layout.gitDir}/objects/pack/pack-exact-fit`;
        await ctx.fs.write(`${packBase}.pack`, built.packBytes);
        await ctx.fs.write(`${packBase}.idx`, built.idxBytes);
        const tipId = built.ids[1]! as ObjectId;
        const [baseOffset] = built.offsets;
        const registry = await createPackRegistry(ctx);

        // Act
        await resolveObject(ctx, registry, tipId, true);

        // Assert
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-exact-fit', baseOffset!)),
        ).toBeDefined();
      });
    });
  });

  describe('Given a single-level chain whose base entry exceeds the per-chain budget by one byte', () => {
    describe('When resolveObject resolves the tip', () => {
      it('Then the base is not cached — proving the fraction, not just the comparison', async () => {
        // Arrange — deltaBaseCacheMaxBytes=800 gives a ¼ chain budget of 200
        // bytes; the base entry still costs 201 (1-byte content + 200
        // overhead). A mutant on the 0.25 fraction (e.g. 0.26) would admit
        // this and make the test above and this one both pass by accident;
        // only the pair together pins the exact constant.
        const ctx = createMemoryContext({ deltaBaseCacheMaxBytes: 800 });
        const baseContent = ENC.encode('a');
        const tipContent = ENC.encode('z');
        const built = await buildSyntheticPack(ctx, [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent: tipContent },
        ]);
        const packBase = `${ctx.layout.gitDir}/objects/pack/pack-exact-miss`;
        await ctx.fs.write(`${packBase}.pack`, built.packBytes);
        await ctx.fs.write(`${packBase}.idx`, built.idxBytes);
        const tipId = built.ids[1]! as ObjectId;
        const [baseOffset] = built.offsets;
        const registry = await createPackRegistry(ctx);

        // Act
        await resolveObject(ctx, registry, tipId, true);

        // Assert
        expect(
          registry.deltaBaseCache.get(deltaBaseCacheKey('pack-exact-miss', baseOffset!)),
        ).toBeUndefined();
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
      ] as const)('Then objectTypeToPackType matches the kind', async (kind, baseContent) => {
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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

        // Act
        const result = await resolveObject(ctx, registry, tipId, false);

        // Assert
        expect(result.type).toBe('blob');
      });
    });
  });

  describe('Given a REF_DELTA whose base is a commit', () => {
    describe('When resolveObject is called', () => {
      it('Then objectTypeToPackType returns the commit constant', async () => {
        // Arrange — round-trip a valid commit base into the pack, then a REF_DELTA
        // pointing at it. Ensures objectTypeToPackType hits the 'commit' arm.
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
        const registry = await createPackRegistry(ctx);

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
          const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);
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
          const realPack = (await (await createPackRegistry(ctx)).all())[0]!;
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
  });

  describe('readEntryHeaderWithChunk', () => {
    describe('Given nextOffset greater than packFileSize', () => {
      describe('When called directly', () => {
        it('Then throws INVALID_PACK_INDEX with the next-offset-exceeds reason without touching the pack', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const hit: PackLookupHit = { pack: unusedPack(), offset: 100 };
          const sut = readEntryHeaderWithChunk;

          // Act
          try {
            await sut(ctx, hit, 101, 100);
            expect.unreachable();
          } catch (error) {
            // Assert
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_PACK_INDEX');
            if (data.code !== 'INVALID_PACK_INDEX') {
              expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
            }
            expect(data.reason).toBe('next offset exceeds pack file size: corrupt index');
          }
        });
      });
    });

    describe('Given nextOffset exactly equal to packFileSize (and equal to the entry offset)', () => {
      describe('When called directly', () => {
        it('Then the bound guard does not fire, and the slice-length guard fires instead', async () => {
          // Arrange — isolates the `>` guard's own boundary: nextOffset ===
          // packFileSize must NOT trip it, so the fall-through hits the
          // sliceLength <= 0 guard (offset === nextOffset here) rather than
          // ever reaching `hit.pack.readSlice`.
          const ctx = await buildSeededContext();
          const hit: PackLookupHit = { pack: unusedPack(), offset: 100 };
          const sut = readEntryHeaderWithChunk;

          // Act
          try {
            await sut(ctx, hit, 100, 100);
            expect.unreachable();
          } catch (error) {
            // Assert
            const data = (error as TsgitError).data;
            expect(data.code).toBe('INVALID_PACK_INDEX');
            if (data.code !== 'INVALID_PACK_INDEX') {
              expect.fail(`expected INVALID_PACK_INDEX, got ${data.code}`);
            }
            expect(data.reason).toBe('slice length ≤ 0: next offset not beyond entry offset');
          }
        });
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
        const registry = await createPackRegistry(ctx);
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
          const registry = await createPackRegistry(ctx);
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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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

  describe('Given a 45-level OFS_DELTA chain fully resolved cold, caching every intermediate level along the way', () => {
    describe('When the shallowest delta (one level off the base) is resolved next', () => {
      it("Then it succeeds — a re-cached intermediate level must carry ITS OWN true depth, not the target level's", async () => {
        // Arrange — resolving the tip caches every one of the 45
        // intermediate levels under its own pack offset. The level closest
        // to the base (one hop off it) is genuinely depth 1; a caching loop
        // that mislabels it with (something related to) the target's own
        // depth instead would make a later direct read of THIS shallow
        // level wrongly appear to have accumulated the full chain's depth.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('base');
        const entries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: baseContent }];
        for (let i = 0; i < 45; i += 1) {
          const target = new TextEncoder().encode(`shallow-after-deep-${i}`);
          entries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: target });
        }
        const ids = await writeSyntheticPack(ctx, 'shallow-after-deep', entries);
        const registry = await createPackRegistry(ctx);
        await resolveObject(ctx, registry, ids.at(-1) as ObjectId, false);

        // Act
        const result = await resolveObject(ctx, registry, ids[1] as ObjectId, false);

        // Assert
        expect(result.type).toBe('blob');
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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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
        const registry = await createPackRegistry(ctx);

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

  describe('Given a REF_DELTA base whose OWN chain resumed from a warm intermediate cache entry (nonzero baseChainDepth)', () => {
    describe('When the REF hop base is resolved for the first time via the hop itself, then enough further levels are stacked to exceed the cap only under its TRUE combined depth', () => {
      it('Then the cross-hop read still refuses with DELTA_CHAIN_TOO_DEEP — a resumed base must report its walked-plus-resumed depth, not just the levels it walked', async () => {
        // Arrange — pack A: base + 20 OFS deltas (positions 1..20). Position
        // 10 is warmed FIRST (cold, baseChainDepth 0, depth 10 cached) —
        // this is an INTERMEDIATE position, never the tip. Pack B's
        // REF_DELTA then targets A's tip (position 20) for the FIRST time:
        // resolving it resumes from position 10's cache (baseChainDepth 10,
        // 10 freshly-walked levels), so A's tip's true depth is 20 — but
        // this is the very return value under test. 35 more OFS levels on
        // top of B's REF hop push the TRUE total (20 + 35 = 55) over the
        // cap; a return value that drops the resumed baseChainDepth instead
        // of adding it would report A's tip at depth 0, letting B's tip
        // wrongly resolve at an apparent depth of 35.
        const ctx = await buildSeededContext();
        let aContent = ENC.encode('hop-resume-a-base');
        const aEntries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: aContent }];
        for (let i = 0; i < 20; i += 1) {
          aContent = ENC.encode(`hop-resume-a-${i}`);
          aEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: aContent });
        }
        const aIds = await writeSyntheticPack(ctx, 'hop-resume-a', aEntries);
        const aPosition10Id = aIds[10]! as ObjectId;
        const aTipId = aIds.at(-1)!;

        const bEntries: EntrySpec[] = [
          {
            kind: 'ref-delta',
            baseId: aTipId,
            baseUncompressed: aContent,
            targetContent: ENC.encode('hop-resume-b-0'),
          },
        ];
        let bContent = ENC.encode('hop-resume-b-0');
        for (let i = 0; i < 35; i += 1) {
          bContent = ENC.encode(`hop-resume-b-${i + 1}`);
          bEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: bContent });
        }
        const bIds = await writeSyntheticPack(ctx, 'hop-resume-b', bEntries);
        const bTipId = bIds.at(-1)! as ObjectId;
        const registry = await createPackRegistry(ctx);

        // Act — warm A's position 10 (intermediate, not the tip), then
        // resolve B's tip, which resolves A's tip for the first time as its
        // REF_DELTA base.
        await resolveObject(ctx, registry, aPosition10Id, false);
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
      });
    });
  });

  describe('Given a REF_DELTA entry whose OWN resolved chain depth (a resumed base plus itself) was cached, then extended further', () => {
    describe('When the extended tip resumes from that offset-keyed cache entry', () => {
      it('Then the true cumulative depth is still enforced — the cached REF-hop entry must report walked-plus-resumed depth on its OWN base, not just its own single hop', async () => {
        // Arrange — pack A: base + 11 OFS deltas; warm position 1 (cold,
        // depth 1), then resolve the tip (position 11), which resumes from
        // position 1 (10 fresh levels + baseChainDepth 1 = true depth 11).
        // Pack B: entry 0 is a REF_DELTA into A's tip; entries 1..40 stack
        // 40 more OFS levels on top. Resolving entry 0 DIRECTLY caches ITS
        // OWN offset-keyed entry using A's returned chainDepth as its base
        // — if that return drops the resumed depth instead of adding it,
        // entry 0's own cached depth undercounts by exactly A's
        // baseChainDepth. Resolving B's tip afterwards then resumes from
        // entry 0's (possibly undercounted) cache entry.
        const ctx = await buildSeededContext();
        let aContent = ENC.encode('return-a-base');
        const aEntries: EntrySpec[] = [{ kind: 'base', type: 'blob', content: aContent }];
        for (let i = 0; i < 11; i += 1) {
          aContent = ENC.encode(`return-a-${i}`);
          aEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: aContent });
        }
        const aIds = await writeSyntheticPack(ctx, 'return-a', aEntries);
        const aPosition1Id = aIds[1]! as ObjectId;
        const aTipId = aIds.at(-1)!;

        const bEntries: EntrySpec[] = [
          {
            kind: 'ref-delta',
            baseId: aTipId,
            baseUncompressed: aContent,
            targetContent: ENC.encode('return-b-0'),
          },
        ];
        let bContent = ENC.encode('return-b-0');
        for (let i = 0; i < 40; i += 1) {
          bContent = ENC.encode(`return-b-${i + 1}`);
          bEntries.push({ kind: 'ofs-delta', baseIndex: i, targetContent: bContent });
        }
        const bIds = await writeSyntheticPack(ctx, 'return-b', bEntries);
        const bEntry0Id = bIds[0]! as ObjectId;
        const bTipId = bIds.at(-1)! as ObjectId;
        const registry = await createPackRegistry(ctx);

        // Act — warm A's position 1 (intermediate, not the tip): A's tip is
        // resolved for the first time below, as bEntry0's own REF_DELTA
        // base, so it goes through the full resolvePackChainWithDepth
        // return path rather than an id-keyed bytes-cache shortcut.
        await resolveObject(ctx, registry, aPosition1Id, false);
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
        const registry = await createPackRegistry(ctx);

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

  describe('OFS_DELTA base-offset guard', () => {
    describe('Given an OFS_DELTA whose base distance points before the pack body (negative offset)', () => {
      describe('When resolveObject runs', () => {
        it('Then throws OBJECT_NOT_FOUND', async () => {
          // Arrange — a single OFS_DELTA at offset 12 with a base distance of
          // 100, so `nextOffset = 12 - 100 = -88`. The `if (nextOffset < 0)`
          // guard must throw OBJECT_NOT_FOUND. Forcing the conditional `false`
          // would carry a negative offset into the next chain hop instead.
          // Declared size 2, matching the 2-byte deflated body's real
          // inflated length — an honest declared size, so the new
          // declared-vs-actual check (item 2) never fires here; only the
          // negative-offset guard this row targets does.
          const ctx = await buildSeededContext();
          const deltaBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 2),
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
          // Declared size 2, matching the 2-byte deflated body's real
          // inflated length — an honest declared size, so the new
          // declared-vs-actual check (item 2) never fires here; only the
          // offset-0 guard this row targets does.
          const ctx = await buildSeededContext();
          const deltaBody = await ctx.compressor.deflate(new Uint8Array([0x00, 0x00]));
          const entry = new Uint8Array([
            ...encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 2),
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
      it('Then the declared-size check throws INVALID_PACK_ENTRY, ahead of the post-apply cap', async () => {
        // Arrange — a base blob entry whose header declares size 1 (so the
        // pre-inflate `enforcePackBaseCap` passes the cap of 4) while the zlib
        // body inflates to 40 bytes. The unconditional declared-vs-actual
        // check now catches this lie before the post-apply OBJECT_TOO_LARGE
        // cap ever runs — mirroring git's `unpack_entry_data`
        // (`stream.total_out != size`), which refuses the SAME shape the
        // same way regardless of any caller-side size cap.
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
          expect(data.code).toBe('INVALID_PACK_ENTRY');
          if (data.code !== 'INVALID_PACK_ENTRY') {
            expect.fail(`expected INVALID_PACK_ENTRY, got ${data.code}`);
          }
          expect(data.reason).toBe('bad object: inflated size differs from declared size');
          expect(data.offset).toBe(12);
        }
      });
    });
  });

  describe('Given a pack base entry whose declared size mismatches its actual inflated size, with no maxBytes cap', () => {
    describe('When resolveObject is called', () => {
      it('Then throws INVALID_PACK_ENTRY unconditionally — not gated on a size cap', async () => {
        // Arrange — an honest zlib body, but the header's declared size is
        // one byte short of the real content length.
        const ctx = await buildSeededContext();
        const content = new TextEncoder().encode('honest body, dishonest declared size\n');
        const [id] = await writeSyntheticPack(ctx, 'base-declared-size-lie', [
          { kind: 'base', type: 'blob', content, declaredSizeOverride: content.length - 1 },
        ]);
        const registry = await createPackRegistry(ctx);

        // Act — no maxBytes argument at all.
        try {
          await resolveObject(ctx, registry, id as ObjectId, false);
          expect.unreachable();
        } catch (error) {
          // Assert
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_PACK_ENTRY');
          if (data.code !== 'INVALID_PACK_ENTRY') {
            expect.fail(`expected INVALID_PACK_ENTRY, got ${data.code}`);
          }
          expect(data.reason).toBe('bad object: inflated size differs from declared size');
        }
      });
    });
  });

  describe("Given an OFS_DELTA entry whose declared size mismatches its instruction stream's actual inflated size", () => {
    describe('When resolveObject is called', () => {
      it('Then throws INVALID_PACK_ENTRY: bad object: inflated size differs from declared size', async () => {
        // Arrange — an honest delta instruction stream, but the entry
        // header's declared size lies.
        const ctx = await buildSeededContext();
        const baseContent = new TextEncoder().encode('base content for a delta size lie\n');
        const targetContent = new TextEncoder().encode('reconstructed target, different length\n');
        const ids = await writeSyntheticPack(ctx, 'delta-declared-size-lie', [
          { kind: 'base', type: 'blob', content: baseContent },
          { kind: 'ofs-delta', baseIndex: 0, targetContent, declaredSizeOverride: 1 },
        ]);
        const deltaId = ids[1] as ObjectId;
        const registry = await createPackRegistry(ctx);

        // Act
        try {
          await resolveObject(ctx, registry, deltaId, false);
          expect.unreachable();
        } catch (error) {
          // Assert
          expect(error).toBeInstanceOf(TsgitError);
          const data = (error as TsgitError).data;
          expect(data.code).toBe('INVALID_PACK_ENTRY');
          if (data.code !== 'INVALID_PACK_ENTRY') {
            expect.fail(`expected INVALID_PACK_ENTRY, got ${data.code}`);
          }
          expect(data.reason).toBe('bad object: inflated size differs from declared size');
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

    // `gitObjectMod.parseObjectContent` is a module-namespace export shared by every
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
          const registry = await createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObjectContent');
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
          const registry = await createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObjectContent');
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
          // Arrange — a 1-byte deltaCache budget floors the memo's own byte
          // valve to 1, always below any real message. A generous
          // `parsedObjectMemoMaxEntries` override keeps the derived entry
          // cap (which would otherwise ALSO be 0 at this valve) from being
          // what excludes the fixture, so the byte valve alone is under test.
          const ctx = createMemoryContext({
            deltaCacheMaxBytes: 1,
            parsedObjectMemoMaxEntries: 10,
          });
          const message = 'a message long enough to exceed a near-zero memo cap';
          const commitId = await writeCommitWithMessage(ctx, message);
          const registry = await createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObjectContent');
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
          const registry = await createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObjectContent');
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
          const registry = await createPackRegistry(ctx);
          createLruCacheSpy.mockClear();

          // Act
          await resolveObject(ctx, registry, commitId, false);

          // Assert
          const memoCall = createLruCacheSpy.mock.calls.find(
            (call) => call[0] === memoByteValve(ctx),
          );
          expect(memoCall?.[1]).toBe(
            Math.floor(ctx.deltaCache.maxSize / PARSED_OBJECT_DIAL_BYTES_PER_ENTRY),
          );
        });
      });
    });

    describe('Given a deltaCache sized so the byte budget never binds', () => {
      describe('When more entries than the derived entry cap are inserted', () => {
        it('Then the entry cap itself evicts down to the cap, not the byte budget', async () => {
          // Arrange — a deltaCache large enough that the memo's own byte
          // valve never binds at tiny synthetic entries; only the
          // entry-count cap (derived from that same valve) can be what
          // evicts. Direct `.set()` calls on the memo itself (grabbed off
          // the createLruCache spy's own return value) keep this fast —
          // resolving that many distinct real commits through resolveObject
          // would be impractical.
          const ctx = createMemoryContext({ deltaCacheMaxBytes: 6_553_600 });
          const derivedEntryCap = Math.floor(
            ctx.deltaCache.maxSize / PARSED_OBJECT_DIAL_BYTES_PER_ENTRY,
          );
          const commitId = await writeCommitWithMessage(ctx, 'entry cap eviction seed');
          const registry = await createPackRegistry(ctx);
          createLruCacheSpy.mockClear();
          await resolveObject(ctx, registry, commitId, false);
          const memoCallIndex = createLruCacheSpy.mock.calls.findIndex(
            (call) => call[1] === derivedEntryCap,
          );
          const memo = createLruCacheSpy.mock.results[memoCallIndex]?.value as LruCache<unknown>;

          // Act
          for (let i = 0; i <= derivedEntryCap; i += 1) {
            memo.set(`synthetic-${i}`, {}, 1);
          }

          // Assert — capped at the entry count; the byte budget (far larger
          // than these tiny 1-byte entries) never bound.
          expect(memo.entryCount).toBe(derivedEntryCap);
        });
      });
    });

    describe('Given entries exceeding the memo cap', () => {
      describe('When a fourth commit is read after the first is touched again', () => {
        it('Then the least-recently-used entry is evicted, not the oldest-inserted one', async () => {
          // Arrange — a 3-entry dial (1,536 B ÷ 512 B/entry) fits exactly
          // three same-size, parentless, 10-char messages: A, B, C fill it
          // exactly (no eviction yet). Re-reading A promotes it to MRU,
          // leaving B — untouched since its own insert — as the LRU tail. A
          // plain FIFO would evict A on the next insert (oldest inserted);
          // an LRU evicts B instead (least recently touched). Sized via the
          // production sizer itself (default sha1 hexLength=40, matching
          // this Context's unspecified algorithm) so the cap tracks
          // PARSED_OBJECT_FIXED_OVERHEAD_BYTES automatically. A generous
          // `parsedObjectMemoMaxEntries` override keeps the entry-count cap
          // from binding first, so the byte valve is the constraint under
          // test.
          const perEntry = parsedObjectByteSize({ message: 'AAAAAAAAAA', extraHeaders: [] }, 40);
          const dialBytes = 3 * PARSED_OBJECT_DIAL_BYTES_PER_ENTRY;
          const ctx = createMemoryContext({
            deltaCacheMaxBytes: dialBytes,
            parsedObjectMemoMaxEntries: 10,
          });
          // A retune of either the dial divisor or the typical-entry
          // constants would silently change which entry the valve evicts —
          // pin the 3-entry relationship those two constants must produce.
          expect(Math.floor(memoByteValve(ctx) / perEntry)).toBe(3);
          const commitA = await writeCommitWithMessage(ctx, 'AAAAAAAAAA');
          const commitB = await writeCommitWithMessage(ctx, 'BBBBBBBBBB');
          const commitC = await writeCommitWithMessage(ctx, 'CCCCCCCCCC');
          const commitD = await writeCommitWithMessage(ctx, 'DDDDDDDDDD');
          const registry = await createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObjectContent');
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
            deltaCache: createLruCache<ObjectContent>(0),
          });
          const registry = await createPackRegistry(ctx);
          const parseSpy = vi.spyOn(gitObjectMod, 'parseObjectContent');
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

  describe('pack-first precedence (buffered reads)', () => {
    describe('Given a synthetic pack with a base blob and no loose copy', () => {
      describe('When resolveObject reads it', () => {
        it('Then its loose fanout directory is never listed', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = ENC.encode('pack-first fanout probe');
          const [id] = await writeSyntheticPack(ctx, 'pack-first-fanout', [
            { kind: 'base', type: 'blob', content },
          ]);
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const registry = await createPackRegistry(instrumented);

          // Act
          const result = await resolveObject(instrumented, registry, id as ObjectId, true);

          // Assert
          expect((result as Blob).content).toEqual(content);
          const fanoutReaddirCalls = calls().filter(
            (call) =>
              call.method === 'readdir' &&
              call.path.endsWith(`/objects/${(id as string).slice(0, 2)}`),
          );
          expect(fanoutReaddirCalls).toEqual([]);
        });
      });
    });

    describe('Given an object that exists only loosely (no pack copy)', () => {
      describe('When resolveObject reads it', () => {
        it('Then the pack registry is consulted first and the loose read follows the miss', async () => {
          // Arrange
          const blob: Blob = {
            type: 'blob',
            content: ENC.encode('pack-miss-falls-to-loose'),
            id: '' as ObjectId,
          };
          const ctx = await buildSeededContext({ objects: [blob] });
          const { serializeObject } = await import('../../../../src/domain/objects/index.js');
          const id = (await ctx.hash.hashHex(serializeObject(blob, ctx.hashConfig))) as ObjectId;
          const registry = await createPackRegistry(ctx);
          const lookupSpy = vi.spyOn(registry, 'lookup');
          const readSpy = vi.spyOn(ctx.fs, 'read');

          // Act
          const result = await resolveObject(ctx, registry, id, true);

          // Assert
          expect((result as Blob).content).toEqual(blob.content);
          expect(lookupSpy).toHaveBeenCalledTimes(1);
          expect(readSpy).toHaveBeenCalledTimes(1);
          const lookupOrder = lookupSpy.mock.invocationCallOrder[0];
          const readOrder = readSpy.mock.invocationCallOrder[0];
          expect(lookupOrder).toBeDefined();
          expect(readOrder).toBeDefined();
          expect(lookupOrder as number).toBeLessThan(readOrder as number);
        });
      });
    });

    describe('Given a packed object with a corrupt loose copy at the same id', () => {
      describe('When resolveObject reads it', () => {
        it('Then it returns the pack content and the corrupt loose file is never read', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          const content = ENC.encode('pack-served-despite-corrupt-loose');
          const [id] = await writeSyntheticPack(ctx, 'corrupt-loose-shadow', [
            { kind: 'base', type: 'blob', content },
          ]);
          const { computeLooseObjectPath } = await import(
            '../../../../src/domain/storage/loose-path.js'
          );
          const loosePath = `${ctx.layout.gitDir}/objects/${computeLooseObjectPath(id as ObjectId)}`;
          await ctx.fs.write(loosePath, ENC.encode('not-a-zlib-stream'));
          const { ctx: instrumented, calls } = instrumentedContext(ctx);
          const registry = await createPackRegistry(instrumented);

          // Act
          const result = await resolveObject(instrumented, registry, id as ObjectId, true);

          // Assert
          expect((result as Blob).content).toEqual(content);
          const looseReadCalls = calls().filter(
            (call) => call.method === 'read' && call.path === loosePath,
          );
          expect(looseReadCalls).toEqual([]);
        });
      });
    });
  });
});
