import { describe, expect, it } from 'vitest';

import { createCachingTreeResolver } from '../../../../src/adapters/snapshot-resolvers/caching-tree-resolver.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type FileMode,
  FilePath,
  type ObjectId,
  type Tree,
} from '../../../../src/domain/objects/index.js';
import type { ResolveOptions, TreeResolver } from '../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../../application/primitives/fixtures.js';

interface CountingResolver extends TreeResolver {
  readonly calls: () => number;
}

const createCountingResolver = (tree: Tree): CountingResolver => {
  let count = 0;
  return {
    calls: () => count,
    resolve: async () => {
      count += 1;
      return tree;
    },
  };
};

const makeTree = (entries: ReadonlyArray<{ name: string; oid: ObjectId }>): Tree => ({
  type: 'tree',
  id: '' as ObjectId,
  entries: entries.map((e) => ({
    name: FilePath.from(e.name),
    mode: FILE_MODE.REGULAR as FileMode,
    id: e.oid,
  })),
});

const oid = (suffix: string): ObjectId =>
  `0000000000000000000000000000000000000${suffix.padStart(3, '0')}` as ObjectId;

describe('createCachingTreeResolver', () => {
  describe('Given a cold cache', () => {
    describe('When the same oid is resolved 100 times', () => {
      it('Then the inner resolver is invoked exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const inner = createCountingResolver(makeTree([{ name: 'a', oid: oid('a') }]));
        const sut = createCachingTreeResolver(inner);
        const treeId = oid('1');

        // Act
        for (let i = 0; i < 100; i += 1) await sut.resolve(ctx, treeId);

        // Assert
        expect(inner.calls()).toBe(1);
      });
    });
  });

  describe('Given two distinct oids resolved in sequence', () => {
    describe('When each is requested twice', () => {
      it('Then the inner resolver is invoked exactly twice (one per oid)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const inner = createCountingResolver(makeTree([]));
        const sut = createCachingTreeResolver(inner);

        // Act
        await sut.resolve(ctx, oid('1'));
        await sut.resolve(ctx, oid('2'));
        await sut.resolve(ctx, oid('1'));
        await sut.resolve(ctx, oid('2'));

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a cache with maxSize=2', () => {
    describe('When 3 distinct oids are resolved and then the LRU oid is requested again', () => {
      it('Then the LRU oid triggers a fresh inner call (LRU eviction)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const inner = createCountingResolver(makeTree([]));
        const sut = createCachingTreeResolver(inner, { maxSize: 2 });

        // Act — fill cache with oid 1 and 2, then add 3 to evict 1, then re-request 1
        await sut.resolve(ctx, oid('1'));
        await sut.resolve(ctx, oid('2'));
        await sut.resolve(ctx, oid('3'));
        await sut.resolve(ctx, oid('1'));

        // Assert — 4 distinct misses: 1, 2, 3, 1 (re-fetched after eviction)
        expect(inner.calls()).toBe(4);
      });
    });
  });

  describe('Given a cache with maxSize=2 and oid 1 promoted by recent access', () => {
    describe('When a third oid is added', () => {
      it('Then the LRU oid (2) is evicted, not the recently-promoted oid (1)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const inner = createCountingResolver(makeTree([]));
        const sut = createCachingTreeResolver(inner, { maxSize: 2 });

        // Act
        await sut.resolve(ctx, oid('1'));
        await sut.resolve(ctx, oid('2'));
        await sut.resolve(ctx, oid('1')); // promote 1; 2 is now LRU
        await sut.resolve(ctx, oid('3')); // evicts 2
        const before = inner.calls();
        await sut.resolve(ctx, oid('1')); // hit
        const afterOne = inner.calls();
        await sut.resolve(ctx, oid('2')); // miss
        const afterTwo = inner.calls();

        // Assert
        expect(afterOne).toBe(before);
        expect(afterTwo).toBe(before + 1);
      });
    });
  });

  describe('Given a resolver with bypassCache=true on the request', () => {
    describe('When the same oid is resolved twice with bypassCache=true', () => {
      it('Then the inner resolver is invoked on each call (cache fully bypassed)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const inner = createCountingResolver(makeTree([]));
        const sut = createCachingTreeResolver(inner);
        const opts: ResolveOptions = { bypassCache: true };

        // Act
        await sut.resolve(ctx, oid('1'), opts);
        await sut.resolve(ctx, oid('1'), opts);

        // Assert
        expect(inner.calls()).toBe(2);
      });
    });
  });

  describe('Given a resolver wrapped around a real store', () => {
    describe('When a tree is resolved and the returned reference is mutated by the caller', () => {
      it('Then a subsequent cache hit returns a structurally equal value (caller cannot corrupt cache)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const tree: Tree = {
          type: 'tree',
          id: '' as ObjectId,
          entries: [
            { name: FilePath.from('x'), mode: FILE_MODE.REGULAR as FileMode, id: oid('a') },
          ],
        };
        const treeId = await writeObject(ctx, tree);
        const inner: TreeResolver = {
          resolve: async (_c, _id) => tree,
        };
        const sut = createCachingTreeResolver(inner);

        // Act
        const first = await sut.resolve(ctx, treeId);
        const second = await sut.resolve(ctx, treeId);

        // Assert — entry contents preserved
        expect(second.entries).toHaveLength(1);
        expect(second.entries[0]?.name).toBe('x');
        expect(second).toBe(first); // same reference (LRU caches the value)
      });
    });
  });
});
