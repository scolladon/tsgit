import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCharsetEncoder,
  charsetIdentity,
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
      const result = encodeFromUtf8('ISO-8859-1', decoded as Uint8Array, buildCharsetEncoder);

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
      const encoded = encodeFromUtf8('x-nonexistent-9', utf8('A'), buildCharsetEncoder);

      // Assert
      expect(decoded).toBeUndefined();
      expect(encoded).toBeUndefined();
    });
  });

  describe.each(['x-user-defined', 'GB18030'])(
    'Given the WHATWG label %s without a derived encoder',
    (label) => {
      describe('When encoding', () => {
        it('Then it is unconverted', () => {
          // Arrange
          const sut = encodeFromUtf8;

          // Act
          const result = sut(label, utf8('A'), buildCharsetEncoder);

          // Assert
          expect(result).toBeUndefined();
        });
      });
    },
  );

  describe.each([
    ['UTF-16LE', [0x70, 0, 0xe9, 0, 0x3d, 0xd8, 0x00, 0xde]],
    ['UTF-16BE', [0, 0x70, 0, 0xe9, 0xd8, 0x3d, 0xde, 0x00]],
  ])('Given the %s label, When encoding', (label, expected) => {
    it('Then the code units carry that byte order and no BOM', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut(label, utf8('pé😀'), buildCharsetEncoder);

      // Assert
      expect(result).toEqual(bytesOf(...expected));
    });
  });

  describe('Given the ISO-2022-JP label', () => {
    const ESC = 0x1b;
    const TO_ASCII = [ESC, 0x28, 0x42];
    const TO_ROMAN = [ESC, 0x28, 0x4a];
    const TO_JIS0208 = [ESC, 0x24, 0x42];

    describe.each([
      ['ASCII only', 'pre', [...utf8('pre')]],
      [
        'kanji between ASCII runs',
        'a日本 b',
        [0x61, ...TO_JIS0208, 0x46, 0x7c, 0x4b, 0x5c, ...TO_ASCII, 0x20, 0x62],
      ],
      ['a trailing kanji', '日', [...TO_JIS0208, 0x46, 0x7c, ...TO_ASCII]],
      ['the yen sign before ASCII', '¥a', [...TO_ROMAN, 0x5c, ...TO_ASCII, 0x61]],
      ['the overline twice', '‾‾', [...TO_ROMAN, 0x7e, 0x7e, ...TO_ASCII]],
    ])('When encoding %s', (_title, text, expected) => {
      it('Then escape sequences switch the character set as iconv does', () => {
        // Arrange
        const sut = encodeFromUtf8;

        // Act
        const result = sut('ISO-2022-JP', utf8(text), buildCharsetEncoder);

        // Assert
        expect(result).toEqual(bytesOf(...expected));
      });
    });

    describe('When encoding through the csISO2022JP alias', () => {
      it('Then the alias encodes as the canonical label', () => {
        // Arrange
        const sut = encodeFromUtf8;

        // Act
        const result = sut('csISO2022JP', utf8('a日'), buildCharsetEncoder);

        // Assert
        expect(result).toEqual(bytesOf(0x61, ...TO_JIS0208, 0x46, 0x7c, ...TO_ASCII));
      });
    });

    describe.each([
      ['a Latin-1 letter', 'é'],
      ['a half-width katakana', 'ｱ'],
      ['a vendor extension of the JIS X 0208 rows', '①'],
    ])('When encoding %s', (_title, text) => {
      it('Then it is unconverted', () => {
        // Arrange
        const sut = encodeFromUtf8;

        // Act
        const result = sut('ISO-2022-JP', utf8(`a${text}`), buildCharsetEncoder);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a Shift_JIS label, When the text holds a character outside it', () => {
    it('Then encoding is unconverted', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('Shift_JIS', utf8('😀'), buildCharsetEncoder);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a single-byte label, When the text is not representable', () => {
    it('Then encoding is unconverted', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('windows-1251', utf8('é'), buildCharsetEncoder);

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given invalid UTF-8, When encoding', () => {
    it('Then it is unconverted', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('ISO-8859-1', bytesOf(0xe9), buildCharsetEncoder);

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
        const result = sut(label, utf8(`${text}a`), buildCharsetEncoder);

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
      const result = sut('Shift_JIS', utf8('ｱ'), buildCharsetEncoder);

      // Assert
      expect(result).toEqual(bytesOf(0xb1));
    });
  });

  describe('Given the UTF-16 label, When encoding', () => {
    it('Then the output is a big-endian BOM followed by the code units', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('UTF-16', utf8('pé😀'), buildCharsetEncoder);

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
    it('Then it is read as big-endian and a lone surrogate is unconverted', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const result = sut('UTF-16', bytesOf(0, 0x70));
      const lone = sut('UTF-16', bytesOf(0xd8, 0x3d));

      // Assert
      expect(result).toEqual(utf8('p'));
      expect(lone).toBeUndefined();
    });
  });

  describe('Given a BOM-less UTF-16 text whose second byte is the little-endian BOM byte, When decoding', () => {
    it('Then it is still read as big-endian, as iconv does', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const result = sut('UTF-16', bytesOf(0, 0xfe));

      // Assert
      expect(result).toEqual(utf8('þ'));
    });
  });

  describe('Given a little-endian BOM before a lone surrogate, When decoding', () => {
    it('Then the text is unconverted', () => {
      // Arrange
      const sut = decodeToUtf8;

      // Act
      const result = sut('UTF-16', bytesOf(0xff, 0xfe, 0x3d, 0xd8));

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe('Given a Shift_JIS character two byte pairs decode to, When encoding', () => {
    it('Then the first pair is used, as iconv does', () => {
      // Arrange
      const sut = encodeFromUtf8;

      // Act
      const result = sut('Shift_JIS', utf8('∪'), buildCharsetEncoder);

      // Assert
      expect(result).toEqual(bytesOf(0x81, 0xbe));
    });
  });

  describe('Given a Big5 decoder that reads one byte pair as two code points, as WHATWG specifies', () => {
    const RealTextDecoder = globalThis.TextDecoder;
    const COMBINING_PAIR = [0x88, 0x62];
    const SINGLE_CHARACTER_PAIR = [0x88, 0x66];
    const isPair = (input: Uint8Array, pair: ReadonlyArray<number>): boolean =>
      input.length === pair.length && pair.every((byte, at) => input[at] === byte);
    class WhatwgBig5Decoder extends RealTextDecoder {
      override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
        const bytes = input as Uint8Array;
        if (isPair(bytes, COMBINING_PAIR)) return '\u00ca\u0304';
        if (isPair(bytes, SINGLE_CHARACTER_PAIR)) return '\u00ca';
        return super.decode(input, options);
      }
    }
    afterEach(() => vi.unstubAllGlobals());

    describe('When encoding the first of those code points alone', () => {
      it('Then the pair decoding to exactly that character is used', () => {
        // Arrange
        vi.stubGlobal('TextDecoder', WhatwgBig5Decoder);
        const sut = buildCharsetEncoder;

        // Act
        const result = sut('big5')?.('\u00ca');

        // Assert
        expect(result).toEqual(bytesOf(...SINGLE_CHARACTER_PAIR));
      });
    });
  });

  describe('Given a caller-owned encoder lookup, When encoding under a padded mixed-case label', () => {
    it('Then the lookup is asked for the normalised label and its encoder runs', () => {
      // Arrange
      const asked: string[] = [];
      const encoders = (label: string) => {
        asked.push(label);
        return (text: string) => utf8(`<${text}>`);
      };
      const sut = encodeFromUtf8;

      // Act
      const result = sut(' Windows-1252 ', utf8('é'), encoders);

      // Assert
      expect(asked).toEqual(['windows-1252']);
      expect(result).toEqual(utf8('<é>'));
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

  describe.each([
    ['sjis', 'shift_jis'],
    ['shift_jis', 'shift_jis'],
    ['l1', 'windows-1252'],
    ['latin1', 'latin1'],
    ['utf-16', 'utf-16'],
    ['utf-16le', 'utf-16le'],
    ['csiso2022jp', 'csiso2022jp'],
    ['gb18030', undefined],
    ['x-no-such-charset', undefined],
  ])('Given the normalised label %j', (label, expected) => {
    describe('When asking which charset it builds an encoder for', () => {
      it(`Then the answer is ${String(expected)}`, () => {
        // Arrange
        const sut = charsetIdentity;

        // Act
        const result = sut(label);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
