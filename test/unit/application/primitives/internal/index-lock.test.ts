import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { init } from '../../../../../src/application/commands/init.js';
import { acquireIndexLock } from '../../../../../src/application/primitives/internal/index-lock.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../../src/application/primitives/read-index.js';
import type {
  CacheTreeEntry,
  IndexEntry,
} from '../../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../../src/domain/git-index/index-parser.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import {
  cacheTreeExtension,
  indexExtensionsOf,
  resolveUndoExtension,
  UNKNOWN_EXTENSION,
  UNTR_EXTENSION,
  withIndexExtensions,
} from '../helpers/index-extensions.js';

const SHA1_DIGEST = 20;
const SHA256_DIGEST = 32;
const OTHER_ID = 'b'.repeat(40) as ObjectId;
const TREE_ID = 'c'.repeat(40) as ObjectId;
const NESTED_PATH = 'd/c' as FilePath;

const treeOf = (id: ObjectId): CacheTreeEntry => ({
  path: '',
  entryCount: 2,
  subtreeCount: 1,
  id,
  children: [{ path: 'd', entryCount: 1, subtreeCount: 0, id, children: [] }],
});

const summary = (tree: CacheTreeEntry): ReadonlyArray<readonly [string, number]> => [
  [tree.path, tree.entryCount],
  ...tree.children.map((child): readonly [string, number] => [child.path, child.entryCount]),
];

const seededRepo = async (config = ''): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  if (config !== '') await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a`, 'a\n');
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d/c`, 'c\n');
  await add(ctx, ['a' as FilePath, NESTED_PATH]);
  await withIndexExtensions(ctx, [
    cacheTreeExtension(treeOf(TREE_ID), SHA1_DIGEST),
    resolveUndoExtension('r', OTHER_ID, SHA1_DIGEST),
    UNTR_EXTENSION,
    UNKNOWN_EXTENSION,
  ]);
  return ctx;
};

const withNestedIdChanged = async (ctx: Context): Promise<ReadonlyArray<IndexEntry>> =>
  (await readIndex(ctx)).entries.map((entry) =>
    entry.path === NESTED_PATH ? { ...entry, id: OTHER_ID } : entry,
  );

describe('IndexLock.commit', () => {
  describe('Given an index carrying TREE, REUC, UNTR and ZZZZ', () => {
    describe('When committing entries with d/c changed as an update', () => {
      it('Then REUC and UNTR are kept, ZZZZ is gone, TREE has the root and d invalidated', async () => {
        // Arrange
        const ctx = await seededRepo();
        const entries = await withNestedIdChanged(ctx);
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'update');

        // Assert
        const written = await indexExtensionsOf(ctx);
        expect([...written.keys()].sort()).toEqual(['REUC', 'TREE', 'UNTR']);
        expect(written.get('REUC')).toEqual(resolveUndoExtension('r', OTHER_ID, SHA1_DIGEST).data);
        expect(written.get('UNTR')).toEqual(UNTR_EXTENSION.data);
        const tree = parseCacheTree(written.get('TREE') as Uint8Array, SHA1_DIGEST);
        expect(tree.entryCount).toBe(-1);
        expect(tree.children.map((child) => [child.path, child.entryCount])).toEqual([['d', -1]]);
      });
    });

    describe('When committing entries with d/c changed as a replace', () => {
      it('Then REUC is dropped and TREE is invalidated along d/c', async () => {
        // Arrange
        const ctx = await seededRepo();
        const entries = await withNestedIdChanged(ctx);
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'replace');

        // Assert
        const written = await indexExtensionsOf(ctx);
        expect([...written.keys()].sort()).toEqual(['TREE', 'UNTR']);
        const tree = parseCacheTree(written.get('TREE') as Uint8Array, SHA1_DIGEST);
        expect([tree.entryCount, tree.children[0]?.entryCount]).toEqual([-1, -1]);
      });
    });
  });

  describe('Given core.untrackedCache=false and an unchanged tracked set', () => {
    describe('When committing the same entries as an update', () => {
      it('Then UNTR is dropped and the other carried extensions are kept', async () => {
        // Arrange
        const ctx = await seededRepo('[core]\n\tuntrackedCache = false\n');
        const entries = (await readIndex(ctx)).entries;
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'update');

        // Assert
        const written = await indexExtensionsOf(ctx);
        expect([...written.keys()].sort()).toEqual(['REUC', 'TREE']);
      });
    });
  });

  describe('Given a cache-tree with directories d, e and x and a tracked file b', () => {
    const restagedRepo = async (ctx: Context = createMemoryContext()): Promise<Context> => {
      await init(ctx);
      const paths = ['b', 'd/c', 'e/c', 'x/c'] as FilePath[];
      for (const path of paths) await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, 'v\n');
      await add(ctx, paths);
      const child = (path: string): CacheTreeEntry => ({
        path,
        entryCount: 1,
        subtreeCount: 0,
        id: TREE_ID,
        children: [],
      });
      const root: CacheTreeEntry = {
        path: '',
        entryCount: 4,
        subtreeCount: 3,
        id: TREE_ID,
        children: ['d', 'e', 'x'].map(child),
      };
      await withIndexExtensions(ctx, [cacheTreeExtension(root, ctx.hashConfig.digestLength)]);
      return ctx;
    };
    describe('When committing identical entries as an update restaging b', () => {
      it('Then the root is invalidated and d, e, x are untouched', async () => {
        // Arrange
        const ctx = await restagedRepo();
        const entries = (await readIndex(ctx)).entries;
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'update', { restagedPaths: ['b' as FilePath] });

        // Assert
        const tree = parseCacheTree(
          (await indexExtensionsOf(ctx)).get('TREE') as Uint8Array,
          SHA1_DIGEST,
        );
        expect(summary(tree)).toEqual([
          ['', -1],
          ['d', 1],
          ['e', 1],
          ['x', 1],
        ]);
      });
    });

    describe('When committing identical entries as a replace restaging b', () => {
      it('Then the TREE bytes are unchanged', async () => {
        // Arrange
        const ctx = await restagedRepo();
        const before = (await indexExtensionsOf(ctx)).get('TREE');
        const entries = (await readIndex(ctx)).entries;
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'replace', { restagedPaths: ['b' as FilePath] });

        // Assert
        expect((await indexExtensionsOf(ctx)).get('TREE')).toEqual(before);
      });
    });
  });

  describe('Given a SHA-256 repository carrying a width-32 TREE and REUC', () => {
    describe('When committing entries with d/c changed as an update', () => {
      it('Then REUC is carried intact and TREE is invalidated along d/c', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await init(ctx, { objectFormat: 'sha256' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a`, 'a\n');
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/d/c`, 'c\n');
        await add(ctx, ['a' as FilePath, NESTED_PATH]);
        const wideId = 'c'.repeat(64) as ObjectId;
        const reuc = resolveUndoExtension('r', wideId, SHA256_DIGEST);
        await withIndexExtensions(ctx, [cacheTreeExtension(treeOf(wideId), SHA256_DIGEST), reuc]);
        const entries = (await readIndex(ctx)).entries.map((entry) =>
          entry.path === NESTED_PATH ? { ...entry, id: 'b'.repeat(64) as ObjectId } : entry,
        );
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'update');

        // Assert
        const written = await indexExtensionsOf(ctx);
        expect(written.get('REUC')).toEqual(reuc.data);
        const tree = parseCacheTree(written.get('TREE') as Uint8Array, SHA256_DIGEST);
        expect(summary(tree)).toEqual([
          ['', -1],
          ['d', -1],
        ]);
      });
    });
  });
});

