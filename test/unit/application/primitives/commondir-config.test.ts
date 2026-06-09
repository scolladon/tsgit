import { describe, expect, it } from 'vitest';
import { readConfig } from '../../../../src/application/primitives/config-read.js';
import {
  isWorktreeScopeActive,
  resolveScopePath,
} from '../../../../src/application/primitives/internal/config-scope.js';
import { readInfoExclude } from '../../../../src/application/primitives/internal/read-gitignore.js';
import type { Context } from '../../../../src/ports/context.js';
import { buildSeededContext } from './fixtures.js';

const adminDir = (ctx: Context): string => `${ctx.layout.gitDir}/worktrees/wt`;

const asWorktreeChild = (ctx: Context): Context => ({
  ...ctx,
  layout: { ...ctx.layout, gitDir: adminDir(ctx), commonDir: ctx.layout.gitDir },
});

describe('common-dir config + info/exclude', () => {
  describe('Given a local config under the common dir', () => {
    describe('When the child Context reads config', () => {
      it('Then the config resolves from the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[user]\n\tname = Alice\n\temail = a@b.c\n',
        );
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await readConfig(sut);

        // Assert
        expect(result.user?.name).toBe('Alice');
      });
    });
  });

  describe('Given an info/exclude under the common dir', () => {
    describe('When the child Context reads info/exclude', () => {
      it('Then the excludes resolve from the common dir', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/exclude`, '*.tmp\n');
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await readInfoExclude(sut);

        // Assert
        expect(result).toBeDefined();
      });
    });
  });

  describe('Given a worktree child Context', () => {
    describe('When resolving the local config scope path', () => {
      it('Then it points at the common dir config', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await resolveScopePath(sut, 'local');

        // Assert
        expect(result).toBe(`${ctx.layout.gitDir}/config`);
      });
    });

    describe('When probing the worktree-config extension', () => {
      it('Then it reads the extension flag from the common dir config', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8(
          `${ctx.layout.gitDir}/config`,
          '[extensions]\n\tworktreeConfig = true\n',
        );
        const sut = asWorktreeChild(ctx);

        // Act
        const result = await isWorktreeScopeActive(sut);

        // Assert
        expect(result).toBe(true);
      });
    });
  });
});
