import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { checkout } from '../../../../src/application/commands/checkout.js';
import { commit } from '../../../../src/application/commands/commit.js';
import { init } from '../../../../src/application/commands/init.js';
import { refreshAndWriteIndex } from '../../../../src/application/commands/internal/refresh-index.js';
import { reset } from '../../../../src/application/commands/reset.js';
import type { AuthorIdentity } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';

const author: AuthorIdentity = {
  name: 'Ada',
  email: 'ada@example.com',
  timestamp: 1_700_000_000,
  timezoneOffset: '+0000',
};
const CLOCK = { toFake: ['Date' as const] };

afterEach(() => {
  vi.useRealTimers();
});

// The clock stands still, so the index and the file share one second: the entry is racily clean.
const racyRepo = async (): Promise<Context> => {
  vi.useFakeTimers(CLOCK);
  const ctx = createMemoryContext();
  await init(ctx);
  await ctx.fs.writeUtf8(`${ctx.layout.workDir}/f`, 'v1\n');
  await add(ctx, ['f']);
  await commit(ctx, { message: 'base', author, committer: author });
  return ctx;
};

const contentReadsOfF = (reads: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): number => reads.mock.calls.filter(([path]) => String(path).endsWith('/f')).length;

describe('the index commit after a pass that already read a racy entry', () => {
  describe('Given a racily clean tracked file', () => {
    describe('When reset --hard runs', () => {
      it('Then its content is read once across the judgement and the commit', async () => {
        // Arrange
        const ctx = await racyRepo();
        const reads = vi.spyOn(ctx.fs, 'read');

        // Act
        await reset(ctx, { mode: 'hard', rev: 'HEAD' });

        // Assert
        expect(contentReadsOfF(reads)).toBe(1);
      });
    });

    describe('When a forced checkout of the current branch runs', () => {
      it('Then its content is read once across the judgement and the commit', async () => {
        // Arrange
        const ctx = await racyRepo();
        const reads = vi.spyOn(ctx.fs, 'read');

        // Act
        await checkout(ctx, { rev: 'main', force: true });

        // Assert
        expect(contentReadsOfF(reads)).toBe(1);
      });
    });

    describe('When an unforced checkout of the current branch runs', () => {
      it('Then its content is read once across the refresh and the commit', async () => {
        // Arrange
        const ctx = await racyRepo();
        const reads = vi.spyOn(ctx.fs, 'read');

        // Act
        await checkout(ctx, { rev: 'main' });

        // Assert
        expect(contentReadsOfF(reads)).toBe(1);
      });
    });

    describe('When the index is refreshed and written', () => {
      it('Then its content is read once across the refresh and the commit', async () => {
        // Arrange
        const ctx = await racyRepo();
        const reads = vi.spyOn(ctx.fs, 'read');

        // Act
        await refreshAndWriteIndex(ctx);

        // Assert
        expect(contentReadsOfF(reads)).toBe(1);
      });
    });
  });
});
