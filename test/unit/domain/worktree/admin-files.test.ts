import { describe, expect, it } from 'vitest';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import {
  WORKTREE_COMMONDIR,
  worktreeGitdirPointer,
  worktreeGitfile,
  worktreeHeadContent,
} from '../../../../src/domain/worktree/admin-files.js';

describe('worktree admin files', () => {
  describe('Given the admin directory layout', () => {
    describe('When WORKTREE_COMMONDIR is read', () => {
      it('Then it points two levels up', () => {
        // Arrange + Assert
        expect(WORKTREE_COMMONDIR).toBe('../..');
      });
    });
  });

  describe('Given an absolute worktree path', () => {
    describe('When worktreeGitdirPointer runs', () => {
      it('Then it points at the worktree .git file', () => {
        // Arrange + Act
        const result = worktreeGitdirPointer('/abs/wt');

        // Assert
        expect(result).toBe('/abs/wt/.git');
      });
    });
  });

  describe('Given an absolute admin directory', () => {
    describe('When worktreeGitfile runs', () => {
      it('Then it renders the gitdir pointer', () => {
        // Arrange + Act
        const result = worktreeGitfile('/g/.git/worktrees/wt');

        // Assert
        expect(result).toBe('gitdir: /g/.git/worktrees/wt');
      });
    });
  });

  describe('Given a branch HEAD', () => {
    describe('When worktreeHeadContent runs', () => {
      it('Then it renders a symref', () => {
        // Arrange + Act
        const result = worktreeHeadContent({ kind: 'branch', ref: 'refs/heads/wt' as RefName });

        // Assert
        expect(result).toBe('ref: refs/heads/wt');
      });
    });
  });

  describe('Given a detached HEAD', () => {
    describe('When worktreeHeadContent runs', () => {
      it('Then it renders the bare oid', () => {
        // Arrange
        const oid = 'a'.repeat(40) as ObjectId;

        // Act
        const result = worktreeHeadContent({ kind: 'detached', oid });

        // Assert
        expect(result).toBe(oid);
      });
    });
  });
});
