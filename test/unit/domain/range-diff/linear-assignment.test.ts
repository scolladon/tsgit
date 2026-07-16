import { describe, expect, it } from 'vitest';
import {
  COST_MAX,
  computeAssignment,
} from '../../../../src/domain/range-diff/linear-assignment.js';

// COST(column, row) = cost[column + columnCount * row]; the flat array lists
// rows outer, columns inner: [C(0,0), C(1,0), …, C(0,1), C(1,1), …].

describe('computeAssignment', () => {
  describe('Given a 2x2 matrix whose diagonal is cheapest, When assigned', () => {
    it('Then it returns the identity assignment', () => {
      // Arrange
      const sut = computeAssignment;
      const cost = [0, 9, 9, 0]; // C(0,0)=0 C(1,0)=9 C(0,1)=9 C(1,1)=0

      // Act
      const result = sut(2, cost);

      // Assert
      expect(result.columnToRow).toEqual([0, 1]);
      expect(result.rowToColumn).toEqual([0, 1]);
    });
  });

  describe('Given a 2x2 matrix whose anti-diagonal is cheapest, When assigned', () => {
    it('Then it swaps the assignment', () => {
      // Arrange
      const sut = computeAssignment;
      const cost = [9, 0, 0, 9]; // C(0,0)=9 C(1,0)=0 C(0,1)=0 C(1,1)=9

      // Act
      const result = sut(2, cost);

      // Assert
      expect(result.columnToRow).toEqual([1, 0]);
      expect(result.rowToColumn).toEqual([1, 0]);
    });
  });

  describe('Given a column count below two, When assigned', () => {
    it('Then both maps are zero-filled', () => {
      // Arrange
      const sut = computeAssignment;

      // Act
      const result = sut(1, [7]);

      // Assert
      expect(result.columnToRow).toEqual([0]);
      expect(result.rowToColumn).toEqual([0]);
    });
  });

  describe('Given a zero-sized problem, When assigned', () => {
    it('Then both maps are empty', () => {
      // Arrange
      const sut = computeAssignment;

      // Act
      const result = sut(0, []);

      // Assert
      expect(result.columnToRow).toEqual([]);
      expect(result.rowToColumn).toEqual([]);
    });
  });

  describe('Given a 3x3 matrix with a unique optimum, When assigned', () => {
    it('Then it returns that permutation', () => {
      // Arrange
      const sut = computeAssignment;
      // Cheapest: col0->row1, col1->row2, col2->row0 (each cost 1; any other
      // assignment pays at least one 5). Rows outer, columns inner.
      //              C(0,r) C(1,r) C(2,r)
      const cost = [
        5,
        5,
        1, // row 0
        1,
        5,
        5, // row 1
        5,
        1,
        5, // row 2
      ];

      // Act
      const result = sut(3, cost);

      // Assert: column0->row1, column1->row2, column2->row0
      expect(result.columnToRow).toEqual([1, 2, 0]);
    });
  });

  describe('Given forbidden COST_MAX cells around a forced zero, When assigned', () => {
    it('Then the forced zero is chosen and forbidden cells are avoided', () => {
      // Arrange — col0 must take row0 (its only finite cell); col1 takes row1.
      const sut = computeAssignment;
      const cost = [
        0,
        COST_MAX, // row 0: C(0,0)=0      C(1,0)=MAX
        COST_MAX,
        0, // row 1: C(0,1)=MAX    C(1,1)=0
      ];

      // Act
      const result = sut(2, cost);

      // Assert
      expect(result.columnToRow).toEqual([0, 1]);
    });
  });

  describe('Given a free row whose only finite column is column 0, When assigned', () => {
    it('Then the single-candidate path (no second-smallest) still assigns it', () => {
      // Arrange — column reduction leaves row 0 free; in the augmenting-row
      // reduction its only non-COST_MAX column is column 0, so no second-smallest
      // candidate exists (git's `j2 < 0` branch).
      const sut = computeAssignment;
      const cost = [
        5,
        COST_MAX, // row 0: C(0,0)=5    C(1,0)=MAX
        3,
        0, // row 1: C(0,1)=3    C(1,1)=0
      ];

      // Act
      const result = sut(2, cost);

      // Assert — col0 takes row0, col1 takes its only cheap row1
      expect(result.columnToRow).toEqual([0, 1]);
    });
  });

  describe('Given a forbidden-cell-heavy 6x6 (range-diff reorder shape), When assigned', () => {
    it('Then the forced permutation is found without overflow corruption', () => {
      // Arrange — three exact pairs (col i -> row [0,2,1][i]) at cost 0, every
      // other real/dummy cell forbidden, dummy×dummy free. A COST_MAX of INT_MAX
      // would overflow the dual arithmetic and loop forever; 1<<16 does not.
      const sut = computeAssignment;
      const total = 6;
      const cost = new Array<number>(total * total).fill(0);
      const at = (column: number, row: number, value: number): void => {
        cost[column + total * row] = value;
      };
      const exact = [0, 2, 1];
      for (let i = 0; i < 3; i++)
        for (let j = 0; j < 3; j++) at(i, j, exact[i] === j ? 0 : COST_MAX);
      for (let i = 0; i < 3; i++) for (let j = 3; j < 6; j++) at(i, j, COST_MAX);
      for (let j = 0; j < 3; j++) for (let i = 3; i < 6; i++) at(i, j, COST_MAX);

      // Act
      const result = sut(total, cost);

      // Assert — old columns map to their exact rows; dummies absorb the rest
      expect(result.columnToRow.slice(0, 3)).toEqual([0, 2, 1]);
    });
  });

  describe('Given a fully forbidden row forcing findTwoSmallest to reset its second candidate, When assigned', () => {
    it('Then the reset drives the complete permutation the solver pins', () => {
      // Arrange — row 2 is entirely COST_MAX, so during augmenting-row reduction
      // a free row sees every column reduced cost >= COST_MAX; findTwoSmallest
      // never records a distinct second smallest, and its `j2 < 0` reset
      // (j2 = j1, u2 = u1) decides where each column lands.
      const sut = computeAssignment;
      const cost = [
        COST_MAX,
        1,
        COST_MAX,
        2, // row 0: C(1,0)=1  C(3,0)=2
        COST_MAX,
        COST_MAX,
        0,
        0, // row 1: C(2,1)=0  C(3,1)=0
        COST_MAX,
        COST_MAX,
        COST_MAX,
        COST_MAX, // row 2: fully forbidden
        2,
        COST_MAX,
        2,
        COST_MAX, // row 3: C(0,3)=2  C(2,3)=2
      ];

      // Act
      const result = sut(4, cost);

      // Assert
      expect(result.columnToRow).toEqual([2, 0, 3, 1]);
      expect(result.rowToColumn).toEqual([1, 3, 0, 2]);
    });
  });

  describe('Given a matrix whose augmenting path needs several scan rounds, When assigned', () => {
    it('Then the do-while keeps scanning until the active column set is exhausted', () => {
      // Arrange — a dense 6x6 whose augmenting-path search must loop scanRows
      // multiple times: the do-while continues while `low !== up` (the set is not
      // yet exhausted). Inverting that continuation to `low === up` stops after
      // one round and yields a different permutation.
      const sut = computeAssignment;
      const cost = [
        0,
        3,
        2,
        COST_MAX,
        0,
        1, // row 0
        2,
        0,
        0,
        1,
        1,
        2, // row 1
        1,
        1,
        0,
        2,
        2,
        2, // row 2
        COST_MAX,
        1,
        COST_MAX,
        2,
        3,
        1, // row 3
        1,
        3,
        1,
        3,
        3,
        0, // row 4
        3,
        3,
        2,
        1,
        COST_MAX,
        COST_MAX, // row 5
      ];

      // Act
      const result = sut(6, cost);

      // Assert
      expect(result.columnToRow).toEqual([4, 1, 2, 5, 0, 3]);
      expect(result.rowToColumn).toEqual([4, 1, 2, 5, 0, 3]);
    });
  });
});
