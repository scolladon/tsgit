import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import {
  stashApply,
  stashList,
  stashPop,
  stashPush,
} from '../../../../src/application/commands/stash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const AUTHOR: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const DIRTY_O = 'dirty\n';

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const commitFile = async (ctx: Context, path: string, content: string): Promise<void> => {
  await write(ctx, path, content);
  await add(ctx, [path]);
  await commit(ctx, { message: `edit ${path}`, author: AUTHOR, committer: AUTHOR });
};

/** A stash of a dirty `o`, then a merge left conflicted on `c`. */
const conflictedRepoWithStash = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await write(ctx, 'c', 'a\nb\nc\n');
  await write(ctx, 'o', 'o\n');
  await add(ctx, ['c', 'o']);
  await commit(ctx, { message: 'base', author: AUTHOR, committer: AUTHOR });
  await branchCreate(ctx, { name: 'theirs' });
  await checkout(ctx, { rev: 'theirs' });
  await commitFile(ctx, 'c', 'a\nY\nc\n');
  await checkout(ctx, { rev: 'main' });
  await commitFile(ctx, 'c', 'a\nX\nc\n');
  await write(ctx, 'o', DIRTY_O);
  await stashPush(ctx, {});
  await mergeRun(ctx, { rev: 'theirs', author: AUTHOR });
  await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_HEAD`);
  return ctx;
};

const stagesOf = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await readIndex(ctx)).entries.map((e) => `${e.flags.stage} ${e.path}`);

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (caught) {
    return (caught as { readonly data?: unknown }).data;
  }
  return undefined;
};

describe('Given a stash and an index holding conflict stages', () => {
  describe('When stash apply runs', () => {
    it('Then it refuses naming the unmerged path and leaves index and work tree untouched', async () => {
      // Arrange
      const ctx = await conflictedRepoWithStash();
      const before = await stagesOf(ctx);
      expect(before).toEqual(['1 c', '2 c', '3 c', '0 o']);

      // Act
      const sut = stashApply;
      const data = await refusalOf(() => sut(ctx, {}));

      // Assert
      expect(data).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
      expect(await stagesOf(ctx)).toEqual(before);
      expect(await ctx.fs.readUtf8(`${ctx.layout.workDir}/o`)).toBe('o\n');
    });

    it('Then it refuses with the index flag too', async () => {
      // Arrange
      const ctx = await conflictedRepoWithStash();

      // Act
      const sut = stashApply;
      const data = await refusalOf(() => sut(ctx, { restoreIndex: true }));

      // Assert
      expect(data).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
    });
  });

  describe('When stash pop runs', () => {
    it('Then it refuses and keeps the stash entry', async () => {
      // Arrange
      const ctx = await conflictedRepoWithStash();

      // Act
      const sut = stashPop;
      const data = await refusalOf(() => sut(ctx, {}));

      // Assert
      expect(data).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
      expect((await stashList(ctx)).entries).toHaveLength(1);
    });
  });
});
