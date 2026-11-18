import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireWorkTree } from '../../../../../src/application/primitives/internal/repo-state.js';
import {
  notUpToDate,
  warnLeftDespiteSparse,
} from '../../../../../src/application/primitives/internal/sparse-left-dirty.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
});

type SeededContext = Awaited<ReturnType<typeof buildSeededContext>>;

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

const writeWork = async (ctx: SeededContext, name: string, body: string): Promise<void> => {
  await ctx.fs.write(`${workDirOf(ctx)}/${name}`, new TextEncoder().encode(body));
};

describe('notUpToDate', () => {
  const sut = notUpToDate;

  describe('Given a work file whose content differs from its entry, When the candidates are judged', () => {
    it('Then the path is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'edited');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

      // Assert
      expect([...result]).toEqual(['a']);
    });
  });

  describe('Given a work file whose content equals its entry, When the candidates are judged', () => {
    it('Then nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'indexed');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe('Given no work file for the entry, When the candidates are judged', () => {
    it('Then nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe('Given a dirty file at a lossy path, When the candidates are judged', () => {
    it('Then nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'edited');
      const lossy = entryOf('a', id, { pathBytes: new TextEncoder().encode('a') });

      // Act
      const result = await sut(ctx, workDirOf(ctx), [lossy], undefined);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe('Given a dirty file at a gitlink path, When the candidates are judged', () => {
    it('Then nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'edited');
      const gitlink = entryOf('a', id, { mode: FILE_MODE.GITLINK });

      // Act
      const result = await sut(ctx, workDirOf(ctx), [gitlink], undefined);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe('Given a clean and a dirty entry, When the candidates are judged', () => {
    it('Then only the dirty path is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'indexed');
      await writeWork(ctx, 'b', 'edited');

      // Act
      const result = await sut(
        ctx,
        workDirOf(ctx),
        [entryOf('a', id), entryOf('b', id)],
        undefined,
      );

      // Assert
      expect([...result]).toEqual(['b']);
    });
  });
});

const NS_PER_SECOND = 1_000_000_000n;

const statEntryOf = async (
  ctx: SeededContext,
  name: string,
  id: ObjectId,
  fileSize?: number,
): Promise<IndexEntry> => {
  const stat = await ctx.fs.lstat(`${workDirOf(ctx)}/${name}`);
  const nanoseconds = (ns: bigint | undefined): number =>
    ns === undefined ? 0 : Number(ns % NS_PER_SECOND);
  return entryOf(name, id, {
    ctimeSeconds: Math.floor(stat.ctimeMs / 1000),
    ctimeNanoseconds: nanoseconds(stat.ctimeNs),
    mtimeSeconds: Math.floor(stat.mtimeMs / 1000),
    mtimeNanoseconds: nanoseconds(stat.mtimeNs),
    uid: stat.uid,
    gid: stat.gid,
    ino: stat.ino,
    fileSize: fileSize ?? stat.size,
  });
};

const OLDER_THAN_ANY_ENTRY = { seconds: 0, nanoseconds: 0 };
const NEWER_THAN_ANY_ENTRY = { seconds: 2 ** 31, nanoseconds: 0 };

describe('notUpToDate stat short-circuit', () => {
  const sut = notUpToDate;

  describe('Given a stat-clean entry whose index is older than the file, When judged', () => {
    it('Then the file is not read and nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'edited');
      const entry = await statEntryOf(ctx, 'a', id);
      const read = vi.spyOn(ctx.fs, 'read');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], NEWER_THAN_ANY_ENTRY);

      // Assert
      expect([...result]).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('Given a stat-dirty entry with the same content, When judged', () => {
    it('Then the content fallback reports nothing', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'indexed');
      const entry = await statEntryOf(ctx, 'a', id, 999);

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], NEWER_THAN_ANY_ENTRY);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe('Given a stat-dirty entry with different content, When judged', () => {
    it('Then the path is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'edited');
      const entry = await statEntryOf(ctx, 'a', id, 999);

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], NEWER_THAN_ANY_ENTRY);

      // Assert
      expect([...result]).toEqual(['a']);
    });
  });

  describe('Given a racy stat-matching entry with different content, When judged', () => {
    it('Then the content is compared and the path is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'edited');
      const entry = await statEntryOf(ctx, 'a', id);
      const read = vi.spyOn(ctx.fs, 'read');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], OLDER_THAN_ANY_ENTRY);

      // Assert
      expect([...result]).toEqual(['a']);
      expect(read).toHaveBeenCalled();
    });
  });
});

describe('warnLeftDespiteSparse', () => {
  const sut = warnLeftDespiteSparse;

  describe('Given no path, When warned', () => {
    it('Then the logger is not called', async () => {
      // Arrange
      const warn = vi.fn();
      const ctx = { ...(await buildSeededContext()), logger: { warn } };

      // Act
      sut(ctx, []);

      // Assert
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('Given two paths, When warned', () => {
    it('Then one warning lists them in the given order with the reapply hint', async () => {
      // Arrange
      const warn = vi.fn();
      const ctx = { ...(await buildSeededContext()), logger: { warn } };

      // Act
      sut(ctx, ['a/g' as FilePath, 'a/k' as FilePath]);

      // Assert
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'The following paths are not up to date and were left despite sparse patterns:\n\ta/g\n\ta/k\n\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.',
      );
    });
  });
});
