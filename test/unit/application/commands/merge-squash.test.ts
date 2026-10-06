import { describe, expect, it } from 'vitest';
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
const DATE = 'Tue Nov 14 23:43:20 2023 +0130';
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

const entry = (id: ObjectId, message: string): string =>
  `\ncommit ${id}\nAuthor: a <a@x>\nDate:   ${DATE}\n\n    ${message}\n`;

const stateFiles = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const names = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'SQUASH_MSG', 'ORIG_HEAD'];
  const present = await Promise.all(
    names.map((name) => ctx.fs.exists(`${ctx.layout.gitDir}/${name}`)),
  );
  return names.filter((_, at) => present[at]);
};

const indexPaths = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await readIndex(ctx)).entries.map((e) => e.path);

describe('merge squash', () => {
  describe.each([
    ['diverged from', false],
    ['fast-forwardable to', true],
  ])('Given HEAD %s a branch with two commits', (_label, fastForwardable) => {
    describe('When merged with squash', () => {
      it("Then the index takes the merge, HEAD stays, and SQUASH_MSG lists git's medium log", async () => {
        // Arrange
        const { ctx, one, two, main } = await repo(fastForwardable);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', squash: true, author });

        // Assert
        expect(result).toEqual({ kind: 'squashed', origHead: main });
        expect(await resolveRef(ctx, HEAD)).toBe(main);
        expect(await stateFiles(ctx)).toEqual(['SQUASH_MSG', 'ORIG_HEAD']);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/SQUASH_MSG`)).toBe(
          `Squashed commit of the following:\n${entry(two, 'two')}${entry(one, 'one')}`,
        );
        expect(await indexPaths(ctx)).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/two.txt`)).toBe(true);
      });
    });
  });

  describe('Given HEAD already contains the branch', () => {
    describe('When merged with squash', () => {
      it('Then it is up to date and writes no SQUASH_MSG', async () => {
        // Arrange
        const { ctx, main } = await repo();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'main~1', squash: true, author });

        // Assert
        expect(result).toEqual({ kind: 'up-to-date', id: main });
        expect(await stateFiles(ctx)).toEqual(['ORIG_HEAD']);
      });
    });
  });

  describe('Given squash with fastForward never', () => {
    describe('When merged', () => {
      it('Then it refuses as git does, before writing anything', async () => {
        // Arrange
        const { ctx } = await repo();
        const sut = mergeRun;

        // Act
        const error = await sut(ctx, {
          rev: 'feature',
          squash: true,
          fastForward: 'never',
          author,
        }).catch((e: unknown) => e);

        // Assert
        expect((error as TsgitError).data).toEqual({
          code: 'INCOMPATIBLE_OPTIONS',
          options: ['--squash', '--no-ff'],
        });
        expect(await stateFiles(ctx)).toEqual([]);
      });
    });
  });

  describe('Given a squashed merge', () => {
    describe('When committed', () => {
      it('Then the commit has the single parent HEAD had and SQUASH_MSG is gone', async () => {
        // Arrange
        const { ctx, main } = await repo();
        await mergeRun(ctx, { rev: 'feature', squash: true, author });
        const sut = commit;

        // Act
        const committed = await sut(ctx, { message: 'squashed', author });

        // Assert
        const result = await readObject(ctx, committed.id);
        expect(result.type === 'commit' && result.data.parents).toEqual([main]);
        expect(await stateFiles(ctx)).toEqual(['ORIG_HEAD']);
      });
    });
  });

  describe('Given a squash whose merge conflicts', () => {
    const conflicting = async (): Promise<Repo & { readonly theirs: ObjectId }> => {
      const built = await repo();
      const { ctx } = built;
      await checkout(ctx, { rev: 'feature' });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'theirs');
      await add(ctx, ['a.txt']);
      const theirs = (await commit(ctx, { message: 'theirs', author })).id;
      await checkout(ctx, { rev: 'main' });
      await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'ours');
      await add(ctx, ['a.txt']);
      const main = (await commit(ctx, { message: 'ours', author })).id;
      return { ...built, theirs, main };
    };

    describe('When merged', () => {
      it("Then git's squash state is left with the conflict stages and a squashed result", async () => {
        // Arrange
        const { ctx, main } = await conflicting();
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev: 'feature', squash: true, author });

        // Assert
        expect(result).toEqual({
          kind: 'squashed',
          origHead: main,
          conflicts: [{ path: 'a.txt', type: 'content' }],
        });
        expect(await resolveRef(ctx, HEAD)).toBe(main);
        expect(await stateFiles(ctx)).toEqual(['MERGE_MSG', 'SQUASH_MSG', 'ORIG_HEAD']);
        expect(await ctx.fs.readUtf8(`${ctx.layout.gitDir}/MERGE_MSG`)).toBe(
          '\n# Conflicts:\n#\ta.txt\n',
        );
        const stages = (await readIndex(ctx)).entries.filter((e) => e.path === 'a.txt');
        expect(stages.map((e) => e.flags.stage)).toEqual([1, 2, 3]);
      });
    });

    describe('When resolved and committed without a message', () => {
      it('Then the commit takes SQUASH_MSG then MERGE_MSG, comments stripped, on one parent', async () => {
        // Arrange
        const { ctx, one, two, theirs, main } = await conflicting();
        await mergeRun(ctx, { rev: 'feature', squash: true, author });
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'resolved');
        await add(ctx, ['a.txt']);
        const sut = commit;

        // Act
        const committed = await sut(ctx, { message: '', author });

        // Assert
        const result = await readObject(ctx, committed.id);
        expect(result.type === 'commit' && result.data.parents).toEqual([main]);
        expect(result.type === 'commit' && result.data.message).toBe(
          `Squashed commit of the following:\n${entry(theirs, 'theirs')}${entry(two, 'two')}${entry(one, 'one')}`,
        );
        expect(await stateFiles(ctx)).toEqual(['ORIG_HEAD']);
      });
    });
  });

  describe('Given a clean squashed merge', () => {
    describe('When committed without a message', () => {
      it('Then the commit message is SQUASH_MSG', async () => {
        // Arrange
        const { ctx, one, two } = await repo();
        await mergeRun(ctx, { rev: 'feature', squash: true, author });
        const sut = commit;

        // Act
        const committed = await sut(ctx, { message: '', author });

        // Assert
        const result = await readObject(ctx, committed.id);
        expect(result.type === 'commit' && result.data.message).toBe(
          `Squashed commit of the following:\n${entry(two, 'two')}${entry(one, 'one')}`,
        );
      });
    });
  });
});
