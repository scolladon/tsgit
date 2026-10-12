import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
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

type Logged = readonly [level: string, message: string];

const commitFile = async (ctx: Context, content: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, content);
  await add(ctx, ['file.txt']);
  return (await commit(ctx, { message, author })).id;
};

const seedDivergedBranches = async (): Promise<{
  ctx: Context;
  head: ObjectId;
  logged: Logged[];
}> => {
  const logged: Logged[] = [];
  const logger = { warn: (message: string) => logged.push(['warn', message]) };
  const ctx: Context = { ...createMemoryContext(), logger };
  await init(ctx);
  await commitFile(ctx, 'base\n', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 'FEATURE\n', 'on-feature');
  await checkout(ctx, { rev: 'main' });
  const head = await commitFile(ctx, 'MAIN\n', 'on-main');
  logged.length = 0;
  return { ctx, head, logged };
};

const plantBranchState = async (ctx: Context, oid: ObjectId): Promise<void> => {
  for (const name of BRANCH_STATE_FILES) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${oid}\n`);
  }
};

const presentStateFiles = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const present: string[] = [];
  for (const name of BRANCH_STATE_FILES) {
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

describe('checkout clears the branch state, as git does', () => {
  describe('Given every branch-state file and a conflict-free index', () => {
    describe('When checkout switches branch', () => {
      it('Then it switches, removes the state and warns of each cancelled operation', async () => {
        // Arrange
        const { ctx, head, logged } = await seedDivergedBranches();
        await plantBranchState(ctx, head);
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'feature' });

        // Assert
        expect(result.branch).toBe('refs/heads/feature');
        expect(await presentStateFiles(ctx)).toEqual([]);
        expect(logged).toEqual([
          ['warn', 'cancelling a cherry picking in progress'],
          ['warn', 'cancelling a revert in progress'],
        ]);
      });
    });

    describe('When checkout restores a path', () => {
      it('Then it restores the path and keeps the state', async () => {
        // Arrange
        const { ctx, head } = await seedDivergedBranches();
        await plantBranchState(ctx, head);
        await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, 'dirty\n');
        const sut = checkout;

        // Act
        await sut(ctx, { paths: ['file.txt'] });

        // Assert
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`)).toBe('MAIN\n');
        expect(await presentStateFiles(ctx)).toEqual(BRANCH_STATE_FILES);
      });
    });
  });

  describe('Given a merge stopped on a conflict', () => {
    describe('When checkout switches branch', () => {
      it('Then it refuses until the index is resolved and keeps the state', async () => {
        // Arrange
        const { ctx } = await seedDivergedBranches();
        await mergeRun(ctx, { rev: 'feature', author });
        const sut = checkout;

        // Act
        const result = await errorDataOf(() => sut(ctx, { rev: 'feature' }));

        // Assert
        expect(result).toEqual({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['file.txt'] });
        expect(await presentStateFiles(ctx)).toEqual([
          'MERGE_HEAD',
          'MERGE_MSG',
          'MERGE_MODE',
          'AUTO_MERGE',
        ]);
      });
    });

    describe('When checkout forces the switch', () => {
      it('Then it discards the conflict, switches and removes the state', async () => {
        // Arrange
        const { ctx } = await seedDivergedBranches();
        await mergeRun(ctx, { rev: 'feature', author });
        const sut = checkout;

        // Act
        const result = await sut(ctx, { rev: 'feature', force: true });

        // Assert
        expect(result.branch).toBe('refs/heads/feature');
        expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/file.txt`)).toBe('FEATURE\n');
        expect(await presentStateFiles(ctx)).toEqual([]);
      });
    });
  });
});
