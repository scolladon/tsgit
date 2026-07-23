import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import {
  EMPTY_TREE_OID,
  FilePath,
  ObjectId,
  RefName,
  ZERO_OID,
} from '../../../../src/domain/objects/object-id.js';
import { arbObjectId } from './arbitraries.js';

describe('object-id', () => {
  describe('ObjectId.from', () => {
    describe('Given a valid 40-char or 64-char hex string', () => {
      describe('When calling ObjectId.from', () => {
        it.each([
          { hex: 'a'.repeat(40), label: '40-char' },
          { hex: 'b'.repeat(64), label: '64-char' },
        ])('Then returns branded ObjectId for the $label hex string', ({ hex }) => {
          // Arrange & Act
          const sut = ObjectId.from(hex);

          // Assert
          expect(sut).toBe(hex);
        });
      });
    });

    describe('Given an invalid hex string', () => {
      describe('When calling ObjectId.from', () => {
        it.each([
          { hex: 'xyz', label: 'invalid hex characters' },
          { hex: '', label: 'an empty string' },
          { hex: 'A'.repeat(40), label: 'uppercase hex' },
          { hex: 'a'.repeat(39), label: 'a 39-char (one under SHA-1 width) string' },
          { hex: 'a'.repeat(41), label: 'a 41-char (one over SHA-1 width) string' },
          { hex: 'a'.repeat(65), label: 'a 65-char (one over SHA-256 width) string' },
        ])('Then throws INVALID_OBJECT_ID for $label', ({ hex }) => {
          // Arrange & Act + Assert
          expect(() => ObjectId.from(hex)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: hex },
            }),
          );
        });
      });
    });
  });

  describe('ObjectId.fromRaw', () => {
    describe('Given a 20-byte or 32-byte Uint8Array', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it.each([
          { size: 20, fill: 0xab, hexLength: 40 },
          { size: 32, fill: 0xcd, hexLength: 64 },
        ])('Then returns a $hexLength-char hex ObjectId', ({ size, fill, hexLength }) => {
          // Arrange
          const bytes = new Uint8Array(size).fill(fill);
          const expected = fill.toString(16).repeat(size);

          // Act
          const sut = ObjectId.fromRaw(bytes);

          // Assert
          expect(sut).toBe(expected);
          expect(sut.length).toBe(hexLength);
        });
      });
    });

    describe('Given a Uint8Array whose length is neither 20 nor 32 bytes', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it.each([19, 0])('Then throws INVALID_OBJECT_ID for a %i-byte array', (size) => {
          // Arrange
          const bytes = new Uint8Array(size);

          // Act + Assert
          expect(() => ObjectId.fromRaw(bytes)).toThrow(
            expect.objectContaining({
              data: {
                code: 'INVALID_OBJECT_ID',
                value: `raw bytes length ${size} is not 20 or 32`,
              },
            }),
          );
        });
      });
    });
  });

  describe('ObjectId identity', () => {
    describe('Given two ObjectIds from same hex', () => {
      describe('When comparing with ===', () => {
        it('Then returns true', () => {
          // Arrange
          const hex = 'a'.repeat(40);

          // Act
          const a = ObjectId.from(hex);
          const b = ObjectId.from(hex);

          // Assert
          expect(a === b).toBe(true);
        });
      });
    });
  });

  describe('ZERO_OID', () => {
    describe('Given ZERO_OID', () => {
      describe('When inspected', () => {
        it('Then it equals exactly forty zero characters', () => {
          // Arrange
          const expected = '0000000000000000000000000000000000000000';

          // Act
          const sut = ZERO_OID;

          // Assert
          expect(sut).toBe(expected);
        });
      });
      describe('When length is read', () => {
        it('Then it equals 40 (sha1 width)', () => {
          // Arrange
          const sut = ZERO_OID.length;

          // Assert
          expect(sut).toBe(40);
        });
      });
      describe('When passed to ObjectId.from', () => {
        it('Then it returns the same value', () => {
          // Arrange
          const hex: string = ZERO_OID;

          // Act
          const sut = ObjectId.from(hex);

          // Assert
          expect(sut).toBe(ZERO_OID);
        });
      });
    });
  });

  describe('EMPTY_TREE_OID', () => {
    describe('Given EMPTY_TREE_OID', () => {
      describe('When inspected', () => {
        it('Then it equals the canonical empty-tree SHA-1 literal', () => {
          // Arrange
          const expected = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

          // Act
          const sut = EMPTY_TREE_OID;

          // Assert
          expect(sut).toBe(expected);
        });
      });
      describe('When length is read', () => {
        it('Then it equals 40', () => {
          // Arrange
          const sut = EMPTY_TREE_OID.length;

          // Assert
          expect(sut).toBe(40);
        });
      });
      describe('When passed to ObjectId.from', () => {
        it('Then it returns the same value', () => {
          // Arrange
          const hex: string = EMPTY_TREE_OID;

          // Act
          const sut = ObjectId.from(hex);

          // Assert
          expect(sut).toBe(EMPTY_TREE_OID);
        });
      });
    });
  });

  describe('RefName', () => {
    describe('Given a non-empty string', () => {
      describe('When calling RefName.from', () => {
        it('Then returns branded RefName', () => {
          // Arrange
          const name = 'refs/heads/main';

          // Act
          const sut = RefName.from(name);

          // Assert
          expect(sut).toBe(name);
        });
      });
    });

    describe('Given an empty string', () => {
      describe('When calling RefName.from', () => {
        it('Then throws Error (plain Error, not TsgitError)', () => {
          // Arrange
          const name = '';

          // Act + Assert
          expect(() => RefName.from(name)).toThrow('RefName must not be empty');
          try {
            RefName.from(name);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(TsgitError);
          }
        });
      });
    });
  });

  describe('FilePath', () => {
    describe('Given a non-empty string', () => {
      describe('When calling FilePath.from', () => {
        it('Then returns branded FilePath', () => {
          // Arrange
          const path = 'src/index.ts';

          // Act
          const sut = FilePath.from(path);

          // Assert
          expect(sut).toBe(path);
        });
      });
    });

    describe('Given an empty string', () => {
      describe('When calling FilePath.from', () => {
        it('Then throws Error (plain Error, not TsgitError)', () => {
          // Arrange
          const path = '';

          // Act + Assert
          expect(() => FilePath.from(path)).toThrow('FilePath must not be empty');
          try {
            FilePath.from(path);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect(error).not.toBeInstanceOf(TsgitError);
          }
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given the roundtrip property "ObjectId.fromRaw(hexToBytes(id)) equals the original id"', () => {
      describe('When sampled', () => {
        it.each([40, 64] as const)('Then it holds for valid %i-char ids', (width) => {
          // Arrange + Assert
          fc.assert(
            fc.property(arbObjectId(width), (id) => {
              const sut = ObjectId.fromRaw(hexToBytes(id));
              expect(sut).toBe(id);
            }),
          );
        });
      });
    });
  });
});
