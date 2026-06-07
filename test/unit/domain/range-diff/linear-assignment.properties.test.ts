import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { computeAssignment } from '../../../../src/domain/range-diff/linear-assignment.js';

// Generate a square n x n non-negative integer cost matrix (flat, row-major over
// COST(column,row) = cost[column + n*row]).
const arbSquareCost = fc
  .integer({ min: 2, max: 6 })
  .chain((n) =>
    fc
      .array(fc.integer({ min: 0, max: 50 }), { minLength: n * n, maxLength: n * n })
      .map((cost) => ({ n, cost })),
  );

const totalCost = (n: number, cost: ReadonlyArray<number>, columnToRow: ReadonlyArray<number>) =>
  columnToRow.reduce((sum, row, column) => sum + cost[column + n * row]!, 0);

describe('Given an arbitrary non-negative square cost matrix', () => {
  describe('When computeAssignment solves it', () => {
    it('Then columnToRow is a permutation and rowToColumn is its inverse', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSquareCost, ({ n, cost }) => {
          const result = computeAssignment(n, n, cost);
          const seen = new Set(result.columnToRow);
          expect(seen.size).toBe(n);
          for (const row of result.columnToRow) {
            expect(row).toBeGreaterThanOrEqual(0);
            expect(row).toBeLessThan(n);
          }
          for (let column = 0; column < n; column++) {
            const row = result.columnToRow[column]!;
            expect(result.rowToColumn[row]).toBe(column);
          }
        }),
        { numRuns: 100 },
      );
    });

    it('Then the assignment cost never exceeds the identity diagonal cost', () => {
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbSquareCost, ({ n, cost }) => {
          const result = computeAssignment(n, n, cost);
          const identity = Array.from({ length: n }, (_, i) => i);
          expect(totalCost(n, cost, result.columnToRow)).toBeLessThanOrEqual(
            totalCost(n, cost, identity),
          );
        }),
        { numRuns: 100 },
      );
    });
  });
});
