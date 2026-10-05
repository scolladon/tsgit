import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import {
  cherryPickAbort,
  cherryPickRun,
  cherryPickSkip,
} from '../../../../src/application/commands/cherry-pick.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { rebaseAbort, rebaseRun, rebaseSkip } from '../../../../src/application/commands/rebase.js';
import { revertAbort, revertRun, revertSkip } from '../../../../src/application/commands/revert.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const STRAY_STATE = ['MERGE_RR', 'AUTO_MERGE', 'SQUASH_MSG'] as const;

const BRANCH_STATE = [
  ...STRAY_STATE,
  'MERGE_MSG',
  'CHERRY_PICK_HEAD',
  'REVERT_HEAD',
  'MERGE_HEAD',
] as const;

const commitFile = async (ctx: Context, content: string, message: string): Promise<ObjectId> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/file.txt`, content);
  await add(ctx, ['file.txt']);
  return (await commit(ctx, { message, author })).id;
};

/** main and feature each rewrite `file.txt` from a shared base. */
const seedDiverged = async (): Promise<{ ctx: Context; head: ObjectId }> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.appendUtf8(`${ctx.layout.gitDir}/config`, '\n[user]\n\tname = Ada\n\temail = a@x\n');
  await commitFile(ctx, 'base\n', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 'FEATURE\n', 'on-feature');
  await checkout(ctx, { rev: 'main' });
  const head = await commitFile(ctx, 'MAIN\n', 'on-main');
  return { ctx, head };
};

const plantStrayState = async (ctx: Context, oid: ObjectId): Promise<void> => {
  for (const name of STRAY_STATE)
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, `${oid}\n`);
};

const presentBranchState = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const present: string[] = [];
  for (const name of BRANCH_STATE) {
    if (await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`)) present.push(name);
  }
  return present;
};

const readOrigHead = (ctx: Context): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.gitDir}/ORIG_HEAD`);

describe('sequencer skip and abort clear the branch state, as git does', () => {
  describe.each([
    ['cherry-pick', 'skip', cherryPickSkip],
    ['cherry-pick', 'abort', cherryPickAbort],
  ] as const)('Given a %s stopped on a conflict', (_op, verb, end) => {
    describe(`When it is ended with ${verb}`, () => {
      it('Then the branch state is gone and ORIG_HEAD records the HEAD it left', async () => {
        // Arrange
        const { ctx, head } = await seedDiverged();
        await cherryPickRun(ctx, { commits: ['feature'] });
        await plantStrayState(ctx, head);
        const sut = end;

        // Act
        await sut(ctx);

        // Assert
        const result = await presentBranchState(ctx);
        expect(result).toEqual([]);
        expect(await readOrigHead(ctx)).toBe(`${head}\n`);
      });
    });
  });

  describe.each([
    ['skip', revertSkip],
    ['abort', revertAbort],
  ] as const)('Given a revert stopped on a conflict', (verb, end) => {
    describe(`When it is ended with ${verb}`, () => {
      it('Then the branch state is gone and ORIG_HEAD records the HEAD it left', async () => {
        // Arrange
        const { ctx } = await seedDiverged();
        const head = await commitFile(ctx, 'MAIN2\n', 'on-main-2');
        await revertRun(ctx, { commits: ['HEAD~1'] });
        await plantStrayState(ctx, head);
        const sut = end;

        // Act
        await sut(ctx);

        // Assert
        const result = await presentBranchState(ctx);
        expect(result).toEqual([]);
        expect(await readOrigHead(ctx)).toBe(`${head}\n`);
      });
    });
  });

  describe.each([
    ['skip', rebaseSkip],
    ['abort', rebaseAbort],
  ] as const)('Given a rebase stopped on a conflict', (verb, end) => {
    describe(`When it is ended with ${verb}`, () => {
      it('Then the branch state is gone', async () => {
        // Arrange
        const { ctx, head } = await seedDiverged();
        await rebaseRun(ctx, { upstream: 'feature' });
        await plantStrayState(ctx, head);
        const sut = end;

        // Act
        await sut(ctx);

        // Assert
        const result = await presentBranchState(ctx);
        expect(result).toEqual([]);
      });
    });
  });
});
