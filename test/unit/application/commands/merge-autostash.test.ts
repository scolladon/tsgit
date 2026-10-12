import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { mergeAbort } from '../../../../src/application/commands/abort-merge.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { reset } from '../../../../src/application/commands/reset.js';
import { getRefStore } from '../../../../src/application/primitives/ref-store.js';
import { readReflog } from '../../../../src/application/primitives/reflog-store.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR = { name: 'Ada', email: 'a@x', timestamp: 100, timezoneOffset: '+0000' };

const STASH_POP_HINT = 'When finished, apply stashed changes with `git stash pop`';

const write = (ctx: Context, name: string, body: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${name}`, body);

const commitFile = async (ctx: Context, name: string, body: string): Promise<ObjectId> => {
  await write(ctx, name, body);
  await add(ctx, [name]);
  return (await commit(ctx, { message: `${name} ${body.trim()}`, author: AUTHOR })).id;
};

const readWork = (ctx: Context, name: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.workDir}/${name}`);

const mergeAutostashFile = (ctx: Context): string => `${ctx.layout.gitDir}/MERGE_AUTOSTASH`;

const stashRef = async (ctx: Context): Promise<string> =>
  (await getRefStore(ctx).resolveDirect('refs/stash' as RefName)).kind;

type Shape = 'fast-forward' | 'clean' | 'conflict';

/** side rewrites f; main stays put (fast-forward), adds g (clean) or rewrites f (conflict). Then u is dirtied. */
const seed = async (shape: Shape, config = '') => {
  const logger = { info: vi.fn(), warn: vi.fn() };
  const ctx = { ...createMemoryContext(), logger };
  await init(ctx);
  await ctx.fs.appendUtf8(
    `${ctx.layout.gitDir}/config`,
    `\n[user]\n\tname = Ada\n\temail = a@x\n${config}`,
  );
  await commitFile(ctx, 'f', 'base\n');
  await commitFile(ctx, 'u', 'u\n');
  await branchCreate(ctx, { name: 'side' });
  await checkout(ctx, { rev: 'side' });
  await commitFile(ctx, 'f', 'side\n');
  await checkout(ctx, { rev: 'main' });
  if (shape === 'clean') await commitFile(ctx, 'g', 'main\n');
  if (shape === 'conflict') await commitFile(ctx, 'f', 'main\n');
  await write(ctx, 'u', 'dirty\n');
  return { ctx, logger };
};

const MERGE_AUTOSTASH_CONFIG = '[merge]\n\tautostash = true\n';

