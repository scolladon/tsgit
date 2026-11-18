import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireWorkTree } from '../../../../../src/application/primitives/internal/repo-state.js';
import {
  NOTHING_RETIRED,
  retireSparseMovers,
  withRetiredSkipped,
} from '../../../../../src/application/primitives/internal/sparse-movers.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import {
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
} from '../../../../../src/domain/git-index/index.js';
import {
  type IndexPathKey,
  indexPathKey,
} from '../../../../../src/domain/git-index/index-path-key.js';
import type { MergeConflict } from '../../../../../src/domain/merge/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type SeededContext = Awaited<ReturnType<typeof buildSeededContext>>;

const CONE = (path: string): boolean => path.startsWith('b/') || !path.includes('/');
const WARNING =
  'The following paths are not up to date and were left despite sparse patterns:\n\ta/g\n\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.';

const workDirOf = (ctx: SeededContext): string => requireWorkTree(ctx, 'test');

const writeBlob = (ctx: SeededContext, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const entryOf = (path: string, id: ObjectId, extra: Partial<IndexEntry> = {}): IndexEntry => ({
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
  flags: STAGE0_FLAGS,
  path: path as FilePath,
  ...extra,
});

const indexOf = (entries: ReadonlyArray<IndexEntry>): GitIndex => ({
  version: 2,
  entries,
  extensions: [],
  trailerSha: new Uint8Array(),
});

const writeWork = async (ctx: SeededContext, name: string, body: string): Promise<void> => {
  await ctx.fs.write(`${workDirOf(ctx)}/${name}`, new TextEncoder().encode(body));
};

const present = (ctx: SeededContext, name: string): Promise<boolean> =>
  ctx.fs.exists(`${workDirOf(ctx)}/${name}`);

const conflictAt = (path: string): MergeConflict => ({ path: path as FilePath }) as MergeConflict;

const noConflicts: ReadonlyArray<MergeConflict> = [];

describe('retireSparseMovers', () => {
  const sut = retireSparseMovers;

  describe('Given a clean out-of-pattern file, When the stop retires movers', () => {
    it('Then the file is removed, retired and its emptied directory pruned', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'g1\n');
      const index = indexOf([entryOf('a/g', id)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, CONE);

      // Assert
      expect([...result.retired]).toEqual(['a/g']);
      expect([...result.leftDirty]).toEqual([]);
      expect(await present(ctx, 'a/g')).toBe(false);
      expect(await present(ctx, 'a')).toBe(false);
    });
  });

  describe('Given a dirty out-of-pattern file, When the stop retires movers', () => {
    it('Then the file stays, is left dirty and one exact warning is logged', async () => {
      // Arrange
      const seeded = await buildSeededContext();
      const warn = vi.fn();
      const ctx = { ...seeded, logger: { warn } };
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'dirty\n');
      const index = indexOf([entryOf('a/g', id)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, CONE);

      // Assert
      expect([...result.retired]).toEqual([]);
      expect([...result.leftDirty]).toEqual(['a/g']);
      expect(await present(ctx, 'a/g')).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(WARNING);
    });
  });

  describe('Given an entry that is skip-worktree, in the patterns, or lossy, When the stop retires movers', () => {
    it.each([
      ['a/g', { flags: { ...STAGE0_FLAGS, skipWorktree: true } }],
      ['b/g', {}],
      ['a/g', { pathBytes: new TextEncoder().encode('a/g') }],
    ])('Then %s with %j is left alone', async (path, extra) => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, path, 'g1\n');
      const index = indexOf([entryOf(path, id, extra)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, CONE);

      // Assert
      expect([...result.retired]).toEqual([]);
      expect(await present(ctx, path)).toBe(true);
    });
  });

  describe('Given an out-of-pattern entry whose leading directory is a symlink, When the stop retires movers', () => {
    it('Then nothing is hashed, removed or retired through the link', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'b/g', 'g1\n');
      await ctx.fs.symlink('b', `${workDirOf(ctx)}/a`);
      const index = indexOf([entryOf('a/g', id)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, CONE);

      // Assert
      expect([...result.retired]).toEqual([]);
      expect([...result.leftDirty]).toEqual([]);
      expect(await present(ctx, 'b/g')).toBe(true);
    });
  });

  describe('Given a gitlink out-of-pattern entry, When the stop retires movers', () => {
    it('Then it is left alone', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'g1\n');
      const index = indexOf([entryOf('a/g', id, { mode: FILE_MODE.GITLINK })]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, CONE);

      // Assert
      expect([...result.retired]).toEqual([]);
      expect(await present(ctx, 'a/g')).toBe(true);
    });
  });

  describe('Given a conflict recorded at the out-of-pattern path, When the stop retires movers', () => {
    it('Then the path is left alone', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'g1\n');
      const index = indexOf([entryOf('a/g', id)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: [conflictAt('a/g')] }, CONE);

      // Assert
      expect([...result.retired]).toEqual([]);
      expect(await present(ctx, 'a/g')).toBe(true);
    });
  });

  describe('Given a conflict recording its sides at other paths, When the stop retires movers', () => {
    it('Then each recorded path is left alone', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'g1\n');
      await writeWork(ctx, 'a/h', 'g1\n');
      const index = indexOf([entryOf('a/g', id), entryOf('a/h', id)]);
      const distinct = {
        type: 'distinct-types',
        path: 'x',
        ourPath: 'a/g',
        theirPath: 'a/h',
      } as MergeConflict;

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: [distinct] }, CONE);

      // Assert
      expect([...result.retired]).toEqual([]);
      expect(await present(ctx, 'a/g')).toBe(true);
      expect(await present(ctx, 'a/h')).toBe(true);
    });
  });

  describe('Given an out-of-pattern entry with no file on disk, When the stop retires movers', () => {
    it('Then it is retired without error', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      const index = indexOf([entryOf('a/g', id)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, CONE);

      // Assert
      expect([...result.retired]).toEqual(['a/g']);
    });
  });

  describe('Given a conflict entry at a stage above zero, When the stop retires movers', () => {
    it('Then it is left alone', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'g1\n');
      const staged = entryOf('a/g', id, { flags: { ...STAGE0_FLAGS, stage: 2 } });

      // Act
      const result = await sut(
        ctx,
        { currentIndex: indexOf([staged]), conflicts: noConflicts },
        CONE,
      );

      // Assert
      expect([...result.retired]).toEqual([]);
      expect(await present(ctx, 'a/g')).toBe(true);
    });
  });

  describe('Given no sparse matcher, When the stop retires movers', () => {
    it('Then nothing is retired and the file system is untouched', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      await writeWork(ctx, 'a/g', 'g1\n');
      const rm = vi.spyOn(ctx.fs, 'rm');
      const index = indexOf([entryOf('a/g', id)]);

      // Act
      const result = await sut(ctx, { currentIndex: index, conflicts: noConflicts }, undefined);

      // Assert
      expect(result).toBe(NOTHING_RETIRED);
      expect(rm).not.toHaveBeenCalled();
      expect(await present(ctx, 'a/g')).toBe(true);
    });
  });
});

describe('withRetiredSkipped', () => {
  const sut = withRetiredSkipped;

  describe('Given a retirement of one path, When the entries are marked', () => {
    it('Then only that stage-0 entry is skip-worktree', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'g1\n');
      const retired = entryOf('a/g', id);
      const kept = entryOf('a/h', id);
      const staged = entryOf('a/g', id, { flags: { ...STAGE0_FLAGS, stage: 2 } });
      const retirement = {
        retired: new Set([indexPathKey(retired)]),
        leftDirty: new Set<IndexPathKey>(),
      };

      // Act
      const result = sut([retired, kept, staged], retirement);

      // Assert
      expect(result.map((entry) => entry.flags.skipWorktree)).toEqual([true, false, false]);
      expect(result.map((entry) => entry.id)).toEqual([id, id, id]);
    });
  });
});
