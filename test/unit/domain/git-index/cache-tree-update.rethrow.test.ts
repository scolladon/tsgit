import { describe, expect, it, vi } from 'vitest';
import type { IndexExtension } from '../../../../src/domain/git-index/index-entry.js';

vi.mock('../../../../src/domain/git-index/index-parser.js', () => ({
  parseCacheTree: () => {
    throw new RangeError('out of memory');
  },
}));

describe('carriedCacheTreeOf', () => {
  describe('Given the TREE parser fails with an unexpected error', () => {
    describe('When reading the carried TREE', () => {
      it('Then the error is rethrown unchanged instead of dropping TREE', async () => {
        // Arrange
        const { carriedCacheTreeOf } = await import(
          '../../../../src/domain/git-index/cache-tree-update.js'
        );
        const extensions: IndexExtension[] = [{ signature: 'TREE', data: new Uint8Array([1]) }];
        const sut = carriedCacheTreeOf;
        let thrown: unknown;

        // Act
        try {
          sut(extensions, 20);
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