describe('mergeRun with autostash', () => {
  describe.each([
    ['a fast-forward', 'fast-forward', 'fast-forward', {}, MERGE_AUTOSTASH_CONFIG],
    ['a clean true merge', 'clean', 'merge', { autostash: true }, ''],
  ] as const)('Given a dirty tree and %s', (_, shape, kind, given, config) => {
    describe('When merged with autostash', () => {
      it('Then the change is stashed around the merge and re-applied', async () => {
        // Arrange
        const { ctx, logger } = await seed(shape, config);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', ...given });

        // Assert
        expect(result.kind).toBe(kind);
        expect(await readWork(ctx, 'u')).toBe('dirty\n');
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringMatching(/^Created autostash: [0-9a-f]{7}$/),
        );
        expect(logger.info).toHaveBeenCalledWith('Applied autostash.');
        expect(logger.info).not.toHaveBeenCalledWith(STASH_POP_HINT);
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
        expect(await stashRef(ctx)).toBe('missing');
      });
    });
  });

  describe('Given merge.autostash and the autostash option off, When merged', () => {
    it('Then the option wins and nothing is stashed', async () => {
      // Arrange
      const { ctx, logger } = await seed('clean', MERGE_AUTOSTASH_CONFIG);

      // Act
      await mergeRun(ctx, { rev: 'side', autostash: false });

      // Assert
      expect(logger.info).not.toHaveBeenCalledWith('Applied autostash.');
      expect(await readWork(ctx, 'u')).toBe('dirty\n');
    });
  });

  describe('Given an invalid merge.autostash, When merged', () => {
    it('Then it refuses the bad boolean', async () => {
      // Arrange
      const { ctx } = await seed('clean', '[merge]\n\tautostash = maybe\n');

      // Act
      let caught: unknown;
      try {
        await mergeRun(ctx, { rev: 'side' });
      } catch (error) {
        caught = error;
      }

      // Assert
      expect((caught as TsgitError).data).toMatchObject({
        code: 'CONFIG_BAD_BOOLEAN_VALUE',
        key: 'merge.autostash',
        value: 'maybe',
      });
    });
  });

  describe('Given an invalid merge.autostash and a merge that is already up to date', () => {
    describe('When the single head is HEAD itself', () => {
      it('Then it refuses the bad boolean', async () => {
        // Arrange
        const { ctx } = await seed('clean', '[merge]\n\tautostash = maybe\n');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'main' }).then(
          () => undefined,
          (e: unknown) => (e as TsgitError).data,
        );

        // Assert
        expect(result).toMatchObject({
          code: 'CONFIG_BAD_BOOLEAN_VALUE',
          key: 'merge.autostash',
          value: 'maybe',
        });
      });
    });
  });

  describe.each([
    ['merge', {}, 'conflict'],
    ['squash merge', { squash: true }, 'squashed'],
  ] as const)('Given a dirty tree, When an autostash %s conflicts', (_label, input, kind) => {
    it('Then MERGE_AUTOSTASH keeps the stash, the tree is clean and the pop hint is given', async () => {
      // Arrange
      const { ctx, logger } = await seed('conflict');
      const sut = mergeRun;

      // Act
      const result = await sut(ctx, { rev: 'side', autostash: true, ...input });

      // Assert
      expect(result.kind).toBe(kind);
      expect(await ctx.fs.readUtf8(mergeAutostashFile(ctx))).toMatch(/^[0-9a-f]{40}\n$/);
      expect(await readWork(ctx, 'u')).toBe('u\n');
      expect(logger.info).toHaveBeenCalledWith(STASH_POP_HINT);
    });
  });

  describe('Given a dirty tree, When an autostash squash merges cleanly without a fast-forward', () => {
    it('Then MERGE_AUTOSTASH keeps the stash for the commit and the pop hint is given', async () => {
      // Arrange
      const { ctx, logger } = await seed('clean');
      const sut = mergeRun;

      // Act
      const result = await sut(ctx, { rev: 'side', autostash: true, squash: true });

      // Assert
      expect(result).toEqual({ kind: 'squashed', origHead: expect.any(String) });
      expect(await ctx.fs.readUtf8(mergeAutostashFile(ctx))).toMatch(/^[0-9a-f]{40}\n$/);
      expect(await readWork(ctx, 'u')).toBe('u\n');
      expect(await stashRef(ctx)).toBe('missing');
      expect(logger.info).toHaveBeenCalledWith(STASH_POP_HINT);
    });
  });

  describe('Given a dirty tree, When an autostash squash fast-forwards', () => {
    it('Then the autostash is re-applied at once', async () => {
      // Arrange
      const { ctx, logger } = await seed('fast-forward');
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'side', autostash: true, squash: true });

      // Assert
      expect(await readWork(ctx, 'u')).toBe('dirty\n');
      expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
      expect(logger.info).toHaveBeenCalledWith('Applied autostash.');
    });
  });

  describe('Given an autostash merge stopped on a conflict', () => {
    const conflicted = async () => {
      const seeded = await seed('conflict');
      await mergeRun(seeded.ctx, { rev: 'side', autostash: true });
      return seeded;
    };

    describe('When the resolution is committed', () => {
      it('Then the autostash is re-applied', async () => {
        // Arrange
        const { ctx, logger } = await conflicted();
        await write(ctx, 'f', 'resolved\n');
        await add(ctx, ['f']);
        const sut = commit;

        // Act
        await sut(ctx, { message: 'merged', author: AUTHOR });

        // Assert
        expect(await readWork(ctx, 'u')).toBe('dirty\n');
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
        expect(logger.info).toHaveBeenCalledWith('Applied autostash.');
      });
    });

    describe('When the merge is aborted', () => {
      it('Then the autostash is re-applied onto the restored tree', async () => {
        // Arrange
        const { ctx } = await conflicted();
        const sut = mergeAbort;

        // Act
        await sut(ctx);

        // Assert
        expect(await readWork(ctx, 'u')).toBe('dirty\n');
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
        expect(await stashRef(ctx)).toBe('missing');
      });
    });

    describe('When the tree is hard-reset', () => {
      it('Then the autostash is saved to the stash list instead of applied', async () => {
        // Arrange
        const { ctx, logger } = await conflicted();
        const sut = reset;

        // Act
        await sut(ctx, { mode: 'hard', rev: 'HEAD' });

        // Assert
        expect(await readWork(ctx, 'u')).toBe('u\n');
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
        const entries = await readReflog(ctx, 'refs/stash' as RefName);
        expect(entries.map((entry) => entry.message)).toEqual(['autostash']);
        expect(logger.info).toHaveBeenCalledWith(
          'Autostash exists; creating a new stash entry.\nYour changes are safe in the stash.\nYou can run "git stash pop" or "git stash drop" at any time.',
        );
      });
    });
  });

  describe('Given a dirty tree', () => {
    describe('When an autostash merge names an option no strategy parses', () => {
      it('Then the refusal reaches the caller', async () => {
        // Arrange
        const { ctx } = await seed('clean');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'side', autostash: true, strategyOptions: ['bogus'] })
          .then(() => undefined)
          .catch((e: unknown) => (e as TsgitError).data);

        // Assert
        expect(result).toEqual({ code: 'UNKNOWN_STRATEGY_OPTION', option: 'bogus' });
      });

      it('Then MERGE_AUTOSTASH keeps the stash and the tree stays clean, as git dies', async () => {
        // Arrange
        const { ctx } = await seed('clean');
        const sut = mergeRun;

        // Act
        await sut(ctx, { rev: 'side', autostash: true, strategyOptions: ['bogus'] }).catch(
          () => undefined,
        );

        // Assert
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(true);
        expect(await readWork(ctx, 'u')).toBe('u\n');
        expect(await stashRef(ctx)).toBe('missing');
      });
    });

    describe('When an up-to-date merge follows the refused one', () => {
      it('Then the kept autostash is saved to the stash list, not applied', async () => {
        // Arrange
        const { ctx } = await seed('clean');
        await mergeRun(ctx, { rev: 'side', autostash: true, strategyOptions: ['bogus'] }).catch(
          () => undefined,
        );
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'main' });

        // Assert
        expect(result.kind).toBe('up-to-date');
        expect(await readWork(ctx, 'u')).toBe('u\n');
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
        const entries = await readReflog(ctx, 'refs/stash' as RefName);
        expect(entries.map((entry) => entry.message)).toEqual(['autostash']);
      });
    });

    describe('When the only strategy fails the autostash merge', () => {
      it('Then the autostash is re-applied at once', async () => {
        // Arrange
        const { ctx } = await seed('conflict');
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, {
          rev: 'side',
          autostash: true,
          strategy: 'resolve',
          strategyOptions: ['ours'],
        })
          .then(() => undefined)
          .catch((e: unknown) => (e as TsgitError).data.code);

        // Assert
        expect(result).toBe('MERGE_STRATEGY_FAILED');
        expect(await ctx.fs.exists(mergeAutostashFile(ctx))).toBe(false);
        expect(await readWork(ctx, 'u')).toBe('dirty\n');
      });
    });
  });
});
