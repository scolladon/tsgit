import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  bareStoreRefName,
  isPerWorktreeRef,
  isPseudoRef,
  linkedWorktreeRefPrefix,
  mainWorktreeBareName,
} from '../../../../src/domain/refs/per-worktree-ref.js';

describe('isPerWorktreeRef', () => {
  describe('Given a per-worktree pseudoref or per-worktree-prefixed ref', () => {
    describe('When isPerWorktreeRef runs', () => {
      it.each([
        'HEAD',
        'ORIG_HEAD',
        'FETCH_HEAD',
        'MERGE_HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'BISECT_HEAD',
        'REBASE_HEAD',
        'AUTO_MERGE',
        'HEADER',
        'NOTES-MERGE_PARTIAL',
        'refs/bisect/good',
        'refs/worktree/private',
        'refs/rewritten/abc',
      ])('Then %s is per-worktree', (name) => {
        // Arrange & Act
        const result = isPerWorktreeRef(name as RefName);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a shared ref', () => {
    describe('When isPerWorktreeRef runs', () => {
      it.each([
        'refs/heads/main',
        'refs/heads/feature/x',
        'refs/tags/v1',
        'refs/remotes/origin/main',
        'refs/notes/commits',
        'refs/bisection', // starts with refs/bisect but not refs/bisect/ — stays shared
        'Head', // a lowercase letter leaves git's root-ref syntax
        'HEAD/x', // so does a slash
      ])('Then %s is shared', (name) => {
        // Arrange & Act
        const result = isPerWorktreeRef(name as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('isPseudoRef', () => {
  describe('Given a ref git reads from a file whatever the ref backend', () => {
    describe('When isPseudoRef runs', () => {
      it.each(['MERGE_HEAD', 'FETCH_HEAD'])('Then %s is a pseudoref', (name) => {
        // Arrange & Act
        const result = isPseudoRef(name as RefName);

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a ref the backend stores', () => {
    describe('When isPseudoRef runs', () => {
      it.each([
        'HEAD',
        'CHERRY_PICK_HEAD',
        'REVERT_HEAD',
        'ORIG_HEAD',
        'REBASE_HEAD',
        'AUTO_MERGE',
      ])('Then %s is not a pseudoref', (name) => {
        // Arrange & Act
        const result = isPseudoRef(name as RefName);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});

describe('linkedWorktreeRefPrefix', () => {
  describe('Given a worktree id', () => {
    describe('When the prefix is built', () => {
      it('Then it is worktrees/<id>/', () => {
        // Arrange
        const sut = linkedWorktreeRefPrefix;

        // Act
        const result = sut('wt');

        // Assert
        expect(result).toBe('worktrees/wt/');
      });
    });
  });
});

describe('bareStoreRefName', () => {
  describe('Given a name carrying one leading worktrees/<id>/ prefix', () => {
    describe('When the prefix is stripped', () => {
      it.each([
        ['worktrees/wt/refs/bisect/bad', 'refs/bisect/bad'],
        ['worktrees/wt/HEAD', 'HEAD'],
        ['worktrees/a/worktrees/b/HEAD', 'worktrees/b/HEAD'],
      ])('Then %s becomes %s', (name, expected) => {
        // Arrange
        const sut = bareStoreRefName;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a name without a leading worktrees/<id>/ prefix', () => {
    describe('When the prefix is stripped', () => {
      it.each([
        'worktrees/wt',
        'worktrees//HEAD',
        'x/worktrees/wt/HEAD',
        'refs/heads/main',
        'HEAD',
        'main-worktree/HEAD',
      ])('Then %s is unchanged', (name) => {
        // Arrange
        const sut = bareStoreRefName;

        // Act
        const result = sut(name);

        // Assert
        expect(result).toBe(name);
      });
    });
  });
});

describe('mainWorktreeBareName', () => {
  describe('Given a per-worktree name under main-worktree/', () => {
    describe('When the bare name is read', () => {
      it.each([
        ['main-worktree/HEAD', 'HEAD'],
        ['main-worktree/ORIG_HEAD', 'ORIG_HEAD'],
        ['main-worktree/refs/bisect/bad', 'refs/bisect/bad'],
        ['main-worktree/refs/worktree/x', 'refs/worktree/x'],
        ['main-worktree/refs/rewritten/x', 'refs/rewritten/x'],
        ['main-worktree/', ''],
      ])('Then %s yields %j', (name, expected) => {
        // Arrange
        const sut = mainWorktreeBareName;

        // Act
        const result = sut(name as RefName);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a name that is not a main-worktree per-worktree ref', () => {
    describe('When the bare name is read', () => {
      it.each([
        'main-worktree/refs/heads/main',
        'refs/heads/main',
        'HEAD',
        'worktrees/wt/HEAD',
        'main-worktreeX/HEAD',
        'x/main-worktree/HEAD',
      ])('Then %s yields undefined', (name) => {
        // Arrange
        const sut = mainWorktreeBareName;

        // Act
        const result = sut(name as RefName);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });
});
