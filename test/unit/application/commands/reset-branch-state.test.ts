import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import { reset } from '../../../../src/application/commands/reset.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const BRANCH_STATE_FILES = [
  'MERGE_HEAD',
  'MERGE_MSG',
  'MERGE_MODE',
  'MERGE_RR',
  'AUTO_MERGE',
  'SQUASH_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
] as const;

const writeFile = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const commitFile = async (ctx: Context, content: string, message: string): Promise<ObjectId> => {
  await writeFile(ctx, 'file.txt', content);
  await add(ctx, ['file.txt']);
  return (await commit(ctx, { message, author })).id;
};

const seedDivergedBranches = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await commitFile(ctx, 'base\n', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 'FEATURE\n', 'on-feature');
  await checkout(ctx, { rev: 'main' });
  const head = await commitFile(ctx, 'MAIN\n', 'on-main');
  return { ctx, head };
};

const conflictedMerge = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const seeded = await seedDivergedBranches();
  await mergeRun(seeded.ctx, { rev: 'feature', author });
  return seeded;
};

const plantBranchState = async (ctx: Context, oid: ObjectId): Promise<void> => {
  for (const name of BRANCH_STATE_FILES) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${oid}\n`);
  }
};

const presentStateFiles = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const present: string[] = [];
  for (const name of [...BRANCH_STATE_FILES, 'sequencer']) {
    if (await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`)) present.push(name);
  }
  return present;
};

const errorDataOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (err) {
    return (err as { data?: unknown }).data;
  }
  return undefined;
};

describe('reset clears the branch state, as git does', () => {
  describe('Given a stopped merge carrying every branch-state file', () => {
    describe.each(['hard', 'mixed'] as const)('When reset --%s HEAD', (mode) => {
      it('Then every branch-state file is removed', async () => {
        // Arrange
        const { ctx, head } = await conflictedMerge();
        await plantBranchState(ctx, head);
        const sut = reset;

        // Act
        await sut(ctx, { mode, rev: 'HEAD' });

        // Assert
        const result = await presentStateFiles(ctx);
        expect(result).toEqual([]);
      });
    });

    describe('When reset --soft HEAD', () => {
      it('Then it refuses the soft reset in the middle of a merge and keeps the state', async () => {
        // Arrange
        const { ctx, head } = await conflictedMerge();
        await plantBranchState(ctx, head);
        const sut = reset;

        // Act
        const result = await errorDataOf(() => sut(ctx, { mode: 'soft', rev: 'HEAD' }));

        // Assert
        expect(result).toEqual({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
        expect(await presentStateFiles(ctx)).toEqual(BRANCH_STATE_FILES);
      });
    });
  });

  describe('Given an unmerged index and no MERGE_HEAD', () => {
    describe('When reset --soft HEAD', () => {
      it('Then it refuses the soft reset in the middle of a merge', async () => {
        // Arrange
        const { ctx } = await conflictedMerge();
        await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_HEAD`);
        const sut = reset;

        // Act
        const result = await errorDataOf(() => sut(ctx, { mode: 'soft', rev: 'HEAD' }));

        // Assert
        expect(result).toEqual({ code: 'OPERATION_IN_PROGRESS', operation: 'merge' });
      });
    });
  });

  describe('Given a resolved cherry-pick stop (no MERGE_HEAD, clean index)', () => {
    describe('When reset --soft HEAD', () => {
      it('Then the soft reset proceeds and removes the pick state', async () => {
        // Arrange
        const { ctx, head } = await seedDivergedBranches();
        await plantBranchState(ctx, head);
        await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_HEAD`);
        const sut = reset;

        // Act
        await sut(ctx, { mode: 'soft', rev: 'HEAD' });

        // Assert
        const result = await presentStateFiles(ctx);
        expect(result).toEqual([]);
      });
    });
  });

  describe('Given a stopped multi-pick sequencer', () => {
    describe.each([
      ['its last pick', 'pick 1234567 one\n', []],
      ['picks still to go', 'pick 1234567 one\npick 89abcde two\n', ['sequencer']],
    ])('When reset --hard HEAD at %s', (_label, todo, expected) => {
      it('Then the sequencer directory goes only once the last pick is done', async () => {
        // Arrange
        const { ctx, head } = await seedDivergedBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/CHERRY_PICK_HEAD`, `${head}\n`);
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/sequencer/todo`, todo);
        const sut = reset;

        // Act
        await sut(ctx, { mode: 'hard', rev: 'HEAD' });

        // Assert
        const result = await presentStateFiles(ctx);
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a sequencer directory but no pick or revert in progress', () => {
    describe('When reset --hard HEAD', () => {
      it('Then the sequencer directory is left alone', async () => {
        // Arrange
        const { ctx } = await seedDivergedBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/sequencer/todo`, 'pick 1234567 one\n');
        const sut = reset;

        // Act
        await sut(ctx, { mode: 'hard', rev: 'HEAD' });

        // Assert
        const result = await presentStateFiles(ctx);
        expect(result).toEqual(['sequencer']);
      });
    });
  });

  describe('Given a stopped rebase (REBASE_HEAD present)', () => {
    describe('When reset --hard HEAD', () => {
      it('Then the reset proceeds', async () => {
        // Arrange
        const { ctx, head } = await seedDivergedBranches();
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/REBASE_HEAD`, `${head}\n`);
        const sut = reset;

        // Act
        const result = await sut(ctx, { mode: 'hard', rev: 'HEAD' });

        // Assert
        expect(result.id).toBe(head);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/REBASE_HEAD`)).toBe(true);
      });
    });
  });
});
