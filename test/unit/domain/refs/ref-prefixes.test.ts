import { describe, expect, it } from 'vitest';
import { HEADS_PREFIX } from '../../../../src/domain/refs/ref-prefixes.js';

describe('Given the local-branch ref prefix', () => {
  describe('When reading the canonical constant', () => {
    it('Then HEADS_PREFIX is refs/heads/', () => {
      // Arrange / Act / Assert
      expect(HEADS_PREFIX).toBe('refs/heads/');
    });
  });
});
