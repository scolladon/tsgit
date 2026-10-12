import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseRenameScore } from '../../../../src/domain/diff/rename-score.js';
import { MAX_SCORE } from '../../../../src/domain/diff/similarity.js';

const PERCENT = 100;

describe('parseRenameScore properties', () => {
  describe('Given any whole percentage', () => {
    describe('When parsed with a trailing %', () => {
      it('Then the score is that share of MAX_SCORE and nothing is left', () => {
        fc.assert(
          fc.property(fc.integer({ min: 0, max: 99 }), (percent) => {
            // Arrange
            const sut = parseRenameScore;

            // Act
            const result = sut(`${percent}%`);

            // Assert
            expect(result).toEqual({
              score: Math.floor((MAX_SCORE * percent) / PERCENT),
              rest: '',
            });
          }),
        );
      });
    });
  });

  describe('Given any numeric prefix and a non-numeric suffix', () => {
    describe('When parsed', () => {
      it('Then the score stays within 0..MAX_SCORE and the suffix is left', () => {
        fc.assert(
          fc.property(
            fc.stringMatching(/^[0-9]{0,8}$/),
            fc.stringMatching(/^[a-z][a-z0-9]{0,4}$/),
            (digits, suffix) => {
              // Arrange
              const sut = parseRenameScore;

              // Act
              const result = sut(`${digits}${suffix}`);

              // Assert
              expect(result.rest).toBe(suffix);
              expect(result.score).toBeGreaterThanOrEqual(0);
              expect(result.score).toBeLessThanOrEqual(MAX_SCORE);
            },
          ),
        );
      });
    });
  });

  describe('Given a decimal fraction below one', () => {
    describe('When parsed', () => {
      it('Then it scores the same as its percentage spelling', () => {
        fc.assert(
          fc.property(fc.integer({ min: 0, max: 99 }), (percent) => {
            // Arrange
            const sut = parseRenameScore;
            const fraction = `0.${String(percent).padStart(2, '0')}`;

            // Act
            const result = sut(fraction);

            // Assert
            expect(result).toEqual(sut(`${percent}%`));
          }),
        );
      });
    });
  });
});
