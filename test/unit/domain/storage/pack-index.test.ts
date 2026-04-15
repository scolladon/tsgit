import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  findByPrefix,
  lookupPackIndex,
  parsePackIndex,
} from '../../../../src/domain/storage/pack-index.js';
import { arbObjectId, buildTestIndex, type TestIndexEntry } from './arbitraries.js';

function makeEntry(id: string, offset: number, crc32 = 0): TestIndexEntry {
  return { id: id as ObjectId, offset, crc32 };
}

function dedupeEntries(
  tuples: ReadonlyArray<readonly [ObjectId, number, number]>,
): TestIndexEntry[] {
  const seen = new Set<string>();
  const entries: TestIndexEntry[] = [];
  for (const [id, offset, crc32] of tuples) {
    if (!seen.has(id)) {
      seen.add(id);
      entries.push({ id, offset, crc32 });
    }
  }
  return entries;
}

function arbUniqueEntries(maxLen: number): fc.Arbitrary<TestIndexEntry[]> {
  return fc
    .array(
      fc.tuple(
        arbObjectId(40),
        fc.integer({ min: 0, max: 2 ** 30 }),
        fc.integer({ min: 0, max: 0xffffffff }),
      ),
      { minLength: 1, maxLength: maxLen },
    )
    .map(dedupeEntries);
}

