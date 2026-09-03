/**
 * Unit tests for the prior `buildPack` non-delta packfile assembler.
 *
 * Coverage:
 *  - empty oid list → 32-byte minimal pack (header + trailer)
 *  - single blob → header + 1 entry + trailer; parsePackHeader sees count=1
 *  - mixed types → entries round-trip through parsePackEntryHeader
 *  - trailer → SHA over the body bytes, byte-equal
 */
import { describe, expect, it } from 'vitest';
import { buildPack } from '../../../../src/application/primitives/build-pack.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import { readRawObject } from '../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../src/application/primitives/write-tree.js';
import { bytesToHex } from '../../../../src/domain/objects/encoding.js';
import type { Blob, FileMode, ObjectId } from '../../../../src/domain/objects/index.js';
import { treeEntry } from '../../../../src/domain/objects/tree.js';
import { crc32 } from '../../../../src/domain/storage/crc32.js';
import {
  PACK_ENTRY_TYPE,
  type PackIndexEntries,
  parsePackEntryHeader,
  parsePackHeader,
} from '../../../../src/domain/storage/index.js';
import { buildSeededContext } from './fixtures.js';

const PACK_HEADER_BYTES = 12;

/** A pure function of (seed, index) so two calls with the same seed always
 *  agree on their common prefix regardless of requested length. */
function pseudoRandomByte(seed: number, index: number): number {
  const h = Math.imul(seed ^ index, 0x9e3779b1) ^ (index << 13);
  return (Math.imul(h, 0x85ebca6b) >>> 24) & 0xff;
}

function pseudoRandomBytes(seed: number, length: number): Uint8Array {
  return Uint8Array.from({ length }, (_unused, i) => pseudoRandomByte(seed, i));
}

async function writeBlob(ctx: Awaited<ReturnType<typeof buildSeededContext>>, content: Uint8Array) {
  const blob: Blob = { type: 'blob', content, id: '' as ObjectId };
  return writeObject(ctx, blob);
}

async function seedPackConfig(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  body: string,
): Promise<void> {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, `[pack]\n${body}`);
  __resetConfigCacheForTests();
}

const TRAILER_BYTES = 20;

/** Each result entry's own byte range in `bytes`, derived from the slab's
 *  own `offsets` (offset-sorted by emission) and the trailer boundary — the
 *  trailer width is `entries.digestLength`, never the SHA-1-only constant,
 *  since the last entry's span would otherwise swallow part of a SHA-256
 *  trailer. */
function entrySpan(
  entries: PackIndexEntries,
  index: number,
  bytes: Uint8Array,
): { readonly start: number; readonly end: number } {
  const start = entries.offsets[index]!;
  const next =
    index + 1 < entries.count ? entries.offsets[index + 1]! : bytes.length - entries.digestLength;
  return { start, end: next };
}

/** Decodes the id at slab position `index` — the oid the fixed-width `oids`
 *  range at that ordinal holds, never a retained per-entry string. */
function entryIdAt(entries: PackIndexEntries, index: number): ObjectId {
  const start = index * entries.digestLength;
  return bytesToHex(entries.oids.subarray(start, start + entries.digestLength)) as ObjectId;
}

