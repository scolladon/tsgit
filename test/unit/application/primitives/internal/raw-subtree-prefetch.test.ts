import { describe, expect, it, vi } from 'vitest';
import { createConcurrencyLimiter } from '../../../../../src/application/primitives/internal/concurrency-limiter.js';
import { prefetchSubtreeChildren } from '../../../../../src/application/primitives/internal/raw-subtree-prefetch.js';
import { readRawTreeById } from '../../../../../src/application/primitives/internal/raw-tree-io.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { FILE_MODE, type ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

async function writeBlob(ctx: Ctx, content: string): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });
}

describe('prefetchSubtreeChildren', () => {
  describe('Given a tree with one directory entry and one leaf entry', () => {
    describe('When prefetchSubtreeChildren runs', () => {
      it('Then only the directory child oid is read, never the leaf oid', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leafBlobId = await writeBlob(ctx, 'leaf');
        const dirBlobId = await writeBlob(ctx, 'inner');
        const dirId = await writeTree(ctx, [
          { name: 'inner.txt', mode: FILE_MODE.REGULAR, id: dirBlobId },
        ]);
        const rootId = await writeTree(ctx, [
          { name: 'dir', mode: FILE_MODE.DIRECTORY, id: dirId },
          { name: 'leaf.txt', mode: FILE_MODE.REGULAR, id: leafBlobId },
        ]);
        const content = await readRawTreeById(ctx, rootId);
        const limiter = createConcurrencyLimiter(4);
        const sut = prefetchSubtreeChildren;

        // Act
        const prefetch = sut(ctx, content, limiter);

        // Assert
        expect(prefetch.size).toBe(1);
        expect(prefetch.has(dirId)).toBe(true);
        expect(prefetch.has(leafBlobId)).toBe(false);
        await expect(prefetch.get(dirId)).resolves.toEqual(
          expect.objectContaining({ type: 'tree' }),
        );
      });
    });
  });

  describe('Given two sibling directory entries that share the identical oid', () => {
    describe('When prefetchSubtreeChildren runs', () => {
      it('Then the shared child is read exactly once', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sharedId = await writeTree(ctx, []);
        const rootId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.DIRECTORY, id: sharedId },
          { name: 'b', mode: FILE_MODE.DIRECTORY, id: sharedId },
        ]);
        const content = await readRawTreeById(ctx, rootId);
        const limiter = createConcurrencyLimiter(4);
        const readSpy = vi.spyOn(readObjectMod, 'readRawObject');
        const sut = prefetchSubtreeChildren;

        // Act
        const prefetch = sut(ctx, content, limiter);
        await prefetch.get(sharedId);

        // Assert
        expect(prefetch.size).toBe(1);
        expect(readSpy).toHaveBeenCalledTimes(1);
        readSpy.mockRestore();
      });
    });
  });

  describe('Given a directory child whose read rejects, and nobody ever awaits the prefetch map', () => {
    describe('When prefetchSubtreeChildren runs', () => {
      it('Then the rejection is not surfaced as an unhandled rejection', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const childId = await writeTree(ctx, []);
        const rootId = await writeTree(ctx, [
          { name: 'a', mode: FILE_MODE.DIRECTORY, id: childId },
        ]);
        const content = await readRawTreeById(ctx, rootId);
        const limiter = createConcurrencyLimiter(4);
        const realReadRawObject = readObjectMod.readRawObject;
        const spy = vi
          .spyOn(readObjectMod, 'readRawObject')
          .mockImplementation(async (spyCtx, id, options) =>
            id === childId
              ? Promise.reject(new Error('boom'))
              : realReadRawObject(spyCtx, id, options),
          );
        const unhandled: unknown[] = [];
        const onUnhandledRejection = (reason: unknown): void => {
          unhandled.push(reason);
        };
        process.on('unhandledRejection', onUnhandledRejection);
        const sut = prefetchSubtreeChildren;

        // Act — the map is built but deliberately never read from.
        sut(ctx, content, limiter);
        for (let i = 0; i < 10; i++) await Promise.resolve();

        // Assert
        try {
          expect(unhandled).toEqual([]);
        } finally {
          process.off('unhandledRejection', onUnhandledRejection);
          spy.mockRestore();
        }
      });
    });
  });
});
