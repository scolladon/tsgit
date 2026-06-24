import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId } from '../../../../src/domain/objects/object-id.js';
import {
  allObjectIds,
  entryOffsets,
  findByPrefix,
  lookupPackIndex,
  parsePackIndex,
} from '../../../../src/domain/storage/pack-index.js';
import { arbObjectId, buildTestIndex, type TestIndexEntry } from './arbitraries.js';

// Property test skipped: entryOffsets is a thin loop whose only invariant is
// result.length === index.objectCount. A property oracle would tautologically
// re-implement the SUT loop (iterate readOffset for all i), making it a
// tautology rather than an independent property proof.

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

const IDX_HEADER_SIZE = 8;
const IDX_FANOUT_SIZE = 1024;
const IDX_MIN_SIZE = IDX_HEADER_SIZE + IDX_FANOUT_SIZE; // 1032

// Builds a structurally-valid index of `byteLength` total bytes whose 256
// fanout slots are all set to `fanoutValue` (a constant fanout is monotonic).
// Lets a test control `bytes.length` and `objectCount` independently of the
// SHA/offset tables — needed to probe the size-guard boundary mutants.
function buildRawIndex(byteLength: number, fanoutValue: number): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xff744f63);
  view.setUint32(4, 2);
  for (let i = 0; i < 256; i++) {
    view.setUint32(IDX_HEADER_SIZE + i * 4, fanoutValue);
  }
  return bytes;
}

