import { describe, expect, it } from 'vitest';
import type { TreeEntry } from '../../../../../src/application/primitives/snapshot/tree-entry.js';
import { createTreeSnapshot } from '../../../../../src/application/primitives/snapshot/tree-snapshot.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import {
  FILE_MODE,
  type FileMode,
  FilePath,
  type ObjectId,
} from '../../../../../src/domain/objects/index.js';
import { compilePathspec } from '../../../../../src/domain/pathspec/index.js';
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
    const obj = await import('../../../../../src/application/primitives/read-object.js').then((m) =>
      m.readObject(ctx, treeId),
    );
    if (obj.type !== 'tree') throw new Error('not a tree');
    return obj;
  },
};

describe('createTreeSnapshot', () => {
  describe('Given a flat tree with three entries', () => {
    describe('When entries() is iterated', () => {
      it('Then it yields one TreeEntry per leaf in canonical path order', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const a = await writeBlob(ctx, new Uint8Array([1]));
        const b = await writeBlob(ctx, new Uint8Array([2]));
        const c = await writeBlob(ctx, new Uint8Array([3]));
        const treeId = await buildTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: a },
          { name: 'b.txt', mode: FILE_MODE.REGULAR as FileMode, id: b },
          { name: 'c.txt', mode: FILE_MODE.REGULAR as FileMode, id: c },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, treeId);

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(rows.every((r): r is TreeEntry => r.source === 'tree' && r.kind === 'file')).toBe(
          true,
        );
      });
    });
  });

  describe('Given a nested tree (subdirectory containing a file)', () => {
    describe('When entries() is iterated with default recursion', () => {
      it('Then it yields nested file paths joined with forward-slash', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const leafOid = await writeBlob(ctx, new Uint8Array([42]));
        const subTreeId = await buildTree(ctx, [
          { name: 'b.txt', mode: FILE_MODE.REGULAR as FileMode, id: leafOid },
        ]);
        const rootId = await buildTree(ctx, [
          { name: 'sub', mode: FILE_MODE.DIRECTORY as FileMode, id: subTreeId },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, rootId);

        // Act
        const rows = await collect(sut.entries());

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['sub/b.txt']);
      });
    });
  });

  describe('Given a tree resolver that counts resolve calls', () => {
    describe('When entries() is iterated twice on the same handle', () => {
      it('Then the resolver is invoked exactly once (iteration-stability)', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const blob = await writeBlob(ctx, new Uint8Array([1]));
        const treeId = await buildTree(ctx, [
          { name: 'a.txt', mode: FILE_MODE.REGULAR as FileMode, id: blob },
        ]);
        let calls = 0;
        const counting: TreeResolver = {
          resolve: async (c, id) => {
            calls += 1;
            return realResolver.resolve(c, id);
          },
        };
        const sut = createTreeSnapshot({ ctx, treeResolver: counting }, treeId);

        // Act
        await collect(sut.entries());
        await collect(sut.entries());

        // Assert
        expect(calls).toBe(1);
      });
    });
  });

  describe('Given a tree with a `.ts` and a `.md` entry', () => {
    describe('When entries() is filtered by a pathspec matching only `*.ts`', () => {
      it('Then only the `.ts` row is yielded', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const a = await writeBlob(ctx, new Uint8Array([1]));
        const b = await writeBlob(ctx, new Uint8Array([2]));
        const treeId = await buildTree(ctx, [
          { name: 'a.md', mode: FILE_MODE.REGULAR as FileMode, id: a },
          { name: 'b.ts', mode: FILE_MODE.REGULAR as FileMode, id: b },
        ]);
        const sut = createTreeSnapshot({ ctx, treeResolver: realResolver }, treeId);

        // Act
        const rows = await collect(sut.entries({ paths: compilePathspec(['*.ts']) }));

        // Assert
        expect(rows.map((r) => r.path)).toEqual(['b.ts']);
      });
    });
  });

  describe('Given a tree containing a submodule (mode 160000) entry', () => {
    describe('When entries() is iterated', () => {
      it('Then the row carries kind="submodule"', async () => {
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
        expect(rows).toHaveLength(1);
        expect(rows[0]?.kind).toBe('submodule');
      });
    });
  });
});
