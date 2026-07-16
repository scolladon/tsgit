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
    describe('Given a valid 40-char hex string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then returns branded ObjectId', () => {
          // Arrange
          const hex = 'a'.repeat(40);

          // Act
          const sut = ObjectId.from(hex);

          // Assert
          expect(sut).toBe(hex);
        });
      });
    });

    describe('Given a valid 64-char hex string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then returns branded ObjectId', () => {
          // Arrange
          const hex = 'b'.repeat(64);

          // Act
          const sut = ObjectId.from(hex);

          // Assert
          expect(sut).toBe(hex);
        });
      });
    });

    describe('Given an invalid hex string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const hex = 'xyz';

          // Act + Assert
          expect(() => ObjectId.from(hex)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: hex },
            }),
          );
        });
      });
    });

    describe('Given an empty string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const hex = '';

          // Act + Assert
          expect(() => ObjectId.from(hex)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: hex },
            }),
          );
        });
      });
    });

    describe('Given uppercase hex', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const hex = 'A'.repeat(40);

          // Act + Assert
          expect(() => ObjectId.from(hex)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: hex },
            }),
          );
        });
      });
    });

    describe('Given a 39-char hex string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const hex = 'a'.repeat(39);

          // Act + Assert
          expect(() => ObjectId.from(hex)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: hex },
            }),
          );
        });
      });
    });

    describe('Given a 41-char hex string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const hex = 'a'.repeat(41);

          // Act + Assert
          expect(() => ObjectId.from(hex)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: hex },
            }),
          );
        });
      });
    });

    describe('Given a 65-char hex string', () => {
      describe('When calling ObjectId.from', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const hex = 'a'.repeat(65);

          // Act + Assert
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
    describe('Given a 20-byte Uint8Array', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it('Then returns 40-char hex ObjectId', () => {
          // Arrange
          const bytes = new Uint8Array(20).fill(0xab);

          // Act
          const sut = ObjectId.fromRaw(bytes);

          // Assert
          expect(sut).toBe('ab'.repeat(20));
          expect(sut.length).toBe(40);
        });
      });
    });

    describe('Given a 32-byte Uint8Array', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it('Then returns 64-char hex ObjectId', () => {
          // Arrange
          const bytes = new Uint8Array(32).fill(0xcd);

          // Act
          const sut = ObjectId.fromRaw(bytes);

          // Assert
          expect(sut).toBe('cd'.repeat(32));
          expect(sut.length).toBe(64);
        });
      });
    });

    describe('Given a 19-byte Uint8Array', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const bytes = new Uint8Array(19);

          // Act + Assert
          expect(() => ObjectId.fromRaw(bytes)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: 'raw bytes length 19 is not 20 or 32' },
            }),
          );
        });
      });
    });

    describe('Given a 0-byte Uint8Array', () => {
      describe('When calling ObjectId.fromRaw', () => {
        it('Then throws INVALID_OBJECT_ID', () => {
          // Arrange
          const bytes = new Uint8Array(0);

          // Act + Assert
          expect(() => ObjectId.fromRaw(bytes)).toThrow(
            expect.objectContaining({
              data: { code: 'INVALID_OBJECT_ID', value: 'raw bytes length 0 is not 20 or 32' },
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
    describe('Given the roundtrip property "ObjectId.fromRaw(hexToBytes(id)) equals the original id for valid 40-char ids"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(arbObjectId(40), (id) => {
              const sut = ObjectId.fromRaw(hexToBytes(id));
              expect(sut).toBe(id);
            }),
          );
        });
      });
    });

    describe('Given the roundtrip property "ObjectId.fromRaw(hexToBytes(id)) equals the original id for valid 64-char ids"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(arbObjectId(64), (id) => {
              const sut = ObjectId.fromRaw(hexToBytes(id));
              expect(sut).toBe(id);
            }),
          );
        });
      });
    });
  });
});
