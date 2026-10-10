import { describe, expect, it } from 'vitest';
import { glyphAt, utf8Width } from '../../../../src/domain/pretty/utf8-width.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const widthOfCodePoint = (codePoint: number): number =>
  utf8Width(encode(String.fromCodePoint(codePoint)));

describe('utf8Width', () => {
  describe('Given printable ASCII, When measured', () => {
    it('Then each byte is one column', () => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(encode('hello world'));

      // Assert
      expect(result).toBe(11);
    });
  });

  describe('Given an empty string, When measured', () => {
    it('Then the width is zero', () => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(new Uint8Array());

      // Assert
      expect(result).toBe(0);
    });
  });

  describe('Given East-Asian wide characters, When measured', () => {
    it('Then each takes two columns', () => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(encode('日本語'));

      // Assert
      expect(result).toBe(6);
    });
  });

  describe('Given a combining mark after a base letter, When measured', () => {
    it('Then the mark takes no column', () => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(encode('é'));

      // Assert
      expect(result).toBe(1);
    });
  });

  describe('Given control characters, When measured', () => {
    it.each([
      ['NUL', 0x00],
      ['TAB', 0x09],
      ['DEL', 0x7f],
      ['C1 control', 0x85],
    ])('Then %s adds no column', (_name, codePoint) => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(encode(`a${String.fromCodePoint(codePoint)}b`));

      // Assert
      expect(result).toBe(2);
    });
  });

  describe('Given code points around interval edges, When measured', () => {
    it.each([
      ['just before the first zero-width interval', 0x02ff, 1],
      ['first of the first zero-width interval', 0x0300, 0],
      ['last of the first zero-width interval', 0x036f, 0],
      ['just after the first zero-width interval', 0x0370, 1],
      ['last zero-width interval first', 0xe0100, 0],
      ['last zero-width interval last', 0xe01ef, 0],
      ['just after the last zero-width interval', 0xe01f0, 1],
      ['just before the first wide interval', 0x10ff, 1],
      ['first of the first wide interval', 0x1100, 2],
      ['last of the first wide interval', 0x115f, 2],
      ['inside a single-point wide interval', 0x23f0, 2],
      ['just before a single-point wide interval', 0x23ef, 1],
      ['just after a single-point wide interval', 0x23f1, 1],
      ['first of the last wide interval', 0x30000, 2],
      ['last of the last wide interval', 0x3fffd, 2],
      ['just after the last wide interval', 0x3fffe, 1],
      ['between the last two wide intervals', 0x2fffe, 1],
      ['the first printable Latin-1 character', 0xa0, 1],
    ])('Then %s measures correctly', (_name, codePoint, expected) => {
      // Arrange
      const sut = widthOfCodePoint;

      // Act
      const result = sut(codePoint);

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given invalid UTF-8, When measured', () => {
    it.each([
      ['a lone continuation byte', [0x61, 0x80, 0x62]],
      ['a truncated two-byte sequence', [0x61, 0xc3]],
      ['an overlong two-byte sequence', [0xc0, 0x80]],
      ['a truncated three-byte sequence', [0xe6, 0x97]],
      ['an overlong three-byte sequence', [0xe0, 0x80, 0x80]],
      ['a surrogate', [0xed, 0xa0, 0x80]],
      ['U+FFFE', [0xef, 0xbf, 0xbe]],
      ['an overlong four-byte sequence', [0xf0, 0x80, 0x80, 0x80]],
      ['a code point above U+10FFFF', [0xf4, 0x90, 0x80, 0x80]],
      ['a five-byte lead', [0xf8, 0x88, 0x80, 0x80, 0x80]],
      ['a bad third byte', [0xe6, 0x97, 0x41]],
      ['a bad fourth byte', [0xf0, 0x9f, 0x98, 0x41]],
      ['a four-byte lead past U+10FFFF', [0xf5, 0x80, 0x80, 0x80]],
      ['four continuation bytes', [0x80, 0x80, 0x80, 0x80]],
    ])('Then %s counts one column per byte', (_name, bytes) => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(new Uint8Array([0xe6, 0x97, 0xa5, ...bytes]));

      // Assert
      expect(result).toBe(bytes.length + 3);
    });
  });

  describe('Given valid three-byte characters beside the rejected ranges, When measured', () => {
    it.each([
      ['an E0 lead past the overlong range', [0xe0, 0xa4, 0x85], 1],
      ['an ED lead below the surrogates', [0xed, 0x95, 0x9c], 2],
      ['a BF BF tail under a lead other than EF', [0xe3, 0xbf, 0xbf], 2],
      ['a BE tail under EF without a BF second byte', [0xef, 0xbc, 0xbe], 2],
      ['an EF BF lead short of U+FFFE', [0xef, 0xbf, 0xbd], 1],
    ])('Then %s is decoded and measured', (_name, bytes, expected) => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(new Uint8Array(bytes));

      // Assert
      expect(result).toBe(expected);
    });
  });

  describe('Given the highest valid code point, When measured', () => {
    it('Then it is decoded and measured', () => {
      // Arrange
      const sut = utf8Width;

      // Act
      const result = sut(new Uint8Array([0xf4, 0x8f, 0xbf, 0xbf]));

      // Assert
      expect(result).toBe(1);
    });
  });
});

describe('glyphAt', () => {
  describe('Given a NUL byte, When read', () => {
    it('Then it is one byte wide and takes no column', () => {
      // Arrange
      const sut = glyphAt;

      // Act
      const result = sut(new Uint8Array([0x00]), 0);

      // Assert
      expect(result).toEqual({ columns: 0, length: 1 });
    });
  });
});
