import { describe, expect, it } from 'vitest';
import * as sut from '../../../../src/domain/refs/ref-prefixes.js';

describe('Given the local-branch ref prefix', () => {
  describe('When reading the canonical constant', () => {
    it('Then HEADS_PREFIX is refs/heads/', () => {
      // Arrange / Act / Assert
      expect(sut.HEADS_PREFIX).toBe('refs/heads/');
    });
  });
});
