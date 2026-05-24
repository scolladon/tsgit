import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../../../../src/domain/storage/crc32.js';

describe('crc32', () => {
  it('Given empty data, When computing CRC-32, Then returns 0x00000000', () => {
    // Arrange
    const sut = new Uint8Array(0);

    // Act
    const result = crc32(sut);

    // Assert
    expect(result).toBe(0x00000000);
  });

  it("Given ASCII '123456789', When computing CRC-32, Then returns 0xCBF43926", () => {
    // Arrange
    const sut = new TextEncoder().encode('123456789');

    // Act
    const result = crc32(sut);

    // Assert
    expect(result).toBe(0xcbf43926);
  });

  it("Given ASCII 'PACK', When computing CRC-32, Then returns known value", () => {
    // Arrange
    const sut = new TextEncoder().encode('PACK');

    // Act
    const result = crc32(sut);

    // Assert — pre-computed with reference implementation
    expect(result).toBe(0xa14bb397);
  });

  it('Given a single byte [0x00], When computing CRC-32, Then returns known value', () => {
    // Arrange
    const sut = new Uint8Array([0x00]);

    // Act
    const result = crc32(sut);

    // Assert
    expect(result).toBe(0xd202ef8d);
  });

  it('Given a single byte [0xFF], When computing CRC-32, Then returns known value', () => {
    // Arrange
    const sut = new Uint8Array([0xff]);

    // Act
    const result = crc32(sut);

    // Assert
    expect(result).toBe(0xff000000);
  });

  it('Given 1000 zero bytes, When computing CRC-32, Then returns known value', () => {
    // Arrange
    const sut = new Uint8Array(1000);

    // Act
    const result = crc32(sut);

    // Assert
    expect(result).toBe(0x060b1780);
  });

  it('Given any data, When computing CRC-32 twice, Then results are identical', () => {
    // Arrange
    const sut = new Uint8Array([1, 2, 3, 4, 5]);

    // Act
    const result1 = crc32(sut);
    const result2 = crc32(sut);

    // Assert
    expect(result1).toBe(result2);
  });

  describe('property-based tests', () => {
    it('Given any data, When computing CRC-32 twice, Then results are identical (deterministic)', () => {
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

    it('Given any data, When computing CRC-32, Then result is unsigned 32-bit (>= 0 and < 2^32)', () => {
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
