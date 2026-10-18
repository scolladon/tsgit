import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../../src/application/commands/add.js';
import { init } from '../../../../../src/application/commands/init.js';
import {
  writeContinuedIndex,
  writeIndexCacheTree,
} from '../../../../../src/application/commands/internal/write-index-cache-tree.js';
import {
  invalidateIndexCache,
  readIndex,
} from '../../../../../src/application/primitives/read-index.js';
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

describe('writeIndexCacheTree stat refresh', () => {
  const T = 1_800_000_000_000;
  const at = (offsetSeconds: number): void => {
    vi.setSystemTime(T + offsetSeconds * 1000);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Files written at T, added at T+2s, TREE written at T+3s: a settled repository. */
  const seedSettled = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    at(0);
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/f`, 'a');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
    at(2);
    await add(ctx, ['a/f', 'b/f']);
    at(3);
    await writeIndexCacheTree(ctx);
    return ctx;
  };

  /** Files and index both written inside second T+2: every entry is racy. */
  const seedRacy = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    at(2);
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/f`, 'a');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
    await add(ctx, ['a/f', 'b/f']);
    await writeIndexCacheTree(ctx);
    return ctx;
  };

  const stagedEntry = async (ctx: Context, path: string) => {
    invalidateIndexCache(ctx);
    return (await readIndex(ctx)).entries.find((e) => e.path === (path as FilePath));
  };

  describe('Given a fully valid TREE and b/f rewritten with the same bytes later', () => {
    describe('When the cache-tree is written', () => {
      it('Then the index is rewritten with the refreshed stat and the same TREE', async () => {
        // Arrange
        const ctx = await seedSettled();
        const treeBefore = await carriedOf(ctx);
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
        at(7);
        const renames = vi.spyOn(ctx.fs, 'rename');
        const sut = writeIndexCacheTree;

        // Act
        const result = await sut(ctx);

        // Assert
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/b/f`);
        const entry = await stagedEntry(ctx, 'b/f');
        expect(renames).toHaveBeenCalledTimes(1);
        expect(entry?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / 1000));
        expect(result).toBe(treeBefore?.id);
        expect(await carriedOf(ctx)).toEqual(treeBefore);
      });
    });
  });

  describe('Given a fully valid TREE, entries racy against the index and nothing moved', () => {
    describe('When the cache-tree is written', () => {
      it('Then the index is left untouched', async () => {
        // Arrange
        const ctx = await seedSettled();
        const before = await indexBytes(ctx);
        const renames = vi.spyOn(ctx.fs, 'rename');
        at(4);
        const sut = writeIndexCacheTree;

        // Act
        await sut(ctx);

        // Assert
        expect(renames).not.toHaveBeenCalled();
        expect(await indexBytes(ctx)).toEqual(before);
      });
    });
  });

  describe('Given a fully valid TREE and b/f modified in the working tree but not staged', () => {
    describe('When the cache-tree is written', () => {
      it('Then the index is not rewritten and the entry stat is unchanged', async () => {
        // Arrange
        const ctx = await seedSettled();
        const before = await stagedEntry(ctx, 'b/f');
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'changed!');
        at(7);
        const renames = vi.spyOn(ctx.fs, 'rename');
        const sut = writeIndexCacheTree;

        // Act
        await sut(ctx);

        // Assert
        expect(renames).not.toHaveBeenCalled();
        expect(await stagedEntry(ctx, 'b/f')).toEqual(before);
      });
    });
  });

  describe('Given a skip-worktree entry whose file stat drifted', () => {
    describe('When the cache-tree is written', () => {
      it('Then its entry is not refreshed', async () => {
        // Arrange
        const ctx = await seedSettled();
        const marked = (await readIndex(ctx)).entries.map((e) =>
          e.path === ('b/f' as FilePath) ? { ...e, flags: { ...e.flags, skipWorktree: true } } : e,
        );
        await plant(ctx, marked);
        at(5);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
        at(7);
        const before = await stagedEntry(ctx, 'b/f');
        const sut = writeIndexCacheTree;

        // Act
        await sut(ctx);

        // Assert
        expect(await stagedEntry(ctx, 'b/f')).toEqual(before);
      });
    });
  });

  describe('Given a racy entry rewritten in place and another entry whose stat moved', () => {
    describe('When the cache-tree is written', () => {
      it('Then the racy modified entry is smudged to size 0 and the moved one keeps its size', async () => {
        // Arrange
        const ctx = await seedRacy();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/f`, 'X');
        at(4);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
        at(5);
        const sut = writeIndexCacheTree;

        // Act
        await sut(ctx);

        // Assert
        expect((await stagedEntry(ctx, 'a/f'))?.fileSize).toBe(0);
        const moved = await stagedEntry(ctx, 'b/f');
        expect(moved?.fileSize).toBe(1);
        expect(moved?.mtimeSeconds).toBe(T / 1000 + 4);
      });
    });
  });

  describe('Given a racy unchanged entry and another entry whose stat moved', () => {
    describe('When the cache-tree is written', () => {
      it('Then the racy file is read once', async () => {
        // Arrange
        const ctx = await seedRacy();
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/f`, 'a');
        at(4);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
        at(5);
        const reads = vi.spyOn(ctx.fs, 'read');
        const sut = writeIndexCacheTree;

        // Act
        await sut(ctx);

        // Assert
        const racyReads = reads.mock.calls.filter(
          ([p]) => String(p) === `${ctx.layout.workDir}/a/f`,
        );
        expect(racyReads).toHaveLength(1);
      });
    });
  });

  describe('Given an unmerged index', () => {
    describe('When the cache-tree is written', () => {
      it('Then it refuses before any worktree lstat', async () => {
        // Arrange
        const ctx = await seed({ ok: '1' });
        const blob = await emptyBlob(ctx);
        await plant(ctx, [entryOf('c', blob, 1), entryOf('c', blob, 2), entryOf('ok', blob, 0)]);
        const lstat = vi.spyOn(ctx.fs, 'lstat');
        const sut = writeIndexCacheTree;

        // Act
        const attempt = sut(ctx);

        // Assert
        await expect(attempt).rejects.toMatchObject({ data: { code: 'MERGE_HAS_CONFLICTS' } });
        const worktreeCalls = lstat.mock.calls.filter(([p]) =>
          String(p).startsWith(`${ctx.layout.workDir}/`),
        );
        expect(worktreeCalls).toEqual([]);
      });
    });
  });
});

describe('writeContinuedIndex', () => {
  const T = 1_800_000_000_000;
  const at = (offsetSeconds: number): void => {
    vi.setSystemTime(T + offsetSeconds * 1000);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A settled repository whose a/f was then re-staged: the TREE chain to the root is invalid. */
  const seedInvalidated = async (): Promise<Context> => {
    const ctx = createMemoryContext();
    at(0);
    await init(ctx);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/f`, 'a');
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
    at(2);
    await add(ctx, ['a/f', 'b/f']);
    at(3);
    await writeIndexCacheTree(ctx);
    at(5);
    await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a/f`, 'a2');
    await add(ctx, ['a/f']);
    return ctx;
  };

  const stagedEntry = async (ctx: Context, path: string) => {
    invalidateIndexCache(ctx);
    return (await readIndex(ctx)).entries.find((e) => e.path === (path as FilePath));
  };

  describe('Given an invalid TREE and a clean file touched since it was staged', () => {
    describe('When the continue pass runs', () => {
      it('Then the stat is refreshed, TREE stays invalid and the root tree is returned', async () => {
        // Arrange
        const ctx = await seedInvalidated();
        at(6);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/b/f`, 'b');
        at(8);
        const expected = await synthesizeTreeFromIndex(ctx, (await readIndex(ctx)).entries);
        const sut = writeContinuedIndex;

        // Act
        const result = await sut(ctx);

        // Assert
        const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/b/f`);
        expect(result).toBe(expected);
        expect((await stagedEntry(ctx, 'b/f'))?.mtimeSeconds).toBe(Math.floor(stat.mtimeMs / 1000));
        expect((await carriedOf(ctx))?.entryCount).toBe(-1);
      });
    });
  });

  describe('Given an invalid TREE and nothing touched', () => {
    describe('When the continue pass runs', () => {
      it('Then TREE is rebuilt valid and names the returned root', async () => {
        // Arrange
        const ctx = await seedInvalidated();
        at(8);
        const sut = writeContinuedIndex;

        // Act
        const result = await sut(ctx);

        // Assert
        const carried = await carriedOf(ctx);
        expect(carried?.entryCount).toBeGreaterThanOrEqual(0);
        expect(carried?.id).toBe(result);
      });
    });
  });
});
