import { describe, expect, it } from 'vitest';
import { parseRenameScore } from '../../../../src/domain/diff/rename-score.js';

describe('parseRenameScore', () => {
  describe.each([
    ['50', 30000, ''],
    ['5', 30000, ''],
    ['077', 4620, ''],
    ['77%', 46200, ''],
    ['0.77', 46200, ''],
    ['.78', 46800, ''],
    ['7.5', 60000, ''],
    ['200%', 60000, ''],
    ['1.5%', 900, ''],
    ['', 0, ''],
    ['abc', 0, 'abc'],
    ['5x', 30000, 'x'],
    ['50%x', 30000, 'x'],
    ['1.2.3', 60000, '.3'],
    ['1234567', 7407, ''],
  ])('Given %j', (text, score, rest) => {
    describe('When parsed', () => {
      it(`Then the score is ${score} and ${JSON.stringify(rest)} is left`, () => {
        // Arrange
        const sut = parseRenameScore;

        // Act
        const result = sut(text);

        // Assert
        expect(result).toEqual({ score, rest });
      });
    });
  });
});
