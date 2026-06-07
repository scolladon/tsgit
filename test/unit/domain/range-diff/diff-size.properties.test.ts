import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { diffSize } from '../../../../src/domain/range-diff/diff-size.js';

const arbText = fc
  .array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { minLength: 0, maxLength: 40 })
  .map((lines) => (lines.length === 0 ? '' : `${lines.join('\n')}\n`));

const lineCount = (text: string): number => (text === '' ? 0 : text.split('\n').length - 1);

describe('Given arbitrary line-structured texts', () => {
  describe('When diffSize measures a text against itself', () => {
    it('Then the size is zero', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbText, (text) => {
          expect(diffSize(text, text)).toBe(0);
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('When diffSize measures a non-empty text against the empty text', () => {
    it('Then the size is one hunk header plus every line', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          arbText.filter((text) => text.length > 0),
          (text) => {
            expect(diffSize('', text)).toBe(1 + lineCount(text));
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
