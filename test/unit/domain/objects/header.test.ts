import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { parseHeader, serializeHeader } from '../../../../src/domain/objects/header.js';

function headerBytes(str: string): Uint8Array {
  return encode(str);
}

describe('header', () => {
  describe('parseHeader', () => {
    describe("Given 'blob 12\\\\0' as bytes", () => {
      describe('When parsing', () => {
        it("Then type='blob', size=12", () => {
          // Arrange
          const raw = headerBytes('blob 12\0');

          // Act
          const sut = parseHeader(raw);

          // Assert
          expect(sut.type).toBe('blob');
          expect(sut.size).toBe(12);
        });
      });
    });

    describe("Given 'tree 0\\\\0' as bytes", () => {
      describe('When parsing', () => {
        it("Then type='tree', size=0", () => {
          // Arrange
          const raw = headerBytes('tree 0\0');

          // Act
          const sut = parseHeader(raw);

          // Assert
          expect(sut.type).toBe('tree');
          expect(sut.size).toBe(0);
        });
      });
    });

    describe("Given 'commit 1234\\\\0' as bytes", () => {
      describe('When parsing', () => {
        it("Then type='commit', size=1234", () => {
          // Arrange
          const raw = headerBytes('commit 1234\0');

          // Act
          const sut = parseHeader(raw);

          // Assert
          expect(sut.type).toBe('commit');
          expect(sut.size).toBe(1234);
        });
      });
    });

    describe("Given 'tag 56\\\\0' as bytes", () => {
      describe('When parsing', () => {
        it("Then type='tag', size=56", () => {
          // Arrange
          const raw = headerBytes('tag 56\0');

          // Act
          const sut = parseHeader(raw);

          // Assert
          expect(sut.type).toBe('tag');
          expect(sut.size).toBe(56);
        });
      });
    });

    describe("Given 'blob 12\\\\0<content>' as bytes", () => {
      describe('When parsing', () => {
        it('Then contentOffset=8 (points past null)', () => {
          // Arrange
          const raw = headerBytes('blob 12\0hello world!');

          // Act
          const sut = parseHeader(raw);

          // Assert
          expect(sut.contentOffset).toBe(8);
        });
      });
    });

    describe("Given 'invalid 12\\\\0' as bytes", () => {
      describe('When parsing', () => {
        it('Then throws INVALID_OBJECT_HEADER with unknown type reason', () => {
          // Arrange
          const raw = headerBytes('invalid 12\0');

          // Act + Assert
          expect(() => parseHeader(raw)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
                reason: 'unknown object type: invalid',
              }),
            }),
          );
        });
      });
    });

    describe('Given bytes with no null terminator', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_OBJECT_HEADER with missing null reason', () => {
          // Arrange
          const raw = headerBytes('blob 12');

          // Act + Assert
          expect(() => parseHeader(raw)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
                reason: 'missing null terminator',
              }),
            }),
          );
        });
      });
    });

    describe('Given bytes with no space', () => {
      describe('When parsing', () => {
        it('Then throws INVALID_OBJECT_HEADER with missing space reason', () => {
          // Arrange
          const raw = headerBytes('blob12\0');

          // Act + Assert
          expect(() => parseHeader(raw)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
                reason: 'missing space between type and size',
              }),
            }),
          );
        });
      });
    });

    describe("Given 'blob abc\\\\0' (non-numeric size)", () => {
      describe('When parsing', () => {
        it('Then throws INVALID_OBJECT_HEADER with invalid size reason', () => {
          // Arrange
          const raw = headerBytes('blob abc\0');

          // Act + Assert
          expect(() => parseHeader(raw)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
                reason: 'invalid size: abc',
              }),
            }),
          );
        });
      });
    });

    describe("Given 'blob -1\\\\0' (negative size)", () => {
      describe('When parsing', () => {
        it('Then throws INVALID_OBJECT_HEADER with invalid size reason', () => {
          // Arrange
          const raw = headerBytes('blob -1\0');

          // Act + Assert
          expect(() => parseHeader(raw)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
                reason: 'invalid size: -1',
              }),
            }),
          );
        });
      });
    });

    describe("Given 'blob 01\\\\0' (leading zero size)", () => {
      describe('When parsing', () => {
        it('Then throws INVALID_OBJECT_HEADER with invalid size reason', () => {
          // Arrange
          const raw = headerBytes('blob 01\0');

          // Act + Assert
          expect(() => parseHeader(raw)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
              }),
            }),
          );
        });
      });
    });
  });

  describe('serializeHeader', () => {
    describe("Given 'blob' type and size 42", () => {
      describe('When serializing', () => {
        it("Then produces bytes for 'blob 42\\0'", () => {
          // Arrange & Act
          const sut = serializeHeader('blob', 42);

          // Assert
          expect(sut).toEqual(headerBytes('blob 42\0'));
        });
      });
    });

    describe("Given 'tree' type and size 0", () => {
      describe('When serializing', () => {
        it("Then produces bytes for 'tree 0\\0'", () => {
          // Arrange & Act
          const sut = serializeHeader('tree', 0);

          // Assert
          expect(sut).toEqual(headerBytes('tree 0\0'));
        });
      });
    });
  });

  describe('roundtrip', () => {
    describe('Given type and size', () => {
      describe('When roundtripping parse(serialize(type, size))', () => {
        it('Then type and size match', () => {
          // Arrange
          const type = 'commit' as const;
          const size = 999;

          // Act
          const serialized = serializeHeader(type, size);
          const sut = parseHeader(serialized);

          // Assert
          expect(sut.type).toBe(type);
          expect(sut.size).toBe(size);
        });
      });
    });
  });
});
