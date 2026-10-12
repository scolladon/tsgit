/**
 * Property tests for wrapText (git's `strbuf_add_wrapped_text`).
 *
 * Lens 4 (counting invariant) fits twice. Over any text of words, spaces,
 * tabs and line feeds, wrapping only moves whitespace: the non-whitespace
 * bytes come out unchanged and in order, whatever the width and indents
 * (a width of 0 only indents). Over space-separated words, every line opens
 * with its indent — `indent1` for the first, `indent2` after — and fits the
 * width unless it holds one word: git breaks a line only at a space, so a word
 * that alone overflows the width stays whole. Lenses 1–3 do not fit: there is
 * no unwrap to round-trip, nothing is matched, and every input is accepted.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { wrapText } from '../../../../src/domain/pretty/wrap.js';

const NUM_RUNS = 100;
const MAX_INDENT = 8;
const MAX_WIDTH = 30;
const WHITESPACE = /[ \t\n]/g;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const arbIndent = fc.integer({ min: 0, max: MAX_INDENT });
const arbText = fc
  .array(fc.constantFrom('a', 'b', '-', '.', ' ', '\t', '\n'), { maxLength: 30 })
  .map((chars) => chars.join(''));
const arbWord = fc.stringMatching(/^[a-z]{1,8}$/);
const arbWords = fc.array(arbWord, { minLength: 1, maxLength: 8 }).map((words) => words.join(' '));

const isSingleWord = (line: string): boolean => !line.trimStart().includes(' ');

describe('wrapText properties', () => {
  describe('Given arbitrary text of words, spaces, tabs and line feeds', () => {
    describe('When it is wrapped at any width and indents', () => {
      it('Then its non-whitespace bytes come out unchanged and in order', () => {
        fc.assert(
          fc.property(
            arbText,
            arbIndent,
            arbIndent,
            fc.integer({ min: 0, max: MAX_WIDTH }),
            (text, indent1, indent2, width) => {
              // Arrange
              const sut = wrapText;

              // Act
              const result = sut(encode(text), indent1, indent2, width);

              // Assert
              expect(decode(result).replace(WHITESPACE, '')).toBe(text.replace(WHITESPACE, ''));
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given arbitrary space-separated words', () => {
    describe('When they are wrapped at a positive width', () => {
      it('Then every line opens with its indent and fits the width unless it holds one word', () => {
        fc.assert(
          fc.property(
            arbWords,
            arbIndent,
            arbIndent,
            fc.integer({ min: 1, max: MAX_WIDTH }),
            (text, indent1, indent2, width) => {
              // Arrange
              const sut = wrapText;

              // Act
              const result = sut(encode(text), indent1, indent2, width);

              // Assert
              const lines = decode(result).split('\n');
              lines.forEach((line, index) => {
                const indent = index === 0 ? indent1 : indent2;
                expect(line.slice(0, indent)).toBe(' '.repeat(indent));
                expect(line.charAt(indent)).toMatch(/[a-z]/);
                expect(line.length <= width || isSingleWord(line)).toBe(true);
              });
            },
          ),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
