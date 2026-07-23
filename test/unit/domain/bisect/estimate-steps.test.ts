import { describe, expect, it } from 'vitest';
import { estimateSteps } from '../../../../src/domain/bisect/estimate-steps.js';

describe('estimateSteps', () => {
  describe('Given a pinned all→steps table entry, When estimating steps', () => {
    it.each([
      [0, 0],
      [1, 0],
      [2, 0],
      // all=3: n=1, e=2, x=1; e<3*x: 2<3 → true → n=1 (e < 3*x branch taken)
      [3, 1],
      // all=4: n=2, e=4, x=0; e<3*x: 4<0 → false → n-1=1 (e >= 3*x branch taken)
      [4, 1],
      [5, 1],
      [6, 2],
      [7, 2],
      [8, 2],
      [9, 2],
    ])('Then estimateSteps(%i) is the canonical git value %i', (all, expected) => {
      // Arrange
      const sut = estimateSteps;

      // Act
      const result = sut(all);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
