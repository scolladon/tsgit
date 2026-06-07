import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COST_MAX,
  computeAssignment,
} from '../../../../src/domain/range-diff/linear-assignment.js';

// A range-diff-shaped cost matrix (n = a old + b new): exact-matched cells cost
// 0, free old/new pairs a small fuzzy cost, cross-matched cells COST_MAX,
// creation/deletion dummies a finite escape (or COST_MAX when exact-matched), and
// the dummy×dummy block 0. The escapes + dummy block guarantee a perfect matching
// while the collisions force the augmenting-path phase the planted-zero matrices
// skip — the genuine input distribution git's solver is built for.
const arbRangeDiffMatrix = fc
  .tuple(fc.integer({ min: 1, max: 7 }), fc.integer({ min: 1, max: 7 }))
  .chain(([a, b]) =>
    fc
      .record({
        exactPairs: fc.uniqueArray(
          fc.tuple(fc.integer({ min: 0, max: a - 1 }), fc.integer({ min: 0, max: b - 1 })),
          { maxLength: Math.min(a, b), selector: ([oldIndex]) => oldIndex },
        ),
        costs: fc.array(fc.integer({ min: 0, max: 30 }), {
          minLength: 2 * (a + b),
          maxLength: 2 * (a + b),
        }),
      })
      .map(({ exactPairs, costs }) => {
        const n = a + b;
        const exactOld = new Array<number>(a).fill(-1);
        const exactNew = new Array<number>(b).fill(-1);
        const newTaken = new Set<number>();
        for (const [oldIndex, newIndex] of exactPairs) {
          if (!newTaken.has(newIndex)) {
            exactOld[oldIndex] = newIndex;
            exactNew[newIndex] = oldIndex;
            newTaken.add(newIndex);
          }
        }
        const cost = new Array<number>(n * n).fill(0);
        let cursor = 0;
        const next = () => costs[cursor++ % costs.length]!;
        for (let i = 0; i < a; i++) {
          for (let j = 0; j < b; j++) {
            cost[i + n * j] =
              exactOld[i] === j ? 0 : exactOld[i]! < 0 && exactNew[j]! < 0 ? next() : COST_MAX;
          }
          const del = exactOld[i]! < 0 ? next() : COST_MAX;
          for (let j = b; j < n; j++) cost[i + n * j] = del;
        }
        for (let j = 0; j < b; j++) {
          const create = exactNew[j]! < 0 ? next() : COST_MAX;
          for (let i = a; i < n; i++) cost[i + n * j] = create;
        }
        return { n, cost };
      }),
  );

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
          const result = computeAssignment(n, cost);
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
          const result = computeAssignment(n, cost);
          expect(totalCost(n, cost, result.columnToRow)).toBe(0);
          expect(result.columnToRow).toEqual(permutation);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe('Given an arbitrary range-diff-shaped cost matrix', () => {
  describe('When computeAssignment solves it', () => {
    it('Then it returns a consistent matching (assigned pairs are mutual inverses)', () => {
      // git's heuristic may leave a column unassigned (-1) even here; range-diff
      // treats that as a deletion. We assert only that what IS assigned is a
      // valid, mutually-consistent partial matching with in-range indices.
      // Arrange + Act + Assert
      fc.assert(
        fc.property(arbRangeDiffMatrix, ({ n, cost }) => {
          const result = computeAssignment(n, cost);
          const assignedRows = new Set<number>();
          for (let column = 0; column < n; column++) {
            const row = result.columnToRow[column]!;
            expect(row).toBeGreaterThanOrEqual(-1);
            expect(row).toBeLessThan(n);
            if (row >= 0) {
              expect(assignedRows.has(row)).toBe(false);
              assignedRows.add(row);
              expect(result.rowToColumn[row]).toBe(column);
            }
          }
        }),
        { numRuns: 500 },
      );
    });
  });
});
