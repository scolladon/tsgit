import { describe, expect, it } from 'vitest';
import {
  type CachedGitObject,
  withUnreadableOverrides,
} from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';

const BLOB_A = '1'.repeat(40) as ObjectId;
const BLOB_B = '2'.repeat(40) as ObjectId;
const TREE_A = '3'.repeat(40) as ObjectId;

const BLOB_PROJECTION: CachedGitObject = { type: 'blob' };
const TREE_PROJECTION: CachedGitObject = { type: 'tree', entries: [] };

describe('Given an empty override set', () => {
  describe('When withUnreadableOverrides is called', () => {
    it('Then it returns the SAME map reference, no copy', () => {
      // Arrange
      const sut = withUnreadableOverrides;
      const cache = new Map<ObjectId, CachedGitObject>([
        [BLOB_A, BLOB_PROJECTION],
        [TREE_A, TREE_PROJECTION],
      ]);

      // Act
      const result = sut(cache, new Set());

      // Assert
      expect(result).toBe(cache);
    });
  });
});

describe('Given a non-empty override set', () => {
  describe('When withUnreadableOverrides is called', () => {
    it('Then it nulls exactly the overridden ids, leaving every other entry untouched', () => {
      // Arrange
      const sut = withUnreadableOverrides;
      const cache = new Map<ObjectId, CachedGitObject>([
        [BLOB_A, BLOB_PROJECTION],
        [BLOB_B, BLOB_PROJECTION],
        [TREE_A, TREE_PROJECTION],
      ]);

      // Act
      const result = sut(cache, new Set([BLOB_B]));

      // Assert — only the overridden id is nulled
      expect(result.get(BLOB_B)).toBeNull();
      expect(result.get(BLOB_A)).toBe(BLOB_PROJECTION);
      expect(result.get(TREE_A)).toBe(TREE_PROJECTION);
      expect(result.size).toBe(cache.size);
    });

    it('Then it never mutates the input map', () => {
      // Arrange
      const sut = withUnreadableOverrides;
      const cache = new Map<ObjectId, CachedGitObject>([
        [BLOB_A, BLOB_PROJECTION],
        [BLOB_B, BLOB_PROJECTION],
      ]);

      // Act
      const result = sut(cache, new Set([BLOB_B]));

      // Assert — a distinct map, the ORIGINAL is unchanged
      expect(result).not.toBe(cache);
      expect(cache.get(BLOB_B)).toBe(BLOB_PROJECTION);
      expect(cache.size).toBe(2);
    });
  });
});
