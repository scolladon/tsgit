import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/index.js';
import { newBranchRef } from '../../../../src/domain/refs/branch-ref.js';

const dataOf = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return (error as TsgitError).data;
  }
  return undefined;
};

describe('Given a new branch name', () => {
  describe('When it is an ordinary name', () => {
    it.each(['main', 'HEAD2', 'heads', 'a-b', 'feature/-x'])(
      'Then %s maps under refs/heads/',
      (name) => {
        // Arrange
        const sut = newBranchRef;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(`refs/heads/${name}`);
      },
    );
  });

  describe('When it is exactly HEAD', () => {
    it('Then it is refused with the HEAD reason', () => {
      // Arrange
      const sut = newBranchRef;

      // Act
      const data = dataOf(() => sut('HEAD'));

      // Assert
      expect(data).toEqual({ code: 'INVALID_REF', reason: 'branch name must not be HEAD' });
    });
  });

  describe('When it starts with a dash', () => {
    it('Then it is refused with the dash reason', () => {
      // Arrange
      const sut = newBranchRef;

      // Act
      const data = dataOf(() => sut('-x'));

      // Assert
      expect(data).toEqual({ code: 'INVALID_REF', reason: 'branch name must not start with -' });
    });
  });

  describe('When it breaks the ref-name grammar', () => {
    it('Then the grammar refusal surfaces', () => {
      // Arrange
      const sut = newBranchRef;

      // Act
      const data = dataOf(() => sut('x..y'));

      // Assert
      expect(data).toEqual({ code: 'INVALID_REF', reason: 'ref name must not contain ..' });
    });
  });
});
