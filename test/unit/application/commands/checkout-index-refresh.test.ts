import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const T0 = 1_700_000_000_000;
const LATER_MS = 10_000;
const CLOCK = { toFake: ['Date' as const] };

afterEach(() => {
  vi.useRealTimers();
});

const write = (ctx: Context, path: string, content: string): Promise<void> =>
  ctx.fs.writeUtf8(`${ctx.layout.workDir}/${path}`, content);

const committedRepo = async (): Promise<Context> => {
  const ctx = createMemoryContext();
  await init(ctx);
  await write(ctx, 'f', 'v1\n');
  await add(ctx, ['f']);
  await commit(ctx, { message: 'base', author, committer: author });
  return ctx;
};

const entryF = async (ctx: Context): Promise<IndexEntry> => {
  const found = (await readIndex(ctx)).entries.find((e) => e.path === 'f');
  if (found === undefined) throw new Error('f is not tracked');
  return found;
};

describe('checkout of the current branch', () => {
  describe('Given a touched clean tracked file', () => {
    describe('When an unforced checkout of the current branch runs', () => {
      it('Then the committed index records the file new stat', async () => {
        // Arrange
        vi.useFakeTimers(CLOCK);
        vi.setSystemTime(T0);
        const ctx = await committedRepo();
        const before = await entryF(ctx);
        vi.setSystemTime(T0 + LATER_MS);
        await write(ctx, 'f', 'v1\n');
        vi.setSystemTime(T0 + 2 * LATER_MS);

        // Act
        const sut = await checkout(ctx, { rev: 'main' });

        // Assert
        const after = await entryF(ctx);
        expect(sut.changedPaths).toBe(0);
        expect(after.mtimeSeconds).toBeGreaterThan(before.mtimeSeconds);
        expect(after.id).toBe(before.id);
      });
    });

    describe('When a forced checkout of the current branch runs', () => {
      it('Then the stale pass rewrites the file and changedPaths is 1', async () => {
        // Arrange
        vi.useFakeTimers(CLOCK);
        vi.setSystemTime(T0);
        const ctx = await committedRepo();
        vi.setSystemTime(T0 + LATER_MS);
        await write(ctx, 'f', 'v1\n');
        vi.setSystemTime(T0 + 2 * LATER_MS);

        // Act
        const sut = await checkout(ctx, { rev: 'main', force: true });

        // Assert
        expect(sut.changedPaths).toBe(1);
      });
    });
  });

  describe('Given a touched file and an edited file that the target changes', () => {
    describe('When the unforced checkout refuses', () => {
      it('Then the index bytes are untouched', async () => {
        // Arrange
        vi.useFakeTimers(CLOCK);
        vi.setSystemTime(T0);
        const ctx = await committedRepo();
        await write(ctx, 'g', 'g1\n');
        await add(ctx, ['g']);
        await commit(ctx, { message: 'second', author, committer: author });
        await checkout(ctx, { rev: 'main', createBranch: { name: 'side' } });
        await write(ctx, 'g', 'g2\n');
        await add(ctx, ['g']);
        await commit(ctx, { message: 'side', author, committer: author });
        await checkout(ctx, { rev: 'main' });
        vi.setSystemTime(T0 + LATER_MS);
        await write(ctx, 'f', 'v1\n');
        await write(ctx, 'g', 'edited\n');
        const indexPath = `${ctx.layout.gitDir}/index`;
        const before = await ctx.fs.read(indexPath);

        // Act
        const sut = await checkout(ctx, { rev: 'side' }).catch((err: unknown) => err);

        // Assert
        expect(sut).toMatchObject({
          data: { code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['g'] },
        });
        expect(await ctx.fs.read(indexPath)).toEqual(before);
      });
    });
  });
});