describe('pack-index', () => {
  describe('parsePackIndex', () => {
    it('Given a valid .idx v2 with 0 objects, When parsing, Then objectCount=0', () => {
      // Arrange
      const sut = buildTestIndex([]);

      // Act
      const result = parsePackIndex(sut);

      // Assert
      expect(result.objectCount).toBe(0);
    });

    it('Given a valid .idx v2 with 3 objects, When parsing, Then objectCount=3', () => {
      // Arrange
      const entries: TestIndexEntry[] = [
        makeEntry('aa' + '00'.repeat(19), 100),
        makeEntry('bb' + '00'.repeat(19), 200),
        makeEntry('cc' + '00'.repeat(19), 300),
      ];
      const sut = buildTestIndex(entries);

      // Act
      const result = parsePackIndex(sut);

      // Assert
      expect(result.objectCount).toBe(3);
    });

    it('Given wrong magic bytes, When parsing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const sut = buildTestIndex([]);
      const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
      view.setUint32(0, 0xdeadbeef);

      // Act & Assert
      try {
        parsePackIndex(sut);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('magic'),
          }),
        );
      }
    });

    it('Given version != 2, When parsing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const sut = buildTestIndex([]);
      const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
      view.setUint32(4, 3);

      // Act & Assert
      try {
        parsePackIndex(sut);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('version'),
          }),
        );
      }
    });

    it('Given non-monotonic fanout, When parsing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const sut = buildTestIndex([]);
      const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
      // Make fanout[1] < fanout[0]
      view.setUint32(8 + 0 * 4, 5);
      view.setUint32(8 + 1 * 4, 3);

      // Act & Assert
      try {
        parsePackIndex(sut);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('non-monotonic'),
          }),
        );
      }
    });

    it('Given truncated file (too short), When parsing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const sut = new Uint8Array(100);

      // Act & Assert
      try {
        parsePackIndex(sut);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('truncated'),
          }),
        );
      }
    });
  });

  describe('lookupPackIndex', () => {
    it('Given an index with 3 known objects, When looking up existing id, Then returns correct offset', () => {
      // Arrange
      const entries: TestIndexEntry[] = [
        makeEntry('aa' + '00'.repeat(19), 100),
        makeEntry('bb' + '00'.repeat(19), 200),
        makeEntry('cc' + '00'.repeat(19), 300),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = lookupPackIndex(idx, ('bb' + '00'.repeat(19)) as ObjectId);

      // Assert
      expect(sut).toBe(200);
    });

    it('Given an index with 3 known objects, When looking up non-existent id, Then returns undefined', () => {
      // Arrange
      const entries: TestIndexEntry[] = [
        makeEntry('aa' + '00'.repeat(19), 100),
        makeEntry('bb' + '00'.repeat(19), 200),
        makeEntry('cc' + '00'.repeat(19), 300),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = lookupPackIndex(idx, ('dd' + '00'.repeat(19)) as ObjectId);

      // Assert
      expect(sut).toBeUndefined();
    });

    it('Given an index with objects starting with byte 0x00, When looking up, Then fanout edge case works', () => {
      // Arrange
      const entries: TestIndexEntry[] = [makeEntry('00' + 'aa'.repeat(19), 42)];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = lookupPackIndex(idx, ('00' + 'aa'.repeat(19)) as ObjectId);

      // Assert
      expect(sut).toBe(42);
    });

    it('Given an index with objects starting with byte 0xFF, When looking up, Then fanout edge case works', () => {
      // Arrange
      const entries: TestIndexEntry[] = [makeEntry('ff' + '00'.repeat(19), 99)];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = lookupPackIndex(idx, ('ff' + '00'.repeat(19)) as ObjectId);

      // Assert
      expect(sut).toBe(99);
    });

    it('Given an index with large offsets (MSB set), When looking up, Then reads from 64-bit offset table', () => {
      // Arrange
      const largeOffset = 0x80000001;
      const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), largeOffset)];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);

      // Assert
      expect(sut).toBe(largeOffset);
    });
  });

  describe('findByPrefix', () => {
    const entries: TestIndexEntry[] = [
      makeEntry('aabb' + '00'.repeat(18), 100),
      makeEntry('aacc' + '00'.repeat(18), 200),
      makeEntry('bbdd' + '00'.repeat(18), 300),
    ];

    it('Given 3 objects, When searching prefix matching exactly 1, Then returns array of 1', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, 'bbdd');

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]).toBe('bbdd' + '00'.repeat(18));
    });

    it('Given 3 objects, When searching prefix matching 0, Then returns empty array', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, 'ccee');

      // Assert
      expect(sut).toHaveLength(0);
    });

    it('Given objects sharing a 4-char prefix, When searching with that prefix, Then returns all matches', () => {
      // Arrange
      const sharedEntries: TestIndexEntry[] = [
        makeEntry('aabb' + '00'.repeat(18), 100),
        makeEntry('aabb' + 'ff'.repeat(18), 200),
        makeEntry('bbdd' + '00'.repeat(18), 300),
      ];
      const idx = parsePackIndex(buildTestIndex(sharedEntries));

      // Act
      const sut = findByPrefix(idx, 'aabb');

      // Assert
      expect(sut).toHaveLength(2);
    });

    it('Given prefix shorter than 4 chars, When searching, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act & Assert
      try {
        findByPrefix(idx, 'abc');
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('too short'),
          }),
        );
      }
    });

    it('Given prefix longer than 40 chars, When searching, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act & Assert
      try {
        findByPrefix(idx, 'a'.repeat(41));
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('too long'),
          }),
        );
      }
    });

    it('Given prefix with non-hex chars, When searching, Then throws INVALID_PACK_INDEX', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act & Assert
      try {
        findByPrefix(idx, 'gggg');
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('non-hex'),
          }),
        );
      }
    });

    it("Given odd-length prefix 'aabb0', When searching, Then correctly handles odd length", () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, 'aabb0');

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]).toBe('aabb' + '00'.repeat(18));
    });

    it('Given even-length prefix (6 chars) matching 1 object, When searching, Then returns that object', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, 'aabb00');

      // Assert
      expect(sut).toHaveLength(1);
    });

    it('Given full 40-char id, When searching, Then returns 0 or 1 match', () => {
      // Arrange
      const idx = parsePackIndex(buildTestIndex(entries));
      const fullId = 'aabb' + '00'.repeat(18);

      // Act
      const sut = findByPrefix(idx, fullId);

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]).toBe(fullId);
    });
  });

  describe('parsePackIndex — truncated with valid header', () => {
    it('Given valid header but objectCount too large for file, When parsing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange — build an index for 3 objects, then truncate it
      const entries: TestIndexEntry[] = [
        makeEntry('aa' + '00'.repeat(19), 100),
        makeEntry('bb' + '00'.repeat(19), 200),
        makeEntry('cc' + '00'.repeat(19), 300),
      ];
      const fullIndex = buildTestIndex(entries);
      // Truncate: keep header + fanout + partial SHA table
      const sut = fullIndex.subarray(0, 1032 + 20); // header(8) + fanout(1024) + 1 SHA (too few)

      // Act & Assert
      try {
        parsePackIndex(sut);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('truncated'),
          }),
        );
      }
    });

    it('Given file exactly 1 byte too short for declared objectCount, When parsing, Then throws INVALID_PACK_INDEX', () => {
      // Arrange — build valid index then shorten by 1 byte
      const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), 100)];
      const fullIndex = buildTestIndex(entries);
      const sut = fullIndex.subarray(0, fullIndex.length - 1);

      // Act & Assert
      try {
        parsePackIndex(sut);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('truncated'),
          }),
        );
      }
    });
  });

  describe('lookupPackIndex — large offset table', () => {
    it('Given multiple large offsets, When looking up each, Then reads correct 64-bit offsets', () => {
      // Arrange — 3 large offsets
      const entries: TestIndexEntry[] = [
        makeEntry('aa' + '00'.repeat(19), 0x80000001),
        makeEntry('bb' + '00'.repeat(19), 0x80000002),
        makeEntry('cc' + '00'.repeat(19), 0x90000000),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act & Assert
      expect(lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId)).toBe(0x80000001);
      expect(lookupPackIndex(idx, ('bb' + '00'.repeat(19)) as ObjectId)).toBe(0x80000002);
      expect(lookupPackIndex(idx, ('cc' + '00'.repeat(19)) as ObjectId)).toBe(0x90000000);
    });

    it('Given offset > 2^32 (needs both high and low words), When looking up, Then reads correct 64-bit value', () => {
      // Arrange — offset = 0x1_00000001 (high=1, low=1)
      const largeOffset = 0x100000001;
      const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), largeOffset)];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);

      // Assert
      expect(sut).toBe(largeOffset);
    });
  });

  describe('lookupPackIndex — security guards', () => {
    it('Given crafted index with largeIdx pointing past large offset table, When looking up, Then throws INVALID_PACK_INDEX', () => {
      // Arrange — build index with 1 entry that has MSB set in small offset,
      // but largeIdx points to non-existent large offset entry
      const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), 42)];
      const idx = parsePackIndex(buildTestIndex(entries));
      // Corrupt the small offset table to have MSB set with a huge largeIdx
      const offsetStart = idx.smallOffsetsTableOffset;
      idx._view.setUint32(offsetStart, 0x80000000 | 999);

      // Act & Assert
      try {
        lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('out of range'),
          }),
        );
      }
    });

    it('Given index with offset requiring high word > 0x1fffff, When looking up, Then throws INVALID_PACK_INDEX', () => {
      // Arrange — build index with a large offset, then corrupt the high word
      const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), 0x80000001)];
      const idx = parsePackIndex(buildTestIndex(entries));
      // Find the large offset table and set high word to exceed safe range
      const largeOffset = idx.largeOffsetsTableOffset;
      idx._view.setUint32(largeOffset, 0x200000);

      // Act & Assert
      try {
        lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);
        expect.fail('Should have thrown');
      } catch (e) {
        const err = e as TsgitError;
        expect(err.data).toEqual(
          expect.objectContaining({
            code: 'INVALID_PACK_INDEX',
            reason: expect.stringContaining('safe JavaScript number range'),
          }),
        );
      }
    });
  });

  describe('lookupPackIndex — binary search branches', () => {
    it('Given many entries in same fanout bucket, When looking up last entry, Then exercises cmp < 0 branch', () => {
      // Arrange — multiple entries with same first byte to force deep binary search
      const entries: TestIndexEntry[] = [
        makeEntry('aa00' + '00'.repeat(18), 10),
        makeEntry('aa11' + '00'.repeat(18), 20),
        makeEntry('aa22' + '00'.repeat(18), 30),
        makeEntry('aa33' + '00'.repeat(18), 40),
        makeEntry('aaff' + '00'.repeat(18), 50),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act — looking up the last one forces multiple cmp < 0 iterations
      const sut = lookupPackIndex(idx, ('aaff' + '00'.repeat(18)) as ObjectId);

      // Assert
      expect(sut).toBe(50);
    });
  });

  describe('findByPrefix — binary search branches', () => {
    it('Given many entries in same fanout bucket, When searching prefix matching later ones, Then exercises lowerBound cmp < 0', () => {
      // Arrange
      const entries: TestIndexEntry[] = [
        makeEntry('aa00' + '00'.repeat(18), 10),
        makeEntry('aa11' + '00'.repeat(18), 20),
        makeEntry('aa22' + '00'.repeat(18), 30),
        makeEntry('aaff' + '00'.repeat(18), 40),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, 'aaff');

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]).toBe('aaff' + '00'.repeat(18));
    });
  });

  describe('findByPrefix — edge case first byte 0x00', () => {
    it('Given prefix starting with 00, When searching, Then handles firstByte === 0 branch', () => {
      // Arrange
      const entries: TestIndexEntry[] = [
        makeEntry('00aa' + '00'.repeat(18), 100),
        makeEntry('00bb' + '00'.repeat(18), 200),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, '00aa');

      // Assert
      expect(sut).toHaveLength(1);
      expect(sut[0]).toBe('00aa' + '00'.repeat(18));
    });
  });

  describe('findByPrefix — minimum 4-char prefix with shared prefix objects', () => {
    it('Given objects sharing a 4-char prefix, When searching with that prefix, Then returns all matches', () => {
      // Arrange
      const entries: TestIndexEntry[] = [
        makeEntry('aabb' + '00'.repeat(18), 100),
        makeEntry('aabb' + 'ff'.repeat(18), 200),
        makeEntry('bbdd' + '00'.repeat(18), 300),
      ];
      const idx = parsePackIndex(buildTestIndex(entries));

      // Act
      const sut = findByPrefix(idx, 'aabb');

      // Assert
      expect(sut).toHaveLength(2);
    });
  });

  describe('property-based tests', () => {
    it('Given any set of entries, When building index and looking up each, Then finds correct offset', () => {
      fc.assert(
        fc.property(arbUniqueEntries(10), (entries) => {
          fc.pre(entries.length > 0);
          const idx = parsePackIndex(buildTestIndex(entries));
          for (const entry of entries) {
            expect(lookupPackIndex(idx, entry.id)).toBe(entry.offset);
          }
        }),
      );
    });

    it('Given any ObjectId not in the index, When looking up, Then returns undefined', () => {
      fc.assert(
        fc.property(arbObjectId(40), arbObjectId(40), (indexId, lookupId) => {
          fc.pre(indexId !== lookupId);
          const entries: TestIndexEntry[] = [{ id: indexId, offset: 42, crc32: 0 }];
          const idx = parsePackIndex(buildTestIndex(entries));

          const sut = lookupPackIndex(idx, lookupId);

          expect(sut).toBeUndefined();
        }),
      );
    });
  });
});