describe('pack-index', () => {
  describe('parsePackIndex', () => {
    describe('Given a valid .idx v2 with 0 objects', () => {
      describe('When parsing', () => {
        it('Then objectCount=0', () => {
          // Arrange
          const sut = buildTestIndex([]);

          // Act
          const result = parsePackIndex(sut);

          // Assert
          expect(result.objectCount).toBe(0);
        });
      });
    });

    describe('Given a valid .idx v2 with 3 objects', () => {
      describe('When parsing', () => {
        it('Then objectCount=3', () => {
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
      });
    });

    describe('Given wrong magic bytes', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const sut = buildTestIndex([]);
          const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
          view.setUint32(0, 0xdeadbeef);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
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
      });
    });

    describe('Given version != 2', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const sut = buildTestIndex([]);
          const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
          view.setUint32(4, 3);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
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
      });
    });

    describe('Given non-monotonic fanout', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const sut = buildTestIndex([]);
          const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
          // Make fanout[1] < fanout[0]
          view.setUint32(8 + 0 * 4, 5);
          view.setUint32(8 + 1 * 4, 3);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
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
      });
    });

    describe('Given truncated file (too short)', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const sut = new Uint8Array(100);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
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
    });
  });

  describe('lookupPackIndex', () => {
    describe('Given an index with 3 known objects', () => {
      describe('When looking up existing id', () => {
        it('Then returns correct offset', () => {
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
      });
      describe('When looking up non-existent id', () => {
        it('Then returns undefined', () => {
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
      });
    });

    describe('Given an index with objects starting with byte 0x00', () => {
      describe('When looking up', () => {
        it('Then fanout edge case works', () => {
          // Arrange
          const entries: TestIndexEntry[] = [makeEntry('00' + 'aa'.repeat(19), 42)];
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = lookupPackIndex(idx, ('00' + 'aa'.repeat(19)) as ObjectId);

          // Assert
          expect(sut).toBe(42);
        });
      });
    });

    describe('Given an index with objects starting with byte 0xFF', () => {
      describe('When looking up', () => {
        it('Then fanout edge case works', () => {
          // Arrange
          const entries: TestIndexEntry[] = [makeEntry('ff' + '00'.repeat(19), 99)];
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = lookupPackIndex(idx, ('ff' + '00'.repeat(19)) as ObjectId);

          // Assert
          expect(sut).toBe(99);
        });
      });
    });

    describe('Given an index with large offsets (MSB set)', () => {
      describe('When looking up', () => {
        it('Then reads from 64-bit offset table', () => {
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
    });
  });

  describe('findByPrefix', () => {
    const entries: TestIndexEntry[] = [
      makeEntry('aabb' + '00'.repeat(18), 100),
      makeEntry('aacc' + '00'.repeat(18), 200),
      makeEntry('bbdd' + '00'.repeat(18), 300),
    ];

    describe('Given 3 objects', () => {
      describe('When searching prefix matching exactly 1', () => {
        it('Then returns array of 1', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = findByPrefix(idx, 'bbdd');

          // Assert
          expect(sut).toHaveLength(1);
          expect(sut[0]).toBe('bbdd' + '00'.repeat(18));
        });
      });
      describe('When searching prefix matching 0', () => {
        it('Then returns empty array', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = findByPrefix(idx, 'ccee');

          // Assert
          expect(sut).toHaveLength(0);
        });
      });
    });

    describe('Given objects sharing a 4-char prefix', () => {
      describe('When searching with that prefix', () => {
        it('Then returns all matches', () => {
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
      });
    });

    describe('Given prefix shorter than 4 chars', () => {
      describe('When searching', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act & Assert
          try {
            findByPrefix(idx, 'abc');
            // Assert
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
      });
    });

    describe('Given prefix longer than 40 chars', () => {
      describe('When searching', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act & Assert
          try {
            findByPrefix(idx, 'a'.repeat(41));
            // Assert
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
      });
    });

    describe('Given prefix with non-hex chars', () => {
      describe('When searching', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act & Assert
          try {
            findByPrefix(idx, 'gggg');
            // Assert
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
      });
    });

    describe("Given odd-length prefix 'aabb0'", () => {
      describe('When searching', () => {
        it('Then correctly handles odd length', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = findByPrefix(idx, 'aabb0');

          // Assert
          expect(sut).toHaveLength(1);
          expect(sut[0]).toBe('aabb' + '00'.repeat(18));
        });
      });
    });

    describe('Given even-length prefix (6 chars) matching 1 object', () => {
      describe('When searching', () => {
        it('Then returns that object', () => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = findByPrefix(idx, 'aabb00');

          // Assert
          expect(sut).toHaveLength(1);
        });
      });
    });

    describe('Given full 40-char id', () => {
      describe('When searching', () => {
        it('Then returns 0 or 1 match', () => {
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
    });
  });

  describe('entryOffsets', () => {
    describe('Given a pack index with 0 entries', () => {
      describe('When entryOffsets is called', () => {
        it('Then returns an empty array', () => {
          // Arrange
          const index = parsePackIndex(buildTestIndex([]));
          const sut = entryOffsets;

          // Act
          const result = sut(index);

          // Assert
          expect(result).toEqual([]);
          expect(result.length).toBe(0);
        });
      });
    });

    describe('Given a pack index with 3 entries at known offsets', () => {
      describe('When entryOffsets is called', () => {
        it('Then returns all 3 offsets in index order', () => {
          // Arrange
          const entries: TestIndexEntry[] = [
            makeEntry('aa' + '00'.repeat(19), 100),
            makeEntry('bb' + '00'.repeat(19), 200),
            makeEntry('cc' + '00'.repeat(19), 300),
          ];
          const index = parsePackIndex(buildTestIndex(entries));
          const sut = entryOffsets;

          // Act
          const result = sut(index);

          // Assert
          expect(result.length).toBe(3);
          expect(result[0]).toBe(100);
          expect(result[1]).toBe(200);
          expect(result[2]).toBe(300);
        });
      });
    });

    describe('Given a pack index with 1 entry whose small-offset slot has MSB set (large-offset table)', () => {
      describe('When entryOffsets is called', () => {
        it('Then returns the large offset value correctly', () => {
          // Arrange
          const entries: TestIndexEntry[] = [
            { id: '00'.repeat(20) as ObjectId, offset: 0x200000000, crc32: 0 },
          ];
          const index = parsePackIndex(buildTestIndex(entries));
          const sut = entryOffsets;

          // Act
          const result = sut(index);

          // Assert
          expect(result.length).toBe(1);
          expect(result[0]).toBe(0x200000000);
        });
      });
    });
  });

  describe('parsePackIndex — truncated with valid header', () => {
    describe('Given valid header but objectCount too large for file', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
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
            // Assert
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
    });

    describe('Given file exactly 1 byte too short for declared objectCount', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange — build valid index then shorten by 1 byte
          const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), 100)];
          const fullIndex = buildTestIndex(entries);
          const sut = fullIndex.subarray(0, fullIndex.length - 1);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
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
    });
  });

  describe('lookupPackIndex — large offset table', () => {
    describe('Given multiple large offsets', () => {
      describe('When looking up each', () => {
        it('Then reads correct 64-bit offsets', () => {
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
      });
    });

    describe('Given offset > 2^32 (needs both high and low words)', () => {
      describe('When looking up', () => {
        it('Then reads correct 64-bit value', () => {
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
    });
  });

  describe('lookupPackIndex — security guards', () => {
    describe('Given crafted index with largeIdx pointing past large offset table', () => {
      describe('When looking up', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
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
            // Assert
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
      });
    });

    describe('Given index with offset requiring high word > 0x1fffff', () => {
      describe('When looking up', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange — build index with a large offset, then corrupt the high word
          const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), 0x80000001)];
          const idx = parsePackIndex(buildTestIndex(entries));
          // Find the large offset table and set high word to exceed safe range
          const largeOffset = idx.largeOffsetsTableOffset;
          idx._view.setUint32(largeOffset, 0x200000);

          // Act & Assert
          try {
            lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);
            // Assert
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
    });
  });

  describe('lookupPackIndex — binary search branches', () => {
    describe('Given many entries in same fanout bucket', () => {
      describe('When looking up last entry', () => {
        it('Then exercises cmp < 0 branch', () => {
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
    });
  });

  describe('findByPrefix — binary search branches', () => {
    describe('Given many entries in same fanout bucket', () => {
      describe('When searching prefix matching later ones', () => {
        it('Then exercises lowerBound cmp < 0', () => {
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
    });
  });

  describe('findByPrefix — edge case first byte 0x00', () => {
    describe('Given prefix starting with 00', () => {
      describe('When searching', () => {
        it('Then handles firstByte === 0 branch', () => {
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
    });
  });

  describe('findByPrefix — minimum 4-char prefix with shared prefix objects', () => {
    describe('Given objects sharing a 4-char prefix', () => {
      describe('When searching with that prefix', () => {
        it('Then returns all matches', () => {
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
    });
  });

  describe('parsePackIndex — size-guard boundary mutants', () => {
    describe('Given a file of exactly minSize (1032) bytes', () => {
      describe('When parsing', () => {
        it('Then the header/fanout guard does not fire — the later truncation guard reports the expected size instead', () => {
          // Arrange — exactly header(8)+fanout(1024) bytes, objectCount 0. The
          // `bytes.length < minSize` guard must be a strict `<`: at length === 1032
          // it must pass and let the second guard report `expected at least 1072`.
          // A `<=` mutant would short-circuit here with the 'header and fanout'
          // reason instead.
          const sut = buildRawIndex(IDX_MIN_SIZE, 0);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_INDEX',
                reason: expect.stringContaining('expected at least 1072'),
              }),
            );
            expect((err.data as { reason: string }).reason).not.toContain('header and fanout');
          }
        });
      });
    });

    describe('Given a magic value whose hex is shorter than 8 chars', () => {
      describe('When parsing', () => {
        it('Then the reason zero-pads it to 8 digits', () => {
          // Arrange — magic 0x00744f63 hexes to '744f63' (6 chars); the padStart
          // pad char must be '0'. A `padStart(8, "")` mutant would leave it
          // unpadded ('0x744f63'), so we assert the fully padded form.
          const sut = buildRawIndex(IDX_MIN_SIZE + 40, 0);
          const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
          view.setUint32(0, 0x00744f63);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect((err.data as { reason: string }).reason).toContain('got 0x00744f63');
          }
        });
      });
    });

    describe('Given a fanout that is monotonic across all 256 slots', () => {
      describe('When parsing', () => {
        it('Then the monotonicity loop stops at index 255 and never inspects index 256', () => {
          // Arrange — all 256 fanout slots equal 5, so objectCount is 5 and the
          // word just past the fanout (offset 1032, here trailer zeros) is 0.
          // The loop bound must be `i < 256`: an `i <= 256` mutant would read that
          // 0 word and report a spurious 'non-monotonic fanout at index 256'
          // (0 < prev=5). The correct code instead reaches the truncation guard.
          const sut = buildRawIndex(IDX_MIN_SIZE + 40, 5);

          // Act & Assert
          try {
            parsePackIndex(sut);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect((err.data as { reason: string }).reason).toContain('truncated');
            expect((err.data as { reason: string }).reason).not.toContain('non-monotonic');
          }
        });
      });
    });
  });

  describe('readOffset — large-offset arithmetic mutants', () => {
    describe('Given a large offset whose entry sits one slot past the table', () => {
      describe('When looking up', () => {
        it('Then trailerOffset (length - 40) rejects it as out of range', () => {
          // Arrange — 1 entry, 1 large-offset slot. trailerOffset === 1068.
          // Corrupt the small offset to largeIdx=1 → largeOffset === 1068, so
          // largeOffset + 8 === 1076 > 1068 must throw. The `length - 40` arithmetic
          // is load-bearing: a `length + 40` mutant raises trailerOffset to 1148
          // and the guard would wrongly pass.
          const entries: TestIndexEntry[] = [makeEntry('aa' + '00'.repeat(19), 0x80000001)];
          const idx = parsePackIndex(buildTestIndex(entries));
          idx._view.setUint32(idx.smallOffsetsTableOffset, 0x80000000 | 1);

          // Act & Assert
          try {
            lookupPackIndex(idx, ('aa' + '00'.repeat(19)) as ObjectId);
            // Assert
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
      });
    });

    describe('Given a large offset entry exactly at the trailer boundary', () => {
      describe('When looking up', () => {
        it('Then the `largeOffset + 8` bound check rejects it', () => {
          // Arrange — corrupt small offset to largeIdx=1 so largeOffset === 1068
          // and trailerOffset === 1068. The guard `largeOffset + 8 > trailerOffset`
          // (1076 > 1068) must throw; a `largeOffset - 8` mutant computes
          // 1060 > 1068 (false) and would wrongly proceed.
          const entries: TestIndexEntry[] = [makeEntry('bb' + '00'.repeat(19), 0x80000001)];
          const idx = parsePackIndex(buildTestIndex(entries));
          idx._view.setUint32(idx.smallOffsetsTableOffset, 0x80000000 | 1);

          // Act & Assert
          try {
            lookupPackIndex(idx, ('bb' + '00'.repeat(19)) as ObjectId);
            // Assert
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
      });
    });

    describe('Given a large offset whose high word is exactly 0x1fffff', () => {
      describe('When looking up', () => {
        it('Then it is accepted (not rejected)', () => {
          // Arrange — high word === 0x1fffff is the largest still-safe value. The
          // guard must be a strict `high > 0x1fffff`: a `>=` mutant would reject
          // this valid offset.
          const entries: TestIndexEntry[] = [makeEntry('cc' + '00'.repeat(19), 0x80000001)];
          const idx = parsePackIndex(buildTestIndex(entries));
          idx._view.setUint32(idx.largeOffsetsTableOffset, 0x1fffff);
          idx._view.setUint32(idx.largeOffsetsTableOffset + 4, 7);

          // Act
          const sut = lookupPackIndex(idx, ('cc' + '00'.repeat(19)) as ObjectId);

          // Assert
          expect(sut).toBe(0x1fffff * 0x100000000 + 7);
        });
      });
    });
  });

  describe('fanout `lo` lower bound — optimization-only mutants', () => {
    describe('Given a non-zero first byte whose predecessor fanout is non-zero', () => {
      describe('When looking up', () => {
        it('Then the result matches a from-zero search', () => {
          // Arrange
          // The `firstByte === 0 ? 0 : readFanout(firstByte - 1)` ternary only
          // narrows the binary-search window; the search over [0, hi) finds the
          // same entry. This regression test pins that the optimized `lo` and a
          // from-zero search agree, documenting why the ConditionalExpression
          // mutant (`lo` forced to 0) is observably equivalent.
          const entries: TestIndexEntry[] = [
            makeEntry('11' + '00'.repeat(19), 10),
            makeEntry('22' + '00'.repeat(19), 20),
            makeEntry('33' + '00'.repeat(19), 30),
          ];
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = lookupPackIndex(idx, ('33' + '00'.repeat(19)) as ObjectId);

          // Assert
          expect(sut).toBe(30);
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any set of entries', () => {
      describe('When building index and looking up each', () => {
        it('Then finds correct offset', () => {
          // Arrange + Assert
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
      });
    });

    describe('Given any ObjectId not in the index', () => {
      describe('When looking up', () => {
        it('Then returns undefined', () => {
          // Arrange + Assert
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
  });

  describe('allObjectIds', () => {
    describe('Given an empty pack index', () => {
      describe('When allObjectIds is called', () => {
        it('Then returns an empty array', () => {
          // Arrange
          const index = parsePackIndex(buildTestIndex([]));
          const sut = allObjectIds;

          // Act
          const result = sut(index);

          // Assert
          expect(result).toEqual([]);
        });
      });
    });

    describe('Given a pack index with three objects', () => {
      describe('When allObjectIds is called', () => {
        it('Then returns all object ids in index order', () => {
          // Arrange
          const entries: TestIndexEntry[] = [
            makeEntry('aa' + '00'.repeat(19), 100),
            makeEntry('bb' + '00'.repeat(19), 200),
            makeEntry('cc' + '00'.repeat(19), 300),
          ];
          const index = parsePackIndex(buildTestIndex(entries));
          const sut = allObjectIds;

          // Act
          const result = sut(index);

          // Assert — ids are returned in the same order the index stores them
          // (sorted by sha: aa… < bb… < cc…)
          expect(result).toHaveLength(3);
          expect(result[0]).toBe('aa' + '00'.repeat(19));
          expect(result[1]).toBe('bb' + '00'.repeat(19));
          expect(result[2]).toBe('cc' + '00'.repeat(19));
        });
      });
    });
  });
});
