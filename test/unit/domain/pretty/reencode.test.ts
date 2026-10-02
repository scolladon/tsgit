import { describe, expect, it } from 'vitest';
import {
  decodeToUtf8,
  encodeFromUtf8,
  isUtf8Label,
} from '../../../../src/domain/pretty/reencode.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const bytesOf = (...values: number[]): Uint8Array => new Uint8Array(values);

describe('reencode', () => {
  describe('Given the ISO-8859-1 label, When decoding then encoding the pinned subject', () => {
    it('Then the Latin-1 bytes round-trip through UTF-8', () => {
      // Arrange
      const latin1 = utf8('caf_ subj');
      latin1[3] = 0xe9;

      // Act
      const decoded = decodeToUtf8('ISO-8859-1', latin1);
      const result = encodeFromUtf8('ISO-8859-1', decoded as Uint8Array);

      // Assert
      expect(decoded).toEqual(utf8('café subj'));
      expect(result).toEqual(latin1);
    });
  });

  describe('Given the ISO-8859-1 label, When decoding a C1 byte', () => {
    it('Then it maps to the same code point as iconv, not windows-1252', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const result = sut('ISO-8859-1', bytesOf(0x80));

      // Assert
      expect(result).toEqual(utf8('\u0080'));
    });
  });

  describe('Given a label WHATWG does not know, When transcoding', () => {
    it('Then both directions are unconverted', () => {
      // Arrange / Act
      const decoded = decodeToUtf8('x-nonexistent-9', bytesOf(0x41));
      const encoded = encodeFromUtf8('x-nonexistent-9', utf8('A'));

      // Assert
      expect(decoded).toBeUndefined();
      expect(encoded).toBeUndefined();
    });
  });

  describe.each(['ISO-2022-JP', 'UTF-16LE', 'x-user-defined'])(
    'Given the stateful or unsupported WHATWG label %s',
    (label) => {
      describe('When encoding', () => {
        it('Then it is unconverted', () => {
          // Arrange
          const sut = encodeFromUtf8;

          // Act
          const result = sut(label, utf8('A'));

          // Assert
          expect(result).toBeUndefined();
        });
      });
    },
  );

  describe('Given a Shift_JIS label, When the text holds a character outside it', () => {
    it('Then encoding is unconverted', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('Shift_JIS', utf8('😀'));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a single-byte label, When the text is not representable', () => {
    it('Then encoding is unconverted', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('windows-1251', utf8('é'));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given invalid UTF-8, When encoding', () => {
    it('Then it is unconverted', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('ISO-8859-1', bytesOf(0xe9));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given an invalid sequence for the label, When decoding', () => {
    it('Then it is unconverted', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const result = sut('Shift_JIS', bytesOf(0x81));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe.each([
    ['Shift_JIS', 'あ', [0x82, 0xa0]],
    ['EUC-JP', 'あ', [0xa4, 0xa2]],
    ['EUC-KR', '가', [0xb0, 0xa1]],
    ['GBK', '中', [0xd6, 0xd0]],
    ['Big5', '中', [0xa4, 0xa4]],
  ])('Given the %s label', (label, text, expected) => {
    describe('When round-tripping one character', () => {
      it('Then the two-byte form is produced and decoded back', () => {
        // Arrange
        const sut = encodeFromUtf8;

        // Act
        const result = sut(label, utf8(`${text}a`));

        // Assert
        expect(result).toEqual(bytesOf(...expected, 0x61));
        expect(decodeToUtf8(label, result as Uint8Array)).toEqual(utf8(`${text}a`));
      });
    });
  });

  describe('Given a half-width katakana, When encoding as Shift_JIS', () => {
    it('Then the single byte form is used', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('Shift_JIS', utf8('ｱ'));

      // Assert
      expect(result).toEqual(bytesOf(0xb1));
    });
  });

  describe('Given the UTF-16 label, When encoding', () => {
    it('Then the output is a big-endian BOM followed by the code units', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('UTF-16', utf8('pé😀'));

      // Assert
      expect(result).toEqual(bytesOf(0xfe, 0xff, 0, 0x70, 0, 0xe9, 0xd8, 0x3d, 0xde, 0x00));
    });
  });

  describe('Given a BOM-prefixed UTF-16 text, When decoding', () => {
    it('Then the big-endian and little-endian forms decode alike', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const big = sut('UTF-16', bytesOf(0xfe, 0xff, 0, 0x70));
      const little = sut('UTF-16', bytesOf(0xff, 0xfe, 0x70, 0));

      // Assert
      expect(big).toEqual(utf8('p'));
      expect(little).toEqual(utf8('p'));
    });
  });

  describe('Given a BOM-less UTF-16 text, When decoding', () => {
    it('Then it is read as little-endian and a lone surrogate is unconverted', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const result = sut('UTF-16', bytesOf(0x70, 0));
      const lone = sut('UTF-16', bytesOf(0x3d, 0xd8));

      // Assert
      expect(result).toEqual(utf8('p'));
      expect(lone).toBeUndefined();
    });
  });

  describe('Given the memoised encoder, When encoding twice', () => {
    it('Then both calls agree', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const first = sut('windows-1252', utf8('é'));
      const second = sut('windows-1252', utf8('é'));

      // Assert
      expect(second).toEqual(first);
    });
  });

  describe.each([
    ['UTF-8', true],
    ['utf8', true],
    ['Utf-8', true],
    ['ISO-8859-1', false],
    ['', false],
  ])('Given the label %j', (label, expected) => {
    describe('When asking whether it is UTF-8', () => {
      it(`Then the answer is ${expected}`, () => {
        // Arrange
        const sut = isUtf8Label;

        // Act
        const result = sut(label);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
