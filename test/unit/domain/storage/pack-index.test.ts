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

function corruptTestIndex(patch: (view: DataView) => void): Uint8Array {
  const bytes = buildTestIndex([]);
  patch(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return bytes;
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
    describe('Given a valid .idx v2', () => {
      describe('When parsing', () => {
        it.each([
          { entries: [] as TestIndexEntry[], expectedCount: 0, label: '0 objects' },
          {
            entries: [
              makeEntry('aa' + '00'.repeat(19), 100),
              makeEntry('bb' + '00'.repeat(19), 200),
              makeEntry('cc' + '00'.repeat(19), 300),
            ],
            expectedCount: 3,
            label: '3 objects',
          },
        ])('Then objectCount=$expectedCount for $label', ({ entries, expectedCount }) => {
          // Arrange
          const sut = buildTestIndex(entries);

          // Act
          const result = parsePackIndex(sut);

          // Assert
          expect(result.objectCount).toBe(expectedCount);
        });
      });
    });

    describe('Given malformed index bytes', () => {
      describe('When parsing', () => {
        it.each([
          {
            bytes: corruptTestIndex((v) => v.setUint32(0, 0xdeadbeef)),
            reasonContains: 'magic',
            label: 'wrong magic bytes',
          },
          {
            bytes: corruptTestIndex((v) => v.setUint32(4, 3)),
            reasonContains: 'version',
            label: 'version != 2',
          },
          {
            // Make fanout[1] < fanout[0]
            bytes: corruptTestIndex((v) => {
              v.setUint32(8 + 0 * 4, 5);
              v.setUint32(8 + 1 * 4, 3);
            }),
            reasonContains: 'non-monotonic',
            label: 'non-monotonic fanout',
          },
          {
            bytes: new Uint8Array(100),
            reasonContains: 'truncated',
            label: 'a truncated file (too short)',
          },
        ])('Then throws INVALID_PACK_INDEX for $label', ({ bytes, reasonContains }) => {
          // Arrange + Act & Assert
          try {
            parsePackIndex(bytes);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_INDEX',
                reason: expect.stringContaining(reasonContains),
              }),
            );
          }
        });
      });
    });
  });

  describe('lookupPackIndex', () => {
    describe('Given an index with a known-offset entry', () => {
      describe('When looking up existing id', () => {
        it.each([
          {
            entries: [
              makeEntry('aa' + '00'.repeat(19), 100),
              makeEntry('bb' + '00'.repeat(19), 200),
              makeEntry('cc' + '00'.repeat(19), 300),
            ],
            lookupId: 'bb' + '00'.repeat(19),
            expected: 200,
            label: 'an existing id among 3 known objects',
          },
          {
            entries: [makeEntry('00' + 'aa'.repeat(19), 42)],
            lookupId: '00' + 'aa'.repeat(19),
            expected: 42,
            label: 'an object starting with byte 0x00 (fanout edge)',
          },
          {
            entries: [makeEntry('ff' + '00'.repeat(19), 99)],
            lookupId: 'ff' + '00'.repeat(19),
            expected: 99,
            label: 'an object starting with byte 0xFF (fanout edge)',
          },
          {
            entries: [makeEntry('aa' + '00'.repeat(19), 0x80000001)],
            lookupId: 'aa' + '00'.repeat(19),
            expected: 0x80000001,
            label: 'a large offset (MSB set, 64-bit offset table)',
          },
        ])('Then returns $expected for $label', ({ entries, lookupId, expected }) => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = lookupPackIndex(idx, lookupId as ObjectId);

          // Assert
          expect(sut).toBe(expected);
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
  });

  describe('findByPrefix', () => {
    const entries: TestIndexEntry[] = [
      makeEntry('aabb' + '00'.repeat(18), 100),
      makeEntry('aacc' + '00'.repeat(18), 200),
      makeEntry('bbdd' + '00'.repeat(18), 300),
    ];

    describe('Given a prefix matching exactly 1 object', () => {
      describe('When searching', () => {
        it.each([
          { prefix: 'bbdd', expected: 'bbdd' + '00'.repeat(18), label: 'a 4-char prefix' },
          { prefix: 'aabb0', expected: 'aabb' + '00'.repeat(18), label: 'an odd-length prefix' },
          {
            prefix: 'aabb' + '00'.repeat(18),
            expected: 'aabb' + '00'.repeat(18),
            label: 'a full 40-char id',
          },
        ])('Then returns 1 match for $label', ({ prefix, expected }) => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act
          const sut = findByPrefix(idx, prefix);

          // Assert
          expect(sut).toHaveLength(1);
          expect(sut[0]).toBe(expected);
        });
      });
    });

    describe('Given a prefix matching a known count of objects', () => {
      describe('When searching', () => {
        it.each([
          { prefix: 'ccee', entries, expectedLength: 0, label: 'no matches' },
          {
            prefix: 'aabb',
            entries: [
              makeEntry('aabb' + '00'.repeat(18), 100),
              makeEntry('aabb' + 'ff'.repeat(18), 200),
              makeEntry('bbdd' + '00'.repeat(18), 300),
            ],
            expectedLength: 2,
            label: 'objects sharing a 4-char prefix',
          },
          { prefix: 'aabb00', entries, expectedLength: 1, label: 'an even-length (6-char) prefix' },
        ])(
          'Then returns $expectedLength match(es) for $label',
          ({ prefix, entries: rowEntries, expectedLength }) => {
            // Arrange
            const idx = parsePackIndex(buildTestIndex(rowEntries));

            // Act
            const sut = findByPrefix(idx, prefix);

            // Assert
            expect(sut).toHaveLength(expectedLength);
          },
        );
      });
    });

    describe('Given a malformed prefix', () => {
      describe('When searching', () => {
        it.each([
          { prefix: 'abc', reasonContains: 'too short', label: 'shorter than 4 chars' },
          { prefix: 'a'.repeat(41), reasonContains: 'too long', label: 'longer than 40 chars' },
          { prefix: 'gggg', reasonContains: 'non-hex', label: 'non-hex chars' },
          {
            // 'aabb' is valid hex but the trailing 'g' is not; the HEX_RE test
            // must anchor at both ends, or a leading-hex-run match would
            // wrongly accept this prefix.
            prefix: 'aabbg',
            reasonContains: 'non-hex',
            label: 'a hex prefix followed by a non-hex character',
          },
          {
            // 'aabb' is valid hex but the leading 'g' is not; the HEX_RE test
            // must anchor at both ends, or a trailing-hex-run match would
            // wrongly accept this prefix.
            prefix: 'gaabb',
            reasonContains: 'non-hex',
            label: 'a non-hex character followed by a hex prefix',
          },
        ])('Then throws INVALID_PACK_INDEX for $label', ({ prefix, reasonContains }) => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act & Assert
          try {
            findByPrefix(idx, prefix);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_INDEX',
                reason: expect.stringContaining(reasonContains),
              }),
            );
          }
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
    describe('Given a validly-headered index truncated below its declared size', () => {
      describe('When parsing', () => {
        it.each([
          {
            entries: [
              makeEntry('aa' + '00'.repeat(19), 100),
              makeEntry('bb' + '00'.repeat(19), 200),
              makeEntry('cc' + '00'.repeat(19), 300),
            ],
            // keep header(8) + fanout(1024) + 1 SHA (too few)
            truncateTo: () => 1032 + 20,
            label: 'objectCount too large for file',
          },
          {
            entries: [makeEntry('aa' + '00'.repeat(19), 100)],
            truncateTo: (fullLength: number) => fullLength - 1,
            label: 'exactly 1 byte too short for the declared objectCount',
          },
        ])('Then throws INVALID_PACK_INDEX for $label', ({ entries, truncateTo }) => {
          // Arrange
          const fullIndex = buildTestIndex(entries);
          const sut = fullIndex.subarray(0, truncateTo(fullIndex.length));

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
    describe('Given entries with large 64-bit offsets', () => {
      describe('When looking up each', () => {
        it.each([
          {
            entries: [
              makeEntry('aa' + '00'.repeat(19), 0x80000001),
              makeEntry('bb' + '00'.repeat(19), 0x80000002),
              makeEntry('cc' + '00'.repeat(19), 0x90000000),
            ],
            label: 'multiple large offsets',
          },
          {
            // offset = 0x1_00000001 (high=1, low=1)
            entries: [makeEntry('aa' + '00'.repeat(19), 0x100000001)],
            label: 'an offset > 2^32 (needs both high and low words)',
          },
        ])('Then reads correct 64-bit offsets for $label', ({ entries }) => {
          // Arrange
          const idx = parsePackIndex(buildTestIndex(entries));

          // Act & Assert
          for (const entry of entries) {
            expect(lookupPackIndex(idx, entry.id)).toBe(entry.offset);
          }
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
    describe('Given a large offset entry at or past the trailer boundary', () => {
      describe('When looking up', () => {
        it.each([
          {
            id: 'aa' + '00'.repeat(19),
            label:
              'one slot past the table — trailerOffset (length - 40) rejects it as out of range',
          },
          {
            id: 'bb' + '00'.repeat(19),
            label: 'exactly at the trailer boundary — the `largeOffset + 8` bound check rejects it',
          },
        ])('Then throws INVALID_PACK_INDEX for $label', ({ id }) => {
          // Arrange — 1 entry, 1 large-offset slot. trailerOffset === 1068.
          // Corrupt the small offset to largeIdx=1 → largeOffset === 1068, so
          // largeOffset + 8 === 1076 > 1068 must throw. The `length - 40` arithmetic
          // is load-bearing (a `length + 40` mutant raises trailerOffset to 1148
          // and the guard would wrongly pass), as is `largeOffset + 8` (a
          // `largeOffset - 8` mutant computes 1060 > 1068 = false and would
          // wrongly proceed).
          const entries: TestIndexEntry[] = [makeEntry(id, 0x80000001)];
          const idx = parsePackIndex(buildTestIndex(entries));
          idx._view.setUint32(idx.smallOffsetsTableOffset, 0x80000000 | 1);

          // Act & Assert
          try {
            lookupPackIndex(idx, id as ObjectId);
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
