import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tokenizeIgnoreLine } from '../../../../src/domain/ignore/index.js';
import { compileSparseRule } from '../../../../src/domain/sparse/non-cone.js';

const NUM_RUNS = 100;
const arbLine = fc.stringMatching(/^\/[aAbB]{1,3}(\/[aAbB]{1,3})?\/?$/);
const arbPath = fc.stringMatching(/^[aAbB]{1,3}(\/[aAbB]{1,3}){0,2}$/);
const arbMask = fc.array(fc.boolean(), { maxLength: 12 });

const flipAsciiCase = (text: string, mask: ReadonlyArray<boolean>): string =>
  [...text]
    .map((ch, i) => {
      if (mask[i] !== true) return ch;
      return ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
    })
    .join('');

const compile = (line: string, caseFold?: boolean) => {
  const tokenized = tokenizeIgnoreLine(line);
  if (tokenized === undefined) throw new Error(`unexpected skipped line: ${line}`);
  return compileSparseRule(tokenized, line, caseFold === undefined ? undefined : { caseFold });
};

describe('compileSparseRule properties', () => {
  describe('Given a folding rule', () => {
    describe('When the path has its ASCII case flipped', () => {
      it('Then the verdict is unchanged', () => {
        fc.assert(
          fc.property(arbLine, arbPath, arbMask, (line, path, mask) => {
            // Arrange
            const sut = compile(line, true).matcher;

            // Act
            const result = sut.test(flipAsciiCase(path, mask));

            // Assert
            expect(result).toBe(sut.test(path));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });

    describe('When the exact rule accepts a path', () => {
      it('Then the folding rule accepts it too', () => {
        fc.assert(
          fc.property(arbLine, arbPath, (line, path) => {
            // Arrange
            const exact = compile(line).matcher;
            const sut = compile(line, true).matcher;

            // Act
            const result = sut.test(path);

            // Assert
            expect(result || !exact.test(path)).toBe(true);
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });

  describe('Given no option', () => {
    describe('When compared with caseFold false', () => {
      it('Then both rules reach the same verdict', () => {
        fc.assert(
          fc.property(arbLine, arbPath, (line, path) => {
            // Arrange
            const sut = compile(line).matcher;

            // Act
            const result = compile(line, false).matcher.test(path);

            // Assert
            expect(result).toBe(sut.test(path));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
