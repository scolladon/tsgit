import { describe, expect, it, vi } from 'vitest';
import { MAX_CONCURRENT_OBJECT_LOADS } from '../../../../../src/application/primitives/internal/bounded-map.js';
import { createConcurrencyLimiter } from '../../../../../src/application/primitives/internal/concurrency-limiter.js';
import { prefetchSubtreeChildren } from '../../../../../src/application/primitives/internal/raw-subtree-prefetch.js';
import { readRawTreeById } from '../../../../../src/application/primitives/internal/raw-tree-io.js';
import * as readObjectMod from '../../../../../src/application/primitives/read-object.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { encode } from '../../../../../src/domain/objects/encoding.js';
import { FILE_MODE, hexToBytes, type ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

type Ctx = Awaited<ReturnType<typeof buildSeededContext>>;

async function writeBlob(ctx: Ctx, content: string): Promise<ObjectId> {
  return writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });
}

function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Hand-built raw entry bytes — used to plant a mode/oid pair `writeTree`
 *  itself would refuse, without needing a resolvable child object. */
function rawEntry(mode: string, name: string, id: ObjectId): Uint8Array {
  return concatBytes(encode(`${mode} ${name}\0`), hexToBytes(id));
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

  describe('Given a tree with more directory entries than the prescan window', () => {
    describe('When prefetchSubtreeChildren runs', () => {
      it('Then only the window (2x the shared concurrency cap) worth of children are queued', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const window = MAX_CONCURRENT_OBJECT_LOADS * 2;
        const width = window + 8;
        const parts: Uint8Array[] = [];
        for (let i = 0; i < width; i++) {
          const oidHex = i.toString(16).padStart(40, '0') as ObjectId;
          const name = `d${String(i).padStart(3, '0')}`;
          parts.push(rawEntry(FILE_MODE.DIRECTORY, name, oidHex));
        }
        const content = concatBytes(...parts);
        const limiter = createConcurrencyLimiter(4);
        const sut = prefetchSubtreeChildren;

        // Act
        const prefetch = sut(ctx, content, limiter);

        // Assert — the tail beyond the window was never enqueued; the
        // per-descent `?? readRawObject` fallback covers it instead.
        expect(prefetch.size).toBe(window);
      });
    });
  });

  describe('Given a remaining entry budget smaller than the window', () => {
    describe('When prefetchSubtreeChildren runs with that budget', () => {
      it('Then the window shrinks to the budget rather than the fixed cap', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const width = 10;
        const parts: Uint8Array[] = [];
        for (let i = 0; i < width; i++) {
          const oidHex = i.toString(16).padStart(40, '0') as ObjectId;
          parts.push(rawEntry(FILE_MODE.DIRECTORY, `d${i}`, oidHex));
        }
        const content = concatBytes(...parts);
        const limiter = createConcurrencyLimiter(4);
        const sut = prefetchSubtreeChildren;

        // Act
        const prefetch = sut(ctx, content, limiter, 3);

        // Assert
        expect(prefetch.size).toBe(3);
      });
    });
  });

  describe('Given a directory entry with the canonical zero-prefixed mode (040000)', () => {
    describe('When prefetchSubtreeChildren runs', () => {
      it('Then the child is prefetched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const childId = await writeTree(ctx, []);
        const content = rawEntry('040000', 'dir', childId);
        const limiter = createConcurrencyLimiter(4);
        const sut = prefetchSubtreeChildren;

        // Act
        const prefetch = sut(ctx, content, limiter);

        // Assert
        expect(prefetch.has(childId)).toBe(true);
      });
    });
  });

  describe('Given a mode the cheap S_ISDIR byte test reads as a directory but no FileMode matches (47777)', () => {
    describe('When prefetchSubtreeChildren runs', () => {
      it('Then the child is still prefetched — the prescan is a documented superset of the mode the main loop later refuses', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const childId = await writeTree(ctx, []);
        const content = rawEntry('47777', 'weird', childId);
        const limiter = createConcurrencyLimiter(4);
        const sut = prefetchSubtreeChildren;

        // Act
        const prefetch = sut(ctx, content, limiter);

        // Assert
        expect(prefetch.has(childId)).toBe(true);
      });
    });
  });
});
