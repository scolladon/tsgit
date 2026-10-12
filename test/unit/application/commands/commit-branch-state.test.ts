import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const STATE_FILES = [
  'MERGE_MSG',
  'MERGE_MODE',
  'MERGE_RR',
  'AUTO_MERGE',
  'SQUASH_MSG',
  'CHERRY_PICK_HEAD',
  'sequencer',
] as const;

const seedCommitAndStage = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'a');
  await add(ctx, ['a.txt']);
  const head = (await commit(ctx, { message: 'first', author })).id;
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/a.txt`, 'b');
  await add(ctx, ['a.txt']);
  return { ctx, head };
};

const plant = (ctx: Context, name: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, content);

const presentStateFiles = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const present: string[] = [];
  for (const name of STATE_FILES) {
    if (await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`)) present.push(name);
  }
  return present;
};

describe('commit clears the branch state, as git does', () => {
  describe('Given stale merge files and no operation in progress', () => {
    describe('When commit', () => {
      it('Then every file but MERGE_RR is removed', async () => {
        // Arrange
        const { ctx, head } = await seedCommitAndStage();
        for (const name of ['MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'AUTO_MERGE', 'SQUASH_MSG']) {
          await plant(ctx, name, `${head}\n`);
        }
        const sut = commit;

        // Act
        await sut(ctx, { message: 'second', author });

        // Assert
        const result = await presentStateFiles(ctx);
        expect(result).toEqual(['MERGE_RR']);
      });
    });
  });

  describe('Given a resolved pick of a multi-pick', () => {
    describe.each([
      ['its last pick', 'pick 1234567 one\n', []],
      ['picks still to go', 'pick 1234567 one\npick 89abcde two\n', ['sequencer']],
    ])('When commit at %s', (_label, todo, expected) => {
      it('Then the sequencer directory goes only once the last pick is done', async () => {
        // Arrange
        const { ctx, head } = await seedCommitAndStage();
        await plant(ctx, 'CHERRY_PICK_HEAD', `${head}\n`);
        await plant(ctx, 'MERGE_MSG', 'picked\n');
        await plant(ctx, 'sequencer/todo', todo);
        const sut = commit;

        // Act
        await sut(ctx, { message: '', author });

        // Assert
        const result = await presentStateFiles(ctx);
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a rebase stopped at a commit', () => {
    describe('When commit', () => {
      it('Then it commits on HEAD and leaves the rebase state in place', async () => {
        // Arrange
        const { ctx, head } = await seedCommitAndStage();
        await plant(ctx, 'REBASE_HEAD', `${head}\n`);
        await plant(ctx, 'rebase-merge/stopped-sha', `${head}\n`);
        const sut = commit;

        // Act
        const result = await sut(ctx, { message: 'manual', author });

        // Assert
        expect(result.parents).toEqual([head]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REBASE_HEAD`)).toBe(true);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/rebase-merge/stopped-sha`)).toBe(true);
      });
    });
  });
});
