import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bytesEqual,
  bytesToHex,
  compareBytes,
  concatBytes,
  decode,
  decodeEscapingInvalid,
  decodePreservingBom,
  decodesLosslessly,
  encode,
  encodeEscaped,
  formatContinuationHeader,
  hasEscapedBytes,
  hexToBytes,
  indexOf,
  parseHeaderLine,
  splitHeaderAndMessage,
  wellFormed,
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

    describe('Given every byte value from 0x00 to 0xff', () => {
      describe('When converting to hex', () => {
        it('Then each byte renders as two lowercase digits, zero-padded', () => {
          // Arrange
          const array = Uint8Array.from({ length: 256 }, (_, byte) => byte);
          const expected = Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');

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

  describe('decodesLosslessly', () => {
    const cases: ReadonlyArray<readonly [string, number[], boolean]> = [
      ['ascii', [0x61, 0x2e, 0x74], true],
      ['a valid two-byte sequence', [0xc3, 0xa9], true],
      ['a leading byte-order mark', [0xef, 0xbb, 0xbf, 0x61], true],
      ['a literal replacement character', [0xef, 0xbf, 0xbd], true],
      ['a lone 0xff', [0xff], false],
      ['a lone continuation byte', [0x80], false],
      ['a truncated sequence', [0xc3], false],
      ['an overlong sequence', [0xc0, 0xaf], false],
      ['an encoded surrogate', [0xed, 0xa0, 0x80], false],
      ['a byte above the unicode range', [0xf5], false],
    ];

    describe.each(cases)('Given %s', (_label, input, expected) => {
      describe('When checking the decoded view against the raw bytes', () => {
        it(`Then it is ${expected ? 'lossless' : 'lossy'}`, () => {
          // Arrange
          const raw = Uint8Array.from(input);
          const text = decodePreservingBom(raw);

          // Act
          const result = decodesLosslessly(text, raw);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('decodeEscapingInvalid', () => {
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<number>, string]> = [
      ['a rejected lead byte before ascii', [0xff, 0x2e, 0x74], '\uDCFF.t'],
      ['a lone continuation byte', [0x80], '\uDC80'],
      ['a truncated two-byte lead', [0xc3], '\uDCC3'],
      ['an overlong two-byte lead', [0xc0, 0xaf], '\uDCC0\uDCAF'],
      ['an encoded surrogate', [0xed, 0xa0, 0x80], '\uDCED\uDCA0\uDC80'],
      ['a byte above the unicode range', [0xf5], '\uDCF5'],
      ['a truncated three-byte sequence', [0xe2, 0x80, 0x41], '\uDCE2\uDC80A'],
      ['a valid non-character code point', [0xef, 0xbf, 0xbe], '￾'],
      ['a literal replacement character', [0xef, 0xbf, 0xbd], '�'],
      ['a leading byte-order mark', [0xef, 0xbb, 0xbf, 0x61], '﻿a'],
      ['a valid astral sequence', [0xf0, 0x90, 0x82, 0x80], '\u{10080}'],
      ['an overlong lead C1 then an invalid byte', [0xc1, 0xbf, 0xff], '\uDCC1\uDCBF\uDCFF'],
      ['the lowest two-byte sequence then an invalid byte', [0xc2, 0x80, 0xff], '\u0080\uDCFF'],
      ['the highest two-byte sequence then an invalid byte', [0xdf, 0xbf, 0xff], '\u07FF\uDCFF'],
      ['a mid two-byte sequence then an invalid byte', [0xc3, 0x80, 0xff], '\u00C0\uDCFF'],
      [
        'the lowest three-byte sequence then an invalid byte',
        [0xe0, 0xa0, 0x80, 0xff],
        '\u0800\uDCFF',
      ],
      ['an overlong three-byte sequence', [0xe0, 0x9f, 0xbf], '\uDCE0\uDC9F\uDCBF'],
      [
        'the lowest four-byte sequence then an invalid byte',
        [0xf0, 0x90, 0x80, 0x80, 0xff],
        '\u{10000}\uDCFF',
      ],
      ['an overlong four-byte sequence', [0xf0, 0x8f, 0xbf, 0xbf], '\uDCF0\uDC8F\uDCBF\uDCBF'],
      [
        'the highest code point then an invalid byte',
        [0xf4, 0x8f, 0xbf, 0xbf, 0xff],
        '\u{10FFFF}\uDCFF',
      ],
      [
        'a four-byte sequence above the unicode range',
        [0xf4, 0x90, 0x80, 0x80],
        '\uDCF4\uDC90\uDC80\uDC80',
      ],
      ['a lead above the four-byte range', [0xf5, 0x80, 0x80, 0x80], '\uDCF5\uDC80\uDC80\uDC80'],
    ];

    describe.each(cases)('Given %s', (_label, input, expected) => {
      describe('When decoding with escapes', () => {
        it('Then each rejected byte becomes a lone low surrogate', () => {
          // Arrange
          const sut = Uint8Array.from(input);

          // Act
          const result = decodeEscapingInvalid(sut);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('encodeEscaped', () => {
    const cases: ReadonlyArray<readonly [string, string, ReadonlyArray<number>]> = [
      ['a lone escape before ascii', '\uDCFF.t', [0xff, 0x2e, 0x74]],
      [
        'an astral pair whose low half is in the escape range',
        '\u{10080}',
        [0xf0, 0x90, 0x82, 0x80],
      ],
      [
        'an astral pair in the escape range next to a lone escape',
        '\u{10080}\uDCFF',
        [0xf0, 0x90, 0x82, 0x80, 0xff],
      ],
      ['a lone high surrogate', '\uD800', [0xef, 0xbf, 0xbd]],
      ['a lone low surrogate outside the escape range', '\uDC41', [0xef, 0xbf, 0xbd]],
      [
        'an astral pair ending at the escape range start then a lone escape',
        '\u{10FC80}\uDCFF',
        [0xf4, 0x8f, 0xb2, 0x80, 0xff],
      ],
      [
        'a lone low surrogate just below the escape range then a lone escape',
        '\uDC7F\uDC80',
        [0xef, 0xbf, 0xbd, 0x80],
      ],
    ];

    describe.each(cases)('Given %s', (_label, input, expected) => {
      describe('When encoding with escapes', () => {
        it('Then a lone escape returns its byte and the rest is UTF-8', () => {
          // Arrange
          const sut = input;

          // Act
          const result = encodeEscaped(sut);

          // Assert
          expect(Array.from(result)).toEqual(expected);
        });
      });
    });
  });

  describe('hasEscapedBytes', () => {
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      ['a lone escape', '\uDCFF', true],
      ['an escape after ascii', 'a\uDC80', true],
      ['an astral pair', '\u{10080}', false],
      ['a lone low surrogate outside the escape range', '\uDC41', false],
      ['the replacement character', '�', false],
      ['the empty string', '', false],
    ];

    describe.each(cases)('Given %s', (_label, input, expected) => {
      describe('When looking for escaped bytes', () => {
        it(`Then it is ${expected}`, () => {
          // Arrange
          const sut = input;

          // Act
          const result = hasEscapedBytes(sut);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });

  describe('wellFormed', () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['a lone low surrogate', '\uDCFF.txt', '\uFFFD.txt'],
      ['a lone high surrogate', 'a\uD800b', 'a\uFFFDb'],
      ['a valid pair', '\u{1F600}', '\u{1F600}'],
      ['a byte order mark', '\uFEFFa', '\uFEFFa'],
      ['a well-formed string', 'src/a.ts', 'src/a.ts'],
    ];

    describe.each(cases)('Given %s', (_label, input, expected) => {
      describe('When normalising', () => {
        it(`Then it is ${JSON.stringify(expected)}`, () => {
          // Arrange
          const sut = wellFormed;

          // Act
          const result = sut(input);

          // Assert
          expect(result).toBe(expected);
        });
      });
    });
  });
});
