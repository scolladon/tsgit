import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAssignment } from '../../../../src/domain/range-diff/linear-assignment.js';

// git's `compute_assignment` is faithful to range-diff's structured cost
// matrices (an exact/cheap matching always exists), not an arbitrary LAP — its
// `BUG("negative j")` guard shows git itself does not promise a complete matching
// on unstructured input. We therefore generate matrices with a planted unique
// zero-cost perfect matching (the shape range-diff's exact matches produce): all
// other cells cost ≥ 1, so the planted permutation is the unique optimum.
const arbStructured = fc.integer({ min: 2, max: 6 }).chain((n) =>
  fc
    .tuple(
      fc.uniqueArray(fc.integer({ min: 0, max: n - 1 }), { minLength: n, maxLength: n }),
      fc.array(fc.integer({ min: 1, max: 50 }), { minLength: n * n, maxLength: n * n }),
    )
    .map(([permutation, filler]) => {
      const cost = filler.slice();
      for (let column = 0; column < n; column++) cost[column + n * permutation[column]!] = 0;
      return { n, permutation, cost };
    }),
);

const totalCost = (n: number, cost: ReadonlyArray<number>, columnToRow: ReadonlyArray<number>) =>
  columnToRow.reduce((sum, row, column) => sum + cost[column + n * row]!, 0);

describe('Given a cost matrix with a planted unique zero-cost matching', () => {
  describe('When computeAssignment solves it', () => {
    it('Then columnToRow is a permutation and rowToColumn is its inverse', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbStructured, ({ n, cost }) => {
          const result = computeAssignment(n, n, cost);
          expect(new Set(result.columnToRow).size).toBe(n);
          for (let column = 0; column < n; column++) {
            const row = result.columnToRow[column]!;
            expect(row).toBeGreaterThanOrEqual(0);
            expect(row).toBeLessThan(n);
            expect(result.rowToColumn[row]).toBe(column);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then it recovers the planted zero-cost optimum', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbStructured, ({ n, permutation, cost }) => {
          const result = computeAssignment(n, n, cost);
          expect(totalCost(n, cost, result.columnToRow)).toBe(0);
          expect(result.columnToRow).toEqual(permutation);
        }),
        { numRuns: 100 },
      );
    });
  });
});
