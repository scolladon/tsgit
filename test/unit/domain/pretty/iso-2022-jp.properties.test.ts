import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeIso2022Jp } from '../../../../src/domain/pretty/iso-2022-jp.js';

const ROUND_TRIP_RUNS = 200;
const MAX_LENGTH = 32;
const ESC = 0x1b;
const FIRST_KANJI_LEAD = 0x30;
const LAST_KANJI_LEAD = 0x4f;
const FIRST_GRAPHIC = 0x21;
const LAST_GRAPHIC = 0x7e;
const ASCII_PRINTABLE = { min: 0x20, max: 0x7e };
const TO_ASCII = [ESC, 0x28, 0x42];

const decoder = new TextDecoder('iso-2022-jp');

/** A JIS X 0208 level-1 kanji, drawn by its two-byte code and read back through WHATWG. */
const kanji = fc
  .tuple(
    fc.integer({ min: FIRST_KANJI_LEAD, max: LAST_KANJI_LEAD }),
    fc.integer({ min: FIRST_GRAPHIC, max: LAST_GRAPHIC }),
  )
  .map(([lead, trail]) => decoder.decode(Uint8Array.of(ESC, 0x24, 0x42, lead, trail)))
  .filter((text) => text.length === 1 && text !== '�');

const ascii = fc.integer(ASCII_PRINTABLE).map((code) => String.fromCharCode(code));
const roman = fc.constantFrom('¥', '‾');

const mixedText = fc
  .array(fc.oneof(ascii, roman, kanji), { maxLength: MAX_LENGTH })
  .map((chars) => chars.join(''));

const hasNonAscii = (text: string): boolean =>
  [...text].some((char) => (char.codePointAt(0) as number) > ASCII_PRINTABLE.max);

describe('Given text drawn from ASCII, JIS X 0201 Roman and JIS X 0208 kanji', () => {
  describe('When encoding it then decoding the bytes', () => {
    it('Then the text comes back', () => {
      fc.assert(
        fc.property(mixedText, (text) => {
          // Arrange
          const sut = encodeIso2022Jp;

          // Act
          const result = sut(text) as Uint8Array;

          // Assert
          expect(decoder.decode(result)).toBe(text);
        }),
        { numRuns: ROUND_TRIP_RUNS },
      );
    });
  });

  describe('When the text leaves ASCII anywhere', () => {
    it('Then the last designation switches back to ASCII', () => {
      fc.assert(
        fc.property(mixedText, (text) => {
          // Arrange
          fc.pre(hasNonAscii(text));
          const sut = encodeIso2022Jp;

          // Act
          const result = sut(text) as Uint8Array;

          // Assert
          const lastEscape = result.lastIndexOf(ESC);
          expect([...result.subarray(lastEscape, lastEscape + TO_ASCII.length)]).toEqual(TO_ASCII);
        }),
        { numRuns: ROUND_TRIP_RUNS },
      );
    });
  });
});
