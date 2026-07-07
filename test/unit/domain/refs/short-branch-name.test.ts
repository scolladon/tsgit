import { describe, expect, it } from 'vitest';
import { RefName } from '../../../../src/domain/objects/object-id.js';
import { shortBranchName as sut } from '../../../../src/domain/refs/short-branch-name.js';

describe('Given a ref name', () => {
  describe('When stripping the heads prefix', () => {
    it('Then a top-level branch ref loses refs/heads/', () => {
      // Arrange
      const ref = RefName.from('refs/heads/main');

      // Act
      const result = sut(ref);

      // Assert
      expect(result).toBe('main');
    });

    it('Then a nested branch ref keeps its inner slashes', () => {
      // Arrange
      const ref = RefName.from('refs/heads/feature/x');

      // Act
      const result = sut(ref);

      // Assert
      expect(result).toBe('feature/x');
    });

    it('Then a non-heads ref is returned unchanged', () => {
      // Arrange
      const ref = RefName.from('refs/tags/v1');

      // Act
      const result = sut(ref);

      // Assert
      expect(result).toBe('refs/tags/v1');
    });
  });
});
