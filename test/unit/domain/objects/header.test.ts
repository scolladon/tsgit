import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { parseHeader, serializeHeader } from '../../../../src/domain/objects/header.js';

function headerBytes(str: string): Uint8Array {
  return encode(str);
}

describe('header', () => {
  describe('parseHeader', () => {
    describe('Given `<type> <size>\\0` as bytes', () => {
      describe('When parsing', () => {
        it.each([
          { raw: 'blob 12\0', type: 'blob', size: 12 },
          { raw: 'tree 0\0', type: 'tree', size: 0 },
          { raw: 'commit 1234\0', type: 'commit', size: 1234 },
          { raw: 'tag 56\0', type: 'tag', size: 56 },
        ])("Then type='$type', size=$size", ({ raw, type, size }) => {
          // Arrange
          const bytes = headerBytes(raw);

          // Act
          const sut = parseHeader(bytes);

          // Assert
          expect(sut.type).toBe(type);
          expect(sut.size).toBe(size);
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

    describe('Given bytes that fail one header-validation guard', () => {
      describe('When parsing', () => {
        it.each([
          {
            raw: 'invalid 12\0',
            reason: 'unknown object type: invalid',
            label: 'an unknown type',
          },
          { raw: 'blob 12', reason: 'missing null terminator', label: 'no null terminator' },
          {
            raw: 'blob12\0',
            reason: 'missing space between type and size',
            label: 'no space between type and size',
          },
          { raw: 'blob abc\0', reason: 'invalid size: abc', label: 'a non-numeric size' },
          { raw: 'blob -1\0', reason: 'invalid size: -1', label: 'a negative size' },
        ])('Then throws INVALID_OBJECT_HEADER with $label reason', ({ raw, reason }) => {
          // Arrange
          const bytes = headerBytes(raw);

          // Act + Assert
          expect(() => parseHeader(bytes)).toThrow(
            expect.objectContaining({
              data: expect.objectContaining({
                code: 'INVALID_OBJECT_HEADER',
                reason,
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
