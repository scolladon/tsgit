import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FLATTEN_BOUNDS,
  type FlattenBounds,
  flattenRawTree,
} from '../../../../../src/application/primitives/internal/flatten-raw.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
  SHA1_CONFIG,
  serializeTreeContent,
} from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

async function writeBlob(
  ctx: Awaited<ReturnType<typeof buildSeededContext>>,
  content: string,
): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });
}

describe('flattenRawTree', () => {
  describe('Given maxEntries=2 and a 3-entry tree', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws TREE_ENTRY_LIMIT_EXCEEDED with the count and the limit (just-over)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'c', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds: FlattenBounds = { maxDepth: 1024, maxEntries: 2 };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, treeId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(3);
          expect(data.limit).toBe(2);
        }
      });
    });
  });

  describe('Given maxEntries=3 and a 3-entry tree (at cap)', () => {
    describe('When flattenRawTree runs', () => {
      it('Then all entries are flattened', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
          { name: 'c', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds: FlattenBounds = { maxDepth: 1024, maxEntries: 3 };
        const sut = flattenRawTree;

        // Act
        const result = await sut(ctx, treeId, bounds);

        // Assert
        expect(result.entries.size).toBe(3);
      });
    });
  });

  describe('Given maxEntries=1 and a tree whose first entry is a directory', () => {
    describe('When flattenRawTree runs', () => {
      it('Then the directory entry itself trips the cap, at the same count walkTree would', async () => {
        // Arrange — proves the counter increments for a directory entry, not
        // only for leaves: the (empty) subtree contributes no entries of its
        // own, so the second entry `b` is the one that observes the overflow.
        const ctx = await buildSeededContext();
        const emptySubtreeId = await writeTree(ctx, []);
        const blobId = await writeBlob(ctx, 'x');
        const treeId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.DIRECTORY, id: emptySubtreeId },
          { name: 'b', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const bounds: FlattenBounds = { maxDepth: 1024, maxEntries: 1 };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, treeId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; count: number; limit: number } };
          expect(data.code).toBe('TREE_ENTRY_LIMIT_EXCEEDED');
          expect(data.count).toBe(2);
          expect(data.limit).toBe(1);
        }
      });
    });
  });

  describe('Given maxDepth=1 and a two-level nested tree', () => {
    describe('When flattenRawTree runs', () => {
      it('Then throws TREE_DEPTH_EXCEEDED with the offending depth', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const leafId = await writeTree(ctx, [
          { name: 'leaf', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const midId = await writeTree(ctx, [
          { name: 'mid', mode: FILE_MODE.DIRECTORY, id: leafId },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'root', mode: FILE_MODE.DIRECTORY, id: midId },
        ]);
        const bounds: FlattenBounds = {
          maxDepth: 1,
          maxEntries: DEFAULT_FLATTEN_BOUNDS.maxEntries,
        };
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, rootId, bounds);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; depth: number } };
          expect(data.code).toBe('TREE_DEPTH_EXCEEDED');
          expect(data.depth).toBe(2);
        }
      });
    });
  });

  describe('Given maxDepth=2 and a two-level nested tree (at cap)', () => {
    describe('When flattenRawTree runs', () => {
      it('Then the tree flattens fully (pins the comparison direction: depth === cap succeeds)', async () => {
        // Arrange — same shape as the maxDepth=1 failing case above, but the
        // cap now exactly matches the depth reached (2), proving the guard is
        // `depth > cap`, not `depth >= cap`.
        const ctx = await buildSeededContext();
        const blobId = await writeBlob(ctx, 'x');
        const leafId = await writeTree(ctx, [
          { name: 'leaf', mode: FILE_MODE.REGULAR, id: blobId },
        ]);
        const midId = await writeTree(ctx, [
          { name: 'mid', mode: FILE_MODE.DIRECTORY, id: leafId },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'root', mode: FILE_MODE.DIRECTORY, id: midId },
        ]);
        const bounds: FlattenBounds = {
          maxDepth: 2,
          maxEntries: DEFAULT_FLATTEN_BOUNDS.maxEntries,
        };
        const sut = flattenRawTree;

        // Act
        const result = await sut(ctx, rootId, bounds);

        // Assert
        expect(result.entries.size).toBe(1);
        expect(result.entries.get('root/mid/leaf' as FilePath)?.id).toBe(blobId);
      });
    });
  });

  describe('Given a tree whose entry resolves — via readRawObject — back to itself', () => {
    describe('When flattenRawTree walks it', () => {
      it('Then throws TREE_CYCLE_DETECTED with the offending id', async () => {
        // Arrange
        // Cryptographic hashes prevent a genuinely self-referential tree from
        // existing on disk, so a real (empty) tree id is intercepted at the
        // read boundary and made to resolve to a tree that loops back to it.
        const ctx = await buildSeededContext();
        const realTreeId = await writeTree(ctx, []);
        const loopEntry: ReadonlyArray<{
          readonly name: string;
          readonly mode: FileMode;
          readonly id: ObjectId;
        }> = [{ name: 'loop', mode: FILE_MODE.DIRECTORY, id: realTreeId }];
        const loopContent = serializeTreeContent(
          { type: 'tree', id: realTreeId, entries: loopEntry },
          SHA1_CONFIG,
        );
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) =>
            id === realTreeId
              ? { type: 'tree', content: loopContent, bytes: loopContent }
              : realReadRawObject(spyCtx, id, options),
          );
        const sut = flattenRawTree;

        // Act + Assert
        try {
          await sut(ctx, realTreeId, DEFAULT_FLATTEN_BOUNDS);
          expect.unreachable();
        } catch (error) {
          const { data } = error as { data: { code: string; id: string } };
          expect(data.code).toBe('TREE_CYCLE_DETECTED');
          expect(data.id).toBe(realTreeId);
        } finally {
          spy.mockRestore();
        }
      });
    });
  });
});
