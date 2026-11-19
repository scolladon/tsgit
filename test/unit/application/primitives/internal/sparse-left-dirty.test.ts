import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireWorkTree } from '../../../../../src/application/primitives/internal/repo-state.js';
import {
  judgeMovers,
  notUpToDate,
  warnLeftDespiteSparse,
} from '../../../../../src/application/primitives/internal/sparse-left-dirty.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext, recordedStatOf } from '../fixtures.js';

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

const statEntryOf = async (
  ctx: SeededContext,
  name: string,
  id: ObjectId,
  fileSize?: number,
): Promise<IndexEntry> => {
  const stat = await ctx.fs.lstat(`${workDirOf(ctx)}/${name}`);
  return entryOf(name, id, { ...recordedStatOf(stat), fileSize: fileSize ?? stat.size });
};

const OLDER_THAN_ANY_ENTRY = { seconds: 0, nanoseconds: 0 };
const NEWER_THAN_ANY_ENTRY = { seconds: 2 ** 31, nanoseconds: 0 };

describe('notUpToDate stat short-circuit', () => {
  const sut = notUpToDate;

  describe('Given a stat-clean entry whose index is newer than the file, When judged', () => {
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

const EXECUTABLE_BITS = 0o100755;

/** The memory file system models no modes: the work file's stat is made to carry the executable bits. */
const makeExecutable = (ctx: SeededContext): void => {
  const tryLstat = ctx.fs.tryLstat?.bind(ctx.fs);
  if (tryLstat === undefined) throw new Error('the memory file system probes with tryLstat');
  vi.spyOn(ctx.fs, 'tryLstat').mockImplementation(async (path) => {
    const stat = await tryLstat(path);
    return stat === undefined ? undefined : { ...stat, mode: EXECUTABLE_BITS };
  });
};

const writeBody = async (ctx: SeededContext, path: string, body: string): Promise<void> => {
  await ctx.fs.write(`${workDirOf(ctx)}/${path}`, new TextEncoder().encode(body));
};

const modeRows = [
  {
    title: 'an executable work file for a regular entry',
    entryMode: FILE_MODE.REGULAR,
    arrange: async (ctx: SeededContext): Promise<void> => {
      await writeWork(ctx, 'a', 'indexed');
      makeExecutable(ctx);
    },
  },
  {
    title: 'a regular work file for an executable entry',
    entryMode: FILE_MODE.EXECUTABLE,
    arrange: (ctx: SeededContext): Promise<void> => writeWork(ctx, 'a', 'indexed'),
  },
];

describe('notUpToDate mode and type', () => {
  const sut = notUpToDate;

  describe.each(modeRows)('Given $title with the entry content', ({ entryMode, arrange }) => {
    describe('When the candidates are judged', () => {
      it('Then the path is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'indexed');
        await arrange(ctx);

        // Act
        const result = await sut(
          ctx,
          workDirOf(ctx),
          [entryOf('a', id, { mode: entryMode })],
          undefined,
        );

        // Assert
        expect([...result]).toEqual(['a']);
      });
    });

    describe('When the candidates are judged with core.filemode off', () => {
      it('Then nothing is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'indexed');
        await arrange(ctx);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tfilemode = false\n');

        // Act
        const result = await sut(
          ctx,
          workDirOf(ctx),
          [entryOf('a', id, { mode: entryMode })],
          undefined,
        );

        // Assert
        expect([...result]).toEqual([]);
      });
    });
  });

  describe('Given an executable work file for an executable entry, When judged', () => {
    it('Then nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'indexed');
      makeExecutable(ctx);
      const entry = entryOf('a', id, { mode: FILE_MODE.EXECUTABLE });

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], undefined);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe.each([
    { filemode: 'on', config: '' },
    { filemode: 'off', config: '[core]\n\tfilemode = false\n' },
  ])('Given core.filemode $filemode', ({ config }) => {
    describe('When a regular file holds the bytes of a symlink entry', () => {
      it('Then the path is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'target');
        await writeWork(ctx, 'a', 'target');
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
        const entry = entryOf('a', id, { mode: FILE_MODE.SYMLINK });

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entry], undefined);

        // Assert
        expect([...result]).toEqual(['a']);
      });
    });

    describe('When a symlink to the entry content stands for a regular entry', () => {
      it('Then the path is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'target');
        await ctx.fs.symlink('target', `${workDirOf(ctx)}/a`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

        // Assert
        expect([...result]).toEqual(['a']);
      });
    });
  });

  describe('Given core.symlinks off', () => {
    const writeSymlinksOff = (ctx: SeededContext): Promise<void> =>
      ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tsymlinks = false\n');

    describe('When a regular file holds the bytes of a symlink entry', () => {
      it('Then nothing is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'target');
        await writeWork(ctx, 'a', 'target');
        await writeSymlinksOff(ctx);
        const entry = entryOf('a', id, { mode: FILE_MODE.SYMLINK });

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entry], undefined);

        // Assert
        expect([...result]).toEqual([]);
      });
    });

    describe('When a regular file holds other bytes than a symlink entry', () => {
      it('Then the path is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'target');
        await writeWork(ctx, 'a', 'edited');
        await writeSymlinksOff(ctx);
        const entry = entryOf('a', id, { mode: FILE_MODE.SYMLINK });

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entry], undefined);

        // Assert
        expect([...result]).toEqual(['a']);
      });
    });

    describe('When a symlink stands for a regular entry', () => {
      it('Then the path is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'target');
        await ctx.fs.symlink('target', `${workDirOf(ctx)}/a`);
        await writeSymlinksOff(ctx);

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

        // Assert
        expect([...result]).toEqual(['a']);
      });
    });

    describe('When an executable file holds the bytes of a regular entry', () => {
      it('Then the path is reported', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'indexed');
        await writeWork(ctx, 'a', 'indexed');
        makeExecutable(ctx);
        await writeSymlinksOff(ctx);
        const entry = entryOf('a', id, { mode: FILE_MODE.REGULAR });

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entry], undefined);

        // Assert
        expect([...result]).toEqual(['a']);
      });
    });
  });

  describe('Given a symlink whose target is the entry content for a symlink entry, When judged', () => {
    it('Then nothing is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'target');
      await ctx.fs.symlink('target', `${workDirOf(ctx)}/a`);
      const entry = entryOf('a', id, { mode: FILE_MODE.SYMLINK });

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], undefined);

      // Assert
      expect([...result]).toEqual([]);
    });
  });

  describe('Given a directory standing at the entry path, When judged', () => {
    it('Then the path is reported without hashing it', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeBody(ctx, 'a/x', 'untracked');
      const read = vi.spyOn(ctx.fs, 'read');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

      // Assert
      expect([...result]).toEqual(['a']);
      expect(read).not.toHaveBeenCalled();
    });
  });

  describe('Given the path reached through a symlinked directory holding the entry content, When judged', () => {
    it('Then the path is reported', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeBody(ctx, 'b/f', 'indexed');
      await ctx.fs.symlink('b', `${workDirOf(ctx)}/a`);

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a/f', id)], undefined);

      // Assert
      expect([...result]).toEqual(['a/f']);
    });
  });
});

