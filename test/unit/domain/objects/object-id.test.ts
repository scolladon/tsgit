import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import { bytesToHex, hexToBytes } from '../../../../src/domain/objects/encoding.js';
import { TsgitError } from '../../../../src/domain/objects/error.js';
import { SHA1_CONFIG, SHA256_CONFIG } from '../../../../src/domain/objects/hash-config.js';
import {
  EMPTY_TREE_OID,
  emptyTreeOid,
  FilePath,
  ObjectId,
  RefName,
  ZERO_OID,
  zeroOid,
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
          const result = ObjectId.from(hex);

          // Assert
          expect(result).toBe(hex);
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
          { hex: 'a'.repeat(63), label: 'a 63-char (one under SHA-256 width) string' },
          { hex: 'a'.repeat(65), label: 'a 65-char (one over SHA-256 width) string' },
        ])('Then throws INVALID_OBJECT_ID for $label', ({ hex }) => {
          // Arrange
          const sut = ObjectId.from;

          // Act + Assert
          try {
            sut(hex);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data).toEqual({
              code: 'INVALID_OBJECT_ID',
              value: hex,
            });
          }
        });
      });
    });

    describe('Given a 40-char hex string with a single character replaced at an accept boundary', () => {
      describe('When calling ObjectId.from', () => {
        it.each([
          { char: '0', label: "'0' (0x30) — low end of the digit range" },
          { char: '9', label: "'9' (0x39) — high end of the digit range" },
          { char: 'a', label: "'a' (0x61) — low end of the lower-alpha range" },
          { char: 'f', label: "'f' (0x66) — high end of the lower-alpha range" },
        ])('Then accepts the boundary character $label', ({ char }) => {
          // Arrange
          const hex = `${char}${'a'.repeat(39)}`;

          // Act
          const result = ObjectId.from(hex);

          // Assert
          expect(result).toBe(hex);
        });
      });
    });

    describe('Given a 40-char hex string with a single character replaced at a reject boundary', () => {
      describe('When calling ObjectId.from', () => {
        it.each([
          { char: '/', label: "'/' (0x2F) — one below the digit range" },
          { char: ':', label: "':' (0x3A) — one above the digit range" },
          { char: '`', label: "'`' (0x60) — one below the lower-alpha range" },
          { char: 'g', label: "'g' (0x67) — one above the lower-alpha range" },
          { char: 'A', label: "'A' — uppercase is rejected, not case-folded" },
          { char: 'F', label: "'F' — uppercase is rejected, not case-folded" },
        ])('Then throws INVALID_OBJECT_ID for $label', ({ char }) => {
          // Arrange
          const hex = `${char}${'a'.repeat(39)}`;

          // Act + Assert
          try {
            ObjectId.from(hex);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data).toEqual({
              code: 'INVALID_OBJECT_ID',
              value: hex,
            });
          }
        });
      });
    });

    describe('Given a 40-char hex string with trailing whitespace', () => {
      describe('When calling ObjectId.from', () => {
        it.each([
          { suffix: '\n', label: 'a trailing newline' },
          { suffix: '\r', label: 'a trailing carriage return' },
        ])('Then throws INVALID_OBJECT_ID for $label', ({ suffix }) => {
          // Arrange
          const hex = `${'a'.repeat(40)}${suffix}`;

          // Act + Assert
          try {
            ObjectId.from(hex);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data).toEqual({
              code: 'INVALID_OBJECT_ID',
              value: hex,
            });
          }
        });
      });
    });

    describe('Given a 39-char hex string with one astral-plane character appended (41 UTF-16 code units)', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID (length is measured in code units, not code points)', () => {
          // Arrange
          const hex = `${'a'.repeat(39)}\u{1f600}`;

          // Act + Assert
          try {
            ObjectId.from(hex);
            expect.unreachable();
          } catch (error) {
            expect(error).toBeInstanceOf(TsgitError);
            expect((error as TsgitError).data).toEqual({
              code: 'INVALID_OBJECT_ID',
              value: hex,
            });
          }
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
          const result = ObjectId.fromRaw(bytes);

          // Assert
          expect(result).toBe(expected);
          expect(result.length).toBe(hexLength);
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

    describe('Given a length-checked 20-byte slice', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it('Then it never re-scans the hex (bytesToHex output is provably [0-9a-f]-only)', () => {
          // Arrange — the validator's only observable primitive is
          // String.prototype.charCodeAt: a fromRaw that delegated to
          // ObjectId.from would scan 40 code units and trip this spy.
          const sut = ObjectId.fromRaw;
          const bytes = new Uint8Array(20).fill(0xab);
          const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt');

          try {
            // Act
            sut(bytes);

            // Assert
            expect(charCodeAtSpy).not.toHaveBeenCalled();
          } finally {
            charCodeAtSpy.mockRestore();
          }
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
          const result = ZERO_OID;

          // Assert
          expect(result).toBe(expected);
        });
      });
      describe('When length is read', () => {
        it('Then it equals 40 (sha1 width)', () => {
          // Arrange
          const result = ZERO_OID.length;

          // Assert
          expect(result).toBe(40);
        });
      });
      describe('When passed to ObjectId.from', () => {
        it('Then it returns the same value', () => {
          // Arrange
          const hex: string = ZERO_OID;

          // Act
          const result = ObjectId.from(hex);

          // Assert
          expect(result).toBe(ZERO_OID);
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
          const result = EMPTY_TREE_OID;

          // Assert
          expect(result).toBe(expected);
        });
      });
      describe('When length is read', () => {
        it('Then it equals 40', () => {
          // Arrange
          const result = EMPTY_TREE_OID.length;

          // Assert
          expect(result).toBe(40);
        });
      });
      describe('When passed to ObjectId.from', () => {
        it('Then it returns the same value', () => {
          // Arrange
          const hex: string = EMPTY_TREE_OID;

          // Act
          const result = ObjectId.from(hex);

          // Assert
          expect(result).toBe(EMPTY_TREE_OID);
        });
      });
    });
  });

  describe('zeroOid', () => {
    describe('Given SHA1_CONFIG', () => {
      describe('When zeroOid is called', () => {
        it('Then it returns 40 zero characters', () => {
          // Arrange
          const sut = zeroOid;

          // Act
          const result = sut(SHA1_CONFIG);

          // Assert
          expect(result).toBe('0000000000000000000000000000000000000000');
        });
      });
    });

    describe('Given SHA256_CONFIG', () => {
      describe('When zeroOid is called', () => {
        it('Then it returns 64 zero characters', () => {
          // Arrange
          const sut = zeroOid;

          // Act
          const result = sut(SHA256_CONFIG);

          // Assert
          expect(result).toBe('0000000000000000000000000000000000000000000000000000000000000000');
        });
      });
    });
  });

  describe('emptyTreeOid', () => {
    describe('Given SHA1_CONFIG', () => {
      describe('When emptyTreeOid is called', () => {
        it('Then it returns the canonical SHA-1 empty-tree literal', () => {
          // Arrange
          const sut = emptyTreeOid;

          // Act
          const result = sut(SHA1_CONFIG);

          // Assert
          expect(result).toBe('4b825dc642cb6eb9a060e54bf8d69288fbee4904');
        });
      });
    });

    describe('Given SHA256_CONFIG', () => {
      describe('When emptyTreeOid is called', () => {
        it('Then it returns the canonical SHA-256 empty-tree literal', () => {
          // Arrange
          const sut = emptyTreeOid;

          // Act
          const result = sut(SHA256_CONFIG);

          // Assert
          expect(result).toBe('6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321');
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
          const result = RefName.from(name);

          // Assert
          expect(result).toBe(name);
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
          const result = FilePath.from(path);

          // Assert
          expect(result).toBe(path);
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
              const result = ObjectId.fromRaw(hexToBytes(id));
              expect(result).toBe(id);
            }),
          );
        });
      });
    });

    describe('Given the property "fromRaw\'s trusted path equals the old regex-validated path" for any 20/32-byte input', () => {
      describe('When sampled', () => {
        it.each([20, 32] as const)('Then it holds for %i-byte raw slices', (size) => {
          // Arrange + Assert
          fc.assert(
            fc.property(fc.uint8Array({ minLength: size, maxLength: size }), (bytes) => {
              const result = ObjectId.fromRaw(bytes);
              const expected = ObjectId.from(bytesToHex(bytes));
              expect(result).toBe(expected);
            }),
          );
        });
      });
    });
  });
});
