import { describe, expect, it } from 'vitest';
import { mergedLayerCount } from '../../../../src/domain/commit/commit-graph-split.js';

describe('mergedLayerCount', () => {
  describe.each([
    { label: 'no existing layer', layers: [], fresh: 3, expected: 0 },
    { label: 'a tip at exactly twice the new commits', layers: [2], fresh: 1, expected: 1 },
    { label: 'a tip past twice the new commits', layers: [3], fresh: 1, expected: 0 },
    { label: 'a merged tip whose base stays too large', layers: [10, 2], fresh: 1, expected: 1 },
    { label: 'a merged tip whose base then fits', layers: [6, 2], fresh: 1, expected: 2 },
  ])('Given $label', ({ layers, fresh, expected }) => {
    describe('When the merge strategy runs', () => {
      it(`Then ${expected} tip layer(s) merge into the new one`, () => {
        // Arrange
        const sut = mergedLayerCount;

        // Act
        const result = sut(layers, fresh);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
