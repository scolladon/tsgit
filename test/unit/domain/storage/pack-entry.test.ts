import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import {
  type BasePackEntryType,
  encodeOfsDistance,
  encodePackEntryHeader,
  PACK_ENTRY_TYPE,
  packEntryTypeToObjectType,
  parsePackEntryHeader,
  parsePackHeader,
  serializePackHeader,
} from '../../../../src/domain/storage/pack-entry.js';

function makeHeaderBytes(magic: number, version: number, objectCount: number): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, magic);
  view.setUint32(4, version);
  view.setUint32(8, objectCount);
  return bytes;
}

describe('pack-entry', () => {
  describe('parsePackHeader', () => {
    describe("Given bytes with magic 'PACK' version 2 count 42", () => {
      describe('When parsing', () => {
        it('Then version=2 objectCount=42', () => {
          // Arrange
          const sut = new Uint8Array(12);
          const view = new DataView(sut.buffer);
          view.setUint32(0, 0x5041434b);
          view.setUint32(4, 2);
          view.setUint32(8, 42);

          // Act
          const result = parsePackHeader(sut);

          // Assert
          expect(result).toEqual({ version: 2, objectCount: 42 });
        });
      });
    });

    describe('Given malformed pack header bytes', () => {
      describe('When parsing', () => {
        it.each([
          {
            bytes: makeHeaderBytes(0xdeadbeef, 2, 1),
            reasonContains: 'magic',
            label: 'wrong magic',
          },
          {
            bytes: makeHeaderBytes(0x5041434b, 3, 1),
            reasonContains: 'version',
            label: 'an unsupported version (3)',
          },
          {
            bytes: new Uint8Array(8),
            reasonContains: 'truncated',
            label: 'bytes too short (< 12)',
          },
        ])('Then throws INVALID_PACK_HEADER for $label', ({ bytes, reasonContains }) => {
          // Act & Assert
          try {
            parsePackHeader(bytes);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_HEADER',
                reason: expect.stringContaining(reasonContains),
              }),
            );
          }
        });
      });
    });

    describe('Given wrong magic that is a small value (fewer than 8 hex digits)', () => {
      describe('When parsing', () => {
        it('Then the reason zero-pads it to 8 digits', () => {
          // Arrange — magic 0x0000004b: `toString(16)` is "4b" (2 chars), so
          // `padStart(8, '0')` must produce "0000004b". The StringLiteral
          // mutant replacing the '0' pad char with '' would leave it "4b".
          const sut = new Uint8Array(12);
          const view = new DataView(sut.buffer);
          view.setUint32(0, 0x0000004b);
          view.setUint32(4, 2);
          view.setUint32(8, 1);

          // Act
          let caught: unknown;
          try {
            parsePackHeader(sut);
          } catch (e) {
            caught = e;
          }

          // Assert — exact reason pins the zero-padding.
          expect((caught as TsgitError).data).toEqual({
            code: 'INVALID_PACK_HEADER',
            reason: 'invalid magic: expected 0x5041434b, got 0x0000004b',
          });
        });
      });
    });

    describe('Given version=2 objectCount=100', () => {
      describe('When serializing then parsing', () => {
        it('Then roundtrips', () => {
          // Arrange
          const serialized = serializePackHeader(2, 100);

          // Act
          const sut = parsePackHeader(serialized);

          // Assert
          expect(sut).toEqual({ version: 2, objectCount: 100 });
        });
      });
    });
  });

  describe('parsePackEntryHeader — base types', () => {
    describe('Given bytes encoding a base entry type', () => {
      describe('When parsing at offset 0', () => {
        it.each([
          {
            bytes: [0b0_001_0101],
            type: PACK_ENTRY_TYPE.COMMIT,
            size: 5,
            dataOffset: 1,
            label: 'type=1/COMMIT, size=5',
          },
          {
            // size = 3 (low 4 bits) | (2 << 4) = 3 + 32 = 35
            bytes: [0b1_010_0011, 0b0_0000010],
            type: PACK_ENTRY_TYPE.TREE,
            size: 35,
            dataOffset: 2,
            label: 'type=2/TREE, size=35',
          },
          {
            // type=3/BLOB, size = 0x0F | (0x7F << 4) | (0x01 << 11) = 15 + 2032 + 2048 = 4095
            bytes: [0b1_011_1111, 0b1_1111111, 0b0_0000001],
            type: PACK_ENTRY_TYPE.BLOB,
            size: 4095,
            dataOffset: 3,
            label: 'a multi-byte size spanning 3 bytes',
          },
          {
            bytes: [0b0_011_1010],
            type: PACK_ENTRY_TYPE.BLOB,
            size: 10,
            dataOffset: 1,
            label: 'type=3/BLOB, size=10',
          },
          {
            bytes: [0b0_100_0000],
            type: PACK_ENTRY_TYPE.TAG,
            size: 0,
            dataOffset: 1,
            label: 'type=4/TAG, size=0',
          },
        ])('Then decodes $label', ({ bytes, type, size, dataOffset }) => {
          // Arrange
          const sut = new Uint8Array(bytes);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(type);
          expect(result.size).toBe(size);
          expect(result.dataOffset).toBe(dataOffset);
        });
      });
    });
  });

  describe('parsePackEntryHeader — delta types', () => {
    describe('Given type=6/OFS_DELTA with distance encoding', () => {
      describe('When parsing', () => {
        it('Then type=6 baseDistance correct', () => {
          // Arrange — type=6, size=0, distance=10
          // First byte: type=6 size=0 → 0b0_110_0000 = 0x60
          // Distance: 10 < 128, single byte 0x0A
          const sut = new Uint8Array([0x60, 0x0a]);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
          expect(result.size).toBe(0);
          expect(result.type === PACK_ENTRY_TYPE.OFS_DELTA && result.baseDistance).toBe(10);
          expect(result.dataOffset).toBe(2);
        });
      });
    });

    describe('Given type=7/REF_DELTA with a hash config', () => {
      describe('When parsing', () => {
        it.each([
          {
            config: SHA1_CONFIG,
            byteLength: 20,
            fillByte: 0xab,
            expectedBaseId: 'ab'.repeat(20),
            label: 'SHA1_CONFIG (20 bytes)',
          },
          {
            config: SHA256_CONFIG,
            byteLength: 32,
            fillByte: 0xcd,
            expectedBaseId: 'cd'.repeat(32),
            label: 'SHA256_CONFIG (32 bytes)',
          },
        ])(
          'Then baseId is extracted for $label',
          ({ config, byteLength, fillByte, expectedBaseId }) => {
            // Arrange — type=7, size=0 → 0b0_111_0000 = 0x70
            const sha = new Uint8Array(byteLength).fill(fillByte);
            const sut = new Uint8Array(1 + byteLength);
            sut[0] = 0x70;
            sut.set(sha, 1);

            // Act
            const result = parsePackEntryHeader(sut, 0, config);

            // Assert
            expect(result.type).toBe(PACK_ENTRY_TYPE.REF_DELTA);
            expect(result.type === PACK_ENTRY_TYPE.REF_DELTA && result.baseId).toBe(expectedBaseId);
            expect(result.dataOffset).toBe(1 + byteLength);
          },
        );
      });
    });
  });

  describe('parsePackEntryHeader — errors', () => {
    describe('Given malformed pack-entry header bytes', () => {
      describe('When parsing', () => {
        it.each([
          {
            // type=5 → 0b0_101_0000 = 0x50
            bytes: [0x50],
            offset: 0,
            reasonContains: 'reserved type 5',
            label: 'a reserved type (5)',
          },
          {
            // 0b1_001_0000 has continuation bit set but no next byte
            bytes: [0b1_001_0000],
            offset: 0,
            reasonContains: 'unexpected end of header',
            label: 'a truncated size-continuation byte',
          },
          {
            // type=6 size=0 no continuation → single byte 0x60, but no distance byte
            bytes: [0x60],
            offset: 0,
            reasonContains: 'unexpected end of OFS_DELTA distance',
            label: 'an OFS_DELTA with no distance bytes',
          },
          {
            // type=6 size=0 → 0x60, distance byte with continuation set but no next byte
            bytes: [0x60, 0x80],
            offset: 0,
            reasonContains: 'unexpected end of OFS_DELTA distance',
            label: 'an OFS_DELTA with a truncated multi-byte distance',
          },
          {
            // type=6 size=0 → 0x60, then 6 bytes all with continuation bit set
            bytes: [0x60, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00],
            offset: 0,
            reasonContains: 'OFS_DELTA distance encoding too long',
            label: 'an OFS_DELTA distance encoding exceeding 4 continuation bytes',
          },
          {
            bytes: [0x30],
            offset: 5,
            reasonContains: 'unexpected end of header',
            label: 'an offset past the end of the bytes',
          },
          {
            // offset = length (off by one)
            bytes: [0x30],
            offset: 1,
            reasonContains: 'unexpected end of header',
            label: 'an offset exactly at bytes.length',
          },
          {
            // type=1 (COMMIT) + 7 continuation bytes (exceeds MAX_SIZE_EXTENSION_BYTES=5)
            bytes: [0b1_001_0000, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00],
            offset: 0,
            reasonContains: 'size encoding too long',
            label: 'a size encoding exceeding 5 continuation bytes',
          },
          {
            // type=0 → 0b0_000_0000 = 0x00
            bytes: [0x00],
            offset: 0,
            reasonContains: 'unknown type 0',
            label: 'type=0 (invalid)',
          },
          {
            // type=7 size=0 → 0x70, but only 5 bytes of SHA instead of 20
            bytes: [0x70, 0, 0, 0, 0, 0],
            offset: 0,
            reasonContains: 'unexpected end of REF_DELTA base id',
            label: 'a REF_DELTA with a truncated base id',
          },
        ])('Then throws INVALID_PACK_ENTRY for $label', ({ bytes, offset, reasonContains }) => {
          // Arrange
          const sut = new Uint8Array(bytes);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, offset, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining(reasonContains),
              }),
            );
          }
        });
      });
    });

    describe('Given an OFS_DELTA distance with exactly 4 continuation bytes (the maximum)', () => {
      describe('When parsing', () => {
        it('Then it is accepted', () => {
          // Arrange — type=6/OFS_DELTA (0x60), then 4 distance bytes with the
          // continuation bit set and a terminating byte: the while loop
          // counts exactly 4 continuations. `continuationCount > 4` keeps 4
          // valid; the `>=` mutant would reject the maximum-length encoding.
          const sut = new Uint8Array([0x60, 0x80, 0x80, 0x80, 0x80, 0x00]);

          // Act — must NOT throw.
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert — OFS_DELTA decoded; the 4-continuation distance stayed in bounds.
          expect(result.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
          expect(result.dataOffset).toBe(6);
        });
      });
    });

    describe('Given a size encoding with exactly 5 continuation bytes (the maximum)', () => {
      describe('When parsing', () => {
        it('Then it is accepted', () => {
          // Arrange — type=1/COMMIT first byte with continuation set, then 4
          // more continuation bytes and a terminating byte: the while loop
          // counts exactly 5 extension bytes. `extensionBytes > 5` keeps 5
          // valid; the `>=` mutant would reject the maximum-length encoding.
          const sut = new Uint8Array([0b1_001_0000, 0x80, 0x80, 0x80, 0x80, 0x00]);

          // Act — must NOT throw.
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert — header decoded; the 5-byte encoding stayed within bounds.
          expect(result.type).toBe(PACK_ENTRY_TYPE.COMMIT);
          expect(result.dataOffset).toBe(6);
        });
      });
    });
  });

  describe('encodePackEntryHeader', () => {
    describe('Given a type and size', () => {
      describe('When encoding', () => {
        it.each([
          {
            type: PACK_ENTRY_TYPE.COMMIT,
            size: 5,
            expected: [0b0_001_0101],
            label: 'type=1 size=5 fits a single byte',
          },
          {
            // low 4 bits = 0, continuation byte = 1
            type: PACK_ENTRY_TYPE.BLOB,
            size: 16,
            expected: [0b1_011_0000, 0b0_0000001],
            label: 'type=3 size=16 needs a continuation byte',
          },
          { type: PACK_ENTRY_TYPE.TAG, size: 0, expected: [0b0_100_0000], label: 'type=4 size=0' },
        ])('Then encodes $label', ({ type, size, expected }) => {
          // Arrange & Act
          const sut = encodePackEntryHeader(type, size);

          // Assert
          expect(sut).toEqual(new Uint8Array(expected));
        });
      });
    });
  });

  describe('encodeOfsDistance', () => {
    describe('Given a distance that fits in a single byte', () => {
      describe('When encoding', () => {
        it.each([
          { distance: 0, expected: [0x00], label: 'distance=0' },
          { distance: 127, expected: [0x7f], label: 'distance=127' },
        ])('Then produces a single byte for $label', ({ distance, expected }) => {
          // Arrange & Act
          const sut = encodeOfsDistance(distance);

          // Assert
          expect(sut).toEqual(new Uint8Array(expected));
        });
      });
    });

    describe('Given a distance requiring continuation bytes', () => {
      describe('When encoding then roundtripping through an OFS_DELTA entry header', () => {
        it.each([
          { distance: 128, label: 'distance=128 (minimum requiring continuation)' },
          { distance: 100000, label: 'a large distance (100000)' },
        ])('Then baseDistance matches for $label', ({ distance }) => {
          // Arrange
          const sut = encodeOfsDistance(distance);
          const entryHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0);
          const combined = new Uint8Array(entryHeader.length + sut.length);
          combined.set(entryHeader);
          combined.set(sut, entryHeader.length);

          // Act
          const result = parsePackEntryHeader(combined, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
          expect(result.type === PACK_ENTRY_TYPE.OFS_DELTA && result.baseDistance).toBe(distance);
        });
      });
    });
  });

  describe('packEntryTypeToObjectType', () => {
    describe('Given a pack entry type', () => {
      describe('When mapping', () => {
        it.each([
          { type: PACK_ENTRY_TYPE.COMMIT, expected: 'commit', label: 'COMMIT(1)' },
          { type: PACK_ENTRY_TYPE.TREE, expected: 'tree', label: 'TREE(2)' },
          { type: PACK_ENTRY_TYPE.BLOB, expected: 'blob', label: 'BLOB(3)' },
          { type: PACK_ENTRY_TYPE.TAG, expected: 'tag', label: 'TAG(4)' },
          { type: PACK_ENTRY_TYPE.OFS_DELTA, expected: undefined, label: 'OFS_DELTA(6)' },
          { type: PACK_ENTRY_TYPE.REF_DELTA, expected: undefined, label: 'REF_DELTA(7)' },
        ])('Then $label maps to $expected', ({ type, expected }) => {
          // Arrange & Act
          const sut = packEntryTypeToObjectType(type);

          // Assert
          expect(sut).toBe(expected);
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any pack header roundtrip', () => {
      describe('When serializing then parsing', () => {
        it('Then preserves values', () => {
          // Arrange
          fc.assert(
            fc.property(fc.integer({ min: 0, max: 2 ** 32 - 1 }), (objectCount) => {
              // Act
              const serialized = serializePackHeader(2, objectCount);
              const sut = parsePackHeader(serialized);

              // Assert
              expect(sut).toEqual({ version: 2, objectCount });
            }),
          );
        });
      });
    });

    describe('Given any base type and size', () => {
      describe('When encoding then parsing entry header', () => {
        it('Then roundtrips', () => {
          // Arrange
          fc.assert(
            fc.property(
              fc.constantFrom(1, 2, 3, 4) as fc.Arbitrary<BasePackEntryType>,
              fc.integer({ min: 0, max: 2 ** 28 }),
              (type, size) => {
                // Act
                const encoded = encodePackEntryHeader(type, size);
                const sut = parsePackEntryHeader(encoded, 0, SHA1_CONFIG);

                // Assert
                expect(sut.type).toBe(type);
                expect(sut.size).toBe(size);
              },
            ),
          );
        });
      });
    });

    describe('Given any OFS distance', () => {
      describe('When encoding then building entry and parsing', () => {
        it('Then roundtrips', () => {
          fc.assert(
            fc.property(fc.integer({ min: 1, max: 2 ** 28 }), (distance) => {
              // Arrange
              const entryHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0);
              const distBytes = encodeOfsDistance(distance);
              const combined = new Uint8Array(entryHeader.length + distBytes.length);
              combined.set(entryHeader);
              combined.set(distBytes, entryHeader.length);

              // Act
              const sut = parsePackEntryHeader(combined, 0, SHA1_CONFIG);

              // Assert
              expect(sut.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
              expect(sut.type === PACK_ENTRY_TYPE.OFS_DELTA && sut.baseDistance).toBe(distance);
            }),
          );
        });
      });
    });
  });
});
