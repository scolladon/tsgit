import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { init } from '../../../../../src/application/commands/init.js';
import { writeIndexCacheTree } from '../../../../../src/application/commands/internal/write-index-cache-tree.js';
import { readIndex } from '../../../../../src/application/primitives/read-index.js';
import { synthesizeTreeFromIndex } from '../../../../../src/application/primitives/synthesize-tree-from-index.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { carriedCacheTreeOf } from '../../../../../src/domain/git-index/cache-tree-update.js';
import {
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
} from '../../../../../src/domain/git-index/index.js';
import type { TsgitError } from '../../../../../src/domain/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../../primitives/fixtures.js';

const seed = async (files: Readonly<Record<string, string>>): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  for (const [path, content] of Object.entries(files)) {
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);
  }
  await add(ctx, Object.keys(files));
  return ctx;
};

const emptyBlob = (ctx: Context): Promise<ObjectId> =>
  writeObject(ctx, { type: 'blob', content: new Uint8Array(0), id: '' as ObjectId });

const entryOf = (path: string, id: ObjectId, stage: 0 | 1 | 2 | 3, ita = false): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: FILE_MODE.REGULAR,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, stage, intentToAdd: ita },
  path: path as FilePath,
});

const plant = async (ctx: Context, entries: ReadonlyArray<IndexEntry>): Promise<void> => {
  const index: GitIndex = { version: 3, entries, extensions: [], trailerSha: new Uint8Array(0) };
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, await serializeIndexFixtureAsync(index, ctx));
};

const indexBytes = (ctx: Context): Promise<Uint8Array> => ctx.fs.read(`${ctx.layout.gitDir}/index`);

const carriedOf = async (ctx: Context) =>
  carriedCacheTreeOf((await readIndex(ctx)).extensions, ctx.hashConfig.digestLength);

describe('writeIndexCacheTree', () => {
  describe('Given three staged files and no TREE in the index', () => {
    describe('When the cache-tree is written', () => {
      it('Then the index carries a fully valid TREE whose root is the returned tree', async () => {
        // Arrange
        const ctx = await seed({ 'a/x': '1', 'b/y': '2', top: '3' });
        const sut = writeIndexCacheTree;

        // Act
        const result = await sut(ctx);

        // Assert
        const { entries } = await readIndex(ctx);
        const carried = await carriedOf(ctx);
        expect(carried?.id).toBe(result);
        expect(carried?.entryCount).toBe(3);
        expect(carried?.children.map((child) => child.entryCount)).toEqual([1, 1]);
        expect(result).toBe(await synthesizeTreeFromIndex(ctx, entries));
      });
    });
  });

  describe('Given a fully valid TREE whose objects exist', () => {
    describe('When the cache-tree is written again', () => {
      it('Then the index is not replaced and the carried root is returned', async () => {
        // Arrange
        const ctx = await seed({ 'a/x': '1', top: '3' });
        const first = await writeIndexCacheTree(ctx);
        const before = await indexBytes(ctx);
        const renames = vi.spyOn(ctx.fs, 'rename');
        const sut = writeIndexCacheTree;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(first);
        expect(renames).not.toHaveBeenCalled();
        expect(await indexBytes(ctx)).toEqual(before);
      });
    });
  });

  describe('Given an unmerged index', () => {
    describe('When the cache-tree is written', () => {
      it('Then it refuses with MERGE_HAS_CONFLICTS and leaves the index bytes alone', async () => {
        // Arrange
        const ctx = await seed({ ok: '1' });
        const blob = await emptyBlob(ctx);
        await plant(ctx, [entryOf('c', blob, 1), entryOf('c', blob, 2), entryOf('ok', blob, 0)]);
        const before = await indexBytes(ctx);
        const sut = writeIndexCacheTree;

        // Act
        const attempt = sut(ctx);

        // Assert
        try {
          await attempt;
          expect.unreachable();
        } catch (error) {
          expect((error as TsgitError).data).toEqual({
            code: 'MERGE_HAS_CONFLICTS',
            count: 1,
            paths: ['c'],
          });
        }
        expect(await indexBytes(ctx)).toEqual(before);
      });
    });
  });

  describe('Given a staged file and an intent-to-add entry in one directory', () => {
    describe('When the cache-tree is written', () => {
      it('Then the tree excludes the intent-to-add entry and its chain is invalid', async () => {
        // Arrange
        const ctx = await seed({ 'a/f': '1' });
        const blob = await emptyBlob(ctx);
        const staged = (await readIndex(ctx)).entries;
        await plant(ctx, [...staged, entryOf('a/n', blob, 0, true)]);
        const sut = writeIndexCacheTree;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(await synthesizeTreeFromIndex(ctx, staged));
        const carried = await carriedOf(ctx);
        expect(carried?.entryCount).toBe(-1);
        expect(carried?.children.map((child) => child.entryCount)).toEqual([-1]);
      });
    });
  });
});
