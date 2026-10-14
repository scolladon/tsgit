import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { serializeCacheTree } from '../../../../src/domain/git-index/cache-tree.js';
import { parseCacheTree } from '../../../../src/domain/git-index/index-parser.js';
import { arbCacheTreeEntry } from './arbitraries.js';

describe('cache-tree serializer properties', () => {
  describe('Given an arbitrary CacheTreeEntry tree at width 20', () => {
    describe('When parseCacheTree(serializeCacheTree(tree))', () => {
      it('Then it returns the same tree', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCacheTreeEntry(3, 40), (tree) => {
            const sut = serializeCacheTree;
            expect(parseCacheTree(sut(tree, 20), 20)).toEqual(tree);
          }),
          { numRuns: 200 },
        );
      });
    });
  });

  describe('Given an arbitrary CacheTreeEntry tree at width 32', () => {
    describe('When parseCacheTree(serializeCacheTree(tree))', () => {
      it('Then it returns the same tree', () => {
        // Arrange + Act + Assert
        fc.assert(
          fc.property(arbCacheTreeEntry(3, 64), (tree) => {
            const sut = serializeCacheTree;
            expect(parseCacheTree(sut(tree, 32), 32)).toEqual(tree);
          }),
          { numRuns: 200 },
        );
      });
    });
  });
});