describe('buildPack', () => {
  describe('Given an empty oid list', () => {
    describe('When buildPack runs', () => {
      it('Then output is 12 header bytes + 20 trailer bytes', async () => {
        // Arrange
        const ctx = await buildSeededContext();

        // Act
        const result = await buildPack(ctx, { oids: [] });

        // Assert — header + trailer only, no entries.
        expect(result.bytes.length).toBe(PACK_HEADER_BYTES + TRAILER_BYTES);
        expect(result.objectCount).toBe(0);
        const header = parsePackHeader(result.bytes);
        expect(header.version).toBe(2);
        expect(header.objectCount).toBe(0);
        // Trailer is the SHA of the pack body (12 header bytes only when empty).
        const expectedTrailer = await ctx.hash.hash(result.bytes.subarray(0, PACK_HEADER_BYTES));
        expect(result.bytes.subarray(PACK_HEADER_BYTES)).toEqual(expectedTrailer);
        expect(result.sha).toBe(bytesToHex(expectedTrailer));
      });
    });
  });

  describe('Given a single blob oid', () => {
    describe('When buildPack runs', () => {
      it('Then header reports objectCount=1 and entry header decodes as BLOB', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = {
          type: 'blob',
          content: new TextEncoder().encode('hello'),
          id: '' as ObjectId,
        };
        const blobId = await writeObject(ctx, blob);

        // Act
        const result = await buildPack(ctx, { oids: [blobId] });

        // Assert
        expect(result.objectCount).toBe(1);
        const header = parsePackHeader(result.bytes);
        expect(header.objectCount).toBe(1);
        const firstEntry = parsePackEntryHeader(result.bytes, PACK_HEADER_BYTES, ctx.hashConfig);
        expect(firstEntry.type).toBe(PACK_ENTRY_TYPE.BLOB);
        expect(firstEntry.size).toBe(5);
      });
    });
  });

  describe('Given mixed types (blob + tree)', () => {
    describe('When buildPack runs', () => {
      it('Then each entry type is preserved in order', async () => {
        // Arrange — write a blob, then a tree referencing it, then pack both.
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a.bin', blobId)]);

        // Act
        const result = await buildPack(ctx, { oids: [blobId, treeId] });

        // Assert — two entries; the first is the BLOB, the second is the TREE.
        expect(result.objectCount).toBe(2);
        const first = parsePackEntryHeader(result.bytes, PACK_HEADER_BYTES, ctx.hashConfig);
        expect(first.type).toBe(PACK_ENTRY_TYPE.BLOB);
      });
    });
  });

  describe('Given an oid for a tree, commit, or annotated tag object', () => {
    describe('When buildPack runs', () => {
      const AUTHOR = { name: 'A', email: 'a@a', timestamp: 0, timezoneOffset: '+0000' };

      it.each([
        {
          label: 'TREE',
          expectedType: PACK_ENTRY_TYPE.TREE,
          // Kills the `packEntryTypeFor("tree")` mutant: dropping the `case
          // 'tree'` body falls through to `'blob'`, mislabeling the entry.
          buildOid: async (ctx: Awaited<ReturnType<typeof buildSeededContext>>, blobId: ObjectId) =>
            writeTree(ctx, [treeEntry('100644' as FileMode, 'a.bin', blobId)]),
        },
        {
          label: 'COMMIT',
          expectedType: PACK_ENTRY_TYPE.COMMIT,
          // Kills the `packEntryTypeFor("commit")` mutant by exercising the
          // commit branch in isolation.
          buildOid: async (
            ctx: Awaited<ReturnType<typeof buildSeededContext>>,
            blobId: ObjectId,
          ) => {
            const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a.bin', blobId)]);
            return writeObject(ctx, {
              type: 'commit' as const,
              id: '' as ObjectId,
              data: {
                tree: treeId,
                parents: [],
                author: AUTHOR,
                committer: AUTHOR,
                message: 'first',
                extraHeaders: [],
              },
            });
          },
        },
        {
          label: 'TAG',
          expectedType: PACK_ENTRY_TYPE.TAG,
          // Kills the `packEntryTypeFor("tag")` mutant.
          buildOid: async (ctx: Awaited<ReturnType<typeof buildSeededContext>>, blobId: ObjectId) =>
            writeObject(ctx, {
              type: 'tag' as const,
              id: '' as ObjectId,
              data: {
                object: blobId,
                objectType: 'blob' as const,
                tagName: 'v1',
                tagger: AUTHOR,
                message: 'tagged\n',
                extraHeaders: [],
              },
            }),
        },
      ])('Then the entry header decodes as $label', async ({ expectedType, buildOid }) => {
        // Arrange — pack the object alone so its entry sits first in the pack.
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([7]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);
        const oid = await buildOid(ctx, blobId);

        // Act
        const result = await buildPack(ctx, { oids: [oid] });

        // Assert
        const header = parsePackEntryHeader(result.bytes, PACK_HEADER_BYTES, ctx.hashConfig);
        expect(header.type).toBe(expectedType);
      });
    });
  });

  describe('Given any pack', () => {
    describe('When buildPack returns', () => {
      it('Then the trailer SHA matches the body hash exactly', async () => {
        // Arrange — a non-empty pack so we exercise both the header-and-trailer
        // path and the body composition.
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([0xff]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);

        // Act
        const result = await buildPack(ctx, { oids: [blobId] });

        // Assert — kills the swap-the-trailer mutant: bytes must end in
        // hash(body), not hash(anything-else).
        const body = result.bytes.subarray(0, result.bytes.length - TRAILER_BYTES);
        const expectedTrailer = await ctx.hash.hash(body);
        expect(result.bytes.subarray(result.bytes.length - TRAILER_BYTES)).toEqual(expectedTrailer);
        expect(result.sha).toBe(bytesToHex(expectedTrailer));
      });
    });
  });

  describe('Given mixed types (blob + tree)', () => {
    describe('When buildPack returns', () => {
      it('Then each meta carries the emission-order oid alongside its crc32/offset', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([1, 2, 3]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'a.bin', blobId)]);

        // Act
        const result = await buildPack(ctx, { oids: [blobId, treeId] });

        // Assert — one identified triple per oid, in emission order, each
        // offset strictly increasing from the header.
        expect(result.entries.count).toBe(2);
        expect(entryIdAt(result.entries, 0)).toBe(blobId);
        expect(entryIdAt(result.entries, 1)).toBe(treeId);
        expect(result.entries.offsets[0]).toBe(PACK_HEADER_BYTES);
        expect(result.entries.offsets[1]).toBeGreaterThan(result.entries.offsets[0] as number);
        for (let i = 0; i < result.entries.count; i += 1) {
          expect(Number.isInteger(result.entries.crcValues[i])).toBe(true);
        }
      });
    });

    describe('When the input oid order differs from a hypothetical emission order', () => {
      it('Then every input oid appears exactly once among result.entries ids', async () => {
        // Arrange — emission order still equals input order at this point in
        // the design (delta selection lands later), so this asserts identity
        // set-wise rather than positionally, which stays true once emission
        // order stops matching input order.
        const ctx = await buildSeededContext();
        const blob: Blob = { type: 'blob', content: new Uint8Array([9, 9]), id: '' as ObjectId };
        const blobId = await writeObject(ctx, blob);
        const treeId = await writeTree(ctx, [treeEntry('100644' as FileMode, 'z.bin', blobId)]);
        const oids = [treeId, blobId];

        // Act
        const result = await buildPack(ctx, { oids });

        // Assert
        const resultIds = new Set(
          Array.from({ length: result.entries.count }, (_, i) => entryIdAt(result.entries, i)),
        );
        expect(resultIds).toEqual(new Set(oids));
      });
    });
  });

  describe('Given core.loosecompression=9 in the repo config', () => {
    describe('When buildPack is called', () => {
      it('Then deflate is called with no level argument (pack path does not use loose compression level)', async () => {
        // Arrange — git's pack path uses pack.compression, not core.loosecompression.
        // Setting core.loosecompression must NOT flow through to build-pack's deflate call.
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tloosecompression = 9\n');
        __resetConfigCacheForTests();
        const deflateLevels: Array<number | undefined> = [];
        const wrappedCtx = {
          ...ctx,
          compressor: {
            ...ctx.compressor,
            deflate: async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
              deflateLevels.push(level);
              return ctx.compressor.deflate(data, level);
            },
          },
        };
        const blob: Blob = { type: 'blob', content: new Uint8Array([88]), id: '' as ObjectId };
        const blobId = await writeObject(wrappedCtx, blob);
        // Reset capture before the pack call so we only see build-pack's deflate calls
        deflateLevels.length = 0;

        // Act
        await buildPack(wrappedCtx, { oids: [blobId] });

        // Assert — build-pack calls deflate without a level (pack.compression key governs pack)
        expect(deflateLevels.every((l) => l === undefined)).toBe(true);
      });
    });
  });

  describe('Given delta:true and two near-identical blobs', () => {
    describe('When buildPack runs', () => {
      it('Then at least one entry decodes as OFS_DELTA', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(41, 200);
        const idA = await writeBlob(ctx, shared);
        const idB = await writeBlob(ctx, shared.slice(0, 150));

        // Act
        const result = await buildPack(ctx, { oids: [idA, idB], delta: true });

        // Assert
        const types = Array.from(
          { length: result.entries.count },
          (_, i) =>
            parsePackEntryHeader(result.bytes, result.entries.offsets[i]!, ctx.hashConfig).type,
        );
        expect(types).toContain(PACK_ENTRY_TYPE.OFS_DELTA);
      });
    });
  });

  describe('Given delta:true and an input order opposite to the emission sort', () => {
    describe('When buildPack runs', () => {
      it.each([
        { algorithm: 'sha1' as const, label: 'SHA-1' },
        { algorithm: 'sha256' as const, label: 'SHA-256' },
      ])(
        'Then every entries[] oid, crc32 and offset all describe the SAME object ($label)',
        async ({ algorithm }) => {
          // Arrange — small blob first in input.oids, big blob second; the
          // emission sort (size DESC) reorders big-first, small-second, so an
          // off-by-one oid<->meta pairing bug would swap the two objects'
          // crc32/offset. Both blobs are mutually unrelated so both are
          // guaranteed base entries, keeping the ground-truth check simple.
          // `W` (the oid stride) is now `entries.digestLength`, an index
          // stride rather than a string length, so both digest widths must
          // be exercised.
          const ctx = await buildSeededContext({ algorithm });
          const smallContent = pseudoRandomBytes(51, 10);
          const bigContent = pseudoRandomBytes(52, 500);
          const smallId = await writeBlob(ctx, smallContent);
          const bigId = await writeBlob(ctx, bigContent);

          // Act
          const result = await buildPack(ctx, { oids: [smallId, bigId], delta: true });

          // Assert — for every i < count, the slab-decoded oid at position i
          // pairs with crcValues[i]/offsets[i] describing THAT SAME object,
          // never the next entry's.
          expect(result.entries.count).toBe(2);
          for (let i = 0; i < result.entries.count; i += 1) {
            const id = entryIdAt(result.entries, i);
            const span = entrySpan(result.entries, i, result.bytes);
            const segment = result.bytes.subarray(span.start, span.end);
            const recomputedCrc = crc32(segment);
            // `crcValues` is unsigned, like `crc32()` itself — no normalisation.
            expect(recomputedCrc).toBe(result.entries.crcValues[i]!);

            const header = parsePackEntryHeader(result.bytes, span.start, ctx.hashConfig);
            expect(header.type).not.toBe(PACK_ENTRY_TYPE.OFS_DELTA);
            const compressed = result.bytes.subarray(header.dataOffset, span.end);
            const inflated = await ctx.compressor.inflate(compressed);
            const expected = (await readRawObject(ctx, id)).content;
            expect(inflated).toEqual(expected);
          }
        },
      );
    });
  });

  describe('Given delta:true, called twice over the same oid set', () => {
    describe('When buildPack runs both times', () => {
      it('Then the two packs are byte-identical', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(61, 300);
        const ids = [
          await writeBlob(ctx, shared),
          await writeBlob(ctx, shared.slice(0, 200)),
          await writeBlob(ctx, shared.slice(0, 100)),
        ];

        // Act
        const first = await buildPack(ctx, { oids: ids, delta: true });
        const second = await buildPack(ctx, { oids: ids, delta: true });

        // Assert
        expect(second.bytes).toEqual(first.bytes);
        expect(second.sha).toBe(first.sha);
      });
    });
  });

  describe('Given delta:true and a shuffled oid array whose sorted order is unchanged', () => {
    describe('When buildPack runs over both orderings', () => {
      it('Then the pack body bytes are identical', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(71, 300);
        const idA = await writeBlob(ctx, shared);
        const idB = await writeBlob(ctx, shared.slice(0, 200));
        const idC = await writeBlob(ctx, shared.slice(0, 100));

        // Act
        const inOrder = await buildPack(ctx, { oids: [idA, idB, idC], delta: true });
        const shuffled = await buildPack(ctx, { oids: [idC, idA, idB], delta: true });

        // Assert — emission order is sort-derived, not input-derived.
        expect(shuffled.bytes).toEqual(inOrder.bytes);
      });
    });
  });

  describe('Given delta:true and same-type blobs tied on uncompressedSize but distinct in content', () => {
    describe('When buildPack runs over two permutations of the same oid set', () => {
      it('Then the pack body bytes are identical, decided by the id tiebreak', async () => {
        // Arrange — same type and same byte length, so comparePackEmissionOrder
        // reaches its `id` clause; Array.prototype.sort is stable, so absent
        // that clause the two differently-ordered inputs would each retain
        // their own input order instead of converging on one canonical order.
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, pseudoRandomBytes(111, 64));
        const idB = await writeBlob(ctx, pseudoRandomBytes(112, 64));
        const idC = await writeBlob(ctx, pseudoRandomBytes(113, 64));

        // Act
        const forward = await buildPack(ctx, { oids: [idA, idB, idC], delta: true });
        const reversed = await buildPack(ctx, { oids: [idC, idB, idA], delta: true });

        // Assert
        expect(reversed.bytes).toEqual(forward.bytes);
      });
    });
  });

  describe('Given pack.window=0 in the repo config', () => {
    describe('When buildPack runs with delta:true', () => {
      it('Then bytes are identical to buildPack without delta', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(81, 200);
        const idA = await writeBlob(ctx, shared);
        const idB = await writeBlob(ctx, shared.slice(0, 150));
        await seedPackConfig(ctx, '\twindow = 0\n');

        // Act
        const withDelta = await buildPack(ctx, { oids: [idA, idB], delta: true });
        const withoutDelta = await buildPack(ctx, { oids: [idA, idB] });

        // Assert
        expect(withDelta.bytes).toEqual(withoutDelta.bytes);
      });
    });
  });

  describe('Given pack.depth=0 in the repo config', () => {
    describe('When buildPack runs with delta:true', () => {
      it('Then bytes are identical to buildPack without delta', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const shared = pseudoRandomBytes(82, 200);
        const idA = await writeBlob(ctx, shared);
        const idB = await writeBlob(ctx, shared.slice(0, 150));
        await seedPackConfig(ctx, '\tdepth = 0\n');

        // Act
        const withDelta = await buildPack(ctx, { oids: [idA, idB], delta: true });
        const withoutDelta = await buildPack(ctx, { oids: [idA, idB] });

        // Assert
        expect(withDelta.bytes).toEqual(withoutDelta.bytes);
      });
    });
  });

  describe('Given a chain-forcing corpus and pack.depth configured below the reader cap', () => {
    describe('When buildPack runs with delta:true', () => {
      it('Then no emitted chain is longer than the configured depth', async () => {
        // Arrange — each object is a strict prefix of the previous, and
        // pack.window=1 forces a straight chain off the sole predecessor.
        const ctx = await buildSeededContext();
        await seedPackConfig(ctx, '\twindow = 1\n\tdepth = 3\n');
        const shared = pseudoRandomBytes(91, 500);
        const ids: ObjectId[] = [];
        for (let k = 0; k < 8; k += 1) {
          ids.push(await writeBlob(ctx, shared.slice(0, 500 - k)));
        }

        // Act
        const result = await buildPack(ctx, { oids: ids, delta: true });

        // Assert
        const headers = Array.from({ length: result.entries.count }, (_, i) => ({
          offset: result.entries.offsets[i]!,
          header: parsePackEntryHeader(result.bytes, result.entries.offsets[i]!, ctx.hashConfig),
        }));
        const chainDepthAt = (index: number): number => {
          const { header } = headers[index]!;
          if (header.type !== PACK_ENTRY_TYPE.OFS_DELTA) return 0;
          const baseOffset = headers[index]!.offset - header.baseDistance;
          const baseIndex = headers.findIndex((h) => h.offset === baseOffset);
          return 1 + chainDepthAt(baseIndex);
        };
        for (let i = 0; i < headers.length; i += 1) {
          expect(chainDepthAt(i)).toBeLessThanOrEqual(3);
        }
        // At least one delta chain actually reaches the cap, proving the
        // corpus was chain-forcing rather than trivially shallow — an
        // all-base pack (delta selection entirely broken) would otherwise
        // still pass the <= 3 bound above.
        expect(Math.max(...headers.map((_h, i) => chainDepthAt(i)))).toBe(3);
      });
    });
  });

  describe('Given delta:true and a corpus of incompressible, mutually unrelated blobs', () => {
    describe('When buildPack runs', () => {
      it('Then zero delta entries are emitted and the pack is not larger than base-only', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const idA = await writeBlob(ctx, pseudoRandomBytes(101, 64));
        const idB = await writeBlob(ctx, pseudoRandomBytes(102, 64));
        const idC = await writeBlob(ctx, pseudoRandomBytes(103, 64));

        // Act
        const withDelta = await buildPack(ctx, { oids: [idA, idB, idC], delta: true });
        const baseOnly = await buildPack(ctx, { oids: [idA, idB, idC] });

        // Assert
        const types = Array.from(
          { length: withDelta.entries.count },
          (_, i) =>
            parsePackEntryHeader(withDelta.bytes, withDelta.entries.offsets[i]!, ctx.hashConfig)
              .type,
        );
        expect(types).not.toContain(PACK_ENTRY_TYPE.OFS_DELTA);
        expect(withDelta.bytes.length).toBeLessThanOrEqual(baseOnly.bytes.length);
      });
    });
  });

  describe('Given a corpus the delta selection reorders away from input order', () => {
    describe('When buildPack runs with delta selection on', () => {
      it('Then emissionOrder maps every emitted ordinal back to its own input oid', async () => {
        // A wrong permutation is silent: gc reads per-object mtimes through it,
        // so an off-by-one attaches each object's mtime to its neighbour and
        // every artefact still parses. The invariant is checked directly
        // against the slab rather than inferred from a downstream artefact.
        {
          // Arrange — mutually similar blobs of differing sizes, so the
          // packer's (type, size DESC, oid) order is NOT the input order.
          const ctx = await buildSeededContext();
          const seed = pseudoRandomBytes(7, 4096);
          const oids: ObjectId[] = [];
          for (const extra of [0, 900, 300, 1500, 60]) {
            const content = new Uint8Array(seed.length + extra);
            content.set(seed, 0);
            oids.push(await writeBlob(ctx, content));
          }

          // Act
          const pack = await buildPack(ctx, { oids, delta: true });

          // Assert — a genuine permutation of [0, count)...
          expect(pack.emissionOrder).toHaveLength(pack.entries.count);
          expect([...pack.emissionOrder].slice().sort((a, b) => a - b)).toEqual(
            oids.map((_, i) => i),
          );
          // ...that is not the identity (otherwise the test proves nothing)...
          expect([...pack.emissionOrder]).not.toEqual(oids.map((_, i) => i));
          // ...and every ordinal's slab oid is the input oid it points at.
          const { oids: slab, digestLength } = pack.entries;
          for (let ordinal = 0; ordinal < pack.entries.count; ordinal += 1) {
            const start = ordinal * digestLength;
            const emitted = bytesToHex(slab.subarray(start, start + digestLength));
            expect(emitted).toBe(oids[pack.emissionOrder[ordinal]!]);
          }
        }
      });
    });
  });
});
