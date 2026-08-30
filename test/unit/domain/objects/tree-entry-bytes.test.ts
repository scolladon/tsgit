import { describe, expect, it } from 'vitest';

import { encode } from '../../../../src/domain/objects/encoding.js';
import { entryNameKey, hasNonOctalByte } from '../../../../src/domain/objects/tree-entry-bytes.js';

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

describe('entryNameKey', () => {
  describe(
    'Given the six bytes that a windows-1252-aliased latin1 decoder would remap ' +
      '(0xFF, 0xFE, 0x81, 0x8D, 0x90, 0x9D)',
    () => {
      describe('When keying each one-byte span', () => {
        it('Then every byte produces a distinct key', () => {
          // Arrange
          const sut = entryNameKey;
          const bytes = [0xff, 0xfe, 0x81, 0x8d, 0x90, 0x9d];

          // Act
          const keys = bytes.map((byte) => sut(Uint8Array.of(byte), 0, 1));

          // Assert
          expect(new Set(keys).size).toBe(bytes.length);
        });
      });
    },
  );

  describe('Given a 4097-byte name spanning multiple chunk boundaries', () => {
    describe('When keying the whole span', () => {
      it('Then returns a 4097-code-unit key with the right byte at each chunk edge', () => {
        // Arrange — a loop that drops, duplicates, or shifts a byte at a chunk
        // boundary (chunk size 1024) would corrupt content, not just length.
        const sut = entryNameKey;
        const buf = new Uint8Array(4097);
        for (let i = 0; i < buf.length; i++) buf[i] = i % 256;

        // Act
        const result = sut(buf, 0, buf.length);

        // Assert
        expect(result).toHaveLength(4097);
        expect(result.charCodeAt(0)).toBe(0);
        expect(result.charCodeAt(1023)).toBe(1023 % 256);
        expect(result.charCodeAt(1024)).toBe(1024 % 256);
        expect(result.charCodeAt(4096)).toBe(4096 % 256);
      });
    });
  });

  describe('Given an empty span (start === end)', () => {
    describe('When keying', () => {
      it('Then returns the empty string', () => {
        // Arrange
        const sut = entryNameKey;
        const buf = Uint8Array.of(0x61);

        // Act
        const result = sut(buf, 0, 0);

        // Assert
        expect(result).toBe('');
      });
    });
  });
});
