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

    describe('Given bytes with wrong magic', () => {
      describe('When parsing', () => {
        it("Then throws INVALID_PACK_HEADER with reason containing 'magic'", () => {
          // Arrange
          const sut = new Uint8Array(12);
          const view = new DataView(sut.buffer);
          view.setUint32(0, 0xdeadbeef);
          view.setUint32(4, 2);
          view.setUint32(8, 1);

          // Act & Assert
          try {
            parsePackHeader(sut);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_HEADER',
                reason: expect.stringContaining('magic'),
              }),
            );
          }
        });
      });
    });

    describe('Given bytes with version 3', () => {
      describe('When parsing', () => {
        it("Then throws INVALID_PACK_HEADER with reason containing 'version'", () => {
          // Arrange
          const sut = new Uint8Array(12);
          const view = new DataView(sut.buffer);
          view.setUint32(0, 0x5041434b);
          view.setUint32(4, 3);
          view.setUint32(8, 1);

          // Act & Assert
          try {
            parsePackHeader(sut);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_HEADER',
                reason: expect.stringContaining('version'),
              }),
            );
          }
        });
      });
    });

    describe('Given bytes too short (< 12)', () => {
      describe('When parsing', () => {
        it("Then throws INVALID_PACK_HEADER with reason containing 'truncated'", () => {
          // Arrange
          const sut = new Uint8Array(8);

          // Act & Assert
          try {
            parsePackHeader(sut);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_HEADER',
                reason: expect.stringContaining('truncated'),
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
    describe('Given byte 0b0_001_0101 (type=1/COMMIT, size=5)', () => {
      describe('When parsing at offset 0', () => {
        it('Then type=1 size=5 dataOffset=1', () => {
          // Arrange
          const sut = new Uint8Array([0b0_001_0101]);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.COMMIT);
          expect(result.size).toBe(5);
          expect(result.dataOffset).toBe(1);
        });
      });
    });

    describe('Given byte 0b1_010_0011 + 0b0_0000010 (type=2/TREE, size=35)', () => {
      describe('When parsing', () => {
        it('Then type=2 size=35 dataOffset=2', () => {
          // Arrange — size = 3 (low 4 bits) | (2 << 4) = 3 + 32 = 35
          const sut = new Uint8Array([0b1_010_0011, 0b0_0000010]);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.TREE);
          expect(result.size).toBe(35);
          expect(result.dataOffset).toBe(2);
        });
      });
    });

    describe('Given multi-byte size spanning 3 bytes', () => {
      describe('When parsing', () => {
        it('Then size correctly assembled', () => {
          // Arrange — type=3/BLOB, size = 0x0F | (0x7F << 4) | (0x01 << 11)
          //   = 15 + 2032 + 2048 = 4095
          const sut = new Uint8Array([0b1_011_1111, 0b1_1111111, 0b0_0000001]);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.BLOB);
          expect(result.size).toBe(4095);
          expect(result.dataOffset).toBe(3);
        });
      });
    });

    describe('Given byte 0b0_011_1010 (type=3/BLOB, size=10)', () => {
      describe('When parsing', () => {
        it('Then type=3 size=10 dataOffset=1', () => {
          // Arrange
          const sut = new Uint8Array([0b0_011_1010]);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.BLOB);
          expect(result.size).toBe(10);
          expect(result.dataOffset).toBe(1);
        });
      });
    });

    describe('Given byte 0b0_100_0000 (type=4/TAG, size=0)', () => {
      describe('When parsing', () => {
        it('Then type=4 size=0 dataOffset=1', () => {
          // Arrange
          const sut = new Uint8Array([0b0_100_0000]);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.TAG);
          expect(result.size).toBe(0);
          expect(result.dataOffset).toBe(1);
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

    describe('Given type=7/REF_DELTA with SHA1_CONFIG', () => {
      describe('When parsing', () => {
        it('Then type=7 baseId extracted (20 bytes)', () => {
          // Arrange — type=7, size=0 → 0b0_111_0000 = 0x70
          const sha = new Uint8Array(20).fill(0xab);
          const sut = new Uint8Array(1 + 20);
          sut[0] = 0x70;
          sut.set(sha, 1);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.REF_DELTA);
          expect(result.type === PACK_ENTRY_TYPE.REF_DELTA && result.baseId).toBe('ab'.repeat(20));
          expect(result.dataOffset).toBe(21);
        });
      });
    });

    describe('Given type=7/REF_DELTA with SHA256_CONFIG', () => {
      describe('When parsing', () => {
        it('Then baseId extracted (32 bytes)', () => {
          // Arrange
          const sha = new Uint8Array(32).fill(0xcd);
          const sut = new Uint8Array(1 + 32);
          sut[0] = 0x70;
          sut.set(sha, 1);

          // Act
          const result = parsePackEntryHeader(sut, 0, SHA256_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.REF_DELTA);
          expect(result.type === PACK_ENTRY_TYPE.REF_DELTA && result.baseId).toBe('cd'.repeat(32));
          expect(result.dataOffset).toBe(33);
        });
      });
    });
  });

  describe('parsePackEntryHeader — errors', () => {
    describe('Given type=5 (reserved)', () => {
      describe('When parsing', () => {
        it("Then throws INVALID_PACK_ENTRY with reason 'reserved type 5'", () => {
          // Arrange — type=5 → 0b0_101_0000 = 0x50
          const sut = new Uint8Array([0x50]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('reserved type 5'),
              }),
            );
          }
        });
      });
    });

    describe('Given truncated bytes with continuation but no next byte', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — 0b1_001_0000 has continuation bit set
          const sut = new Uint8Array([0b1_001_0000]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unexpected end of header'),
              }),
            );
          }
        });
      });
    });

    describe('Given OFS_DELTA with no distance bytes', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — type=6 size=0 no continuation → single byte 0x60, but no distance byte
          const sut = new Uint8Array([0x60]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unexpected end of OFS_DELTA distance'),
              }),
            );
          }
        });
      });
    });

    describe('Given OFS_DELTA with truncated multi-byte distance', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — type=6 size=0 → 0x60, distance byte with continuation set but no next byte
          const sut = new Uint8Array([0x60, 0x80]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unexpected end of OFS_DELTA distance'),
              }),
            );
          }
        });
      });
    });

    describe('Given OFS_DELTA with distance encoding exceeding 4 continuation bytes', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — type=6 size=0 → 0x60, then 6 bytes all with continuation bit set
          const sut = new Uint8Array([0x60, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('OFS_DELTA distance encoding too long'),
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

    describe('Given offset past end of bytes', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange
          const sut = new Uint8Array([0x30]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 5, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unexpected end of header'),
              }),
            );
          }
        });
      });
    });

    describe('Given offset exactly at bytes.length', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — offset = length (off by one)
          const sut = new Uint8Array([0x30]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 1, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unexpected end of header'),
              }),
            );
          }
        });
      });
    });

    describe('Given entry with size encoding exceeding 5 continuation bytes', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — type=1 (COMMIT) + 7 continuation bytes (exceeds MAX_SIZE_EXTENSION_BYTES=5)
          const sut = new Uint8Array([0b1_001_0000, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('size encoding too long'),
              }),
            );
          }
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

    describe('Given type=0 (invalid)', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — type=0 → 0b0_000_0000 = 0x00
          const sut = new Uint8Array([0x00]);

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unknown type 0'),
              }),
            );
          }
        });
      });
    });

    describe('Given REF_DELTA with truncated base id', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_PACK_ENTRY', () => {
          // Arrange — type=7 size=0 → 0x70, but only 5 bytes of SHA instead of 20
          const sut = new Uint8Array(6);
          sut[0] = 0x70;

          // Act & Assert
          try {
            parsePackEntryHeader(sut, 0, SHA1_CONFIG);
            // Assert
            expect.fail('Should have thrown');
          } catch (e) {
            const err = e as TsgitError;
            expect(err.data).toEqual(
              expect.objectContaining({
                code: 'INVALID_PACK_ENTRY',
                reason: expect.stringContaining('unexpected end of REF_DELTA base id'),
              }),
            );
          }
        });
      });
    });
  });

  describe('encodePackEntryHeader', () => {
    describe('Given type=1 size=5', () => {
      describe('When encoding', () => {
        it('Then single byte 0b0_001_0101', () => {
          // Arrange
          const sut = encodePackEntryHeader(PACK_ENTRY_TYPE.COMMIT, 5);

          // Assert
          expect(sut).toEqual(new Uint8Array([0b0_001_0101]));
        });
      });
    });

    describe('Given type=3 size=16', () => {
      describe('When encoding', () => {
        it('Then two bytes (continuation needed for size > 15)', () => {
          // Arrange
          const sut = encodePackEntryHeader(PACK_ENTRY_TYPE.BLOB, 16);

          // Assert — low 4 bits = 0, continuation byte = 1
          expect(sut).toEqual(new Uint8Array([0b1_011_0000, 0b0_0000001]));
        });
      });
    });

    describe('Given type=4 size=0', () => {
      describe('When encoding', () => {
        it('Then single byte with size bits = 0', () => {
          // Arrange
          const sut = encodePackEntryHeader(PACK_ENTRY_TYPE.TAG, 0);

          // Assert
          expect(sut).toEqual(new Uint8Array([0b0_100_0000]));
        });
      });
    });
  });

  describe('encodeOfsDistance', () => {
    describe('Given distance=0', () => {
      describe('When encoding', () => {
        it('Then single byte 0x00', () => {
          // Arrange
          const sut = encodeOfsDistance(0);

          // Assert
          expect(sut).toEqual(new Uint8Array([0x00]));
        });
      });
    });

    describe('Given distance=127', () => {
      describe('When encoding', () => {
        it('Then single byte 0x7F', () => {
          // Arrange
          const sut = encodeOfsDistance(127);

          // Assert
          expect(sut).toEqual(new Uint8Array([0x7f]));
        });
      });
    });

    describe('Given distance=128', () => {
      describe('When encoding', () => {
        it('Then two bytes with continuation', () => {
          // Arrange
          const sut = encodeOfsDistance(128);

          // Assert — Verify roundtrip
          const entryHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0);
          const combined = new Uint8Array(entryHeader.length + sut.length);
          combined.set(entryHeader);
          combined.set(sut, entryHeader.length);
          const result = parsePackEntryHeader(combined, 0, SHA1_CONFIG);
          expect(result.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
          expect(result.type === PACK_ENTRY_TYPE.OFS_DELTA && result.baseDistance).toBe(128);
        });
      });
    });

    describe('Given large distance (100000)', () => {
      describe('When encoding then roundtripping', () => {
        it('Then baseDistance matches', () => {
          // Arrange
          const sut = encodeOfsDistance(100000);
          const entryHeader = encodePackEntryHeader(PACK_ENTRY_TYPE.OFS_DELTA, 0);
          const combined = new Uint8Array(entryHeader.length + sut.length);
          combined.set(entryHeader);
          combined.set(sut, entryHeader.length);
          const result = parsePackEntryHeader(combined, 0, SHA1_CONFIG);

          // Assert
          expect(result.type).toBe(PACK_ENTRY_TYPE.OFS_DELTA);
          expect(result.type === PACK_ENTRY_TYPE.OFS_DELTA && result.baseDistance).toBe(100000);
        });
      });
    });
  });

  describe('packEntryTypeToObjectType', () => {
    describe('Given COMMIT(1)', () => {
      describe('When mapping', () => {
        it("Then returns 'commit'", () => {
          // Arrange
          const sut = packEntryTypeToObjectType(PACK_ENTRY_TYPE.COMMIT);

          // Assert
          expect(sut).toBe('commit');
        });
      });
    });

    describe('Given TREE(2)', () => {
      describe('When mapping', () => {
        it("Then returns 'tree'", () => {
          // Arrange
          const sut = packEntryTypeToObjectType(PACK_ENTRY_TYPE.TREE);

          // Assert
          expect(sut).toBe('tree');
        });
      });
    });

    describe('Given BLOB(3)', () => {
      describe('When mapping', () => {
        it("Then returns 'blob'", () => {
          // Arrange
          const sut = packEntryTypeToObjectType(PACK_ENTRY_TYPE.BLOB);

          // Assert
          expect(sut).toBe('blob');
        });
      });
    });

    describe('Given TAG(4)', () => {
      describe('When mapping', () => {
        it("Then returns 'tag'", () => {
          // Arrange
          const sut = packEntryTypeToObjectType(PACK_ENTRY_TYPE.TAG);

          // Assert
          expect(sut).toBe('tag');
        });
      });
    });

    describe('Given OFS_DELTA(6)', () => {
      describe('When mapping', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = packEntryTypeToObjectType(PACK_ENTRY_TYPE.OFS_DELTA);

          // Assert
          expect(sut).toBeUndefined();
        });
      });
    });

    describe('Given REF_DELTA(7)', () => {
      describe('When mapping', () => {
        it('Then returns undefined', () => {
          // Arrange
          const sut = packEntryTypeToObjectType(PACK_ENTRY_TYPE.REF_DELTA);

          // Assert
          expect(sut).toBeUndefined();
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
