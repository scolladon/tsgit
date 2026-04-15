import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import { crc32 } from '../../../../src/domain/storage/crc32.js';
import {
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  parsePackHeader,
} from '../../../../src/domain/storage/pack-entry.js';
import { lookupPackIndex, parsePackIndex } from '../../../../src/domain/storage/pack-index.js';
import {
  type PackWriterEntry,
  serializePackfile,
  serializePackIndex,
} from '../../../../src/domain/storage/pack-writer.js';
import { arbObjectId } from './arbitraries.js';

function makeEntry(type: 1 | 2 | 3 | 4, data: Uint8Array): PackWriterEntry {
  return { type, uncompressedSize: data.length, compressedData: data };
}

function arbUniqueIndexEntries(
  maxLen: number,
): fc.Arbitrary<Array<{ id: string; offset: number; crc32: number }>> {
  return fc
    .array(
      fc.tuple(
        arbObjectId(40),
        fc.integer({ min: 0, max: 2 ** 30 }),
        fc.integer({ min: 0, max: 0xffffffff }),
      ),
      { minLength: 1, maxLength: maxLen },
    )
    .map((tuples) => {
      const seen = new Set<string>();
      const entries: Array<{ id: string; offset: number; crc32: number }> = [];
      for (const [id, offset, crc] of tuples) {
        if (!seen.has(id)) {
          seen.add(id);
          entries.push({ id, offset, crc32: crc });
        }
      }
      return entries;
    });
}

