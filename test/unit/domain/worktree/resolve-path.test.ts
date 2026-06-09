import { describe, expect, it } from 'vitest';
import {
  resolveWorktreePath,
  worktreePathBasename,
} from '../../../../src/domain/worktree/resolve-path.js';

describe('worktreePathBasename', () => {
  describe('Given an absolute path', () => {
    describe('When worktreePathBasename runs', () => {
      it('Then it returns the last component', () => {
        // Arrange
        const sut = '/a/b/feature';

        // Act
        const result = worktreePathBasename(sut);

        // Assert
        expect(result).toBe('feature');
      });
    });
  });

  describe('Given a path with a trailing slash', () => {
    describe('When worktreePathBasename runs', () => {
      it('Then trailing empties are ignored', () => {
        // Arrange
        const sut = '/a/b/';

        // Act
        const result = worktreePathBasename(sut);

        // Assert
        expect(result).toBe('b');
      });
    });
  });

  describe('Given the root path', () => {
    describe('When worktreePathBasename runs', () => {
      it('Then it returns the empty string', () => {
        // Arrange
        const sut = '/';

        // Act
        const result = worktreePathBasename(sut);

        // Assert
        expect(result).toBe('');
      });
    });
  });
});

describe('resolveWorktreePath', () => {
  describe('Given an absolute input', () => {
    describe('When resolveWorktreePath runs', () => {
      it('Then it ignores cwd', () => {
        // Arrange
        const sut = '/abs/wt';

        // Act
        const result = resolveWorktreePath('/cwd', sut);

        // Assert
        expect(result).toBe('/abs/wt');
      });
    });
  });

  describe('Given a relative input', () => {
    describe('When resolveWorktreePath runs', () => {
      it('Then it joins onto cwd', () => {
        // Arrange
        const sut = 'wt';

        // Act
        const result = resolveWorktreePath('/cwd', sut);

        // Assert
        expect(result).toBe('/cwd/wt');
      });
    });
  });

  describe('Given a parent-relative input', () => {
    describe('When resolveWorktreePath runs', () => {
      it('Then `..` pops the previous segment', () => {
        // Arrange
        const sut = '../wt';

        // Act
        const result = resolveWorktreePath('/a/b', sut);

        // Assert
        expect(result).toBe('/a/wt');
      });
    });
  });

  describe('Given a current-dir segment', () => {
    describe('When resolveWorktreePath runs', () => {
      it('Then `.` is dropped', () => {
        // Arrange
        const sut = './wt';

        // Act
        const result = resolveWorktreePath('/a/b', sut);

        // Assert
        expect(result).toBe('/a/b/wt');
      });
    });
  });

  describe('Given more `..` than depth', () => {
    describe('When resolveWorktreePath runs', () => {
      it('Then it never pops below the root', () => {
        // Arrange
        const sut = '../../wt';

        // Act
        const result = resolveWorktreePath('/a', sut);

        // Assert
        expect(result).toBe('/wt');
      });
    });
  });

  describe('Given doubled separators', () => {
    describe('When resolveWorktreePath runs', () => {
      it('Then empty segments are collapsed', () => {
        // Arrange
        const sut = 'c';

        // Act
        const result = resolveWorktreePath('/a//b', sut);

        // Assert
        expect(result).toBe('/a/b/c');
      });
    });
  });
});
