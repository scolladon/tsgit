import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  acquireIndexLock,
  acquireOptionalIndexLock,
  type IndexLock,
} from '../../../../../src/application/primitives/internal/index-lock.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import {
  type CacheTreeEntry,
  type IndexEntry,
  STAGE0_FLAGS,
} from '../../../../../src/domain/git-index/index-entry.js';
import { parseCacheTree } from '../../../../../src/domain/git-index/index-parser.js';
import {
  FILE_MODE,
  type FilePath,
  type ObjectId,
} from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../fixtures.js';
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
const NOTHING_VERIFIED = () => false;

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
        await sut.commit(entries, 'update', { restagedPaths: [{ path: 'b' as FilePath }] });

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

    describe('When committing a lossy entry restaged as an update', () => {
      it('Then the cache-tree child named by its raw bytes is invalidated', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await init(ctx);
        const lossyEntry: IndexEntry = {
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
          id: OTHER_ID,
          flags: STAGE0_FLAGS,
          path: '\uFFFD/x' as FilePath,
          pathBytes: Uint8Array.of(0xff, 0x2f, 0x78),
        };
        const root: CacheTreeEntry = {
          path: '',
          entryCount: 1,
          subtreeCount: 1,
          id: TREE_ID,
          children: [
            {
              path: '\uFFFD',
              nameBytes: Uint8Array.of(0xff),
              entryCount: 1,
              subtreeCount: 0,
              id: TREE_ID,
              children: [],
            },
          ],
        };
        const index = {
          version: 2 as const,
          entries: [lossyEntry],
          extensions: [cacheTreeExtension(root, ctx.hashConfig.digestLength)],
          trailerSha: new Uint8Array(0),
        };
        await ctx.fs.write(
          `${ctx.layout.gitDir}/index`,
          await serializeIndexFixtureAsync(index, ctx),
        );
        invalidateIndexCache(ctx);
        const entries = (await readIndex(ctx)).entries;
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'update', { restagedPaths: [entries[0] as IndexEntry] });

        // Assert
        const tree = parseCacheTree(
          (await indexExtensionsOf(ctx)).get('TREE') as Uint8Array,
          SHA1_DIGEST,
        );
        expect(tree.entryCount).toBe(-1);
        expect(tree.children.map((child) => child.entryCount)).toEqual([-1]);
      });
    });

    describe('When committing identical entries as a replace restaging b', () => {
      it('Then the root is invalidated and d, e, x are untouched', async () => {
        // Arrange
        const ctx = await restagedRepo();
        const entries = (await readIndex(ctx)).entries;
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit(entries, 'replace', { restagedPaths: [{ path: 'b' as FilePath }] });

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
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

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

  describe('Given an index holding a literal U+FFFD path and a raw invalid-UTF-8 path that decodes to it', () => {
    describe('When refreshing only the literal U+FFFD entry', () => {
      it('Then the raw-byte entry keeps its path bytes', async () => {
        // Arrange
        const ctx = await seededRepo();
        const [template] = (await readIndex(ctx)).entries as [IndexEntry];
        const literal: IndexEntry = { ...template, path: '\uFFFD.txt' as FilePath };
        const raw: IndexEntry = {
          ...literal,
          id: OTHER_ID,
          pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
        };
        const seed = await acquireIndexLock(ctx);
        await seed.commit([literal, raw], 'replace');
        invalidateIndexCache(ctx);
        const read = await readIndex(ctx);
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commitRefresh(read, [withLaterMtime(literal)], NOTHING_VERIFIED);

        // Assert
        invalidateIndexCache(ctx);
        const written = (await readIndex(ctx)).entries;
        expect(written.map((entry) => entry.id)).toEqual([literal.id, OTHER_ID]);
        expect(written[0]?.mtimeSeconds).toBe(literal.mtimeSeconds + 10);
        expect(written[1]?.pathBytes).toEqual(Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74));
        expect(written[1]?.mtimeSeconds).toBe(literal.mtimeSeconds);
      });
    });
  });

  describe('Given a lock already released', () => {
    describe('When refreshing an entry', () => {
      it('Then it resolves false and leaves the index bytes unchanged', async () => {
        // Arrange
        const ctx = await seededRepo();
        const read = await readIndex(ctx);
        const original = read.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const sut = await acquireIndexLock(ctx);
        const before = await ctx.fs.read(`${ctx.layout.gitDir}/index`);
        await sut.release();

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

        // Assert
        expect(result).toBe(false);
        expect(await ctx.fs.read(`${ctx.layout.gitDir}/index`)).toEqual(before);
      });
    });
  });

  describe('Given a lock whose refresh already committed', () => {
    describe('When refreshing again', () => {
      it('Then it resolves false and renames nothing more', async () => {
        // Arrange
        const ctx = await seededRepo();
        const read = await readIndex(ctx);
        const original = read.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const sut = await acquireIndexLock(ctx);
        await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);
        const committed = await ctx.fs.read(`${ctx.layout.gitDir}/index`);

        // Act
        const result = await sut.commitRefresh(
          read,
          [{ ...withLaterMtime(original), mtimeSeconds: original.mtimeSeconds + 99 }],
          NOTHING_VERIFIED,
        );

        // Assert
        expect(result).toBe(false);
        expect(await ctx.fs.read(`${ctx.layout.gitDir}/index`)).toEqual(committed);
      });
    });
  });

  describe('Given a read index also holding the refreshed path at a conflict stage', () => {
    describe('When refreshing the stage-0 entry', () => {
      it('Then only the stage-0 entry takes the refreshed stat', async () => {
        // Arrange
        const ctx = await seededRepo();
        const real = await readIndex(ctx);
        const original = real.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const conflicted: IndexEntry = { ...original, flags: { ...original.flags, stage: 1 } };
        const read = { ...real, entries: [...real.entries, conflicted] };
        const sut = await acquireIndexLock(ctx);

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

        // Assert
        expect(result).toBe(true);
        invalidateIndexCache(ctx);
        const written = (await readIndex(ctx)).entries.filter(
          (entry) => entry.path === NESTED_PATH,
        );
        expect(written).toEqual([withLaterMtime(original), conflicted]);
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
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

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
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

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
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

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

const LOCK_NAME = 'index.lock';

/** A context whose fs method `method` throws `failure`, with a recording logger. */
const failingAt = (
  base: Context,
  method: string,
  failure: unknown,
): { ctx: Context; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  const fs = new Proxy(base.fs, {
    get(target, prop, receiver) {
      if (prop === method) {
        return () => Promise.reject(failure);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { ctx: { ...base, fs, logger: { warn } } as unknown as Context, warn };
};

const unsupported = (reason: string): TsgitError =>
  new TsgitError({ code: 'UNSUPPORTED_OPERATION', operation: 'filesystem', reason });
const REFRESH_SKIPPED = 'status: index refresh skipped';

describe('acquireOptionalIndexLock', () => {
  describe('Given no index.lock', () => {
    describe('When acquiring the optional lock', () => {
      it('Then it returns a lock whose release removes index.lock', async () => {
        // Arrange
        const ctx = await seededRepo();
        const lockPath = `${ctx.layout.gitDir}/${LOCK_NAME}`;

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeDefined();
        expect(await ctx.fs.exists(lockPath)).toBe(true);
        await result?.release();
        expect(await ctx.fs.exists(lockPath)).toBe(false);
      });
    });
  });

  describe('Given an index.lock older than breakStaleLockMs', () => {
    describe('When acquiring the optional lock', () => {
      it('Then it resolves undefined, leaves the lock untouched and warns with FILE_EXISTS', async () => {
        // Arrange
        const base = await seededRepo();
        const lockPath = `${base.layout.gitDir}/${LOCK_NAME}`;
        await base.fs.writeUtf8(lockPath, 'held');
        const mtimeBefore = (await base.fs.lstat(lockPath)).mtimeMs;
        const warn = vi.fn();
        const ctx = {
          ...base,
          config: { breakStaleLockMs: 0 },
          logger: { warn },
        } as unknown as Context;

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(await base.fs.readUtf8(lockPath)).toBe('held');
        expect((await base.fs.lstat(lockPath)).mtimeMs).toBe(mtimeBefore);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(REFRESH_SKIPPED, { code: 'FILE_EXISTS', path: lockPath });
      });
    });
  });

  describe('Given writeExclusive fails with an unmapped errno', () => {
    describe.each(['ENOSPC', 'EIO'])('When the reason is %s', (reason) => {
      it('Then it resolves undefined and warns with the code and the reason', async () => {
        // Arrange
        const { ctx, warn } = failingAt(await seededRepo(), 'writeExclusive', unsupported(reason));

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(REFRESH_SKIPPED, {
          code: 'UNSUPPORTED_OPERATION',
          path: `${ctx.layout.gitDir}/${LOCK_NAME}`,
          reason,
        });
      });
    });
  });

  describe('Given writeExclusive fails with PERMISSION_DENIED', () => {
    describe('When acquiring the optional lock', () => {
      it('Then the warning carries no reason key', async () => {
        // Arrange
        const lockPath = `${(await seededRepo()).layout.gitDir}/${LOCK_NAME}`;
        const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: lockPath });
        const { ctx, warn } = failingAt(await seededRepo(), 'writeExclusive', denied);

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(warn.mock.calls[0]?.[1]).toStrictEqual({
          code: 'PERMISSION_DENIED',
          path: lockPath,
        });
      });
    });
  });

  describe('Given writeExclusive fails with a browser DOMException', () => {
    describe('When acquiring the optional lock', () => {
      it('Then the code is the exception name', async () => {
        // Arrange
        const denied = new DOMException('denied', 'NoModificationAllowedError');
        const { ctx, warn } = failingAt(await seededRepo(), 'writeExclusive', denied);

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(warn.mock.calls[0]?.[1]).toStrictEqual({
          code: 'NoModificationAllowedError',
          path: `${ctx.layout.gitDir}/${LOCK_NAME}`,
        });
      });
    });
  });

  describe('Given writeExclusive throws a bare string', () => {
    describe('When acquiring the optional lock', () => {
      it('Then the code is unknown', async () => {
        // Arrange
        const { ctx, warn } = failingAt(await seededRepo(), 'writeExclusive', 'boom');

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(warn.mock.calls[0]?.[1]).toStrictEqual({
          code: 'unknown',
          path: `${ctx.layout.gitDir}/${LOCK_NAME}`,
        });
      });
    });
  });

  describe('Given writeExclusive fails and no logger is configured', () => {
    describe('When acquiring the optional lock', () => {
      it('Then it resolves undefined without throwing', async () => {
        // Arrange
        const { ctx } = failingAt(await seededRepo(), 'writeExclusive', 'boom');
        const { logger: _logger, ...silent } = ctx;

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(silent as Context);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a lock whose commitRefresh hits a failing filesystem', () => {
    describe.each([
      ['write', LOCK_NAME],
      ['rename', 'index'],
      ['readSlice', 'index'],
    ])('When %s throws ENOSPC', (method, target) => {
      it('Then it resolves false, leaves no index.lock and warns with the targeted path', async () => {
        // Arrange
        const base = await seededRepo();
        const read = await readIndex(base);
        const original = read.entries.find((entry) => entry.path === NESTED_PATH) as IndexEntry;
        const { ctx, warn } = failingAt(base, method, unsupported('ENOSPC'));
        const sut = (await acquireOptionalIndexLock(ctx)) as IndexLock;

        // Act
        const result = await sut.commitRefresh(read, [withLaterMtime(original)], NOTHING_VERIFIED);

        // Assert
        expect(result).toBe(false);
        expect(await base.fs.exists(`${base.layout.gitDir}/${LOCK_NAME}`)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(REFRESH_SKIPPED, {
          code: 'UNSUPPORTED_OPERATION',
          path: `${base.layout.gitDir}/${target}`,
          reason: 'ENOSPC',
        });
      });
    });
  });
});

describe('acquireOptionalIndexLock failure shapes', () => {
  describe('Given writeExclusive throws null', () => {
    describe('When acquiring the optional lock', () => {
      it('Then it resolves undefined and warns with the unknown code', async () => {
        // Arrange
        const { ctx, warn } = failingAt(await seededRepo(), 'writeExclusive', null);

        // Act
        const sut = acquireOptionalIndexLock;
        const result = await sut(ctx);

        // Assert
        expect(result).toBeUndefined();
        expect(warn.mock.calls[0]?.[1]).toStrictEqual({
          code: 'unknown',
          path: `${ctx.layout.gitDir}/${LOCK_NAME}`,
        });
      });
    });
  });
});

describe('IndexLock.release', () => {
  describe('Given rm reports the lock already gone', () => {
    describe('When releasing', () => {
      it('Then it resolves', async () => {
        // Arrange
        const gone = new TsgitError({ code: 'FILE_NOT_FOUND', path: LOCK_NAME });
        const { ctx } = failingAt(await seededRepo(), 'rm', gone);
        const sut = await acquireIndexLock(ctx);

        // Act
        const result = await sut.release();

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe.each([
    ['a TsgitError with another code', unsupported('ENOSPC')],
    ['a plain Error', new Error('boom')],
  ])('Given rm fails with %s', (_label, failure) => {
    describe('When releasing', () => {
      it('Then that same error is rethrown', async () => {
        // Arrange
        const { ctx } = failingAt(await seededRepo(), 'rm', failure);
        const sut = await acquireIndexLock(ctx);

        // Act
        const result = sut.release();

        // Assert
        await expect(result).rejects.toBe(failure);
      });
    });
  });

  describe.each([
    [
      'committed',
      async (ctx: Context, sut: IndexLock) =>
        sut.commit((await readIndex(ctx)).entries, 'update', {}),
    ],
    ['released', async (_ctx: Context, sut: IndexLock) => sut.release()],
  ])('Given a lock already %s and index.lock now held by another writer', (_state, spend) => {
    describe('When releasing', () => {
      it('Then the other writer lock is left in place', async () => {
        // Arrange
        const ctx = await seededRepo();
        const lockPath = `${ctx.layout.gitDir}/${LOCK_NAME}`;
        const sut = await acquireIndexLock(ctx);
        await spend(ctx, sut);
        await ctx.fs.writeUtf8(lockPath, 'held');

        // Act
        await sut.release();

        // Assert
        expect(await ctx.fs.readUtf8(lockPath)).toBe('held');
      });
    });
  });
});

describe('IndexLock.commit once spent', () => {
  describe.each([
    [
      'committed',
      (sut: IndexLock, entries: ReadonlyArray<IndexEntry>) => sut.commit(entries, 'update', {}),
    ],
    ['released', (sut: IndexLock) => sut.release()],
  ])('Given a lock already %s', (_state, spend) => {
    describe('When committing changed entries', () => {
      it('Then the index bytes stay as they were', async () => {
        // Arrange
        const ctx = await seededRepo();
        const entries = await readIndex(ctx).then((index) => index.entries);
        const sut = await acquireIndexLock(ctx);
        await spend(sut, entries);
        const settled = await ctx.fs.read(`${ctx.layout.gitDir}/index`);

        // Act
        await sut.commit(await withNestedIdChanged(ctx), 'update', {});

        // Assert
        expect(await ctx.fs.read(`${ctx.layout.gitDir}/index`)).toEqual(settled);
      });
    });
  });
});
