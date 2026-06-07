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
      const result = sut(2, 2, cost);

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
      const result = sut(2, 2, cost);

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
      const result = sut(1, 1, [7]);

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
      const result = sut(0, 0, []);

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
      const result = sut(3, 3, cost);

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
      const result = sut(2, 2, cost);

      // Assert
      expect(result.columnToRow).toEqual([0, 1]);
    });
  });
});
