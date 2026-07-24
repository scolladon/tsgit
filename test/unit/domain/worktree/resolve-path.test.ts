import { describe, expect, it } from 'vitest';
import {
  resolveWorktreePath,
  worktreePathBasename,
} from '../../../../src/domain/worktree/resolve-path.js';

describe('worktreePathBasename', () => {
  describe('Given a path', () => {
    describe('When worktreePathBasename runs', () => {
      it.each([
        { path: '/a/b/feature', expected: 'feature', label: 'it returns the last component' },
        { path: '/a/b/', expected: 'b', label: 'trailing empties are ignored' },
        { path: '/', expected: '', label: 'it returns the empty string' },
      ])('Then $label', ({ path, expected }) => {
        // Arrange
        const sut = worktreePathBasename;

        // Act
        const result = sut(path);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});

describe('resolveWorktreePath', () => {
  describe('Given a cwd and an input path', () => {
    describe('When resolveWorktreePath runs', () => {
      it.each([
        { cwd: '/cwd', input: '/abs/wt', expected: '/abs/wt', label: 'it ignores cwd' },
        { cwd: '/cwd', input: 'wt', expected: '/cwd/wt', label: 'it joins onto cwd' },
        { cwd: '/a/b', input: '../wt', expected: '/a/wt', label: '`..` pops the previous segment' },
        { cwd: '/a/b', input: './wt', expected: '/a/b/wt', label: '`.` is dropped' },
        { cwd: '/a', input: '../../wt', expected: '/wt', label: 'it never pops below the root' },
        { cwd: '/a//b', input: 'c', expected: '/a/b/c', label: 'empty segments are collapsed' },
      ])('Then $label', ({ cwd, input, expected }) => {
        // Arrange
        const sut = resolveWorktreePath;

        // Act
        const result = sut(cwd, input);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });
});
