import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { hasNonOctalByte } from '../../../../src/domain/objects/tree-entry-bytes.js';

describe('hasNonOctalByte', () => {
  describe("Given a single-byte span at the low octal boundary (0x30, '0')", () => {
    describe('When scanning', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x30);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe("Given a single-byte span at the high octal boundary (0x37, '7')", () => {
    describe('When scanning', () => {
      it('Then returns false', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x37);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe("Given a single-byte span just above the high octal boundary (0x38, '8')", () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x38);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a single-byte span holding a slash', () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x2f);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a single-byte span holding NUL', () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x00);

        // Act
        const result = sut(buf, 0, 1);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given an empty span (start === end)', () => {
    describe('When scanning', () => {
      it('Then returns false', () => {
        // Arrange — a non-octal byte sits just outside the (empty) span
        const sut = hasNonOctalByte;
        const buf = Uint8Array.of(0x38);

        // Act
        const result = sut(buf, 0, 0);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a span of otherwise-octal bytes whose last byte is non-octal', () => {
    describe('When scanning', () => {
      it('Then returns true', () => {
        // Arrange — a loop that stops one short of `end` would miss this byte
        const sut = hasNonOctalByte;
        const buf = encode('10064a');

        // Act
        const result = sut(buf, 0, buf.length);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});
