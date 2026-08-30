import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesEqual,
  bytesToHex,
  compareBytes,
  concatBytes,
  decode,
  decodePreservingBom,
  encode,
  formatContinuationHeader,
  hexToBytes,
  indexOf,
  parseHeaderLine,
  splitHeaderAndMessage,
} from '../../../../src/domain/objects/encoding.js';

describe('encoding', () => {
  describe('bytesToHex', () => {
    describe('Given a byte array', () => {
      describe('When converting to hex', () => {
        it.each([
          { bytes: [0xde, 0xad], expected: 'dead' },
          { bytes: [], expected: '' },
        ])('Then returns "$expected"', ({ bytes, expected }) => {
          // Arrange
          const array = new Uint8Array(bytes);

          // Act
          const result = bytesToHex(array);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('hexToBytes', () => {
    describe('Given a valid hex string', () => {
      describe('When converting to bytes', () => {
        it.each([
          { hex: 'dead', expected: [0xde, 0xad], label: 'a hex string' },
          { hex: '', expected: [], label: 'an empty hex string' },
          { hex: '09af', expected: [0x09, 0xaf], label: 'digits and letters a-f' },
        ])('Then $label returns the correct bytes', ({ hex, expected }) => {
          // Arrange & Act
          const result = hexToBytes(hex);

          // Assert
          expect(result).toEqual(new Uint8Array(expected));
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

    // Each row isolates one boundary of `parseHexDigit`'s digit/letter ranges,
    // at a mix of high/low nibble and byte-pair position, so a StringLiteral or
    // off-by-one mutant on the position, or a range-boundary mutant, cannot survive.
    describe('Given a hex string with an invalid character', () => {
      describe('When converting to bytes', () => {
        it.each([
          { hex: 'zzzz', position: 0, label: 'chars above the letter range (both nibbles)' },
          { hex: 'ABCD', position: 0, label: 'uppercase letters (the gap between digits and a-f)' },
          {
            hex: 'aagb',
            position: 2,
            label: 'a valid high nibble but an above-range low nibble, in the second byte pair',
          },
          { hex: 'az', position: 0, label: 'a valid high nibble but an invalid low nibble' },
          { hex: '.0', position: 0, label: 'a char just below the digit range' },
        ])(
          'Then throws with invalid hex character at position $position for $label',
          ({ hex, position }) => {
            // Arrange & Act + Assert
            expect(() => hexToBytes(hex)).toThrow(`Invalid hex character at position ${position}`);
          },
        );
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
          const result = compareBytes(a, b);

          // Assert
          expect(result).toBe(0);
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
          const result = compareBytes(a, b);

          // Assert
          expect(result).toBeLessThan(0);
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
          const result = compareBytes(a, b);

          // Assert
          expect(result).toBeGreaterThan(0);
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
          const result = compareBytes(a, b);

          // Assert
          expect(result).toBeGreaterThan(0);
        });
      });
    });
  });

  describe('bytesEqual', () => {
    // Each row isolates one branch: length-mismatch short-circuit, per-byte
    // early-return, and the fallthrough true — b in the length-mismatch row is
    // a strict prefix of a, so the per-byte loop alone would not catch it.
    describe('Given two byte arrays', () => {
      describe('When comparing for equality', () => {
        it.each([
          {
            a: [0x01, 0x02, 0x03],
            b: [0x01, 0x02, 0x03],
            expected: true,
            label: 'identical content',
          },
          { a: [0x01, 0x02], b: [0x01], expected: false, label: 'different length' },
          {
            a: [0x01, 0x02, 0x03],
            b: [0x01, 0x09, 0x03],
            expected: false,
            label: 'equal length differing in one byte',
          },
        ])('Then $label returns $expected', ({ a, b, expected }) => {
          // Arrange
          const arrayA = new Uint8Array(a);
          const arrayB = new Uint8Array(b);

          // Act
          const result = bytesEqual(arrayA, arrayB);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('indexOf', () => {
    describe('Given a byte array and a search start position', () => {
      describe('When searching with indexOf', () => {
        it.each([
          {
            bytes: [10, 20, 30, 40],
            target: 30,
            fromIndex: 0,
            expected: 2,
            label: 'the target is found',
          },
          {
            bytes: [10, 20, 30],
            target: 99,
            fromIndex: 0,
            expected: -1,
            label: 'the target is absent',
          },
          {
            bytes: [10, 20, 30],
            target: 10,
            fromIndex: 100,
            expected: -1,
            label: 'fromIndex is beyond the array length',
          },
          {
            bytes: [10, 20, 30, 40],
            target: 20,
            fromIndex: 1,
            expected: 1,
            label: 'the target sits exactly at fromIndex',
          },
          {
            bytes: [10, 20, 30],
            target: 10,
            fromIndex: 1,
            expected: -1,
            label: 'the target occurs only before fromIndex',
          },
          {
            bytes: [10, 20, 30],
            target: 30,
            fromIndex: 0,
            expected: 2,
            label: 'the target is the last element',
          },
        ])('Then $label, returns $expected', ({ bytes, target, fromIndex, expected }) => {
          // Arrange
          const array = new Uint8Array(bytes);

          // Act
          const result = indexOf(array, target, fromIndex);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('encode / decode', () => {
    describe('Given a string', () => {
      describe('When encoding to bytes', () => {
        it.each([
          { str: 'hello', expected: [104, 101, 108, 108, 111] },
          { str: '', expected: [] },
        ])('Then returns the UTF-8 Uint8Array for "$str"', ({ str, expected }) => {
          // Arrange & Act
          const result = encode(str);

          // Assert
          expect(result).toEqual(new Uint8Array(expected));
        });
      });
    });

    describe('Given a Uint8Array', () => {
      describe('When decoding to string', () => {
        it('Then returns UTF-8 string', () => {
          // Arrange
          const bytes = new Uint8Array([104, 101, 108, 108, 111]);

          // Act
          const result = decode(bytes);

          // Assert
          expect(result).toBe('hello');
        });
      });
    });

    describe('Given multi-byte UTF-8 chars', () => {
      describe('When encoding then decoding', () => {
        it('Then roundtrips correctly', () => {
          // Arrange
          const str = '日本語🚀';

          // Act
          const result = decode(encode(str));

          // Assert
          expect(result).toBe(str);
        });
      });
    });
  });

  describe('decodePreservingBom', () => {
    describe('Given bytes starting with a UTF-8 byte-order mark', () => {
      describe('When decoding', () => {
        it('Then the BOM character (U+FEFF) is kept at the start of the result', () => {
          // Arrange
          const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]);

          // Act
          const result = decodePreservingBom(bytes);

          // Assert
          expect(result).toBe('\uFEFFhi');
        });
      });
    });

    describe('Given bytes without a byte-order mark', () => {
      describe('When decoding', () => {
        it('Then it decodes identically to decode', () => {
          // Arrange
          const bytes = new Uint8Array([104, 101, 108, 108, 111]);

          // Act
          const result = decodePreservingBom(bytes);

          // Assert
          expect(result).toBe(decode(bytes));
        });
      });
    });
  });

  describe('splitHeaderAndMessage', () => {
    describe('Given text', () => {
      describe('When splitting', () => {
        it.each([
          {
            text: 'header1\nheader2\n\nmessage body',
            expected: { headerPart: 'header1\nheader2', message: 'message body' },
            label: 'a blank line separates headerPart and message',
          },
          {
            text: 'header only',
            expected: { headerPart: 'header only', message: '' },
            label: 'no blank line leaves message empty',
          },
        ])('Then $label', ({ text, expected }) => {
          // Arrange & Act
          const result = splitHeaderAndMessage(text);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });
  });

  describe('formatContinuationHeader', () => {
    describe('Given single-line value', () => {
      describe('When formatting', () => {
        it('Then returns key + space + value', () => {
          // Arrange & Act
          const result = formatContinuationHeader('gpgsig', 'value');

          // Assert
          expect(result).toBe('gpgsig value');
        });
      });
    });

    describe('Given multi-line value', () => {
      describe('When formatting', () => {
        it('Then continuation lines are prefixed with space', () => {
          // Arrange & Act
          const result = formatContinuationHeader('gpgsig', 'line1\nline2\nline3');

          // Assert
          expect(result).toBe('gpgsig line1\n line2\n line3');
        });
      });
    });

    // Each row isolates one condition of the `key.includes('\n') ||
    // key.includes(' ') || key === ''` guard.
    describe('Given an invalid key', () => {
      describe('When formatting', () => {
        it.each([
          { key: 'bad\nkey', label: 'containing a newline' },
          { key: 'bad key', label: 'containing a space' },
          { key: '', label: 'empty' },
        ])('Then throws for a key $label', ({ key }) => {
          // Arrange & Act & Assert
          expect(() => formatContinuationHeader(key, 'value')).toThrow('invalid header key');
        });
      });
    });
  });

  describe('parseHeaderLine', () => {
    describe('Given a line', () => {
      describe('When parsing', () => {
        it.each([
          {
            line: 'key value here',
            expected: { key: 'key', value: 'value here' },
            label: 'with a space, the key and value are split',
          },
          {
            line: 'keyonly',
            expected: { key: 'keyonly', value: '' },
            label: 'without a space, the value is the empty string',
          },
        ])('Then $label', ({ line, expected }) => {
          // Arrange & Act
          const result = parseHeaderLine(line);

          // Assert
          expect(result).toEqual(expected);
        });
      });
    });
  });

  describe('property-based tests', () => {
    describe('Given the roundtrip property "bytesToHex(hexToBytes(hex)) === hex for any valid even-length hex string"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange
          fc.assert(
            fc.property(
              fc.uint8Array({ minLength: 0, maxLength: 100 }).map((bytes) =>
                Array.from(bytes)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(''),
              ),
              (hex) => {
                // Act
                const result = bytesToHex(hexToBytes(hex));

                // Assert
                expect(result).toBe(hex);
              },
            ),
          );
        });
      });
    });

    describe('Given the roundtrip property "hexToBytes(bytesToHex(bytes)) equals original bytes"', () => {
      describe('When sampled', () => {
        it('Then it holds', () => {
          // Arrange
          fc.assert(
            fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (bytes) => {
              // Act
              const result = hexToBytes(bytesToHex(bytes));

              // Assert
              expect(result).toEqual(bytes);
            }),
          );
        });
      });
    });

    describe('Given the reflexive property "compareBytes(a, a) === 0 for any array"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange
          fc.assert(
            fc.property(fc.uint8Array({ minLength: 0, maxLength: 100 }), (a) => {
              // Act
              const result = compareBytes(a, a);

              // Assert
              expect(result).toBe(0);
            }),
          );
        });
      });
    });

    describe('Given the antisymmetric property "Math.sign(compareBytes(a, b)) === -Math.sign(compareBytes(b, a))"', () => {
      describe('When checked', () => {
        it('Then it holds', () => {
          // Arrange
          fc.assert(
            fc.property(
              fc.uint8Array({ minLength: 0, maxLength: 50 }),
              fc.uint8Array({ minLength: 0, maxLength: 50 }),
              (a, b) => {
                // Act
                const ab = compareBytes(a, b);
                const ba = compareBytes(b, a);

                // Assert
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

  describe('concatBytes', () => {
    describe('Given an empty list of parts', () => {
      describe('When concatenating', () => {
        it('Then returns a zero-length buffer', () => {
          // Arrange
          const parts: ReadonlyArray<Uint8Array> = [];

          // Act
          const result = concatBytes(parts);

          // Assert
          expect(result).toEqual(new Uint8Array(0));
        });
      });
    });

    describe('Given several byte parts', () => {
      describe('When concatenating', () => {
        it('Then the parts land in order with additive length', () => {
          // Arrange
          const parts = [
            Uint8Array.of(1, 2),
            new Uint8Array(0),
            Uint8Array.of(3),
            Uint8Array.of(4, 5),
          ];

          // Act
          const result = concatBytes(parts);

          // Assert
          expect(result).toEqual(Uint8Array.of(1, 2, 3, 4, 5));
        });
      });
    });
  });
});
