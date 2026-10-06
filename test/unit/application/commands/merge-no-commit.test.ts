import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { readObject } from '../../../../src/application/primitives/read-object.js';
import { resolveRef } from '../../../../src/application/primitives/resolve-ref.js';
import type { TsgitError } from '../../../../src/domain/error.js';
import type { AuthorIdentity, ObjectId, RefName } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'a',
  email: 'a@x',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0130',
};
const HEAD = 'HEAD' as RefName;

const commitFile = async (ctx: Context, file: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${file}`, file);
  await add(ctx, [file]);
  return (await commit(ctx, { message, author })).id;
};

interface Repo {
  readonly ctx: Context;
  readonly one: ObjectId;
  readonly two: ObjectId;
  readonly main: ObjectId;
}

/** feature adds `one` then `two` over `base`; main adds `on-main` unless `fastForwardable`. */
const repo = async (fastForwardable = false): Promise<Repo> => {
  const ctx = createMemoryContext();
  await init(ctx);
  const base = await commitFile(ctx, 'a.txt', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  const one = await commitFile(ctx, 'one.txt', 'one');
  const two = await commitFile(ctx, 'two.txt', 'two');
  await checkout(ctx, { rev: 'main' });
  const main = fastForwardable ? base : await commitFile(ctx, 'c.txt', 'on-main');
  return { ctx, one, two, main };
};

const stateFile = (ctx: Context, name: string): Promise<string | undefined> =>
  ctx.fs
    .exists(`${ctx.layout.gitDir}/${name}`)
    .then((present) => (present ? ctx.fs.readUtf8(`${ctx.layout.gitDir}/${name}`) : undefined));

const mergeState = async (ctx: Context) => ({
  head: await stateFile(ctx, 'MERGE_HEAD'),
  msg: await stateFile(ctx, 'MERGE_MSG'),
  mode: await stateFile(ctx, 'MERGE_MODE'),
});

describe('merge without committing', () => {
  describe('Given HEAD diverged from a branch', () => {
    describe('When merged with commit false', () => {
      it('Then the merge is staged, HEAD stays and MERGE_HEAD, MERGE_MSG and MERGE_MODE are kept', async () => {
        // Arrange
        const { ctx, two, main } = await repo();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', commit: false, author });

        // Assert
        expect(result).toEqual({ kind: 'stopped', mergeHead: two, origHead: main });
        expect(await resolveRef(ctx, HEAD)).toBe(main);
        expect(await mergeState(ctx)).toEqual({
          head: `${two}\n`,
          msg: "Merge branch 'feature'\n",
          mode: '',
        });
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toContain('two.txt');
      });
    });

    describe('When the stopped merge is committed without a message', () => {
      it('Then the commit has both parents and MERGE_MSG as its message', async () => {
        // Arrange
        const { ctx, two, main } = await repo();
        await mergeRun(ctx, { rev: 'feature', commit: false, author });
        const sut = commit;

        // Act
        const committed = await sut(ctx, { message: '', author });

        // Assert
        const result = await readObject(ctx, committed.id);
        expect(result.type === 'commit' && result.data.parents).toEqual([main, two]);
        expect(result.type === 'commit' && result.data.message).toBe("Merge branch 'feature'\n");
        expect(await mergeState(ctx)).toEqual({ head: undefined, msg: undefined, mode: undefined });
      });
    });
  });

  describe('Given HEAD fast-forwardable to a branch', () => {
    describe('When merged with commit false', () => {
      it('Then it still fast-forwards', async () => {
        // Arrange
        const { ctx, two } = await repo(true);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', commit: false, author });

        // Assert
        expect(result).toEqual({ kind: 'fast-forward', id: two, branch: 'refs/heads/main' });
      });
    });

    describe('When merged with commit false and fastForward never', () => {
      it('Then it stops with MERGE_MODE no-ff', async () => {
        // Arrange
        const { ctx, two, main } = await repo(true);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, {
          rev: 'feature',
          commit: false,
          fastForward: 'never',
          author,
        });

        // Assert
        expect(result).toEqual({ kind: 'stopped', mergeHead: two, origHead: main });
        expect(await stateFile(ctx, 'MERGE_MODE')).toBe('no-ff');
      });
    });
  });

  describe('Given two heads to merge', () => {
    describe('When merged with commit false', () => {
      it('Then it stops with every head in MERGE_HEAD', async () => {
        // Arrange
        const { ctx, one, two, main } = await repo();
        await branchCreate(ctx, { name: 'other', startPoint: one });
        await checkout(ctx, { rev: 'other' });
        const other = await commitFile(ctx, 'o.txt', 'oo');
        await checkout(ctx, { rev: 'main' });
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: ['feature', 'other'], commit: false, author });

        // Assert
        expect(result).toEqual({ kind: 'stopped', mergeHead: two, origHead: main });
        expect(await stateFile(ctx, 'MERGE_HEAD')).toBe(`${two}\n${other}\n`);
      });
    });
  });

  describe('Given a dirty tree, When an autostash merge is stopped', () => {
    it('Then MERGE_AUTOSTASH keeps the stash and the pop hint is given', async () => {
      // Arrange
      const { ctx: base } = await repo();
      const logger = { info: vi.fn(), warn: vi.fn() };
      const ctx = { ...base, logger };
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'dirty');
      const sut = mergeRun;

      // Act
      await sut(ctx, { rev: 'feature', commit: false, autostash: true, author });

      // Assert
      expect(await ctx.fs.exists(`${ctx.layout.gitDir}/MERGE_AUTOSTASH`)).toBe(true);
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/a.txt`)).toBe('a.txt');
      expect(logger.info).toHaveBeenCalledWith(
        'When finished, apply stashed changes with `git stash pop`',
      );
    });
  });

  describe('Given squash with commit true', () => {
    describe('When merged', () => {
      it('Then it refuses as git does, before writing anything', async () => {
        // Arrange
        const { ctx } = await repo();
        const sut = mergeRun;

        // Act
        const error = await sut(ctx, {
          rev: 'feature',
          squash: true,
          commit: true,
          author,
        }).catch((e: unknown) => e);

        // Assert
        expect((error as TsgitError).data).toEqual({
          code: 'INCOMPATIBLE_OPTIONS',
          options: ['--squash', '--commit'],
        });
        expect(await stateFile(ctx, 'ORIG_HEAD')).toBeUndefined();
      });
    });
  });
});
