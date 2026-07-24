import { describe, expect, it } from 'vitest';
import { RefName } from '../../../../src/domain/objects/object-id.js';
import { shortBranchName as sut } from '../../../../src/domain/refs/short-branch-name.js';

describe('Given a ref name', () => {
  describe('When stripping the heads prefix', () => {
    it.each([
      {
        ref: 'refs/heads/main',
        expected: 'main',
        label: 'a top-level branch ref loses refs/heads/',
      },
      {
        ref: 'refs/heads/feature/x',
        expected: 'feature/x',
        label: 'a nested branch ref keeps its inner slashes',
      },
      {
        ref: 'refs/tags/v1',
        expected: 'refs/tags/v1',
        label: 'a non-heads ref is returned unchanged',
      },
    ])('Then $label', ({ ref, expected }) => {
      // Arrange
      const name = RefName.from(ref);

      // Act
      const result = sut(name);

      // Assert
      expect(result).toBe(expected);
    });
  });
});
