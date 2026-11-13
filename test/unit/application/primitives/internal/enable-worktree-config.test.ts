import { describe, expect, it, vi } from 'vitest';
import { invalidateConfigCache } from '../../../../../src/application/primitives/config-read.js';
import { enableWorktreeConfig } from '../../../../../src/application/primitives/internal/enable-worktree-config.js';
import { commonGitDir } from '../../../../../src/application/primitives/path-layout.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../fixtures.js';

const EXTENSION = '[extensions]\n\tworktreeConfig = true\n';

const seedLocal = async (ctx: Context, text: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${commonGitDir(ctx)}/config`, text);
  invalidateConfigCache(ctx);
};
const readLocal = (ctx: Context): Promise<string> => ctx.fs.readUtf8(`${commonGitDir(ctx)}/config`);
const worktreeFile = (ctx: Context): string => `${commonGitDir(ctx)}/config.worktree`;

describe('enableWorktreeConfig', () => {
  const sut = enableWorktreeConfig;

  describe('Given the extension is already on', () => {
    describe('When enabling', () => {
      it('Then nothing is written', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedLocal(ctx, `[core]\n\tworktree = /w\n${EXTENSION}`);
        const spy = vi.spyOn(ctx.fs, 'writeUtf8');

        // Act
        await sut(ctx);

        // Assert
        expect(spy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a fresh local config', () => {
    describe('When enabling', () => {
      it('Then the local config gains the extension and no worktree file is created', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedLocal(ctx, '[core]\n\trepositoryformatversion = 0\n');

        // Act
        await sut(ctx);

        // Assert
        expect(await readLocal(ctx)).toBe(`[core]\n\trepositoryformatversion = 0\n${EXTENSION}`);
        expect(await ctx.fs.exists(worktreeFile(ctx))).toBe(false);
      });
    });
  });

  describe('Given the extension is switched off locally', () => {
    describe('When enabling', () => {
      it('Then the line is rewritten in place', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedLocal(ctx, '[extensions]\n\tworktreeConfig = false\n');

        // Act
        await sut(ctx);

        // Assert
        expect(await readLocal(ctx)).toBe(EXTENSION);
      });
    });
  });

  describe('Given a local core.worktree', () => {
    describe('When enabling', () => {
      it('Then it moves to the common worktree config', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedLocal(ctx, '[core]\n\tworktree = /w\n');

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.readUtf8(worktreeFile(ctx))).toBe('[core]\n\tworktree = /w\n');
        expect(await readLocal(ctx)).not.toContain('worktree = /w');
        expect(await readLocal(ctx)).toContain(EXTENSION);
      });
    });
  });

  describe('Given two local core.worktree entries', () => {
    describe('When enabling', () => {
      it('Then the last one moves and both leave the local file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await seedLocal(ctx, '[core]\n\tworktree = /first\n\tworktree = /last\n');

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.readUtf8(worktreeFile(ctx))).toBe('[core]\n\tworktree = /last\n');
        expect(await readLocal(ctx)).not.toContain('/first');
        expect(await readLocal(ctx)).not.toContain('/last');
      });
    });
  });

  describe('Given a linked worktree context with a local core.worktree', () => {
    describe('When enabling', () => {
      it('Then it moves to the main worktree config, not the linked one', async () => {
        // Arrange
        const main = await buildSeededContext();
        const adminDir = `${main.layout.gitDir}/worktrees/wt`;
        const ctx: Context = {
          ...main,
          layout: { ...main.layout, gitDir: adminDir, commonDir: main.layout.gitDir },
        };
        await seedLocal(ctx, '[core]\n\tworktree = /w\n');
        await ctx.fs.mkdir(adminDir);

        // Act
        await sut(ctx);

        // Assert
        expect(await ctx.fs.readUtf8(`${main.layout.gitDir}/config.worktree`)).toBe(
          '[core]\n\tworktree = /w\n',
        );
        expect(await ctx.fs.exists(`${adminDir}/config.worktree`)).toBe(false);
      });
    });
  });
});
