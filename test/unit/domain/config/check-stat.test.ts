import { describe, expect, it } from 'vitest';
import { parseCheckStat } from '../../../../src/domain/config/check-stat.js';

describe('parseCheckStat', () => {
  describe.each([
    ['default', 'default'],
    ['DEFAULT', 'default'],
    ['minimal', 'minimal'],
    ['Minimal', 'minimal'],
    ['', undefined],
    ['bogus', undefined],
    [null, undefined],
  ] as const)('Given %j', (value, expected) => {
    describe('When parsed', () => {
      it('Then git reads it as the matching mode or ignores it', () => {
        // Arrange
        const sut = parseCheckStat;

        // Act
        const result = sut(value);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
