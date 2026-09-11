import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commitIsBeforeCutoff, nameRevCutoff } from '../../../../src/domain/name-rev/cutoff.js';

const CUTOFF_DATE_SLOP = 86_400;
const GENERATION_INFINITY = Number.POSITIVE_INFINITY;
const safeInt = () => fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });

/** The date branch fires only when both sides carry an infinite generation
 *  (`commitIsBeforeCutoff`'s `cutoff.generation < GENERATION_INFINITY` guard is false). */
const infiniteGenerationCommit = (committerDate: number) => ({
  committerDate,
  generation: GENERATION_INFINITY,
});
const infiniteGenerationCutoff = (date: number) => ({ date, generation: GENERATION_INFINITY });

describe('Given an arbitrary safe-integer cutoff date, both sides at an infinite generation', () => {
  describe('When testing arbitrary safe-integer commit dates', () => {
    it('Then it is total — always returns a boolean and never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(safeInt(), safeInt(), (date, cutoff) => {
          const result = commitIsBeforeCutoff(
            infiniteGenerationCommit(date),
            infiniteGenerationCutoff(cutoff),
          );
          expect(typeof result).toBe('boolean');
        }),
        { numRuns: 200 },
      );
    });

    it('Then it is monotone in date — pruning an older date prunes every date before it', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(safeInt(), safeInt(), safeInt(), (d1, d2, cutoff) => {
          const [older, newer] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const result = commitIsBeforeCutoff(
            infiniteGenerationCommit(newer),
            infiniteGenerationCutoff(cutoff),
          );
          if (result) {
            expect(
              commitIsBeforeCutoff(
                infiniteGenerationCommit(older),
                infiniteGenerationCutoff(cutoff),
              ),
            ).toBe(true);
          }
        }),
        { numRuns: 200 },
      );
    });

    it('Then the threshold sits strictly between cutoff-1 and cutoff', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc.integer({ min: Number.MIN_SAFE_INTEGER + 1, max: Number.MAX_SAFE_INTEGER }),
          (cutoff) => {
            expect(
              commitIsBeforeCutoff(
                infiniteGenerationCommit(cutoff),
                infiniteGenerationCutoff(cutoff),
              ),
            ).toBe(false);
            expect(
              commitIsBeforeCutoff(
                infiniteGenerationCommit(cutoff - 1),
                infiniteGenerationCutoff(cutoff),
              ),
            ).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary safe-integer target date above the slop floor, at an infinite generation', () => {
  describe('When computing the name-rev cutoff', () => {
    it('Then the result is exactly one day of slop below the target', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          fc
            .integer({
              min: Number.MIN_SAFE_INTEGER + CUTOFF_DATE_SLOP + 1,
              max: Number.MAX_SAFE_INTEGER,
            })
            .filter((t) => t !== 0),
          (t) => {
            const result = nameRevCutoff(infiniteGenerationCommit(t));
            expect(t - result.date).toBe(CUTOFF_DATE_SLOP);
            expect(result.date).toBeLessThan(t);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given a finite cutoff generation', () => {
  describe('When testing an arbitrary commit generation and date', () => {
    it('Then the verdict depends only on the generation, never on the date', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(
          safeInt(),
          safeInt(),
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 0, max: 1_000_000 }),
          (dateA, dateB, commitGeneration, cutoffGeneration) => {
            const cutoff = { date: 0, generation: cutoffGeneration };
            const resultA = commitIsBeforeCutoff(
              { committerDate: dateA, generation: commitGeneration },
              cutoff,
            );
            const resultB = commitIsBeforeCutoff(
              { committerDate: dateB, generation: commitGeneration },
              cutoff,
            );
            expect(resultA).toBe(resultB);
            expect(resultA).toBe(commitGeneration < cutoffGeneration);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
