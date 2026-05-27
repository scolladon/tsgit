/**
 * Mutation-killer tests for `tree-snapshot.ts`. Targets:
 *  - kindFromMode discriminator branches (symlink / submodule / file)
 *  - resolver.resolve receives `{ bypassCache }` option literal
 *  - walkTree opts: recurse=false, maxDepth/maxEntries forwarding
 */
import { describe, expect, it, vi } from 'vitest';

import { createTreeSnapshot } from '../../../../../src/application/primitives/snapshot/tree-snapshot.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type FileMode,
  FilePath,
  type ObjectId,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { TreeResolver } from '../../../../../src/ports/snapshot-resolvers.js';
import { buildSeededContext } from '../fixtures.js';

const writeBlob = async (ctx: Context, content: Uint8Array): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', id: '' as ObjectId, content });

const buildTree = async (
  ctx: Context,
  entries: ReadonlyArray<{ readonly name: string; readonly mode: FileMode; readonly id: ObjectId }>,
): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'tree',
    id: '' as ObjectId,
    entries: entries.map((e) => ({ name: FilePath.from(e.name), mode: e.mode, id: e.id })),
  });

const collect = async <T>(it: AsyncIterable<T>): Promise<T[]> => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

const realResolver: TreeResolver = {
  resolve: async (ctx, treeId) => {
    const { readObject } = await import('../../../../../src/application/primitives/read-object.js');
    const obj = await readObject(ctx, treeId);
    if (obj.type !== 'tree') throw new Error('not a tree');
    return obj;
  },
};

describe('tree-snapshot — kindFromMode discriminator', () => {
  describe('Given a tree entry with mode 120000', () => {
    describe('When the row is yielded', () => {
      it('Then kind is exactly "symlink"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const target = await writeBlob(ctx, new TextEncoder().encode('target/path'));
        const treeId = await buildTree(ctx, [
          { name: 'lnk', mode: FILE_MODE.SYMLINK as FileMode, id: target },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, treeId);

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows[0]?.kind).toBe('symlink');
      });
    });
  });

  describe('Given a tree entry with mode 160000 (submodule)', () => {
    describe('When the row is yielded', () => {
      it('Then kind is exactly "submodule"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const subOid = '0123456789abcdef0123456789abcdef01234567' as ObjectId;
        const treeId = await buildTree(ctx, [
          { name: 'vendor', mode: FILE_MODE.GITLINK as FileMode, id: subOid },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, treeId);

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows[0]?.kind).toBe('submodule');
      });
    });
  });

  describe('Given a tree entry with mode 100644 (regular file)', () => {
    describe('When the row is yielded', () => {
      it('Then kind is exactly "file"', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await buildTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, treeId);

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows[0]?.kind).toBe('file');
      });
    });
  });
});

describe('tree-snapshot — bypassCache forwarding to TreeResolver', () => {
  describe('Given a stub TreeResolver that records its ResolveOptions', () => {
    describe('When entries({ bypassCache: true }) is iterated', () => {
      it('Then the resolver is invoked with { bypassCache: true } on the first call', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await buildTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const recordedOpts: Array<unknown> = [];
        const real = realResolver;
        const recording: TreeResolver = {
          resolve: async (c, id, opts) => {
            recordedOpts.push(opts);
            return real.resolve(c, id, opts);
          },
        };
        const sut = createTreeSnapshot({ ctx, treeResolver: recording }, treeId);

        // Act
        await collect(sut.entries({ bypassCache: true }));

        // Assert
        expect(recordedOpts[0]).toEqual({ bypassCache: true });
      });
    });

    describe('When entries() is iterated without bypassCache', () => {
      it('Then the resolver is invoked with { bypassCache: false }', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await buildTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const recordedOpts: Array<unknown> = [];
        const real = realResolver;
        const recording: TreeResolver = {
          resolve: async (c, id, opts) => {
            recordedOpts.push(opts);
            return real.resolve(c, id, opts);
          },
        };
        const sut = createTreeSnapshot({ ctx, treeResolver: recording }, treeId);

        // Act
        await collect(sut.entries());

        // Assert
        expect(recordedOpts[0]).toEqual({ bypassCache: false });
      });
    });
  });
});

describe('tree-snapshot — walkTree opts forwarding', () => {
  describe('Given a tree with a sub-directory and recurse=false', () => {
    describe('When entries() is iterated', () => {
      it('Then the sub-tree is NOT descended; only top-level leaves yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const subTreeId = await buildTree(ctx, [
          { name: 'inner.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const rootId = await buildTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY as FileMode, id: subTreeId },
          { name: 'top.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, rootId);

        // Act — with recurse=false, sub/ entry itself is filtered out (isDirectory)
        // and inner.txt is never reached.
        const rows = await collect(sut.entries({ recurse: false }));

        // Assert — only top.txt (sub directory itself filtered by isDirectory)
        expect(rows.map((r) => r.path).sort()).toEqual(['top.txt']);
      });
    });
  });

  describe('Given a tree exceeding maxDepth=0', () => {
    describe('When entries() is iterated', () => {
      it('Then it throws TREE_DEPTH_EXCEEDED (the option is forwarded to walkTree)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const subTreeId = await buildTree(ctx, [
          { name: 'inner.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const rootId = await buildTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY as FileMode, id: subTreeId },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, rootId);

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.entries({ maxDepth: 0 })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'TREE_DEPTH_EXCEEDED' },
        });
      });
    });
  });

  describe('Given maxEntries=1 on a flat 3-entry tree', () => {
    describe('When entries() is iterated', () => {
      it('Then it throws TREE_ENTRY_LIMIT_EXCEEDED', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await buildTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
          { name: 'b.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
          { name: 'c.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, treeId);

        // Act + Assert
        const iterate = async (): Promise<void> => {
          for await (const _ of sut.entries({ maxEntries: 1 })) {
            // consume
          }
        };
        await expect(iterate()).rejects.toMatchObject({
          data: { code: 'TREE_ENTRY_LIMIT_EXCEEDED' },
        });
      });
    });
  });
});

// Suppress unused-import warning on vi (kept for potential future spy usage).
void vi;
