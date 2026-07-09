import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { commitIsBeforeCutoff, nameRevCutoff } from '../../../../src/domain/name-rev/cutoff.js';

const CUTOFF_DATE_SLOP = 86_400;
const safeInt = () => fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });

describe('Given an arbitrary safe-integer cutoff', () => {
  describe('When testing arbitrary safe-integer dates', () => {
    it('Then it is total — always returns a boolean and never throws', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(safeInt(), safeInt(), (date, cutoff) => {
          const sut = commitIsBeforeCutoff(date, cutoff);
          expect(typeof sut).toBe('boolean');
        }),
        { numRuns: 200 },
      );
    });

    it('Then it is monotone in date — pruning an older date prunes every date before it', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(safeInt(), safeInt(), safeInt(), (d1, d2, cutoff) => {
          const [older, newer] = d1 <= d2 ? [d1, d2] : [d2, d1];
          const sut = commitIsBeforeCutoff(newer, cutoff);
          if (sut) expect(commitIsBeforeCutoff(older, cutoff)).toBe(true);
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
            expect(commitIsBeforeCutoff(cutoff, cutoff)).toBe(false);
            expect(commitIsBeforeCutoff(cutoff - 1, cutoff)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

describe('Given an arbitrary safe-integer target date above the slop floor', () => {
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
            const sut = nameRevCutoff(t);
            expect(t - sut).toBe(CUTOFF_DATE_SLOP);
            expect(sut).toBeLessThan(t);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