describe('judgeMovers', () => {
  const sut = judgeMovers;

  describe('Given no work file for the entry, When judged', () => {
    it('Then the path is neither dirty nor verified clean', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

      // Assert
      expect([...result.dirty]).toEqual([]);
      expect([...result.verifiedClean]).toEqual([]);
    });
  });

  describe('Given a regular file where a leading directory is due, When judged', () => {
    it('Then the path is dirty and not verified clean', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'indexed');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a/f', id)], undefined);

      // Assert
      expect([...result.dirty]).toEqual(['a/f']);
      expect([...result.verifiedClean]).toEqual([]);
    });
  });

  describe.each([
    {
      title: 'a symlink to an empty directory',
      arrange: async (ctx: SeededContext): Promise<void> => {
        await ctx.fs.mkdir(`${workDirOf(ctx)}/e`);
        await ctx.fs.symlink('e', `${workDirOf(ctx)}/a`);
      },
    },
    {
      title: 'a dangling symlink',
      arrange: (ctx: SeededContext): Promise<void> =>
        ctx.fs.symlink('nowhere', `${workDirOf(ctx)}/a`),
    },
  ])('Given $title where a leading directory is due and nothing behind it', ({ arrange }) => {
    describe('When judged', () => {
      it('Then the path is neither dirty nor verified clean', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const id = await writeBlob(ctx, 'indexed');
        await arrange(ctx);

        // Act
        const result = await sut(ctx, workDirOf(ctx), [entryOf('a/f', id)], undefined);

        // Assert
        expect([...result.dirty]).toEqual([]);
        expect([...result.verifiedClean]).toEqual([]);
      });
    });
  });

  describe('Given a work file whose content equals its entry, When judged', () => {
    it('Then the path is verified clean', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'indexed');
      await writeWork(ctx, 'a', 'indexed');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entryOf('a', id)], undefined);

      // Assert
      expect([...result.dirty]).toEqual([]);
      expect([...result.verifiedClean]).toEqual(['a']);
    });
  });

  describe('Given a stat-matching symlink for a symlink entry, When judged', () => {
    it('Then it is verified clean without reading its target', async () => {
      // Arrange
      const ctx = await buildSeededContext();
      const id = await writeBlob(ctx, 'target');
      await ctx.fs.symlink('target', `${workDirOf(ctx)}/a`);
      const entry = { ...(await statEntryOf(ctx, 'a', id)), mode: FILE_MODE.SYMLINK };
      const readlink = vi.spyOn(ctx.fs, 'readlink');

      // Act
      const result = await sut(ctx, workDirOf(ctx), [entry], NEWER_THAN_ANY_ENTRY);

      // Assert
      expect([...result.verifiedClean]).toEqual(['a']);
      expect(readlink).not.toHaveBeenCalled();
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
