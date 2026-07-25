import { describe, expect, it } from 'vitest';
import { TsgitError } from '../../../../src/domain/error.js';
import {
  branchCheckedOut,
  notAWorktree,
  worktreeDirty,
  worktreeLocked,
  worktreePathExists,
} from '../../../../src/domain/worktree/error.js';

describe('worktree errors', () => {
  describe('Given worktreePathExists', () => {
    describe('When constructed', () => {
      it('Then carries the code and path', () => {
        // Arrange + Act
        const result = worktreePathExists('/abs/wt');

        // Assert
        expect(result).toBeInstanceOf(TsgitError);
        expect(result.data).toEqual({ code: 'WORKTREE_PATH_EXISTS', path: '/abs/wt' });
      });
    });
  });

  describe('Given branchCheckedOut', () => {
    describe('When constructed', () => {
      it('Then carries the code, branch and path', () => {
        // Arrange + Act
        const result = branchCheckedOut('refs/heads/main', '/abs/wt');

        // Assert
        expect(result.data).toEqual({
          code: 'BRANCH_CHECKED_OUT',
          branch: 'refs/heads/main',
          path: '/abs/wt',
        });
      });
    });
  });

  describe('Given worktreeLocked', () => {
    describe('When constructed', () => {
      it('Then carries the code, path and reason', () => {
        // Arrange + Act
        const result = worktreeLocked('/abs/wt', 'in use');

        // Assert
        expect(result.data).toEqual({ code: 'WORKTREE_LOCKED', path: '/abs/wt', reason: 'in use' });
      });
    });
  });

  describe('Given worktreeDirty', () => {
    describe('When constructed', () => {
      it('Then carries the code and path', () => {
        // Arrange + Act
        const result = worktreeDirty('/abs/wt');

        // Assert
        expect(result.data).toEqual({ code: 'WORKTREE_DIRTY', path: '/abs/wt' });
      });
    });
  });

  describe('Given notAWorktree', () => {
    describe('When constructed', () => {
      it('Then carries the code and path', () => {
        // Arrange + Act
        const result = notAWorktree('/abs/wt');

        // Assert
        expect(result.data).toEqual({ code: 'NOT_A_WORKTREE', path: '/abs/wt' });
      });
    });
  });
});
