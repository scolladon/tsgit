import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import {
  branchCreate,
  branchDelete,
  branchRename,
} from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { errorDataCode } from '../../../../src/domain/error-data-code.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

/** main and feature at one commit; HEAD went main → feature → main. */
const switchedRepo = async (): Promise<{ ctx: Context; tip: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const tip = (await commit(ctx, { message: 'first', author })).id;
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await checkout(ctx, { rev: 'main' });
  return { ctx, tip };
};

describe('Given HEAD switched main → feature → main', () => {
  describe('When branchDelete @{-1}', () => {
    it('Then feature is deleted', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      const sut = branchDelete;

      // Act
      const result = await sut(ctx, { name: '@{-1}' });

      // Assert
      expect(result).toEqual({ name: 'refs/heads/feature' });
    });
  });

  describe('When branchRename @{-1} to renamed', () => {
    it('Then feature is renamed', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      const sut = branchRename;

      // Act
      const result = await sut(ctx, { from: '@{-1}', to: 'renamed' });

      // Assert
      expect(result).toEqual({ from: 'refs/heads/feature', to: 'refs/heads/renamed' });
    });
  });

  describe('When branchCreate copy at @{-1}', () => {
    it('Then copy starts at the prior checkout', async () => {
      // Arrange
      const { ctx, tip } = await switchedRepo();
      const sut = branchCreate;

      // Act
      await sut(ctx, { name: 'copy', startPoint: '@{-1}' });

      // Assert
      const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/copy`);
      expect(result).toBe(`${tip}\n`);
    });
  });

  describe('When branchCreate @{-1}', () => {
    it('Then it refuses: the branch it spells, feature, already exists', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      const sut = branchCreate;

      // Act
      let result: unknown;
      try {
        await sut(ctx, { name: '@{-1}' });
      } catch (error) {
        result = error;
      }

      // Assert
      expect(errorDataCode(result)).toBe('BRANCH_EXISTS');
      expect((result as { data: { name: string } }).data.name).toBe('refs/heads/feature');
    });
  });
});
