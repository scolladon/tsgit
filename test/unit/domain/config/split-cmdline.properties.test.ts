/**
 * Property test for git's `split_cmdline` grammar: any argv quoted word by
 * word — single quotes for a word free of `'`, double quotes with `"` and `\`
 * escaped for any word — splits back to itself, and an argv of bare words
 * joined by one space does too.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { splitCmdline } from '../../../../src/domain/config/split-cmdline.js';

const ROUND_TRIP_RUNS = 200;

const argv = (word: fc.Arbitrary<string>): fc.Arbitrary<string[]> =>
  fc.array(word, { minLength: 1, maxLength: 6 });

const bareWord = fc.stringMatching(/^[^\s'"\\]+$/);

const doubleQuoted = (word: string): string => `"${word.replace(/["\\]/g, '\\$&')}"`;

describe('splitCmdline properties', () => {
  describe.each([
    ['bare words joined by a space', argv(bareWord), (words: string[]) => words.join(' ')],
    [
      'words single-quoted',
      argv(fc.string().filter((w) => !w.includes("'"))),
      (words: string[]) => words.map((w) => `'${w}'`).join(' '),
    ],
    [
      'words double-quoted with escapes',
      argv(fc.string()),
      (words: string[]) => words.map(doubleQuoted).join('\t'),
    ],
  ])('Given any argv of %s', (_, words, spell) => {
    describe('When split', () => {
      it('Then it round-trips to the argv', () => {
        // Arrange
        const sut = splitCmdline;

        // Act & Assert
        fc.assert(
          fc.property(words, (given) => {
            expect(sut(spell(given))).toEqual({ kind: 'argv', argv: given });
          }),
          { numRuns: ROUND_TRIP_RUNS },
        );
      });
    });
  });

  describe('Given any line with one more quote opened than closed', () => {
    describe('When split', () => {
      it('Then it refuses as an unclosed quote', () => {
        // Arrange
        const sut = splitCmdline;

        // Act & Assert
        fc.assert(
          fc.property(argv(bareWord), (given) => {
            expect(sut(`${given.join(' ')} 'open`)).toEqual({
              kind: 'error',
              reason: 'unclosed quote',
            });
          }),
        );
      });
    });
  });
});
