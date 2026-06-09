import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesEqual,
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
    describe('Given a byte array [0xde, 0xad]', () => {
      describe('When converting to hex', () => {
        it('Then returns "dead"', () => {
          // Arrange
          const bytes = new Uint8Array([0xde, 0xad]);

          // Act
          const sut = bytesToHex(bytes);

          // Assert
          expect(sut).toBe('dead');
        });
      });
    });

    describe('Given an empty byte array', () => {
      describe('When converting to hex', () => {
        it('Then returns empty string', () => {
          // Arrange
          const bytes = new Uint8Array([]);

          // Act
          const sut = bytesToHex(bytes);

          // Assert
          expect(sut).toBe('');
        });
      });
    });
  });

  describe('hexToBytes', () => {
    describe('Given a hex string "dead"', () => {
      describe('When converting to bytes', () => {
        it('Then returns Uint8Array [0xde, 0xad]', () => {
          // Arrange
          const hex = 'dead';

          // Act
          const sut = hexToBytes(hex);

          // Assert
          expect(sut).toEqual(new Uint8Array([0xde, 0xad]));
        });
      });
    });

    describe('Given an empty hex string', () => {
      describe('When converting to bytes', () => {
        it('Then returns empty Uint8Array', () => {
          // Arrange
          const hex = '';

          // Act
          const sut = hexToBytes(hex);

          // Assert
          expect(sut).toEqual(new Uint8Array([]));
        });
      });
    });

    describe('Given an odd-length hex string', () => {
      describe('When converting to bytes', () => {
        it('Then throws with even length message', () => {
          // Arrange
          const hex = 'abc';

          // Act + Assert
          expect(() => hexToBytes(hex)).toThrow('Hex string must have even length');
        });
      });
    });

    describe('Given a hex string with non-hex chars', () => {
      describe('When converting to bytes', () => {
        it('Then throws with invalid hex character message', () => {
          // Arrange
          const hex = 'zzzz';

          // Act + Assert
          expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
        });
      });
    });

    describe('Given a hex string with uppercase letters', () => {
      describe('When converting to bytes', () => {
        it('Then throws with invalid hex character message', () => {
          // Arrange
          const hex = 'ABCD';

          // Act + Assert
          expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
        });
      });
    });

    describe('Given a hex string with invalid char in second byte pair', () => {
      describe('When converting to bytes', () => {
        it('Then throws with position 2', () => {
          // Arrange
          const hex = 'aagb';

          // Act + Assert
          expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 2');
        });
      });
    });

    describe('Given a hex string with valid high nibble but invalid low nibble', () => {
      describe('When converting to bytes', () => {
        it('Then throws', () => {
          // Arrange — 'az': high='a' (valid), low='z' (invalid)
          const hex = 'az';

          // Act + Assert
          expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
        });
      });
    });

    describe('Given valid hex digits', () => {
      describe('When converting', () => {
        it('Then returns correct byte values for digit and letter ranges', () => {
          // Arrange — covers digits 0-9 and letters a-f
          const hex = '09af';

          // Act
          const sut = hexToBytes(hex);

          // Assert
          expect(sut).toEqual(new Uint8Array([0x09, 0xaf]));
        });
      });
    });

    describe('Given hex string with char just below digit range (dot ".")', () => {
      describe('When converting', () => {
        it('Then throws', () => {
          // Arrange — '.' is charCode 46, below '0' (48), and charCode-48 = -2 (not -1)
          const hex = '.0';

          // Act + Assert
          expect(() => hexToBytes(hex)).toThrow('Invalid hex character at position 0');
        });
      });
    });
  });

  describe('compareBytes', () => {
    describe('Given two identical byte arrays', () => {
      describe('When comparing', () => {
        it('Then returns 0', () => {
          // Arrange
          const a = new Uint8Array([1, 2, 3]);
          const b = new Uint8Array([1, 2, 3]);

          // Act
          const sut = compareBytes(a, b);

          // Assert
          expect(sut).toBe(0);
        });
      });
    });

    describe('Given [0x01] and [0x02]', () => {
      describe('When comparing', () => {
        it('Then returns negative number', () => {
          // Arrange
          const a = new Uint8Array([0x01]);
          const b = new Uint8Array([0x02]);

          // Act
          const sut = compareBytes(a, b);

          // Assert
          expect(sut).toBeLessThan(0);
        });
      });
    });

    describe('Given [0x02] and [0x01]', () => {
      describe('When comparing', () => {
        it('Then returns positive number', () => {
          // Arrange
          const a = new Uint8Array([0x02]);
          const b = new Uint8Array([0x01]);

          // Act
          const sut = compareBytes(a, b);

          // Assert
          expect(sut).toBeGreaterThan(0);
        });
      });
    });

    describe('Given [0x01, 0x02] and [0x01]', () => {
      describe('When comparing', () => {
        it('Then returns positive (longer)', () => {
          // Arrange
          const a = new Uint8Array([0x01, 0x02]);
          const b = new Uint8Array([0x01]);

          // Act
          const sut = compareBytes(a, b);

          // Assert
          expect(sut).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('bytesEqual', () => {
    describe('Given two byte arrays with identical content', () => {
      describe('When comparing for equality', () => {
        it('Then returns true', () => {
          // Arrange
          const a = new Uint8Array([0x01, 0x02, 0x03]);
          const b = new Uint8Array([0x01, 0x02, 0x03]);

          // Act
          const sut = bytesEqual(a, b);

          // Assert
          expect(sut).toBe(true);
        });
      });
    });

    describe('Given two byte arrays of different length', () => {
      describe('When comparing for equality', () => {
        it('Then returns false without comparing content', () => {
          // Arrange — b is a strict prefix of a, so the per-byte loop alone would not catch it.
          const a = new Uint8Array([0x01, 0x02]);
          const b = new Uint8Array([0x01]);

          // Act
          const sut = bytesEqual(a, b);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });

    describe('Given two equal-length arrays differing in one byte', () => {
      describe('When comparing for equality', () => {
        it('Then returns false', () => {
          // Arrange
          const a = new Uint8Array([0x01, 0x02, 0x03]);
          const b = new Uint8Array([0x01, 0x09, 0x03]);

          // Act
          const sut = bytesEqual(a, b);

          // Assert
          expect(sut).toBe(false);
        });
      });
    });
  });

  describe('indexOf', () => {
    describe('Given a byte array with target byte', () => {
      describe('When searching with indexOf', () => {
        it('Then returns correct position', () => {
          // Arrange
          const bytes = new Uint8Array([10, 20, 30, 40]);

          // Act
          const sut = indexOf(bytes, 30, 0);

          // Assert
          expect(sut).toBe(2);
        });
      });
    });

    describe('Given a byte array without target byte', () => {
      describe('When searching with indexOf', () => {
        it('Then returns -1', () => {
          // Arrange
          const bytes = new Uint8Array([10, 20, 30]);

          // Act
          const sut = indexOf(bytes, 99, 0);

          // Assert
          expect(sut).toBe(-1);
        });
      });
    });

    describe('Given fromIndex beyond array length', () => {
      describe('When searching with indexOf', () => {
        it('Then returns -1', () => {
          // Arrange
          const bytes = new Uint8Array([10, 20, 30]);

          // Act
          const sut = indexOf(bytes, 10, 100);

          // Assert
          expect(sut).toBe(-1);
        });
      });
    });

    describe('Given target byte at fromIndex position', () => {
      describe('When searching with indexOf', () => {
        it('Then returns fromIndex', () => {
          // Arrange
          const bytes = new Uint8Array([10, 20, 30, 40]);

          // Act
          const sut = indexOf(bytes, 20, 1);

          // Assert
          expect(sut).toBe(1);
        });
      });
    });

    describe('Given target byte only before fromIndex', () => {
      describe('When searching with indexOf', () => {
        it('Then returns -1', () => {
          // Arrange
          const bytes = new Uint8Array([10, 20, 30]);

          // Act
          const sut = indexOf(bytes, 10, 1);

          // Assert
          expect(sut).toBe(-1);
        });
      });
    });

    describe('Given target byte at last position', () => {
      describe('When searching from start', () => {
        it('Then returns last index', () => {
          // Arrange
          const bytes = new Uint8Array([10, 20, 30]);

          // Act
          const sut = indexOf(bytes, 30, 0);

          // Assert
          expect(sut).toBe(2);
        });
      });
    });
  });

  describe('encode / decode', () => {
    describe('Given a string', () => {
      describe('When encoding to bytes', () => {
        it('Then returns UTF-8 Uint8Array', () => {
          // Arrange
          const str = 'hello';

          // Act
          const sut = encode(str);

          // Assert
          expect(sut).toEqual(new Uint8Array([104, 101, 108, 108, 111]));
        });
      });
    });

    describe('Given a Uint8Array', () => {
      describe('When decoding to string', () => {
        it('Then returns UTF-8 string', () => {
          // Arrange
          const bytes = new Uint8Array([104, 101, 108, 108, 111]);

          // Act
          const sut = decode(bytes);

          // Assert
          expect(sut).toBe('hello');
        });
      });
    });

    describe('Given an empty string', () => {
      describe('When encoding to bytes', () => {
        it('Then returns empty Uint8Array', () => {
          // Arrange
          const str = '';

          // Act
          const sut = encode(str);

          // Assert
          expect(sut).toEqual(new Uint8Array([]));
        });
      });
    });

    describe('Given multi-byte UTF-8 chars', () => {
      describe('When encoding then decoding', () => {
        it('Then roundtrips correctly', () => {
          // Arrange
          const str = '日本語🚀';

          // Act
          const sut = decode(encode(str));

          // Assert
          expect(sut).toBe(str);
        });
      });
    });
  });

  describe('splitHeaderAndMessage', () => {
    describe('Given text with blank line', () => {
      describe('When splitting', () => {
        it('Then headerPart and message are separated', () => {
          // Arrange
          const text = 'header1\nheader2\n\nmessage body';

          // Act
          const sut = splitHeaderAndMessage(text);

          // Assert
          expect(sut).toEqual({ headerPart: 'header1\nheader2', message: 'message body' });
        });
      });
    });

    describe('Given text without blank line', () => {
      describe('When splitting', () => {
        it('Then message is empty', () => {
          // Arrange
          const text = 'header only';

          // Act
          const sut = splitHeaderAndMessage(text);

          // Assert
          expect(sut).toEqual({ headerPart: 'header only', message: '' });
        });
      });
    });
  });

  describe('formatContinuationHeader', () => {
    describe('Given single-line value', () => {
      describe('When formatting', () => {
        it('Then returns key + space + value', () => {
          // Arrange & Act
          const sut = formatContinuationHeader('gpgsig', 'value');

          // Assert
          expect(sut).toBe('gpgsig value');
        });
      });
    });

    describe('Given multi-line value', () => {
      describe('When formatting', () => {
        it('Then continuation lines are prefixed with space', () => {
          // Arrange & Act
          const sut = formatContinuationHeader('gpgsig', 'line1\nline2\nline3');

          // Assert
          expect(sut).toBe('gpgsig line1\n line2\n line3');
        });
      });
    });

    describe('Given key containing newline', () => {
      describe('When formatting', () => {
        it('Then throws', () => {
          // Arrange & Act & Assert
          expect(() => formatContinuationHeader('bad\nkey', 'value')).toThrow('invalid header key');
        });
      });
    });

    describe('Given key containing space', () => {
      describe('When formatting', () => {
        it('Then throws', () => {
          // Arrange & Act & Assert
          expect(() => formatContinuationHeader('bad key', 'value')).toThrow('invalid header key');
        });
      });
    });

    describe('Given empty key', () => {
      describe('When formatting', () => {
        it('Then throws', () => {
          // Arrange & Act & Assert
          expect(() => formatContinuationHeader('', 'value')).toThrow('invalid header key');
        });
      });
    });
  });

  describe('parseHeaderLine', () => {
    describe('Given line with space', () => {
      describe('When parsing', () => {
        it('Then key and value are split', () => {
          // Arrange & Act
          const sut = parseHeaderLine('key value here');

          // Assert
          expect(sut).toEqual({ key: 'key', value: 'value here' });
        });
      });
    });

    describe('Given line without space', () => {
      describe('When parsing', () => {
        it('Then value is empty string', () => {
          // Arrange & Act
          const sut = parseHeaderLine('keyonly');

          // Assert
          expect(sut).toEqual({ key: 'keyonly', value: '' });
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given the roundtrip property "bytesToHex(hexToBytes(hex)) === hex for any valid even-length hex string"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange + Assert
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
      });
    });

    describe('Given the roundtrip property "hexToBytes(bytesToHex(bytes)) equals original bytes"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (bytes) => {
              const sut = hexToBytes(bytesToHex(bytes));
              expect(sut).toEqual(bytes);
            }),
          );
        });
      });
    });

    describe('Given the reflexive property "compareBytes(a, a) === 0 for any array"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange + Assert
          fc.assert(
            fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (a) => {
              const sut = compareBytes(a, a);
              expect(sut).toBe(0);
            }),
          );
        });
      });
    });

    describe('Given the antisymmetric property "Math.sign(compareBytes(a, b)) === -Math.sign(compareBytes(b, a))"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange + Assert
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
  });
});
