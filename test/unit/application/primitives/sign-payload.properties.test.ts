import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { stripCrBeforeLf } from '../../../../src/application/primitives/sign-payload.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Text dense in the two bytes the rule is about, with a letter to separate runs. */
const arbCrLfText = (): fc.Arbitrary<string> =>
  fc.stringMatching(/^[\r\na]*$/).filter((text) => text.length < 64);

const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

describe('stripCrBeforeLf properties', () => {
  describe('Given an arbitrary text of carriage returns, line feeds and letters', () => {
    describe('When stripCrBeforeLf runs', () => {
      it('Then it drops exactly one carriage return per carriage-return-and-line-feed pair', () => {
        fc.assert(
          fc.property(arbCrLfText(), (text) => {
            // Arrange
            const sut = stripCrBeforeLf;

            // Act
            const result = sut(text);

            // Assert
            expect(text.length - result.length).toBe(count(text, /\r\n/g));
          }),
          { numRuns: 100 },
        );
      });

      it('Then every line feed and letter is kept', () => {
        fc.assert(
          fc.property(arbCrLfText(), (text) => {
            // Arrange
            const sut = stripCrBeforeLf;

            // Act
            const result = sut(text);

            // Assert
            expect(result.replace(/\r/g, '')).toBe(text.replace(/\r/g, ''));
          }),
          { numRuns: 100 },
        );
      });

      it('Then a text with no line feed is returned unchanged', () => {
        fc.assert(
          fc.property(arbCrLfText(), (text) => {
            // Arrange
            const sut = stripCrBeforeLf;
            const withoutLineFeed = text.replace(/\n/g, 'a');

            // Act
            const result = sut(withoutLineFeed);

            // Assert
            expect(result).toBe(withoutLineFeed);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
