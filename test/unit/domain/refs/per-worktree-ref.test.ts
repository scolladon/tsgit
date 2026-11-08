import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import {
  bareStoreRefName,
  isPerWorktreeRef,
  isPseudoRef,
  linkedWorktreeRefPrefix,
  parseWorktreeRef,
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

describe('parseWorktreeRef', () => {
  describe('Given a ref name', () => {
    describe('When it is parsed', () => {
      it.each([
        ['HEAD', { kind: 'current', bare: 'HEAD' }],
        ['ORIG_HEAD', { kind: 'current', bare: 'ORIG_HEAD' }],
        ['refs/bisect/bad', { kind: 'current', bare: 'refs/bisect/bad' }],
        ['refs/heads/main', { kind: 'shared', bare: 'refs/heads/main' }],
        ['main-worktree/HEAD', { kind: 'main', bare: 'HEAD' }],
        ['main-worktree/refs/bisect/bad', { kind: 'main', bare: 'refs/bisect/bad' }],
        ['main-worktree/', { kind: 'main', bare: '' }],
        [
          'main-worktree/refs/heads/main',
          { kind: 'shared', bare: 'main-worktree/refs/heads/main' },
        ],
        ['main-worktreeX/HEAD', { kind: 'shared', bare: 'main-worktreeX/HEAD' }],
        ['worktrees/wt/HEAD', { kind: 'other', id: 'wt', bare: 'HEAD' }],
        ['worktrees/wt/refs/bisect/y', { kind: 'other', id: 'wt', bare: 'refs/bisect/y' }],
        ['worktrees/wt/', { kind: 'other', id: 'wt', bare: '' }],
        ['worktrees//HEAD', { kind: 'other', id: '', bare: 'HEAD' }],
        ['worktrees/wt', { kind: 'other', id: 'wt', bare: '' }],
        ['worktrees/HEAD', { kind: 'other', id: 'HEAD', bare: '' }],
        ['worktrees/ORIG_HEAD', { kind: 'other', id: 'ORIG_HEAD', bare: '' }],
        ['worktrees/', { kind: 'other', id: '', bare: '' }],
        ['worktrees/wt/refs/heads/side', { kind: 'shared', bare: 'worktrees/wt/refs/heads/side' }],
        [
          'worktrees/wt/main-worktree/HEAD',
          { kind: 'shared', bare: 'worktrees/wt/main-worktree/HEAD' },
        ],
        ['x/worktrees/wt/HEAD', { kind: 'shared', bare: 'x/worktrees/wt/HEAD' }],
      ])('Then %s selects %j', (name, expected) => {
        // Arrange
        const sut = parseWorktreeRef;

        // Act
        const result = sut(name as RefName);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
