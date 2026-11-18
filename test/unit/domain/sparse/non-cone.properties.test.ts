import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { tokenizeIgnoreLine } from '../../../../src/domain/ignore/index.js';
import { compileSparseRule } from '../../../../src/domain/sparse/non-cone.js';
import { arbCaseMask, flipAsciiCase } from '../path/arbitraries.js';

const NUM_RUNS = 100;
const arbLine = fc.stringMatching(/^\/[aAbB]{1,3}(\/[aAbB]{1,3})?\/?$/);
const arbPath = fc.stringMatching(/^[aAbB]{1,3}(\/[aAbB]{1,3}){0,2}$/);
const arbMask = arbCaseMask();

const tokenized = (line: string) => {
  const tokens = tokenizeIgnoreLine(line);
  if (tokens === undefined) throw new Error(`unexpected skipped line: ${line}`);
  return tokens;
};

describe('compileSparseRule properties', () => {
  describe('Given a folding rule', () => {
    describe('When the path has its ASCII case flipped', () => {
      it('Then the verdict is unchanged', () => {
        fc.assert(
          fc.property(arbLine, arbPath, arbMask, (line, path, mask) => {
            // Arrange
            const sut = compileSparseRule;

            // Act
            const result = sut(tokenized(line), line, { caseFold: true }).matcher.test(
              flipAsciiCase(path, mask),
            );

            // Assert
            expect(result).toBe(sut(tokenized(line), line, { caseFold: true }).matcher.test(path));
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
            const exact = compileSparseRule(tokenized(line), line).matcher;
            const sut = compileSparseRule;

            // Act
            const result = sut(tokenized(line), line, { caseFold: true }).matcher.test(path);

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
            const sut = compileSparseRule;

            // Act
            const result = sut(tokenized(line), line, { caseFold: false }).matcher.test(path);

            // Assert
            expect(result).toBe(sut(tokenized(line), line).matcher.test(path));
          }),
          { numRuns: NUM_RUNS },
        );
      });
    });
  });
});
