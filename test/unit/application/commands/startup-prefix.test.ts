import { describe, expect, it } from 'vitest';
import { startupPrefix } from '../../../../src/application/commands/internal/startup-prefix.js';

describe('startupPrefix', () => {
  describe('Given no worktree', () => {
    describe('When the caller sits in a directory spelt like the unset worktree', () => {
      it('Then it is outside the worktree', () => {
        // Arrange
        const sut = startupPrefix;

        // Act
        const result = sut('undefined/sub', undefined);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each([
    ['/repo', '/repo', ''],
    ['/repo/a/b', '/repo', 'a/b/'],
    ['/repository', '/repo', undefined],
  ] as const)('Given the worktree /repo and the caller at %s', (cwd, workDir, expected) => {
    describe('When the prefix is taken', () => {
      it('Then it is git’s startup prefix', () => {
        // Arrange
        const sut = startupPrefix;

        // Act
        const result = sut(cwd, workDir);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
