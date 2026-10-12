import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { rebaseAbort, rebaseRun } from '../../../../src/application/commands/rebase.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = { name: 'Feat', email: 'feat@y', timestamp: 100, timezoneOffset: '+0000' };

const write = (ctx: Context, name: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body);

const commitFile = async (ctx: Context, name: string, body = `${name}\n`): Promise<ObjectId> => {
  await write(ctx, name, body);
  await add(ctx, [name]);
  return (await commit(ctx, { message: name, author: AUTHOR })).id;
};

const stashRef = async (ctx: Context): Promise<string> =>
  (await getRefStore(ctx).resolveDirect('refs/stash' as RefName)).kind;

/** topic: base, f, t1; main: base, f, u1 (rewriting f when `upstreamTouchesF`). Then f is dirtied. */
const seed = async (
  opts: { upstreamTouchesF?: boolean; config?: string } = {},
): Promise<{
  ctx: Context;
  logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
}> => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const ctx = { ...createMemoryContext(), logger };
  await init(ctx);
  await ctx.fs.appendUtf8(
    `${ctx.layout.gitDir}/config`,
    `\n[user]\n\tname = Ada\n\temail = a@x\n${opts.config ?? ''}`,
  );
  await commitFile(ctx, 'base');
  await commitFile(ctx, 'f');
  await branchCreate(ctx, { name: 'topic' });
  await checkout(ctx, { rev: 'topic' });
  await commitFile(ctx, 't1');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, opts.upstreamTouchesF === true ? 'f' : 'u1', 'up\n');
  await checkout(ctx, { rev: 'topic' });
  await write(ctx, 'f', 'dirty\n');
  return { ctx, logger };
};

describe('rebaseRun with autostash', () => {
  describe('Given a dirty tree, When rebased with autostash', () => {
    it('Then the changes are stashed, the rebase runs and they come back', async () => {
      // Arrange
      const { ctx, logger } = await seed();
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main', autostash: true });

      // Assert
      expect(result.kind).toBe('rebased');
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('dirty\n');
      expect(await stashRef(ctx)).toBe('missing');
      expect(logger.info).toHaveBeenCalledWith('Applied autostash.');
    });
  });

  describe('Given a dirty tree, When rebased with autostash', () => {
    it('Then it announces the created autostash by its abbreviated id', async () => {
      // Arrange
      const { ctx, logger } = await seed();
      const sut = rebaseRun;

      // Act
      await sut(ctx, { upstream: 'main', autostash: true });

      // Assert
      expect(logger.info.mock.calls.map(([line]) => line)).toEqual([
        expect.stringMatching(/^Created autostash: [0-9a-f]{7}$/),
        'Applied autostash.',
      ]);
    });
  });

  describe('Given rebase.autostash, When rebased without the option', () => {
    it('Then the config stashes the tree', async () => {
      // Arrange
      const { ctx } = await seed({ config: '[rebase]\n\tautostash = true\n' });
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main' });

      // Assert
      expect(result.kind).toBe('rebased');
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('dirty\n');
    });
  });

  describe('Given rebase.autostash, When rebased with autostash false', () => {
    it('Then the dirty tree refuses as without autostash', async () => {
      // Arrange
      const { ctx } = await seed({ config: '[rebase]\n\tautostash = true\n' });
      const sut = rebaseRun;
      let caught: TsgitError | undefined;

      // Act
      try {
        await sut(ctx, { upstream: 'main', autostash: false });
      } catch (err) {
        caught = err as TsgitError;
      }

      // Assert
      expect(caught?.data.code).toBe('WORKING_TREE_DIRTY');
    });
  });

  describe('Given the stashed changes conflict with the rebased branch, When rebased with autostash', () => {
    it('Then the rebase finishes, the conflict stays and the stash is stored', async () => {
      // Arrange
      const { ctx, logger } = await seed({ upstreamTouchesF: true });
      const sut = rebaseRun;

      // Act
      const result = await sut(ctx, { upstream: 'main', autostash: true });

      // Assert
      expect(result.kind).toBe('rebased');
      expect(await stashRef(ctx)).toBe('direct');
      const log = await readReflog(ctx, 'refs/stash' as RefName);
      expect(log.map((e) => e.message)).toEqual(['autostash']);
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toContain('<<<<<<<');
      expect(logger.warn).toHaveBeenCalledOnce();
    });
  });

  describe('Given a rebase that stops, When it is aborted', () => {
    it('Then the stop records the autostash and the abort applies it', async () => {
      // Arrange
      const { ctx } = await seed();
      await checkout(ctx, { rev: 'main', force: true });
      await commitFile(ctx, 't1', 'clash\n');
      await checkout(ctx, { rev: 'topic' });
      await write(ctx, 'f', 'dirty\n');
      const stopped = await rebaseRun(ctx, { upstream: 'main', autostash: true });
      const stash = (await ctx.fs.readUtf8(`${ctx.layout.gitDir}/rebase-merge/autostash`)).trim();
      const sut = rebaseAbort;

      // Act
      await sut(ctx);

      // Assert
      expect(stopped.kind).toBe('conflict');
      const obj = await readObject(ctx, stash as ObjectId);
      expect(obj.type === 'commit' && obj.data.message).toBe('On topic: autostash');
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/f`)).toBe('dirty\n');
    });
  });
});
