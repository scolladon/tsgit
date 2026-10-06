import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { isPerWorktreeRef, isPseudoRef } from '../../../../src/domain/refs/per-worktree-ref.js';

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
