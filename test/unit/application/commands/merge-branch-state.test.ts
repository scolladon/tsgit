import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};

const STALE_MERGE_STATE = ['MERGE_MSG', 'MERGE_MODE', 'MERGE_RR', 'AUTO_MERGE'] as const;

const commitFile = async (ctx: Context, path: string, message: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, `${message}\n`);
  await add(ctx, [path]);
  await commit(ctx, { message, author });
};

/** `feature` one commit ahead of `main`; `onMain` adds an unrelated commit to main. */
const seed = async (onMain: boolean): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await commitFile(ctx, 'base.txt', 'base');
  await branchCreate(ctx, { name: 'feature' });
  await checkout(ctx, { rev: 'feature' });
  await commitFile(ctx, 'feature.txt', 'feature');
  await checkout(ctx, { rev: 'main' });
  if (onMain) await commitFile(ctx, 'main.txt', 'main');
  for (const name of [...STALE_MERGE_STATE, 'SQUASH_MSG']) {
    await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/${name}`, 'stale\n');
  }
  return ctx;
};

const presentState = async (ctx: Context): Promise<ReadonlyArray<string>> => {
  const present: string[] = [];
  for (const name of [...STALE_MERGE_STATE, 'SQUASH_MSG']) {
    if (await ctx.fs.exists(`${ctx.layout.gitDir}/${name}`)) present.push(name);
  }
  return present;
};

describe('merge clears a stale merge state once it concludes, as git does', () => {
  describe.each([
    ['a fast-forward', false, 'feature', 'fast-forward'],
    ['a true merge', true, 'feature', 'merge'],
    ['an up-to-date merge', true, 'main', 'up-to-date'],
  ] as const)('Given stale merge files and %s', (_label, onMain, rev, kind) => {
    describe('When merge concludes', () => {
      it('Then the merge files go and SQUASH_MSG stays', async () => {
        // Arrange
        const ctx = await seed(onMain);
        const sut = mergeRun;

        // Act
        const result = await sut(ctx, { rev, author });

        // Assert
        expect(result.kind).toBe(kind);
        expect(await presentState(ctx)).toEqual(['SQUASH_MSG']);
      });
    });
  });
});
