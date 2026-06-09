import { describe, expect, it } from 'vitest';
import type { RefName } from '../../../../src/domain/objects/index.js';
import { isPerWorktreeRef } from '../../../../src/domain/refs/per-worktree-ref.js';

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
        'refs/bisect/good',
        'refs/worktree/private',
        'refs/rewritten/abc',
      ])('Then %s is per-worktree', (name) => {
        // Arrange
        const sut = name as RefName;

        // Act
        const result = isPerWorktreeRef(sut);

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
        'HEADER', // not the HEAD pseudoref
      ])('Then %s is shared', (name) => {
        // Arrange
        const sut = name as RefName;

        // Act
        const result = isPerWorktreeRef(sut);

        // Assert
        expect(result).toBe(false);
      });
    });
  });
});
