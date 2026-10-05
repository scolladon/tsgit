import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
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

const head = (ctx: Context): Promise<string> => ctx.fs.readUtf8(`${ctx.layout.gitDir}/HEAD`);

const newestHeadMessage = async (ctx: Context): Promise<string | undefined> =>
  (await readReflog(ctx, 'HEAD' as RefName)).at(-1)?.message;

describe('Given HEAD switched main → feature → main', () => {
  describe.each(['-', '@{-1}'])('When checkout %s', (rev) => {
    it('Then HEAD attaches to feature, logged under the branch name', async () => {
      // Arrange
      const { ctx } = await switchedRepo();
      const sut = checkout;

      // Act
      await sut(ctx, { rev });

      // Assert
      const result = await head(ctx);
      expect(result).toBe('ref: refs/heads/feature\n');
      expect(await newestHeadMessage(ctx)).toBe('checkout: moving from main to feature');
    });
  });

  describe('When checkout -b copy -', () => {
    it('Then the new branch starts at the prior checkout', async () => {
      // Arrange
      const { ctx, tip } = await switchedRepo();
      const sut = checkout;

      // Act
      await sut(ctx, { rev: '-', createBranch: { name: 'copy' } });

      // Assert
      const result = await ctx.fs.readUtf8(`${ctx.layout.gitDir}/refs/heads/copy`);
      expect(result).toBe(`${tip}\n`);
      expect(await head(ctx)).toBe('ref: refs/heads/copy\n');
    });
  });
});

describe('Given the prior checkout was a detached HEAD', () => {
  describe('When checkout -', () => {
    it('Then HEAD detaches at that commit, logged under its object id', async () => {
      // Arrange
      const { ctx, tip } = await switchedRepo();
      await checkout(ctx, { rev: tip, detach: true });
      await checkout(ctx, { rev: 'main' });
      const sut = checkout;

      // Act
      await sut(ctx, { rev: '-' });

      // Assert
      const result = await head(ctx);
      expect(result).toBe(`${tip}\n`);
      expect(await newestHeadMessage(ctx)).toBe(`checkout: moving from main to ${tip}`);
    });
  });
});