const withLaterMtime = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  mtimeSeconds: entry.mtimeSeconds + 10,
});

describe('IndexLock.commitRefresh', () => {
  describe('Given an index with TREE, REUC, UNTR and ZZZZ read into memory', () => {
    describe('When refreshing one entry with a later mtime', () => {
      it('Then it resolves true, copies the stat only and carries TREE, REUC and UNTR verbatim', async () => {
        // Arrange
        const ctx = await seededRepo();
        const before = await indexExtensionsOf(ctx);
        const read = await readIndex(ctx);
        const original = read.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const sut = await acquireIndexLock(ctx);

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)]);

        // Assert
        expect(result).toBe(true);
        invalidateIndexCache(ctx);
        const written = (await readIndex(ctx)).entries.find((entry) => entry.path === NESTED_PATH);
        expect(written).toEqual(withLaterMtime(original));
        const extensions = await indexExtensionsOf(ctx);
        expect([...extensions.keys()].sort()).toEqual(['REUC', 'TREE', 'UNTR']);
        expect(extensions.get('TREE')).toEqual(before.get('TREE'));
        expect(extensions.get('REUC')).toEqual(before.get('REUC'));
        expect(extensions.get('UNTR')).toEqual(before.get('UNTR'));
      });
    });
  });

  describe('Given another commit rewrote the index after the read', () => {
    describe('When refreshing an entry', () => {
      it('Then it resolves false, keeps the other writer bytes and leaves no index.lock', async () => {
        // Arrange
        const ctx = await seededRepo();
        const read = await readIndex(ctx);
        const original = read.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const sut = await acquireIndexLock(ctx);
        await withIndexExtensions(ctx, [cacheTreeExtension(treeOf(OTHER_ID), SHA1_DIGEST)]);
        const otherWriterBytes = await ctx.fs.read(`${ctx.layout.gitDir}/index`);

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)]);

        // Assert
        expect(result).toBe(false);
        expect(await ctx.fs.read(`${ctx.layout.gitDir}/index`)).toEqual(otherWriterBytes);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });

  describe('Given the index file was deleted after the read', () => {
    describe('When refreshing an entry', () => {
      it('Then it resolves false and writes nothing', async () => {
        // Arrange
        const ctx = await seededRepo();
        const read = await readIndex(ctx);
        const original = read.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const sut = await acquireIndexLock(ctx);
        await ctx.fs.rm(`${ctx.layout.gitDir}/index`);

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)]);

        // Assert
        expect(result).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index`)).toBe(false);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });

  describe('Given a SHA-256 repository carrying a width-32 TREE and REUC', () => {
    describe('When refreshing one entry with a later mtime', () => {
      it('Then it resolves true and carries TREE and REUC verbatim', async () => {
        // Arrange
        const ctx = createMemoryContext({ algorithm: 'sha256' });
        await init(ctx, { objectFormat: 'sha256' });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a`, 'a\n');
        await add(ctx, ['a' as FilePath]);
        const wideId = 'c'.repeat(64) as ObjectId;
        await withIndexExtensions(ctx, [
          cacheTreeExtension(treeOf(wideId), SHA256_DIGEST),
          resolveUndoExtension('r', wideId, SHA256_DIGEST),
        ]);
        const before = await indexExtensionsOf(ctx);
        const read = await readIndex(ctx);
        const original = read.entries[0] as IndexEntry;
        const sut = await acquireIndexLock(ctx);

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)]);

        // Assert
        expect(result).toBe(true);
        const extensions = await indexExtensionsOf(ctx);
        expect(extensions.get('TREE')).toEqual(before.get('TREE'));
        expect(extensions.get('REUC')).toEqual(before.get('REUC'));
        expect((await readIndex(ctx)).entries[0]).toEqual(withLaterMtime(original));
      });
    });
  });
});