describe('pack-writer', () => {
  describe('serializePackfile', () => {
    it('Given 1 entry (BLOB), When serializing, Then result.data starts with PACK header (magic+v2+count=1)', () => {
      // Arrange
      const entry = makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array([1, 2, 3]));

      // Act
      const sut = serializePackfile([entry]);

      // Assert
      const header = parsePackHeader(sut.data);
      expect(header.version).toBe(2);
      expect(header.objectCount).toBe(1);
    });

    it('Given 1 entry, When serializing, Then result.entries[0].offset equals 12 (pack header size)', () => {
      // Arrange
      const entry = makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array([1, 2, 3]));

      // Act
      const sut = serializePackfile([entry]);

      // Assert
      expect(sut.entries[0]!.offset).toBe(12);
    });

    it('Given 1 entry, When serializing, Then result.entries[0].crc32 equals crc32(header + compressedData)', () => {
      // Arrange
      const compressedData = new Uint8Array([1, 2, 3]);
      const entry = makeEntry(PACK_ENTRY_TYPE.BLOB, compressedData);

      // Act
      const sut = serializePackfile([entry]);

      // Assert
      const entryHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, compressedData.length);
      const combined = new Uint8Array(entryHeader.length + compressedData.length);
      combined.set(entryHeader);
      combined.set(compressedData, entryHeader.length);
      expect(sut.entries[0]!.crc32).toBe(crc32(combined));
    });

    it('Given 3 entries, When serializing, Then result.entries offsets are sequential', () => {
      // Arrange
      const entries = [
        makeEntry(PACK_ENTRY_TYPE.COMMIT, new Uint8Array(10)),
        makeEntry(PACK_ENTRY_TYPE.TREE, new Uint8Array(20)),
        makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array(30)),
      ];

      // Act
      const sut = serializePackfile(entries);

      // Assert
      expect(sut.entries[0]!.offset).toBe(12);
      expect(sut.entries[1]!.offset).toBeGreaterThan(sut.entries[0]!.offset);
      expect(sut.entries[2]!.offset).toBeGreaterThan(sut.entries[1]!.offset);
    });

    it('Given 3 entries, When serializing, Then parsePackHeader gives count=3', () => {
      // Arrange
      const entries = [
        makeEntry(PACK_ENTRY_TYPE.COMMIT, new Uint8Array(10)),
        makeEntry(PACK_ENTRY_TYPE.TREE, new Uint8Array(20)),
        makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array(30)),
      ];

      // Act
      const sut = serializePackfile(entries);

      // Assert
      const header = parsePackHeader(sut.data);
      expect(header.objectCount).toBe(3);
    });

    it('Given 0 entries, When serializing, Then result.data is just the 12-byte pack header', () => {
      // Act
      const sut = serializePackfile([]);

      // Assert
      expect(sut.data.length).toBe(12);
      const header = parsePackHeader(sut.data);
      expect(header.objectCount).toBe(0);
      expect(sut.entries).toHaveLength(0);
    });
  });

  describe('serializePackIndex', () => {
    it('Given 3 entries with known ObjectIds, When serializing, Then starts with magic and version 2', () => {
      // Arrange
      const entries = [
        { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 12 },
        { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 100 },
        { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 200 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);

      // Assert
      const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
      expect(view.getUint32(0)).toBe(0xff744f63);
      expect(view.getUint32(4)).toBe(2);
    });

    it('Given 3 entries, When serializing, Then fanout table has correct cumulative counts', () => {
      // Arrange
      const entries = [
        { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 12 },
        { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 100 },
        { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 200 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);

      // Assert
      const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
      // 0xaa = 170
      expect(view.getUint32(8 + 170 * 4)).toBe(1);
      // 0xbb = 187
      expect(view.getUint32(8 + 187 * 4)).toBe(2);
      // 0xcc = 204
      expect(view.getUint32(8 + 204 * 4)).toBe(3);
      // fanout[255] = total
      expect(view.getUint32(8 + 255 * 4)).toBe(3);
    });

    it('Given entry with offset > 2^31, When serializing, Then small offset has MSB set and large offset table present', () => {
      // Arrange
      const largeOffset = 0x80000001;
      const entries = [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: largeOffset }];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      // Append self-checksum placeholder for parsing
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);

      // Assert — roundtrip parse finds the correct offset
      const idx = parsePackIndex(withTrailer);
      const result = lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);
      expect(result).toBe(largeOffset);
    });

    it('Given multiple entries with offsets > 2^31 including > 2^32, When serializing then parsing, Then all large offsets correct', () => {
      // Arrange — 3 large offset entries, one with high word > 0 to kill largeIdx math mutants
      const entries = [
        { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x80000001 },
        { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 0x100000002 },
        { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 0x200000003 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);
      const idx = parsePackIndex(withTrailer);

      // Assert — each entry has a distinct large offset
      expect(lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId)).toBe(0x80000001);
      expect(lookupPackIndex(idx, ('bb' + '00'.repeat(19)) as ObjectId)).toBe(0x100000002);
      expect(lookupPackIndex(idx, ('cc' + '00'.repeat(19)) as ObjectId)).toBe(0x200000003);
    });

    it('Given mix of small and large offsets, When serializing then parsing, Then all offsets correct', () => {
      // Arrange
      const entries = [
        { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 42 },
        { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 0x80000001 },
        { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 99 },
        { id: 'dd' + '00'.repeat(19), crc32: 0, offset: 0x90000002 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);
      const idx = parsePackIndex(withTrailer);

      // Assert
      expect(lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId)).toBe(42);
      expect(lookupPackIndex(idx, ('bb' + '00'.repeat(19)) as ObjectId)).toBe(0x80000001);
      expect(lookupPackIndex(idx, ('cc' + '00'.repeat(19)) as ObjectId)).toBe(99);
      expect(lookupPackIndex(idx, ('dd' + '00'.repeat(19)) as ObjectId)).toBe(0x90000002);
    });

    it('Given offset exactly 0x7fffffff, When serializing then parsing, Then treated as small offset', () => {
      // Arrange — 0x7fffffff is the max small offset (MSB not set)
      const entries = [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x7fffffff }];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);
      const idx = parsePackIndex(withTrailer);

      // Assert
      expect(lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId)).toBe(0x7fffffff);
    });

    it('Given offset > 2^32, When serializing then parsing, Then reads correct 64-bit value', () => {
      // Arrange — offset = 0x100000001 (high=1, low=1)
      const largeOffset = 0x100000001;
      const entries = [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: largeOffset }];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);
      const idx = parsePackIndex(withTrailer);

      // Assert
      expect(lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId)).toBe(largeOffset);
    });

    it('Given 3 entries, When serializing, Then SHA table is sorted', () => {
      // Arrange — entries given out of order
      const entries = [
        { id: 'cc' + '00'.repeat(19), crc32: 333, offset: 300 },
        { id: 'aa' + '00'.repeat(19), crc32: 111, offset: 100 },
        { id: 'bb' + '00'.repeat(19), crc32: 222, offset: 200 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);
      const idx = parsePackIndex(withTrailer);

      // Assert — lookup works regardless of input order
      expect(lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId)).toBe(100);
      expect(lookupPackIndex(idx, ('bb' + '00'.repeat(19)) as ObjectId)).toBe(200);
      expect(lookupPackIndex(idx, ('cc' + '00'.repeat(19)) as ObjectId)).toBe(300);
    });

    it('Given 3 entries, When serializing, Then CRC-32 table matches entry order after sort', () => {
      // Arrange — out of order entries with distinct CRC values
      const entries = [
        { id: 'cc' + '00'.repeat(19), crc32: 0xaabbccdd, offset: 300 },
        { id: 'aa' + '00'.repeat(19), crc32: 0x11223344, offset: 100 },
        { id: 'bb' + '00'.repeat(19), crc32: 0x55667788, offset: 200 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);

      // Assert — CRC table follows sorted SHA order (aa, bb, cc)
      const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
      const n = 3;
      const crcStart = 1032 + n * 20;
      expect(view.getUint32(crcStart + 0 * 4)).toBe(0x11223344); // aa
      expect(view.getUint32(crcStart + 1 * 4)).toBe(0x55667788); // bb
      expect(view.getUint32(crcStart + 2 * 4)).toBe(0xaabbccdd); // cc
    });

    it('Given packChecksum of wrong length, When serializing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const entries = [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 12 }];
      const packChecksum = new Uint8Array(10);

      // Act & Assert
      try {
        serializePackIndex(entries, packChecksum);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('packChecksum'),
          }),
        );
      }
    });

    it('Given 0 entries, When serializing, Then produces valid index with objectCount=0', () => {
      // Arrange
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex([], packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);

      // Assert
      const idx = parsePackIndex(withTrailer);
      expect(idx.objectCount).toBe(0);
    });

    it('Given 3 known entries, When serializing then parsing, Then lookupPackIndex finds each at correct offset', () => {
      // Arrange
      const entries = [
        { id: 'aa' + '00'.repeat(19), crc32: 111, offset: 12 },
        { id: 'bb' + '00'.repeat(19), crc32: 222, offset: 100 },
        { id: 'cc' + '00'.repeat(19), crc32: 333, offset: 200 },
      ];
      const packChecksum = new Uint8Array(20);

      // Act
      const sut = serializePackIndex(entries, packChecksum);
      const withTrailer = new Uint8Array(sut.length + 20);
      withTrailer.set(sut);
      const idx = parsePackIndex(withTrailer);

      // Assert
      for (const entry of entries) {
        expect(lookupPackIndex(idx, entry.id as ObjectId)).toBe(entry.offset);
      }
    });
  });

  describe('property-based tests', () => {
    it('Given any entries, When serializing pack, Then parsePackHeader count matches', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 10 }), (count) => {
          // Arrange
          const entries = Array.from({ length: count }, () =>
            makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array(10)),
          );

          // Act
          const sut = serializePackfile(entries);

          // Assert
          const header = parsePackHeader(sut.data);
          expect(header.objectCount).toBe(count);
        }),
      );
    });

    it('Given any entries, When serializing index then parsing, Then lookupPackIndex finds every entry', () => {
      fc.assert(
        fc.property(arbUniqueIndexEntries(8), (entries) => {
          fc.pre(entries.length > 0);
          const packChecksum = new Uint8Array(20);
          const serialized = serializePackIndex(entries, packChecksum);
          const withTrailer = new Uint8Array(serialized.length + 20);
          withTrailer.set(serialized);
          const idx = parsePackIndex(withTrailer);

          for (const entry of entries) {
            expect(lookupPackIndex(idx, entry.id as ObjectId)).toBe(entry.offset);
          }
        }),
      );
    });

    it('Given any pack entries, When serializing, Then CRC-32 matches independently computed value', () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(
              fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<1 | 2 | 3 | 4>,
              fc.uint8Array({ minLength: 1, maxLength: 50 }),
            ),
            { minLength: 1, maxLength: 5 },
          ),
          (entryDefs) => {
            const entries = entryDefs.map(([type, data]) => makeEntry(type, data));
            const result = serializePackfile(entries);

            for (let i = 0; i < entries.length; i++) {
              const entry = entries[i]!;
              const entryHeader = encodePackEntryHeader(entry.type, entry.uncompressedSize);
              const combined = new Uint8Array(entryHeader.length + entry.compressedData.length);
              combined.set(entryHeader);
              combined.set(entry.compressedData, entryHeader.length);
              expect(result.entries[i]!.crc32).toBe(crc32(combined));
            }
          },
        ),
      );
    });
  });
});
