import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  estimateSimilarity,
  MAX_SCORE,
  toSimilarityPercent,
} from '../../../../src/domain/diff/similarity.js';
import { arbBlobBytes } from './arbitraries.js';

describe('similarity properties', () => {
  describe('Given an arbitrary blob', () => {
    describe('When estimateSimilarity(x, x) is called (identity)', () => {
      it('Then returns MAX_SCORE for any non-empty blob', () => {
        // Arrange
        fc.assert(
          fc.property(arbBlobBytes(), (x) => {
            // Act
            const result = estimateSimilarity(x, x);

            // Assert
            expect(result).toBe(MAX_SCORE);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When estimateSimilarity(a, b) is called (bounded)', () => {
      it('Then result is always in [0, MAX_SCORE]', () => {
        // Arrange
        fc.assert(
          fc.property(arbBlobBytes(), arbBlobBytes(), (a, b) => {
            // Act
            const result = estimateSimilarity(a, b);

            // Assert
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBeLessThanOrEqual(MAX_SCORE);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When toSimilarityPercent is called (monotone non-decreasing)', () => {
      it('Then higher score always yields equal or higher percent', () => {
        // Arrange
        fc.assert(
          fc.property(
            fc.integer({ min: 0, max: MAX_SCORE }),
            fc.integer({ min: 0, max: MAX_SCORE }),
            (a, b) => {
              const lo = Math.min(a, b);
              const hi = Math.max(a, b);

              // Act
              const pctLo = toSimilarityPercent(lo);
              const pctHi = toSimilarityPercent(hi);

              // Assert
              expect(pctLo).toBeLessThanOrEqual(pctHi);
            },
          ),
          { numRuns: 100 },
        );
      });

      it('Then result is always <= 100', () => {
        // Arrange
        fc.assert(
          fc.property(fc.integer({ min: 0, max: MAX_SCORE }), (score) => {
            // Act
            const result = toSimilarityPercent(score);

            // Assert
            expect(result).toBeLessThanOrEqual(100);
          }),
          { numRuns: 100 },
        );
      });
    });

    describe('When dissimilarity identity is computed', () => {
      it('Then MAX_SCORE - estimateSimilarity(x, x) is always 0', () => {
        // Arrange
        fc.assert(
          fc.property(arbBlobBytes(), (x) => {
            // Act
            const result = MAX_SCORE - estimateSimilarity(x, x);

            // Assert
            expect(result).toBe(0);
          }),
          { numRuns: 100 },
        );
      });
    });
  });
});
