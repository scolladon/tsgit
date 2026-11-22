import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { sparseCheckoutSet } from '../../../../src/application/commands/sparse-checkout.js';
import { stashApply, stashPush } from '../../../../src/application/commands/stash.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const EXCLUDED = 'a/f';

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

/** Counts the presence-walk probes aimed at the one skip-worktree path. */
const countingProbes = (ctx: Context): { readonly ctx: Context; readonly probes: () => number } => {
  let count = 0;
  const fs = new Proxy(ctx.fs, {
    get: (target, key) => {
      const member = Reflect.get(target, key);
      if (key !== 'lstatReachableSync') return member;
      return (path: string, ...rest: unknown[]) => {
        if (path.endsWith(`/${EXCLUDED}`)) count++;
        return member.call(target, path, ...rest);
      };
    },
  });
  return { ctx: { ...ctx, fs }, probes: () => count };
};

/** `a/f` is excluded by the cone and absent from disk, so its bit stays and every index read probes it; `other` differs in `b/f`. */
const sparseRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await write(ctx, EXCLUDED, 'f1\n');
  await write(ctx, 'b/f', 'f1\n');
  await add(ctx, [EXCLUDED, 'b/f']);
  await commit(ctx, { message: 'base', author });
  await checkout(ctx, { createBranch: { name: 'other' } });
  await write(ctx, 'b/f', 'other\n');
  await add(ctx, ['b/f']);
  await commit(ctx, { message: 'other', author });
  await checkout(ctx, { rev: 'main' });
  await sparseCheckoutSet(ctx, { patterns: ['b'] });
  return ctx;
};

describe('Given a sparse checkout whose excluded file is absent from disk', () => {
  describe('When add stages a tracked change', () => {
    it('Then the excluded file is probed once', async () => {
      // Arrange
      const base = await sparseRepo();
      await write(base, 'b/f', 'edited\n');
      const { ctx, probes } = countingProbes(base);

      // Act
      await add(ctx, ['b/f']);

      // Assert
      expect(probes()).toBe(1);
    });
  });

  describe('When checkout switches branch', () => {
    it('Then the excluded file is probed once', async () => {
      // Arrange
      const { ctx, probes } = countingProbes(await sparseRepo());

      // Act
      await checkout(ctx, { rev: 'other' });

      // Assert
      expect(probes()).toBe(1);
    });
  });

  describe('When stash push saves a change', () => {
    it('Then the excluded file is probed by the refresh, the change scan and the reset only', async () => {
      // Arrange
      const base = await sparseRepo();
      await write(base, 'b/f', 'edited\n');
      const { ctx, probes } = countingProbes(base);

      // Act
      await stashPush(ctx, {});

      // Assert
      expect(probes()).toBe(3);
    });
  });

  describe('When stash apply restores a change', () => {
    it('Then the excluded file is probed by the refresh and the apply only', async () => {
      // Arrange
      const base = await sparseRepo();
      await write(base, 'b/f', 'edited\n');
      await stashPush(base, {});
      const { ctx, probes } = countingProbes(base);

      // Act
      await stashApply(ctx, {});

      // Assert
      expect(probes()).toBe(2);
    });
  });
});
