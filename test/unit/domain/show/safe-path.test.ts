import { describe, expect, it } from 'vitest';

import type { TsgitError } from '../../../../src/domain/error.js';
import { assertSafePath } from '../../../../src/domain/show/safe-path.js';

const NUL = String.fromCharCode(0);

const dataOf = (run: () => void): TsgitError['data'] => {
  try {
    run();
  } catch (err) {
    return (err as TsgitError).data;
  }
  throw new Error('expected assertSafePath to throw');
};

describe('Given assertSafePath', () => {
  describe('When the path has no control characters', () => {
    it('Then it accepts the path', () => {
      // Arrange + Act + Assert
      expect(() => assertSafePath('sub/dir/file name.txt')).not.toThrow();
    });
  });

  describe('When the path contains a newline', () => {
    it('Then it throws INVALID_DIFF_INPUT without echoing the path', () => {
      // Arrange + Act
      const data = dataOf(() => assertSafePath('a\ndiff --cc evil'));

      // Assert
      expect(data.code).toBe('INVALID_DIFF_INPUT');
      expect(JSON.stringify(data)).not.toContain('evil');
    });
  });

  describe('When the path contains a carriage return or NUL', () => {
    it('Then it throws', () => {
      // Arrange + Act + Assert
      expect(() => assertSafePath('a\rb')).toThrow();
      expect(() => assertSafePath(`a${NUL}b`)).toThrow();
    });
  });
});
