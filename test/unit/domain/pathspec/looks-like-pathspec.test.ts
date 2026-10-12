import { describe, expect, it } from 'vitest';
import { looksLikePathspec } from '../../../../src/domain/pathspec/index.js';

describe('Given an argument a revision could not resolve', () => {
  describe.each([
    { arg: 'a*', expected: true },
    { arg: 'a?', expected: true },
    { arg: 'a[b', expected: true },
    { arg: ':(glob)x', expected: true },
    { arg: 'a\\*', expected: false },
    { arg: 'a\\', expected: false },
    { arg: 'a\\\\*', expected: true },
    { arg: 'main~1', expected: false },
    { arg: 'x:(y', expected: false },
  ])('When looksLikePathspec reads $arg', ({ arg, expected }) => {
    it(`Then it answers ${expected}`, () => {
      // Arrange
      const sut = looksLikePathspec;

      // Act
      const result = sut(arg);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
