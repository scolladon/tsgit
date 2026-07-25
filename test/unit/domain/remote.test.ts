import { describe, expect, it } from 'vitest';
import { DEFAULT_REMOTE } from '../../../src/domain/remote.js';

describe('Given the default remote name', () => {
  describe('When reading the canonical constant', () => {
    it('Then DEFAULT_REMOTE is origin', () => {
      // Arrange
      const expected = 'origin';

      // Act
      const result = DEFAULT_REMOTE;

      // Assert
      expect(result).toBe(expected);
    });
  });
});
