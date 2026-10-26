import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { MemoryHookRunner } from '../../../../src/adapters/memory/memory-hook-runner.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { readHeadRaw } from '../../../../src/application/primitives/internal/repo-state.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const HEAD = 'HEAD' as RefName;

const seedMain = async (): Promise<{ ctx: Context; runner: MemoryHookRunner; tip: ObjectId }> => {
  const runner = new MemoryHookRunner();
  const ctx = createMemoryContext({ hooks: runner });
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const tip = (await commit(ctx, { message: 'first', author })).id;
  return { ctx, runner, tip };
};

const reflogMessages = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await readReflog(ctx, HEAD)).map((entry) => entry.message);

describe('checkout of a bare HEAD spelling', () => {
  describe.each(['HEAD', '@'])('Given HEAD on main, When checkout rev %s', (rev) => {
    it('Then HEAD stays on main and no reflog entry is added', async () => {
      // Arrange
      const { ctx, tip } = await seedMain();
      const before = await reflogMessages(ctx);

      // Act
      const result = await checkout(ctx, { rev });

      // Assert
      expect(result).toEqual({
        branch: 'refs/heads/main',
        id: tip,
        detached: false,
        changedPaths: 0,
      });
      expect(await readHeadRaw(ctx)).toEqual({ kind: 'symbolic', target: 'refs/heads/main' });
      expect(await reflogMessages(ctx)).toEqual(before);
    });
  });

  describe('Given a detached HEAD, When checkout rev HEAD', () => {
    it('Then no reflog entry is added and the result reports branch undefined, detached true', async () => {
      // Arrange
      const { ctx, tip } = await seedMain();
      await checkout(ctx, { rev: tip, detach: true });
      const before = await reflogMessages(ctx);

      // Act
      const result = await checkout(ctx, { rev: 'HEAD' });

      // Assert
      expect(result).toEqual({ branch: undefined, id: tip, detached: true, changedPaths: 0 });
      expect(await readHeadRaw(ctx)).toEqual({ kind: 'direct', id: tip });
      expect(await reflogMessages(ctx)).toEqual(before);
    });
  });

  describe('Given HEAD on main, When checkout rev HEAD with detach true', () => {
    it('Then HEAD detaches and the reflog logs the move from main to HEAD', async () => {
      // Arrange
      const { ctx, tip } = await seedMain();

      // Act
      const result = await checkout(ctx, { rev: 'HEAD', detach: true });

      // Assert
      expect(result.detached).toBe(true);
      expect(await readHeadRaw(ctx)).toEqual({ kind: 'direct', id: tip });
      expect((await reflogMessages(ctx)).at(-1)).toBe('checkout: moving from main to HEAD');
    });
  });

  describe('Given HEAD on main, When checkout rev HEAD with createBranch nb', () => {
    it('Then nb is attached and the reflog logs the move from main to nb', async () => {
      // Arrange
      const { ctx } = await seedMain();

      // Act
      const result = await checkout(ctx, { rev: 'HEAD', createBranch: { name: 'nb' } });

      // Assert
      expect(result.branch).toBe('refs/heads/nb');
      expect((await reflogMessages(ctx)).at(-1)).toBe('checkout: moving from main to nb');
    });
  });

  describe('Given HEAD on main, When checkout rev HEAD~0', () => {
    it('Then HEAD detaches', async () => {
      // Arrange
      const { ctx, tip } = await seedMain();

      // Act
      const result = await checkout(ctx, { rev: 'HEAD~0' });

      // Assert
      expect(result.detached).toBe(true);
      expect(await readHeadRaw(ctx)).toEqual({ kind: 'direct', id: tip });
    });
  });

  describe('Given HEAD on main and a post-checkout hook, When checkout rev HEAD', () => {
    it('Then post-checkout fires once with the same oid twice and the branch flag', async () => {
      // Arrange
      const { ctx, runner, tip } = await seedMain();
      const before = runner.calls.length;

      // Act
      await checkout(ctx, { rev: 'HEAD' });

      // Assert
      const post = runner.calls.slice(before).filter((call) => call.name === 'post-checkout');
      expect(post.map((call) => call.args)).toEqual([[tip, tip, '1']]);
    });
  });

  describe('Given HEAD on main and a MERGE_HEAD, When checkout rev HEAD', () => {
    it('Then MERGE_HEAD is removed', async () => {
      // Arrange
      const { ctx, tip } = await seedMain();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${tip}\n`);

      // Act
      await checkout(ctx, { rev: 'HEAD' });

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_HEAD`)).toBe(false);
    });
  });
});
