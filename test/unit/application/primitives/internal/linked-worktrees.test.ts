import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { linkedWorktreeAdmins } from '../../../../../src/application/primitives/internal/linked-worktrees.js';
import { fileNotFound, permissionDenied } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

afterEach(() => {
  vi.restoreAllMocks();
});

const adminDirOf = (ctx: Context, id: string): string => `${ctx.layout.gitDir}/worktrees/${id}`;

const repoWithWorktrees = async (ids: ReadonlyArray<string> = ['wt1', 'wt2']): Promise<Context> => {
  const ctx = createMemoryContext();
  for (const id of ids) {
    const adminDir = adminDirOf(ctx, id);
    await ctx.fs.writeUtf8(`${adminDir}/HEAD`, 'ref: refs/heads/main\n');
    await ctx.fs.writeUtf8(`${adminDir}/gitdir`, `/work/${id}/.git\n`);
    await ctx.fs.writeUtf8(`${adminDir}/commondir`, '../..\n');
  }
  return ctx;
};

const failReadOf = (ctx: Context, target: string, fault: Error): void => {
  const readUtf8 = ctx.fs.readUtf8.bind(ctx.fs);
  vi.spyOn(ctx.fs, 'readUtf8').mockImplementation(async (path: string) => {
    if (path === target) throw fault;
    return readUtf8(path);
  });
};

const admin = (ctx: Context, id: string, gitdirPointer = `/work/${id}/.git\n`) => ({
  id,
  adminDir: adminDirOf(ctx, id),
  gitdirPointer,
});

describe('linkedWorktreeAdmins', () => {
  describe('Given a repository with no worktrees directory', () => {
    describe('When the admins are listed', () => {
      it('Then there are none', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given two worktrees with a readable gitdir', () => {
    describe('When the admins are listed', () => {
      it('Then each carries its id, admin directory and raw gitdir content', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([admin(ctx, 'wt1'), admin(ctx, 'wt2')]);
      });
    });
  });

  describe('Given a worktree whose gitdir file is absent', () => {
    describe('When the admins are listed', () => {
      it('Then that worktree is skipped', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        failReadOf(ctx, `${adminDirOf(ctx, 'wt1')}/gitdir`, fileNotFound('gitdir'));
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([admin(ctx, 'wt2')]);
      });
    });
  });

  describe('Given a worktree whose gitdir file is refused', () => {
    describe('When the admins are listed', () => {
      it('Then that worktree is skipped', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        const target = `${adminDirOf(ctx, 'wt1')}/gitdir`;
        failReadOf(ctx, target, permissionDenied(target));
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([admin(ctx, 'wt2')]);
      });
    });
  });

  describe('Given an entry under worktrees that is a regular file', () => {
    describe('When the admins are listed', () => {
      it('Then it is skipped', async () => {
        // Arrange
        const ctx = await repoWithWorktrees(['wt1']);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/worktrees/stray`, 'not a directory');
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([admin(ctx, 'wt1')]);
      });
    });
  });

  describe('Given a worktree whose gitdir file has zero bytes', () => {
    describe('When the admins are listed', () => {
      it('Then that worktree is skipped', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        await ctx.fs.writeUtf8(`${adminDirOf(ctx, 'wt1')}/gitdir`, '');
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([admin(ctx, 'wt2')]);
      });
    });
  });

  describe('Given a worktree whose gitdir file holds only whitespace', () => {
    describe('When the admins are listed', () => {
      it('Then it is listed with the raw content', async () => {
        // Arrange
        const ctx = await repoWithWorktrees(['wt1']);
        await ctx.fs.writeUtf8(`${adminDirOf(ctx, 'wt1')}/gitdir`, '\n');
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toEqual([admin(ctx, 'wt1', '\n')]);
      });
    });
  });

  describe('Given an unclassified fault reading a gitdir file', () => {
    describe('When the admins are listed', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        const fault = new Error('EIO');
        failReadOf(ctx, `${adminDirOf(ctx, 'wt1')}/gitdir`, fault);
        const sut = linkedWorktreeAdmins;

        // Act
        const result = sut(ctx);

        // Assert
        await expect(result).rejects.toBe(fault);
      });
    });
  });

  describe('Given an unclassified fault listing the worktrees directory', () => {
    describe('When the admins are listed', () => {
      it('Then the fault propagates', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        const fault = new Error('EIO');
        vi.spyOn(ctx.fs, 'readdir').mockRejectedValue(fault);
        const sut = linkedWorktreeAdmins;

        // Act
        const result = sut(ctx);

        // Assert
        await expect(result).rejects.toBe(fault);
      });
    });
  });

  describe('Given an adapter that lists in OS order', () => {
    describe('When the admins are listed', () => {
      it('Then they follow that order', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        const readdir = ctx.fs.readdir.bind(ctx.fs);
        Object.assign(ctx.fs, {
          readdirInOsOrder: async (p: string) => [...(await readdir(p))].reverse(),
        });
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.map((entry) => entry.id)).toEqual(['wt2', 'wt1']);
      });
    });
  });

  describe('Given an adapter without an OS-order listing', () => {
    describe('When the admins are listed', () => {
      it('Then they follow readdir', async () => {
        // Arrange
        const ctx = await repoWithWorktrees();
        const sut = linkedWorktreeAdmins;

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result.map((entry) => entry.id)).toEqual(['wt1', 'wt2']);
      });
    });
  });
});
