import { describe, expect, it, vi } from 'vitest';
import {
  pruneEmptiedDirectories,
  survivingDirectoriesOf,
} from '../../../../../src/application/primitives/internal/prune-emptied-directories.js';
import { requireWorkTree } from '../../../../../src/application/primitives/internal/repo-state.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

const workdirOf = (ctx: Context): string => requireWorkTree(ctx, 'test');

const inWork = (ctx: Context, path: string): string => `${workdirOf(ctx)}/${path}`;

const NO_SURVIVORS = survivingDirectoriesOf([]);

describe('pruneEmptiedDirectories', () => {
  describe('Given a leading component that is a symlink to a directory', () => {
    describe('When its path is pruned', () => {
      it('Then the link survives and its target is untouched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(inWork(ctx, 'real/survivor'), bytes('keep\n'));
        await ctx.fs.symlink('real', inWork(ctx, 'a'));
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['a/x'], NO_SURVIVORS);

        // Assert
        expect((await ctx.fs.lstat(inWork(ctx, 'a'))).isSymbolicLink).toBe(true);
        expect(await ctx.fs.exists(inWork(ctx, 'real/survivor'))).toBe(true);
      });
    });
  });

  describe('Given a leading component that is a regular file', () => {
    describe('When a path beneath it is pruned', () => {
      it('Then the file survives', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(inWork(ctx, 'a'), bytes('file\n'));
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['a/x'], NO_SURVIVORS);

        // Assert
        expect(await ctx.fs.exists(inWork(ctx, 'a'))).toBe(true);
      });
    });
  });

  describe('Given d/e emptied while d still holds d/y', () => {
    describe('When d/e/x is pruned', () => {
      it('Then d/e is removed and the climb ends at d, which stays', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(inWork(ctx, 'd/e'));
        await ctx.fs.write(inWork(ctx, 'd/y'), bytes('y\n'));
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], NO_SURVIVORS);

        // Assert
        expect(rmdir.mock.calls.map(([path]) => path)).toEqual([
          inWork(ctx, 'd/e'),
          inWork(ctx, 'd'),
        ]);
        expect(await ctx.fs.exists(inWork(ctx, 'd/e'))).toBe(false);
        expect(await ctx.fs.exists(inWork(ctx, 'd/y'))).toBe(true);
      });
    });
  });

  describe('Given a leaf directory that still holds a file', () => {
    describe('When a path beneath it is pruned', () => {
      it('Then one attempt is made and no ancestor is tried', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(inWork(ctx, 'd/e/z'), bytes('z\n'));
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], NO_SURVIVORS);

        // Assert
        expect(rmdir.mock.calls.map(([path]) => path)).toEqual([inWork(ctx, 'd/e')]);
      });
    });
  });

  describe('Given two removed paths that share an ancestor chain', () => {
    describe('When both are pruned', () => {
      it('Then the shared ancestor is attempted once, after both children went, and is removed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(inWork(ctx, 'd/e'));
        await ctx.fs.mkdir(inWork(ctx, 'd/f'));
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x', 'd/f/y'], NO_SURVIVORS);

        // Assert
        expect(rmdir).toHaveBeenCalledTimes(3);
        expect(await ctx.fs.exists(inWork(ctx, 'd'))).toBe(false);
      });
    });
  });

  describe('Given several same-depth directories and a shared parent', () => {
    describe('When they are pruned', () => {
      it('Then same-depth removals overlap and the parent starts only after every child settled', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        for (const leaf of ['d/a', 'd/b', 'd/c']) await ctx.fs.mkdir(inWork(ctx, leaf));
        const events: string[] = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const realRmdir = ctx.fs.rmdir?.bind(ctx.fs);
        vi.spyOn(ctx.fs, 'rmdir').mockImplementation(async (path) => {
          events.push(`start ${path}`);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          await realRmdir?.(path);
          inFlight--;
          events.push(`end ${path}`);
        });
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/a/x', 'd/b/x', 'd/c/x'], NO_SURVIVORS);

        // Assert
        const parentStart = events.indexOf(`start ${inWork(ctx, 'd')}`);
        const lastChildEnd = Math.max(
          ...['d/a', 'd/b', 'd/c'].map((leaf) => events.indexOf(`end ${inWork(ctx, leaf)}`)),
        );
        expect(maxInFlight).toBeGreaterThan(1);
        expect(parentStart).toBeGreaterThan(lastChildEnd);
      });
    });
  });

  describe('Given a leading directory that is already gone', () => {
    describe('When its path is pruned', () => {
      it('Then one removal is attempted and its refusal does not throw', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['gone/x'], NO_SURVIVORS);

        // Assert
        expect(rmdir.mock.calls.map(([path]) => path)).toEqual([inWork(ctx, 'gone')]);
      });
    });
  });

  describe('Given a leading component that is a symlink to an empty directory', () => {
    describe('When its path is pruned', () => {
      it('Then the link survives and its target is untouched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(inWork(ctx, 'real'));
        await ctx.fs.symlink('real', inWork(ctx, 'a'));
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['a/x'], NO_SURVIVORS);

        // Assert
        expect((await ctx.fs.lstat(inWork(ctx, 'a'))).isSymbolicLink).toBe(true);
        expect((await ctx.fs.lstat(inWork(ctx, 'real'))).isDirectory).toBe(true);
      });
    });
  });

  describe('Given a port without rmdir', () => {
    const withoutRmdir = (ctx: Context): Context => {
      const { rmdir: _omitted, ...rest } = ctx.fs;
      return { ...ctx, fs: rest };
    };

    describe('When a symlink to an empty directory is pruned', () => {
      it('Then the link survives and its target is untouched', async () => {
        // Arrange
        const base = await buildSeededContext();
        await base.fs.mkdir(inWork(base, 'real'));
        await base.fs.symlink('real', inWork(base, 'a'));
        const ctx = withoutRmdir(base);
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['a/x'], NO_SURVIVORS);

        // Assert
        expect((await base.fs.lstat(inWork(base, 'a'))).isSymbolicLink).toBe(true);
        expect((await base.fs.lstat(inWork(base, 'real'))).isDirectory).toBe(true);
      });
    });

    describe('When an emptied directory is pruned', () => {
      it('Then it is removed through rm', async () => {
        // Arrange
        const base = await buildSeededContext();
        await base.fs.mkdir(inWork(base, 'd/e'));
        const ctx = withoutRmdir(base);
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], NO_SURVIVORS);

        // Assert
        expect(await base.fs.exists(inWork(base, 'd'))).toBe(false);
      });
    });
  });

  describe('Given a leaf directory the target state still tracks an entry under', () => {
    describe('When a path beneath it is pruned', () => {
      it('Then no filesystem call is made for it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(inWork(ctx, 'd/e/z'), bytes('z\n'));
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const lstat = vi.spyOn(ctx.fs, 'lstat');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], survivingDirectoriesOf(['d/e/z']));

        // Assert
        expect(rmdir).not.toHaveBeenCalled();
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given d/e emptied while the target still tracks d/y', () => {
    describe('When d/e/x is pruned', () => {
      it('Then d/e is removed and d is never touched', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(inWork(ctx, 'd/e'));
        await ctx.fs.write(inWork(ctx, 'd/y'), bytes('y\n'));
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], survivingDirectoriesOf(['d/y']));

        // Assert
        expect(rmdir.mock.calls.map(([path]) => path)).toEqual([inWork(ctx, 'd/e')]);
        expect(await ctx.fs.exists(inWork(ctx, 'd/e'))).toBe(false);
      });
    });
  });

  describe('Given a multi-character top-level directory emptied next to an empty sibling named like its prefix', () => {
    describe('When its only file is pruned', () => {
      it('Then the climb ends at the work tree root and the sibling stays', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(inWork(ctx, 'dir/e'));
        await ctx.fs.mkdir(inWork(ctx, 'di'));
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['dir/e/x'], NO_SURVIVORS);

        // Assert
        expect(await ctx.fs.exists(inWork(ctx, 'dir'))).toBe(false);
        expect(await ctx.fs.exists(inWork(ctx, 'di'))).toBe(true);
      });
    });
  });
});

describe('survivingDirectoriesOf', () => {
  describe('Given nested and top-level tracked paths', () => {
    describe('When the directories are derived', () => {
      it('Then every ancestor directory is listed once and the root is not', () => {
        // Arrange
        const paths = ['a/b/c', 'a/b/d', 'a/e', 'top'];

        // Act
        const result = survivingDirectoriesOf(paths);

        // Assert
        expect([...result].sort()).toEqual(['a', 'a/b']);
      });
    });
  });
});
