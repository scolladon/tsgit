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
    describe('Given 1 entry (BLOB)', () => {
      describe('When serializing', () => {
        it('Then result.data starts with PACK header (magic+v2+count=1)', () => {
          // Arrange
          const entry = makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array([1, 2, 3]));

          // Act
          const sut = serializePackfile([entry]);

          // Assert
          const header = parsePackHeader(sut.data);
          expect(header.version).toBe(2);
          expect(header.objectCount).toBe(1);
        });
      });
    });

    describe('Given 1 entry', () => {
      describe('When serializing', () => {
        it('Then result.entries[0].offset equals 12 (pack header size)', () => {
          // Arrange
          const entry = makeEntry(PACK_ENTRY_TYPE.BLOB, new Uint8Array([1, 2, 3]));

          // Act
          const sut = serializePackfile([entry]);

          // Assert
          expect(sut.entries[0]!.offset).toBe(12);
        });
        it('Then result.entries[0].crc32 equals crc32(header + compressedData)', () => {
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
      });
    });

    describe('Given 3 entries', () => {
      describe('When serializing', () => {
        it('Then result.entries offsets are sequential', () => {
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
        it('Then parsePackHeader gives count=3', () => {
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
      });
    });

    describe('Given 0 entries', () => {
      describe('When serializing', () => {
        it('Then result.data is just the 12-byte pack header', () => {
          // Arrange
          const sut = serializePackfile([]);

          // Assert
          expect(sut.data.length).toBe(12);
          const header = parsePackHeader(sut.data);
          expect(header.objectCount).toBe(0);
          expect(sut.entries).toHaveLength(0);
        });
      });
    });
  });

  describe('serializePackIndex', () => {
    describe('Given 3 entries with known ObjectIds', () => {
      describe('When serializing', () => {
        it('Then starts with magic and version 2', () => {
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
      });
    });

    describe('Given 3 entries', () => {
      describe('When serializing', () => {
        it('Then fanout table has correct cumulative counts', () => {
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
      });
    });

    describe('Given entries spanning small, large, and boundary offsets', () => {
      describe('When serializing then parsing', () => {
        it.each([
          {
            entries: [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x80000001 }],
            label: 'a single offset just above 2^31',
          },
          {
            // 3 large offset entries, one with high word > 0, to kill largeIdx math mutants
            entries: [
              { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x80000001 },
              { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 0x100000002 },
              { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 0x200000003 },
            ],
            label: 'offsets above 2^31, including one above 2^32',
          },
          {
            entries: [
              { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 42 },
              { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 0x80000001 },
              { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 99 },
              { id: 'dd' + '00'.repeat(19), crc32: 0, offset: 0x90000002 },
            ],
            label: 'a mix of small and large offsets',
          },
          {
            // 0x7fffffff is the max small offset (MSB not set)
            entries: [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x7fffffff }],
            label: 'the exact-boundary small offset (0x7fffffff)',
          },
          {
            // offset = 0x100000001 (high=1, low=1)
            entries: [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x100000001 }],
            label: 'an offset above 2^32',
          },
          {
            entries: [
              { id: 'aa' + '00'.repeat(19), crc32: 111, offset: 12 },
              { id: 'bb' + '00'.repeat(19), crc32: 222, offset: 100 },
              { id: 'cc' + '00'.repeat(19), crc32: 333, offset: 200 },
            ],
            label: '3 small, known entries',
          },
        ])('Then lookupPackIndex finds every entry for $label', ({ entries }) => {
          // Arrange
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
    });

    describe('Given entries whose offsets do or do not require a large-offset slot', () => {
      describe('When serializing', () => {
        it.each([
          {
            // 0x7fffffff must NOT count as large; `> 0x7fffffff` boundary. Kills the
            // L78 `>=` EqualityOperator mutant (would reserve 8 extra large-offset bytes).
            entries: [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x7fffffff }],
            expectedLength: 8 + 1024 + 20 + 4 + 4 + 0 + 20,
            label: '1 entry at the exact-boundary small offset (0x7fffffff)',
          },
          {
            // Both offsets well below 0x7fffffff; kills the L78 ConditionalExpression
            // `true` mutant (which counts every entry as large → 16 extra bytes).
            entries: [
              { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 12 },
              { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 99 },
            ],
            expectedLength: 8 + 1024 + 40 + 8 + 8 + 0 + 20,
            label: '2 small-offset entries',
          },
          {
            // Offset strictly above 0x7fffffff: exactly one large slot. Pins L78
            // against ConditionalExpression `true` (would count extra) — here n===1
            // so true≡correct, but combined with the small-offset row this anchors
            // the exact count.
            entries: [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 0x80000000 }],
            expectedLength: 8 + 1024 + 20 + 4 + 4 + 8 + 20,
            label: '1 large-offset entry',
          },
          {
            // Only the middle entry is large. Kills L78 ConditionalExpression `true`
            // (would reserve 3 slots = 24 bytes) and L78 `>=` is irrelevant here.
            entries: [
              { id: 'aa' + '00'.repeat(19), crc32: 0, offset: 12 },
              { id: 'bb' + '00'.repeat(19), crc32: 0, offset: 0x90000000 },
              { id: 'cc' + '00'.repeat(19), crc32: 0, offset: 200 },
            ],
            expectedLength: 8 + 1024 + 60 + 12 + 12 + 8 + 20,
            label: '3 entries, only the middle one large',
          },
        ])(
          'Then the total length reserves the correct large-offset bytes for $label',
          ({ entries, expectedLength }) => {
            // Arrange
            const packChecksum = new Uint8Array(20);

            // Act
            const sut = serializePackIndex(entries, packChecksum);

            // Assert
            expect(sut.length).toBe(expectedLength);
          },
        );
      });
    });

    describe('Given 1 entry with SHA starting with non-zero byte', () => {
      describe('When serializing', () => {
        it('Then SHA table is not corrupted by the fanout write loop', () => {
          // Arrange — kills the L117 `i <= 256` EqualityOperator mutant: writing
          // fanout[256] lands at byte offset 1032 (shaStart), zeroing the first 4
          // bytes of SHA[0] and breaking the lookup of an `aa...`-prefixed id.
          const id = 'aabbccdd' + '11'.repeat(16);
          const entries = [{ id, crc32: 0, offset: 12 }];
          const packChecksum = new Uint8Array(20);

          // Act
          const sut = serializePackIndex(entries, packChecksum);
          const withTrailer = new Uint8Array(sut.length + 20);
          withTrailer.set(sut);
          const idx = parsePackIndex(withTrailer);

          // Assert — first 4 SHA bytes intact: lookup succeeds with the exact id
          expect(lookupPackIndex(idx, id as ObjectId)).toBe(12);
          const view = new DataView(sut.buffer, sut.byteOffset, sut.byteLength);
          // shaStart = 8 + 1024 = 1032; first 4 bytes must equal 0xaabbccdd
          expect(view.getUint32(1032)).toBe(0xaabbccdd);
        });
      });
    });

    describe('Given 3 entries', () => {
      describe('When serializing', () => {
        it('Then SHA table is sorted', () => {
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
        it('Then CRC-32 table matches entry order after sort', () => {
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
      });
    });

    describe('Given packChecksum of wrong length', () => {
      describe('When serializing', () => {
        it('Then throws INVALID_PACK_INDEX', () => {
          // Arrange
          const entries = [{ id: 'aa' + '00'.repeat(19), crc32: 0, offset: 12 }];
          const packChecksum = new Uint8Array(10);

          // Act & Assert
          try {
            serializePackIndex(entries, packChecksum);
            // Assert
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
      });
    });

    describe('Given 0 entries', () => {
      describe('When serializing', () => {
        it('Then produces valid index with objectCount=0', () => {
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
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any entries', () => {
      describe('When serializing pack', () => {
        it('Then parsePackHeader count matches', () => {
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
      });
      describe('When serializing index then parsing', () => {
        it('Then lookupPackIndex finds every entry', () => {
          // Arrange + Assert
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
      });
    });

    describe('Given any pack entries', () => {
      describe('When serializing', () => {
        it('Then CRC-32 matches independently computed value', () => {
          // Arrange + Assert
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
  });
});
