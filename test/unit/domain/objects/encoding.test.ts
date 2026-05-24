import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesToHex,
  compareBytes,
  decode,
  encode,
  formatContinuationHeader,
  hexToBytes,
  indexOf,
  parseHeaderLine,
  splitHeaderAndMessage,
} from '../../../../src/domain/objects/encoding.js';

describe('encoding', () => {
  describe('bytesToHex', () => {
    it('Given a byte array [0xde, 0xad], When converting to hex, Then returns "dead"', () => {
      // Arrange
      const bytes = new Uint8Array([0xde, 0xad]);

      // Act
      const sut = bytesToHex(bytes);

      // Assert
      expect(sut).toBe('dead');
    });

    it('Given an empty byte array, When converting to hex, Then returns empty string', () => {
      // Arrange
      const bytes = new Uint8Array([]);

      // Act
      const sut = bytesToHex(bytes);

      // Assert
      expect(sut).toBe('');
    });
  });

  describe('hexToBytes', () => {
    it('Given a hex string "dead", When converting to bytes, Then returns Uint8Array [0xde, 0xad]', () => {
      // Arrange
      const hex = 'dead';

      // Act
      const sut = hexToBytes(hex);

      // Assert
      expect(sut).toEqual(new Uint8Array([0xde, 0xad]));
    });

    it('Given an empty hex string, When converting to bytes, Then returns empty Uint8Array', () => {
      // Arrange
      const hex = '';

      // Act
      const sut = hexToBytes(hex);

      // Assert
      expect(sut).toEqual(new Uint8Array([]));
    });

    it('Given an odd-length hex string, When converting to bytes, Then throws with even length message', () => {
      // Arrange
      const hex = 'abc';

      // Act & Assert
      // Assert
      expect(() => hexToBytes(hex)).toThrow('Hex string must have even length');
    });

    it('Given a hex string with non-hex chars, When converting to bytes, Then throws with invalid hex character message', () => {
      // Arrange
      const hex = 'zzzz';

      // Act & Assert
      // Assert
      expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
    });

    it('Given a hex string with uppercase letters, When converting to bytes, Then throws with invalid hex character message', () => {
      // Arrange
      const hex = 'ABCD';

      // Act & Assert
      // Assert
      expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
    });

    it('Given a hex string with invalid char in second byte pair, When converting to bytes, Then throws with position 2', () => {
      // Arrange
      const hex = 'aagb';

      // Act & Assert
      // Assert
      expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 2');
    });

    it('Given a hex string with valid high nibble but invalid low nibble, When converting to bytes, Then throws', () => {
      // Arrange — 'az': high='a' (valid), low='z' (invalid)
      const hex = 'az';

      // Act & Assert
      // Assert
      expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
    });

    it('Given valid hex digits, When converting, Then returns correct byte values for digit and letter ranges', () => {
      // Arrange — covers digits 0-9 and letters a-f
      const hex = '09af';

      // Act
      const sut = hexToBytes(hex);

      // Assert
      expect(sut).toEqual(new Uint8Array([0x09, 0xaf]));
    });

    it('Given hex string with char just below digit range (dot "."), When converting, Then throws', () => {
      // Arrange — '.' is charCode 46, below '0' (48), and charCode-48 = -2 (not -1)
      const hex = '.0';

      // Act & Assert
      // Assert
      expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
    });
  });

  describe('compareBytes', () => {
    it('Given two identical byte arrays, When comparing, Then returns 0', () => {
      // Arrange
      const a = new Uint8Array([1, 2, 3]);
      const b = new Uint8Array([1, 2, 3]);

      // Act
      const sut = compareBytes(a, b);

      // Assert
      expect(sut).toBe(0);
    });

    it('Given [0x01] and [0x02], When comparing, Then returns negative number', () => {
      // Arrange
      const a = new Uint8Array([0x01]);
      const b = new Uint8Array([0x02]);

      // Act
      const sut = compareBytes(a, b);

      // Assert
      expect(sut).toBeLessThan(0);
    });

    it('Given [0x02] and [0x01], When comparing, Then returns positive number', () => {
      // Arrange
      const a = new Uint8Array([0x02]);
      const b = new Uint8Array([0x01]);

      // Act
      const sut = compareBytes(a, b);

      // Assert
      expect(sut).toBeGreaterThan(0);
    });

    it('Given [0x01, 0x02] and [0x01], When comparing, Then returns positive (longer)', () => {
      // Arrange
      const a = new Uint8Array([0x01, 0x02]);
      const b = new Uint8Array([0x01]);

      // Act
      const sut = compareBytes(a, b);

      // Assert
      expect(sut).toBeGreaterThan(0);
    });
  });

  describe('indexOf', () => {
    it('Given a byte array with target byte, When searching with indexOf, Then returns correct position', () => {
      // Arrange
      const bytes = new Uint8Array([10, 20, 30, 40]);

      // Act
      const sut = indexOf(bytes, 30, 0);

      // Assert
      expect(sut).toBe(2);
    });

    it('Given a byte array without target byte, When searching with indexOf, Then returns -1', () => {
      // Arrange
      const bytes = new Uint8Array([10, 20, 30]);

      // Act
      const sut = indexOf(bytes, 99, 0);

      // Assert
      expect(sut).toBe(-1);
    });

    it('Given fromIndex beyond array length, When searching with indexOf, Then returns -1', () => {
      // Arrange
      const bytes = new Uint8Array([10, 20, 30]);

      // Act
      const sut = indexOf(bytes, 10, 100);

      // Assert
      expect(sut).toBe(-1);
    });

    it('Given target byte at fromIndex position, When searching with indexOf, Then returns fromIndex', () => {
      // Arrange
      const bytes = new Uint8Array([10, 20, 30, 40]);

      // Act
      const sut = indexOf(bytes, 20, 1);

      // Assert
      expect(sut).toBe(1);
    });

    it('Given target byte only before fromIndex, When searching with indexOf, Then returns -1', () => {
      // Arrange
      const bytes = new Uint8Array([10, 20, 30]);

      // Act
      const sut = indexOf(bytes, 10, 1);

      // Assert
      expect(sut).toBe(-1);
    });

    it('Given target byte at last position, When searching from start, Then returns last index', () => {
      // Arrange
      const bytes = new Uint8Array([10, 20, 30]);

      // Act
      const sut = indexOf(bytes, 30, 0);

      // Assert
      expect(sut).toBe(2);
    });
  });

  describe('encode / decode', () => {
    it('Given a string, When encoding to bytes, Then returns UTF-8 Uint8Array', () => {
      // Arrange
      const str = 'hello';

      // Act
      const sut = encode(str);

      // Assert
      expect(sut).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
    });

    it('Given a Uint8Array, When decoding to string, Then returns UTF-8 string', () => {
      // Arrange
      const bytes = new Uint8Array([104, 101, 108, 108, 111]);

      // Act
      const sut = decode(bytes);

      // Assert
      expect(sut).toBe('hello');
    });

    it('Given an empty string, When encoding to bytes, Then returns empty Uint8Array', () => {
      // Arrange
      const str = '';

      // Act
      const sut = encode(str);

      // Assert
      expect(sut).toEqual(new Uint8Array([]));
    });

    it('Given multi-byte UTF-8 chars, When encoding then decoding, Then roundtrips correctly', () => {
      // Arrange
      const str = '日本語🚀';

      // Act
      const sut = decode(encode(str));

      // Assert
      expect(sut).toBe(str);
    });
  });

  describe('splitHeaderAndMessage', () => {
    it('Given text with blank line, When splitting, Then headerPart and message are separated', () => {
      // Arrange
      const text = 'header1\nheader2\n\nmessage body';

      // Act
      const sut = splitHeaderAndMessage(text);

      // Assert
      expect(sut).toEqual({ headerPart: 'header1\nheader2', message: 'message body' });
    });

    it('Given text without blank line, When splitting, Then message is empty', () => {
      // Arrange
      const text = 'header only';

      // Act
      const sut = splitHeaderAndMessage(text);

      // Assert
      expect(sut).toEqual({ headerPart: 'header only', message: '' });
    });
  });

  describe('formatContinuationHeader', () => {
    it('Given single-line value, When formatting, Then returns key + space + value', () => {
      // Arrange & Act
      const sut = formatContinuationHeader('gpgsig', 'value');

      // Assert
      expect(sut).toBe('gpgsig value');
    });

    it('Given multi-line value, When formatting, Then continuation lines are prefixed with space', () => {
      // Arrange & Act
      const sut = formatContinuationHeader('gpgsig', 'line1\nline2\nline3');

      // Assert
      expect(sut).toBe('gpgsig line1\n line2\n line3');
    });

    it('Given key containing newline, When formatting, Then throws', () => {
      // Arrange & Act & Assert
      // Assert
      expect(() => formatContinuationHeader('bad\nkey', 'value')).toThrow('invalid header key');
    });

    it('Given key containing space, When formatting, Then throws', () => {
      // Arrange & Act & Assert
      // Assert
      expect(() => formatContinuationHeader('bad key', 'value')).toThrow('invalid header key');
    });

    it('Given empty key, When formatting, Then throws', () => {
      // Arrange & Act & Assert
      // Assert
      expect(() => formatContinuationHeader('', 'value')).toThrow('invalid header key');
    });
  });

  describe('parseHeaderLine', () => {
    it('Given line with space, When parsing, Then key and value are split', () => {
      // Arrange & Act
      const sut = parseHeaderLine('key value here');

      // Assert
      expect(sut).toEqual({ key: 'key', value: 'value here' });
    });

    it('Given line without space, When parsing, Then value is empty string', () => {
      // Arrange & Act
      const sut = parseHeaderLine('keyonly');

      // Assert
      expect(sut).toEqual({ key: 'keyonly', value: '' });
    });
  });

  describe('property-based tests', () => {
    it('Roundtrip: bytesToHex(hexToBytes(hex)) === hex for any valid even-length hex string', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 100 }).map((bytes) =>
            Array.from(bytes)
              .map((b) => b.toString(16).padStart(2, '0'))
              .join(''),
          ),
          (hex) => {
            const sut = bytesToHex(hexToBytes(hex));
            expect(sut).toBe(hex);
          },
        ),
      );
    });

    it('Roundtrip: hexToBytes(bytesToHex(bytes)) equals original bytes', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (bytes) => {
          const sut = hexToBytes(bytesToHex(bytes));
          expect(sut).toEqual(bytes);
        }),
      );
    });

    it('Reflexive: compareBytes(a, a) === 0 for any array', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (a) => {
          const sut = compareBytes(a, a);
          expect(sut).toBe(0);
        }),
      );
    });

    it('Antisymmetric: Math.sign(compareBytes(a, b)) === -Math.sign(compareBytes(b, a))', () => {
      // Arrange
      // Assert
      fc.assert(
        fc.property(
          fc.uint8Array({ minLength: 0, maxLength: 50 }),
          fc.uint8Array({ minLength: 0, maxLength: 50 }),
          (a, b) => {
            const ab = compareBytes(a, b);
            const ba = compareBytes(b, a);
            if (ab === 0) {
              expect(ba).toBe(0);
            } else {
              expect(Math.sign(ab)).toBe(-Math.sign(ba));
            }
          },
        ),
      );
    });
  });
});
