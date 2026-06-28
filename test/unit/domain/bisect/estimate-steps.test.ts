import { describe, expect, it } from 'vitest';
import { estimateSteps } from '../../../../src/domain/bisect/estimate-steps.js';

describe('estimateSteps', () => {
  describe('Given all < 3, When estimating steps', () => {
    it('Then it returns 0', () => {
      // Arrange
      const sut = estimateSteps;

      // Act + Assert
      expect(sut(0)).toBe(0);
      expect(sut(1)).toBe(0);
      expect(sut(2)).toBe(0);
    });
  });

  describe('Given all = 3, When estimating steps', () => {
    it('Then it returns 1 (e < 3*x branch taken)', () => {
      // Arrange
      const sut = estimateSteps;
      // n=1, e=2, x=1; e<3*x: 2<3 → true → n=1

      // Act
      const result = sut(3);

      // Assert
      expect(result).toBe(1);
    });
  });

  describe('Given all = 4, When estimating steps', () => {
    it('Then it returns 1 (e >= 3*x branch taken)', () => {
      // Arrange
      const sut = estimateSteps;
      // n=2, e=4, x=0; e<3*x: 4<0 → false → n-1=1

      // Act
      const result = sut(4);

      // Assert
      expect(result).toBe(1);
    });
  });

  describe('Given pinned all→steps table entries, When estimating steps', () => {
    it('Then it returns the canonical git value for each entry', () => {
      // Arrange
      const sut = estimateSteps;
      const table: ReadonlyArray<[number, number]> = [
        [2, 0],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 2],
        [7, 2],
        [8, 2],
        [9, 2],
      ];

      // Act + Assert
      for (const [all, expected] of table) {
        expect(sut(all), `all=${all}`).toBe(expected);
      }
    });
  });
});
