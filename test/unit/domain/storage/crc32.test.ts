import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../../../../src/domain/storage/crc32.js';

describe('crc32', () => {
  describe('Given data with a known CRC-32 value', () => {
    describe('When computing CRC-32', () => {
      it.each([
        { data: new Uint8Array(0), expected: 0x00000000, label: 'empty data' },
        {
          data: new TextEncoder().encode('123456789'),
          expected: 0xcbf43926,
          label: "ASCII '123456789'",
        },
        {
          data: new TextEncoder().encode('PACK'),
          expected: 0xa14bb397,
          label: "ASCII 'PACK'",
        },
        { data: new Uint8Array([0x00]), expected: 0xd202ef8d, label: 'a single byte [0x00]' },
        { data: new Uint8Array([0xff]), expected: 0xff000000, label: 'a single byte [0xFF]' },
        { data: new Uint8Array(1000), expected: 0x060b1780, label: '1000 zero bytes' },
      ])('Then returns the known value for $label', ({ data, expected }) => {
        // Arrange & Act
        const result = crc32(data);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given any data', () => {
    describe('When computing CRC-32 twice', () => {
      it('Then results are identical', () => {
        // Arrange
        const sut = new Uint8Array([1, 2, 3, 4, 5]);

        // Act
        const result1 = crc32(sut);
        const result2 = crc32(sut);

        // Assert
        expect(result1).toBe(result2);
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given any data', () => {
      describe('When computing CRC-32 twice', () => {
        it('Then results are identical (deterministic)', () => {
          // Arrange
          fc.assert(
            fc.property(fc.uint8Array({ maxLength: 10000 }), (data) => {
              // Act
              const sut = crc32(data);

              // Assert
              expect(sut).toBe(crc32(data));
            }),
          );
        });
      });
      describe('When computing CRC-32', () => {
        it('Then result is unsigned 32-bit (>= 0 and < 2^32)', () => {
          // Arrange
          fc.assert(
            fc.property(fc.uint8Array({ maxLength: 10000 }), (data) => {
              // Act
              const sut = crc32(data);

              // Assert
              expect(sut).toBeGreaterThanOrEqual(0);
              expect(sut).toBeLessThan(2 ** 32);
            }),
          );
        });
      });
    });
  });
});
