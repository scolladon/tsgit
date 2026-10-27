import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { branchCreate } from '../../../../src/application/commands/branch.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { mergeRun } from '../../../../src/application/commands/merge.js';
import {
  applyAutostash,
  createAutostash,
  stashApply,
  stashDrop,
  stashList,
  stashPop,
  stashPush,
} from '../../../../src/application/commands/stash.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { AuthorIdentity, ObjectId } from '../../../../src/domain/objects/index.js';
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

const read = (ctx: Context, path: string): Promise<string> =>
  ctx.fs.readUtf8(`${ctx.layout.workDir}/${path}`);

const commitFile = async (ctx: Context, path: string, content: string): Promise<void> => {
  await write(ctx, path, content);
  await add(ctx, [path]);
  await commit(ctx, { message: `edit ${path}`, author: AUTHOR, committer: AUTHOR });
};

const CLOCK_START_MS = 1_700_000_000_000;
const DRIFT_MS = 10_000;

/** A stash of a dirty `o`, then a merge left conflicted on `c`, MERGE_HEAD still present. */
const mergeConflictedWithStash = async (): Promise<Context> => {
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
  return ctx;
};

/** The same conflicted state with the pending-operation marker removed. */
const conflictedRepoWithStash = async (): Promise<Context> => {
  const ctx = await mergeConflictedWithStash();
  await ctx.fs.rm(`${ctx.layout.gitDir}/MERGE_HEAD`);
  return ctx;
};

const stagesOf = async (ctx: Context): Promise<ReadonlyArray<string>> =>
  (await readIndex(ctx)).entries.map((e) => `${e.flags.stage} ${e.path}`);

const oMtime = async (ctx: Context): Promise<number> => {
  const found = (await readIndex(ctx)).entries.find((e) => e.path === 'o');
  if (found === undefined) throw new Error('o is not tracked');
  return found.mtimeSeconds;
};

const refusalOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (caught) {
    return (caught as { readonly data?: unknown }).data;
  }
  return undefined;
};

describe('Given a merge left conflicted with MERGE_HEAD present and a drifted bystander', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('When stash apply runs', () => {
    it('Then it refuses the unmerged path, keeps the stages and refreshes the bystander', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(CLOCK_START_MS);
      const ctx = await mergeConflictedWithStash();
      const stages = await stagesOf(ctx);
      const before = await oMtime(ctx);
      vi.setSystemTime(CLOCK_START_MS + DRIFT_MS);
      await write(ctx, 'o', 'o\n');
      const sut = stashApply;

      // Act
      const data = await refusalOf(() => sut(ctx, {}));

      // Assert
      expect(data).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
      expect(await stagesOf(ctx)).toEqual(stages);
      expect(await oMtime(ctx)).toBeGreaterThan(before);
    });
  });
});

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

const AUTOSTASH_WARNING = 'Your local changes are stashed, however applying them';

const withWarnSpy = (
  ctx: Context,
): { readonly ctx: Context; readonly warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  return { ctx: { ...ctx, logger: { warn } }, warn };
};

describe('Given an autostash whose apply is refused', () => {
  describe('When the index holds conflict stages', () => {
    it('Then the autostash is stored in refs/stash and the refusal is warned', async () => {
      // Arrange
      const base = await conflictedRepoWithStash();
      const autostash = (await stashList(base)).entries[0]?.stash;
      await stashDrop(base, {});
      const { ctx, warn } = withWarnSpy(base);

      // Act
      const sut = applyAutostash;
      await sut(ctx, autostash as ObjectId);

      // Assert
      const list = await stashList(ctx);
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]?.stash).toBe(autostash);
      expect(list.entries[0]?.message).toBe('autostash');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(AUTOSTASH_WARNING);
      expect(warn.mock.calls[0]?.[1]).toEqual({ code: 'MERGE_HAS_CONFLICTS' });
    });
  });

  describe('When the apply would overwrite a dirty working file', () => {
    it('Then the autostash is stored in refs/stash and the refusal is warned', async () => {
      // Arrange
      const base = createMemoryContext();
      await init(base);
      await commitFile(base, 'o', 'o\n');
      await write(base, 'o', 'stashed\n');
      const autostash = await createAutostash(base);
      await write(base, 'o', 'local edit\n');
      const { ctx, warn } = withWarnSpy(base);

      // Act
      const sut = applyAutostash;
      await sut(ctx, autostash as ObjectId);

      // Assert
      const list = await stashList(ctx);
      expect(list.entries).toHaveLength(1);
      expect(list.entries[0]?.stash).toBe(autostash);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain(AUTOSTASH_WARNING);
      expect(warn.mock.calls[0]?.[1]).toEqual({ code: 'STASH_APPLY_WOULD_OVERWRITE' });
      expect(await read(ctx, 'o')).toBe('local edit\n');
    });
  });
});

const hasStashRef = (ctx: Context): Promise<boolean> =>
  ctx.fs.exists(`${ctx.layout.gitDir}/refs/stash`);

describe('Given an index holding conflict stages', () => {
  describe('When stash push runs', () => {
    it('Then it refuses naming the unmerged path and writes no stash ref', async () => {
      // Arrange
      const ctx = await conflictedRepoWithStash();
      await stashDrop(ctx, {});
      const before = await stagesOf(ctx);

      // Act
      const sut = stashPush;
      const data = await refusalOf(() => sut(ctx, {}));

      // Assert
      expect(data).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
      expect(await hasStashRef(ctx)).toBe(false);
      expect(await stagesOf(ctx)).toEqual(before);
    });
  });

  describe('When stash push runs during a conflicted merge', () => {
    it('Then it refuses with the conflicts, not the pending operation', async () => {
      // Arrange
      const ctx = await conflictedRepoWithStash();
      await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/MERGE_HEAD`, `${'a'.repeat(40)}\n`);

      // Act
      const sut = stashPush;
      const data = await refusalOf(() => sut(ctx, {}));

      // Assert
      expect(data).toMatchObject({ code: 'MERGE_HAS_CONFLICTS', count: 1, paths: ['c'] });
    });
  });
});
