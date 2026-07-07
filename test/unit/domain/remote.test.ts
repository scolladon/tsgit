import { describe, expect, it } from 'vitest';
import * as sut from '../../../src/domain/remote.js';

describe('Given the default remote name', () => {
  describe('When reading the canonical constant', () => {
    it('Then DEFAULT_REMOTE is origin', () => {
      // Arrange / Act / Assert
      expect(sut.DEFAULT_REMOTE).toBe('origin');
    });
  });
});
