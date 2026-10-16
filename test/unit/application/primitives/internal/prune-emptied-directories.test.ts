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
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], NO_SURVIVORS);

        // Assert
        expect(rm.mock.calls.map(([path]) => path)).toEqual([inWork(ctx, 'd/e'), inWork(ctx, 'd')]);
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
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], NO_SURVIVORS);

        // Assert
        expect(rm.mock.calls.map(([path]) => path)).toEqual([inWork(ctx, 'd/e')]);
      });
    });
  });

  describe('Given two removed paths that share an ancestor chain', () => {
    describe('When both are pruned', () => {
      it('Then the shared ancestor is retried after its last child went and is removed', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir(inWork(ctx, 'd/e'));
        await ctx.fs.mkdir(inWork(ctx, 'd/f'));
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x', 'd/f/y'], NO_SURVIVORS);

        // Assert
        expect(rm).toHaveBeenCalledTimes(4);
        expect(await ctx.fs.exists(inWork(ctx, 'd'))).toBe(false);
      });
    });
  });

  describe('Given a leading directory that is already gone', () => {
    describe('When its path is pruned', () => {
      it('Then nothing is removed and nothing throws', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['gone/x'], NO_SURVIVORS);

        // Assert
        expect(rm).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a leaf directory the target state still tracks an entry under', () => {
    describe('When a path beneath it is pruned', () => {
      it('Then no filesystem call is made for it', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.write(inWork(ctx, 'd/e/z'), bytes('z\n'));
        const rm = vi.spyOn(ctx.fs, 'rm');
        const lstat = vi.spyOn(ctx.fs, 'lstat');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], survivingDirectoriesOf(['d/e/z']));

        // Assert
        expect(rm).not.toHaveBeenCalled();
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
        const rm = vi.spyOn(ctx.fs, 'rm');
        const sut = pruneEmptiedDirectories;

        // Act
        await sut(ctx, workdirOf(ctx), ['d/e/x'], survivingDirectoriesOf(['d/y']));

        // Assert
        expect(rm.mock.calls.map(([path]) => path)).toEqual([inWork(ctx, 'd/e')]);
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
