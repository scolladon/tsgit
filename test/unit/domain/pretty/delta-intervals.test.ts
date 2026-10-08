import { describe, expect, it } from 'vitest';
import { decodeDeltaIntervals } from '../../../../src/domain/pretty/delta-intervals.js';
import {
  DOUBLE_WIDTH_INTERVALS,
  ZERO_WIDTH_INTERVALS,
} from '../../../../src/domain/pretty/utf8-width-tables.js';
import {
  GIT_DOUBLE_WIDTH_INTERVALS,
  GIT_ZERO_WIDTH_INTERVALS,
} from '../../../fixtures/utf8-width-intervals.js';

describe('decodeDeltaIntervals', () => {
  describe('Given a single base-36 value, When decoded', () => {
    it('Then it is the distance from zero', () => {
      // Arrange
      const sut = decodeDeltaIntervals;

      // Act
      const result = sut('lc');

      // Assert
      expect(result).toEqual([0x300]);
    });
  });

  describe('Given several deltas, When decoded', () => {
    it('Then each code point adds its delta to the previous one', () => {
      // Arrange
      const sut = decodeDeltaIntervals;

      // Act
      const result = sut('lc,33,0,z');

      // Assert
      expect(result).toEqual([0x300, 0x36f, 0x36f, 0x392]);
    });
  });

  describe('Given the generated zero-width table, When decoded at module evaluation', () => {
    it("Then it holds git's zero-width intervals", () => {
      // Arrange
      const sut = ZERO_WIDTH_INTERVALS;

      // Act
      const result = [...sut];

      // Assert
      expect(result).toEqual(GIT_ZERO_WIDTH_INTERVALS);
    });
  });

  describe('Given the generated double-width table, When decoded at module evaluation', () => {
    it("Then it holds git's double-width intervals", () => {
      // Arrange
      const sut = DOUBLE_WIDTH_INTERVALS;

      // Act
      const result = [...sut];

      // Assert
      expect(result).toEqual(GIT_DOUBLE_WIDTH_INTERVALS);
    });
  });
});
