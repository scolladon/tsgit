import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../../src/adapters/memory/memory-adapter.js';
import {
  type CachedGitObject,
  collectUnreadablePackMemberIds,
  hasPackCopy,
  withUnreadableOverrides,
} from '../../../../../../src/application/commands/internal/fsck/object-cache.js';
import type { ObjectId } from '../../../../../../src/domain/objects/index.js';
import { writeSyntheticPack } from '../../../primitives/pack-fixture.js';

const enc = new TextEncoder();

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

describe('Given an id claimed by a pack', () => {
  describe('When hasPackCopy is called', () => {
    it('Then it returns true', async () => {
      // Arrange
      const sut = hasPackCopy;
      const ctx = createMemoryContext();
      const [packedId] = await writeSyntheticPack(ctx, 'member', [
        { kind: 'base', type: 'blob', content: enc.encode('packed content') },
      ]);

      // Act
      const result = await sut(ctx, packedId as ObjectId);

      // Assert
      expect(result).toBe(true);
    });
  });
});

describe('Given an id claimed by no pack', () => {
  describe('When hasPackCopy is called', () => {
    it('Then it returns false', async () => {
      // Arrange
      const sut = hasPackCopy;
      const ctx = createMemoryContext();

      // Act
      const result = await sut(ctx, BLOB_A);

      // Assert
      expect(result).toBe(false);
    });
  });
});

describe('Given a cache mixing typed, unreadable pack-backed and unreadable non-pack-backed ids', () => {
  describe('When collectUnreadablePackMemberIds is called', () => {
    it('Then it returns exactly the null ids also claimed by a pack', async () => {
      // Arrange
      const sut = collectUnreadablePackMemberIds;
      const ctx = createMemoryContext();
      const [packedId] = await writeSyntheticPack(ctx, 'mixed', [
        { kind: 'base', type: 'blob', content: enc.encode('claimed content') },
      ]);
      const unclaimedUnreadable = BLOB_B;
      const cache = new Map<ObjectId, CachedGitObject>([
        [BLOB_A, BLOB_PROJECTION],
        [packedId as ObjectId, null],
        [unclaimedUnreadable, null],
      ]);

      // Act
      const result = await sut(ctx, cache);

      // Assert — only the pack-claimed null id is returned
      expect(result.has(packedId as ObjectId)).toBe(true);
      expect(result.has(unclaimedUnreadable)).toBe(false);
      expect(result.has(BLOB_A)).toBe(false);
      expect(result.size).toBe(1);
    });
  });
});
