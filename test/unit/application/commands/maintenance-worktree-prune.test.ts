import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { maintenance } from '../../../../src/application/commands/maintenance.js';
import { worktreeAdd } from '../../../../src/application/commands/worktree.js';
import { commonGitDir } from '../../../../src/application/primitives/path-layout.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const seedWithWorktree = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'hello');
  await add(ctx, ['a.txt']);
  await commit(ctx, { message: 'seed', author: AUTHOR });
  await worktreeAdd(ctx, { path: 'wt', detach: true });
  return ctx;
};

const adminOf = (ctx: Context): string => `${commonGitDir(ctx)}/worktrees/wt`;

const CASE_TWIN_ADMIN = 'wt2';

/** A second live worktree whose path is the first one's with its case changed. */
const addCaseTwinWorktree = async (ctx: Context): Promise<string> => {
  const admin = `${commonGitDir(ctx)}/worktrees/${CASE_TWIN_ADMIN}`;
  const twin = `${ctx.layout.workDir}/WT`;
  await ctx.fs.writeUtf8(`${twin}/.git`, `gitdir: ${admin}\n`);
  await ctx.fs.writeUtf8(`${admin}/gitdir`, `${twin}/.git\n`);
  await ctx.fs.writeUtf8(`${admin}/index`, 'index');
  return admin;
};

describe('maintenance gc worktree prune', () => {
  describe('Given a linked worktree whose admin gitdir file is empty', () => {
    describe('When the gc task runs', () => {
      it('Then the admin dir and the emptied worktrees dir are removed', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        await ctx.fs.writeUtf8(`${adminOf(ctx)}/gitdir`, '');
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(`${commonGitDir(ctx)}/worktrees`)).toBe(false);
      });
    });
  });

  describe('Given a vanished linked worktree with a fresh index', () => {
    describe('When gc.worktreePruneExpire is now', () => {
      it('Then the admin dir is removed', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/wt`);
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/config`,
          '[gc]\n  worktreePruneExpire = now\n',
        );
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(adminOf(ctx))).toBe(false);
      });
    });

    describe('When gc.worktreePruneExpire is left at its default', () => {
      it('Then the admin dir is kept', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        await ctx.fs.rmRecursive(`${ctx.layout.workDir}/wt`);
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(`${adminOf(ctx)}/gitdir`)).toBe(true);
      });
    });
  });

  describe('Given an invalid gc.worktreePruneExpire', () => {
    describe('When the gc task runs', () => {
      it('Then it refuses before writing any pack', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        await ctx.fs.writeUtf8(`${adminOf(ctx)}/gitdir`, '');
        await ctx.fs.appendUtf8(
          `${ctx.layout.gitDir}/config`,
          '[gc]\n  worktreePruneExpire = all\n',
        );
        const sut = maintenance;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, { tasks: ['gc'] });
        } catch (error) {
          caught = error;
        }

        // Assert
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_BAD_DATE_VALUE',
          value: 'all',
        });
        expect(await ctx.fs.readdir(`${commonGitDir(ctx)}/objects/pack`)).toEqual([]);
        expect(await ctx.fs.exists(adminOf(ctx))).toBe(true);
      });
    });
  });

  describe('Given a linked worktree locked with an empty gitdir under core.ignoreCase', () => {
    describe('When the gc task runs', () => {
      it('Then the locked admin dir is kept', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        await ctx.fs.writeUtf8(`${adminOf(ctx)}/gitdir`, '');
        await ctx.fs.writeUtf8(`${adminOf(ctx)}/locked`, '');
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  ignoreCase = true\n');
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(adminOf(ctx))).toBe(true);
      });
    });
  });

  describe('Given two live linked worktrees whose paths differ only by case', () => {
    describe('When core.ignoreCase is set and the gc task runs', () => {
      it('Then the later admin dir is pruned as a duplicate', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        const twinAdmin = await addCaseTwinWorktree(ctx);
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  ignoreCase = true\n');
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(adminOf(ctx))).toBe(true);
        expect(await ctx.fs.exists(twinAdmin)).toBe(false);
      });
    });

    describe('When core.ignoreCase is explicitly off and the gc task runs', () => {
      it('Then both admin dirs are kept', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        const twinAdmin = await addCaseTwinWorktree(ctx);
        await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  ignoreCase = false\n');
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(adminOf(ctx))).toBe(true);
        expect(await ctx.fs.exists(twinAdmin)).toBe(true);
      });
    });

    describe('When core.ignoreCase is unset and the gc task runs', () => {
      it('Then both admin dirs are kept', async () => {
        // Arrange
        const ctx = await seedWithWorktree();
        const twinAdmin = await addCaseTwinWorktree(ctx);
        const sut = maintenance;

        // Act
        await sut(ctx, { tasks: ['gc'] });

        // Assert
        expect(await ctx.fs.exists(adminOf(ctx))).toBe(true);
        expect(await ctx.fs.exists(twinAdmin)).toBe(true);
      });
    });
  });
});
