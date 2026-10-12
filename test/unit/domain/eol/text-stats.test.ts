import { describe, expect, it } from 'vitest';

import { gatherTextStats, isBinaryText } from '../../../../src/domain/eol/text-stats.js';

const ascii = (text: string): Uint8Array => Uint8Array.from(text, (c) => c.charCodeAt(0));
const repeat = (char: string, count: number): string => char.repeat(count);

const HEURISTIC_FIXTURES: ReadonlyArray<readonly [string, string, boolean]> = [
  ['nul-far', `${repeat('a', 9000)}\0\r\n`, true],
  ['r127', `${repeat('a', 127)}\x01\r\n`, true],
  ['r128', `${repeat('a', 128)}\x01\r\n`, false],
  ['r128eof', `${repeat('a', 128)}\x01\r\n\x1a`, false],
  ['r128x2eof', `${repeat('a', 128)}\x01\x01\r\n\x1a`, true],
  ['ctl', '\x1b\t\b\x0cx\r\n', false],
];

describe('gatherTextStats', () => {
  describe.each(HEURISTIC_FIXTURES)('Given the heuristic fixture %s', (_name, text, binary) => {
    describe('When gathered', () => {
      it(`Then isBinaryText is ${binary}`, () => {
        // Arrange
        const bytes = ascii(text);

        // Act
        const sut = gatherTextStats(bytes);

        // Assert
        expect(isBinaryText(sut)).toBe(binary);
      });
    });
  });

  describe.each([
    ['a\r\nb\n', { nul: 0, loneCr: 0, loneLf: 1, crlf: 1, printable: 2, nonPrintable: 0 }],
    ['a\rb\r\n', { nul: 0, loneCr: 1, loneLf: 0, crlf: 1, printable: 2, nonPrintable: 0 }],
    ['\x7f', { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 1 }],
    ['\x80', { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 1, nonPrintable: 0 }],
    ['\0', { nul: 1, loneCr: 0, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 1 }],
    ['\x01', { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 1 }],
    ['\x1a', { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 0 }],
    ['\x1ax', { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 1, nonPrintable: 1 }],
    ['\r', { nul: 0, loneCr: 1, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 0 }],
    ['', { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 0 }],
  ])('Given the bytes %j', (text, expected) => {
    describe('When gathered', () => {
      it('Then the counters match', () => {
        // Arrange
        const bytes = ascii(text);

        // Act
        const result = gatherTextStats(bytes);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});

describe('isBinaryText', () => {
  const clean = { nul: 0, loneCr: 0, loneLf: 0, crlf: 0, printable: 0, nonPrintable: 0 };

  describe('Given only a lone CR', () => {
    it('Then the text is binary', () => {
      // Arrange
      const sut = { ...clean, loneCr: 1 };

      // Act
      const result = isBinaryText(sut);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given only a NUL', () => {
    it('Then the text is binary', () => {
      // Arrange
      const sut = { ...clean, nul: 1 };

      // Act
      const result = isBinaryText(sut);

      // Assert
      expect(result).toBe(true);
    });
  });

  describe('Given non-printable bytes exactly at printable >> 7', () => {
    it('Then the text is not binary', () => {
      // Arrange
      const sut = { ...clean, printable: 128, nonPrintable: 1 };

      // Act
      const result = isBinaryText(sut);

      // Assert
      expect(result).toBe(false);
    });
  });
});
