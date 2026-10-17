import { describe, expect, it, vi } from 'vitest';
import type { IndexChange } from '../../../../src/domain/git-index/diff-index-entries.js';
import type { FilePath } from '../../../../src/domain/objects/object-id.js';

vi.mock('../../../../src/domain/git-index/cache-tree.js', () => ({
  invalidateCacheTree: () => {
    throw new RangeError('out of memory');
  },
  namesEachSubtreeOnce: () => true,
  serializeCacheTree: () => new Uint8Array(0),
}));
vi.mock('../../../../src/domain/git-index/index-parser.js', () => ({
  parseCacheTree: () => ({ path: '', entryCount: 0, subtreeCount: 0, id: undefined, children: [] }),
}));

describe('carryExtensions TREE carry', () => {
  describe('Given the cache-tree machinery fails with an unexpected error', () => {
    describe("When TREE is carried on an 'update' with a changed path", () => {
      it('Then the error is rethrown unchanged instead of dropping TREE', async () => {
        // Arrange
        const { carryExtensions, NO_INDEX_CHANGE } = await import(
          '../../../../src/domain/git-index/carry-extensions.js'
        );
        const change: IndexChange = {
          ...NO_INDEX_CHANGE,
          changedPaths: [{ path: 'd/c' as FilePath }],
        };
        const previous = [{ signature: 'TREE', data: new Uint8Array([1]) }];
        const sut = carryExtensions;
        let thrown: unknown;

        // Act
        try {
          sut(previous, change, 'update', { untrackedCache: undefined, digestLength: 20 });
        } catch (err) {
          thrown = err;
        }

        // Assert
        expect(thrown).toBeInstanceOf(RangeError);
        expect((thrown as RangeError).message).toBe('out of memory');
      });
    });
  });
});
